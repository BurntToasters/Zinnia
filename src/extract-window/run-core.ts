import { invoke } from "@tauri-apps/api/core";
import { listenToOwnWindow } from "../window-events";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { validateArchivePaths } from "../archive-rules";
import { confirmExtractDestination } from "../extract-destination";
import { deriveExtractDestinationPath } from "../extract-path";
import { describe7zError, userFacingBackendError } from "../error-hints";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import { installWdioGuestPluginIfEnabled } from "../e2e-wdio-plugin";
import { normalizeAutoCloseDelay, parseSettingsRaw } from "../settings-model";
import { basename } from "../path-display";
import {
  formatEta as formatSharedEta,
  type ProgressUpdate,
} from "../progress-update";
import { redactSensitiveText } from "../utils";
import { sanitizeCommandArgsForPreview } from "../archive/command-sanitize";
import {
  formatArchiveIoDiagnosticsForDebug,
  formatCommandOutputForLogs,
} from "../output-logging";
import {
  installNativeWebviewContextMenuGuard,
  setNativeWebviewContextMenuAllowed,
} from "../webview-context-menu";
import {
  $,
  setButtons,
  stopProgressAt,
  startIndeterminateProgress,
  setDeterminateProgress,
  parentDir,
} from "./dom";
import { closeWindowSafely, syncExtractWindowFx } from "./fx";
import {
  runWithPasswordRetry,
  EXTRACT_PASSWORD_PROMPT_CANCELLED,
  isExtractRunInFlight,
  type Run7zResult,
} from "./password-retry";
import { readInjectedExtractSession } from "./injected-session";
import { sanitizeStatusFileName } from "./status-sanitize";
import { createAutoCloseController } from "./auto-close";

export async function runExtractWindow(): Promise<void> {
  installNativeWebviewContextMenuGuard();
  await installWdioGuestPluginIfEnabled();
  const appWindow = getCurrentWebviewWindow();

  // Platform styling is independent of extraction startup; do not put it on
  // the critical path between first paint and starting 7-Zip.
  void invoke<string>("get_platform_info")
    .then((platform) => {
      if (["windows", "macos", "linux"].includes(platform)) {
        document.body.classList.add(`platform-${platform}`);
      }
    })
    .catch(() => {});
  void syncExtractWindowFx();

  // Wire custom titlebar buttons
  const minBtn = document.getElementById("titlebar-min");
  const closeTitlebarBtn = document.getElementById("titlebar-close");

  if (minBtn) {
    minBtn.addEventListener("click", () => {
      void appWindow.minimize();
    });
  }
  const cancelBtn = $("cancel-btn") as HTMLButtonElement;
  const openDestinationBtn = $("open-destination-btn") as HTMLButtonElement;
  const closeBtn = $("close-btn") as HTMLButtonElement;
  let cancelRequested = false;
  const extractAbort = new AbortController();

  if (closeTitlebarBtn) {
    closeTitlebarBtn.addEventListener("click", () => {
      // Arm local abort before teardown so an in-flight password prompt cannot
      // start another run_7z after the window is dismissed.
      cancelRequested = true;
      extractAbort.abort();
      void closeWindowSafely();
    });
  }
  let operationFinished = false;
  let destination = "";

  let autoCloseDelay = 1.5;
  let debugMode = false;
  try {
    const raw = await invoke<string>("load_settings");
    const { settings } = parseSettingsRaw(raw);
    autoCloseDelay = normalizeAutoCloseDelay(
      settings.extractAutoCloseSeconds,
      1.5,
    );
    debugMode = settings.debug === true;
  } catch {
    autoCloseDelay = -1;
    debugMode = false;
  }
  setNativeWebviewContextMenuAllowed(debugMode);

  const { beginAutoClose } = createAutoCloseController(
    closeBtn,
    autoCloseDelay,
  );

  const finish = (
    status: string,
    progressPercent: number,
    asError = false,
    allowOpenDestination = true,
    asCancelled = false,
  ) => {
    operationFinished = true;
    $("extract-status").textContent = status;
    const h1 = document.querySelector<HTMLHeadingElement>("h1");
    if (h1) {
      h1.textContent = asError
        ? "Extraction failed"
        : asCancelled
          ? "Extraction cancelled"
          : "Extraction complete";
    }
    document.title = asError
      ? "Zinnia: Failed"
      : asCancelled
        ? "Zinnia: Cancelled"
        : "Zinnia: Done";
    stopProgressAt(progressPercent, asError);
    setButtons(false, !asError && allowOpenDestination, true);
    cancelBtn.disabled = false;
    openDestinationBtn.disabled = false;
    closeBtn.disabled = false;
    if (!asError && allowOpenDestination) {
      openDestinationBtn.focus();
    } else {
      closeBtn.focus();
    }

    if (!asError && !asCancelled && autoCloseDelay >= 0) {
      if (autoCloseDelay === 0) {
        void closeWindowSafely();
        return;
      }

      beginAutoClose();
    }
  };

  const copyErrorBtn = document.getElementById(
    "copy-error-detail",
  ) as HTMLButtonElement | null;
  copyErrorBtn?.addEventListener("click", async () => {
    const text = $("error-detail").textContent ?? "";
    if (!text.trim()) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
      copyErrorBtn.textContent = "Copied";
      window.setTimeout(() => {
        copyErrorBtn.textContent = "Copy details";
      }, 1300);
    } catch {
      copyErrorBtn.textContent = "Copy failed";
      window.setTimeout(() => {
        copyErrorBtn.textContent = "Copy details";
      }, 1300);
    }
  });

  const showError = (
    detail: string,
    debugDump?: {
      args?: string[];
      result?: Run7zResult;
      extra?: string;
      rawDetail?: string;
    },
  ) => {
    $("extract-error").hidden = false;
    const detailEl = $("error-detail");
    let text = detail;
    if (debugMode && debugDump) {
      const parts = [detail, "", "--- debug ---"];
      if (debugDump.args) {
        parts.push(
          `cmd: 7z ${sanitizeCommandArgsForPreview(debugDump.args).join(" ")}`,
        );
      }
      if (debugDump.result) {
        parts.push(`exit: ${debugDump.result.code}`);
        const streams = formatCommandOutputForLogs(
          debugDump.result.stdout ?? "",
          debugDump.result.stderr ?? "",
          "debug",
        );
        for (const entry of streams) parts.push(entry.text);
        if (streams.length === 0) parts.push("(empty stdout/stderr)");
        if (debugDump.result.ioDiagnostics) {
          const summary = formatArchiveIoDiagnosticsForDebug(
            debugDump.result.ioDiagnostics,
          );
          if (summary) parts.push(summary);
        }
      }
      if (debugDump.extra) parts.push(debugDump.extra);
      if (debugDump.rawDetail && debugDump.rawDetail !== detail) {
        parts.push(`raw: ${debugDump.rawDetail}`);
      }
      text = redactSensitiveText(parts.join("\n"));
      detailEl.classList.add("extract-error-detail--debug");
    } else {
      detailEl.classList.remove("extract-error-detail--debug");
    }
    detailEl.textContent = text;
    if (copyErrorBtn) copyErrorBtn.hidden = false;
    finish("Failed", 100, true, false);
  };

  cancelBtn.addEventListener("click", async () => {
    if (operationFinished) return;
    // Record abort intent even when 7z is idle (password-prompt gap).
    cancelRequested = true;
    extractAbort.abort();
    cancelBtn.disabled = true;
    openDestinationBtn.disabled = true;
    closeBtn.disabled = true;
    $("extract-status").textContent = "Cancelling...";
    try {
      await invoke<boolean>("cancel_7z");
    } catch (err) {
      // All three buttons were disabled above before the cancel request. A
      // failed cancel means extraction is still running, so re-opening the
      // (not-yet-final) destination still doesn't make sense, but leaving
      // Cancel/`closeBtn` disabled stranded the window with only the titlebar
      // close as an escape hatch. Re-enable cancel (to retry) and close.
      cancelBtn.disabled = false;
      closeBtn.disabled = false;
      const detail = err instanceof Error ? err.message : String(err);
      $("extract-error").hidden = false;
      const title = $("extract-error").querySelector<HTMLElement>(
        ".extract-error-title",
      );
      if (title) title.textContent = "Could not cancel safely";
      $("error-detail").textContent = detail;
      $("extract-status").textContent =
        "Cancel requested; waiting for the current phase to stop";
    }
  });

  closeBtn.addEventListener("click", async () => {
    await closeWindowSafely();
  });

  openDestinationBtn.addEventListener("click", async () => {
    if (!destination) return;
    openDestinationBtn.disabled = true;
    try {
      await invoke("register_extract_open_path", { path: destination });
      await invoke("open_path", { path: destination });
      $("extract-status").textContent = "Destination opened.";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      $("extract-error").hidden = false;
      const titleEl = $("extract-error").querySelector<HTMLElement>(
        ".extract-error-title",
      );
      if (titleEl) titleEl.textContent = "Could not open destination";
      $("error-detail").textContent = detail;
      $("extract-status").textContent = "Done (open destination failed)";
    } finally {
      openDestinationBtn.disabled = false;
    }
  });

  setButtons(true, false, false);

  const injected = readInjectedExtractSession();
  // Drain the backend queue even when the session was injected at window create.
  const claimPaths = invoke<string[]>("get_extract_paths");

  let archivePath = injected?.archive ?? "";
  const derivedDestination = archivePath
    ? deriveExtractDestinationPath(archivePath)
    : "";
  destination =
    injected?.destination ??
    (derivedDestination.length > 0
      ? derivedDestination
      : archivePath
        ? parentDir(archivePath)
        : "");

  if (injected) {
    $("archive-name").textContent = basename(archivePath);
    $("archive-name").title = archivePath;
    $("extract-dest").textContent = destination;
    $("extract-dest").title = destination;
    $("extract-status").textContent = "Starting extraction...";
    $("extract-error").hidden = true;
    try {
      await claimPaths;
    } catch (err) {
      console.warn(
        `Could not drain quick-extract launch queue: ${String(err)}`,
      );
    }
  } else {
    const paths = await claimPaths;
    archivePath = paths[0] ?? "";
    if (!archivePath) {
      $("extract-status").textContent = "No archive specified.";
      stopProgressAt(0, false);
      setButtons(false, false, true);
      operationFinished = true;
      return;
    }
    destination =
      deriveExtractDestinationPath(archivePath) || parentDir(archivePath);
    $("archive-name").textContent = basename(archivePath);
    $("archive-name").title = archivePath;
    $("extract-dest").textContent = destination;
    $("extract-dest").title = destination;
    $("extract-status").textContent = "Starting extraction...";
    $("extract-error").hidden = true;
  }

  if (!archivePath) {
    $("extract-status").textContent = "No archive specified.";
    stopProgressAt(0, false);
    setButtons(false, false, true);
    operationFinished = true;
    return;
  }

  try {
    const proceed = await confirmExtractDestination(destination);
    if (!proceed || cancelRequested) {
      finish("Cancelled", 0, false, false, true);
      return;
    }
    $("extract-status").textContent = "Starting extraction...";
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    showError(userFacingBackendError(raw), { rawDetail: raw });
    return;
  }

  startIndeterminateProgress();
  if (cancelRequested) {
    finish("Cancelled", 100, false, false, true);
    return;
  }

  let expectedArchiveIdentity: string | undefined;
  try {
    const [validation] = await validateArchivePaths([archivePath], true);
    if (!validation?.valid) {
      const reason = validation?.reason?.trim() ?? "";
      if (reason) {
        showError(reason);
      } else {
        showError("This archive path is not supported for extraction.");
      }
      return;
    }
    expectedArchiveIdentity = validation.identity;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const facing = userFacingBackendError(raw);
    showError(
      facing === raw ? `Could not validate the archive: ${facing}` : facing,
      { rawDetail: raw },
    );
    return;
  }
  if (cancelRequested) {
    finish("Cancelled", 100, false, false, true);
    return;
  }

  let sawStructuredPercent = false;

  const startedAt = Date.now();
  let lastFile = "";

  const registerProgressListener = <T>(registration: Promise<T>) =>
    registration.catch((err) => {
      console.warn(
        `Could not register extraction progress listener: ${String(err)}`,
      );
      return null;
    });
  const structuredListen = registerProgressListener(
    listenToOwnWindow<ProgressUpdate>("7z-progress-structured", (event) => {
      if (!isExtractRunInFlight()) return;
      const update = event.payload;
      if (update?.currentFile === "Working…") {
        // Heartbeats fill blank status only; keep file name / ETA lines.
        if (!sawStructuredPercent && !lastFile) {
          $("extract-status").textContent = "Still working…";
        }
        return;
      }
      if (update?.currentFile === "Finalizing…") {
        sawStructuredPercent = true;
        cancelBtn.disabled = true;
        setDeterminateProgress(100);
        $("extract-status").textContent = "Finalizing…";
        return;
      }
      let eta = "";
      if (
        typeof update?.percent === "number" &&
        Number.isFinite(update.percent)
      ) {
        sawStructuredPercent = true;
        const progressBar = document.getElementById("extract-progress");
        if (progressBar) progressBar.dataset.sawStructuredPercent = "true";
        setDeterminateProgress(Math.min(99, update.percent));
        eta = formatSharedEta(Date.now() - startedAt, update.percent);
      }
      if (update?.currentFile) {
        const clean = sanitizeStatusFileName(basename(update.currentFile));
        if (clean) lastFile = clean;
      }
      const label = lastFile ? `Extracting ${lastFile}...` : "Extracting...";
      $("extract-status").textContent = eta ? `${label}  ${eta}` : label;
    }),
  );
  const rawListen = registerProgressListener(
    listenToOwnWindow<string>("7z-progress", (event) => {
      if (!isExtractRunInFlight() || sawStructuredPercent) return;
      const chunk = typeof event.payload === "string" ? event.payload : "";
      for (const line of chunk.split(/[\r\n]+/)) {
        const match = line.trim().match(/^-\s+(.+)/);
        if (match?.[1]) {
          const clean = sanitizeStatusFileName(basename(match[1]));
          if (!clean) continue;
          lastFile = clean;
          $("extract-status").textContent = `Extracting ${clean}...`;
        }
      }
    }),
  );

  // Listener registration is asynchronous in real Tauri webviews. Starting
  // 7-Zip first can lose every percentage event from a fast extraction.
  const [unlistenStructured, unlistenRaw] = await Promise.all([
    structuredListen,
    rawListen,
  ]);

  async function removeProgressListeners() {
    for (const unlisten of [unlistenStructured, unlistenRaw]) {
      try {
        unlisten?.();
      } catch (err) {
        console.warn(
          `Could not remove extraction progress listener: ${String(err)}`,
        );
      }
    }
  }

  if (cancelRequested) {
    await removeProgressListeners();
    finish("Cancelled", 0, false, false, true);
    return;
  }

  $("extract-status").textContent = "Extracting...";

  const args = [
    "x",
    `-o${destination}`,
    SAFE_EXTRACT_OVERWRITE_MODE,
    "-bb1",
    "-bsp1",
    "--",
    archivePath,
  ];

  try {
    const result = await runWithPasswordRetry(
      args,
      () => cancelRequested,
      expectedArchiveIdentity,
      extractAbort.signal,
      debugMode,
    );
    await removeProgressListeners();

    if (cancelRequested && result.code !== 0) {
      finish("Cancelled", 100, false, false, true);
      return;
    }

    if (result.code !== 0) {
      const hint = describe7zError(result.stdout ?? "", result.stderr ?? "");
      const userMessage =
        result.code === 1
          ? "7-Zip stopped with warnings (exit code 1). Extraction was not completed."
          : hint ||
            `Extraction failed (exit code ${result.code}). Check the application log for details.`;
      showError(userMessage, { args, result });
      return;
    }

    finish(result.warning_code ? "Done (warnings)" : "Done", 100);
  } catch (err) {
    await removeProgressListeners();
    if (cancelRequested) {
      finish("Cancelled", 100, false, false, true);
      return;
    }
    const raw = err instanceof Error ? err.message : String(err);
    if (cancelRequested || raw === EXTRACT_PASSWORD_PROMPT_CANCELLED) {
      finish("Cancelled", 100, false, false, true);
      return;
    }
    showError(userFacingBackendError(raw), {
      args,
      rawDetail: raw,
    });
  }
}
