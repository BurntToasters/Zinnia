import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { validateArchivePaths } from "./archive-rules";
import { deriveExtractDestinationPath } from "./extract-path";
import { describe7zError, looksLikePasswordRequiredError } from "./error-hints";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "./extract-policy";
import { installWdioGuestPluginIfEnabled } from "./e2e-wdio-plugin";
import {
  setProgressIndeterminateClass,
  setProgressPercentClass,
} from "./progress-bar";
import { normalizeAutoCloseDelay } from "./settings-model";
import { withPassword } from "./password-args";
import { basename } from "./path-display";
import {
  formatEta as formatSharedEta,
  type ProgressUpdate,
} from "./progress-update";
import { redactSensitiveText } from "./utils";
import { sanitizeCommandArgsForPreview } from "./archive/command-sanitize";
import { formatCommandOutputForLogs } from "./output-logging";
import {
  installNativeWebviewContextMenuGuard,
  setNativeWebviewContextMenuAllowed,
} from "./webview-context-menu";

export { formatEta } from "./progress-update";

interface Run7zResult {
  stdout: string;
  stderr: string;
  code: number;
  warning_code?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

interface InjectedExtractSession {
  archive: string;
  destination: string;
}

declare global {
  interface Window {
    __ZINNIA_EXTRACT__?: InjectedExtractSession;
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

/** Strip noisy progress junk so status never flashes missing-glyph boxes. */
export function sanitizeStatusFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F-\u009F\uFEFF\uFFFD]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064]/g, "")
    .trim();
  if (!cleaned) return "";
  const withoutProgressJunk = cleaned
    .replace(/^[\s\u2500-\u259F]+(?:-\s*)?/u, "")
    .trim();
  // Start at the first filename-like character. Include `(` / `[` / `{` so
  // names like `(report).txt` keep their parentheses, while still dropping
  // leading `***` / similar symbol runs from 7-Zip progress lines.
  const match = withoutProgressJunk.match(/[\p{L}\p{N}._~(\[{]/u);
  if (match?.index === undefined) return "";
  return [...withoutProgressJunk]
    .slice(match.index, match.index + 200)
    .join("");
}

function readInjectedExtractSession(): InjectedExtractSession | null {
  const injected = window.__ZINNIA_EXTRACT__;
  if (
    !injected ||
    typeof injected.archive !== "string" ||
    !injected.archive ||
    typeof injected.destination !== "string" ||
    !injected.destination
  ) {
    return null;
  }
  return injected;
}

/** True only while this window's `run_7z` invoke is in flight. */
let extractRunInFlight = false;

async function invokeExtractRun(
  args: Record<string, unknown>,
): Promise<Run7zResult> {
  extractRunInFlight = true;
  try {
    return await invoke<Run7zResult>("run_7z", args);
  } finally {
    extractRunInFlight = false;
  }
}

async function runWithPasswordRetry(
  args: string[],
  shouldAbort: () => boolean,
  expectedArchiveIdentity?: string,
): Promise<Run7zResult> {
  const invokeArgs = {
    args,
    ...(expectedArchiveIdentity ? { expectedArchiveIdentity } : {}),
  };
  let result: Run7zResult;
  try {
    result = await invokeExtractRun(invokeArgs);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Header encryption can make backend safety listing request a password
    // before extraction returns a normal Run7zResult.
    if (!looksLikePasswordRequiredError("", detail)) throw error;
    result = { stdout: "", stderr: detail, code: 255 };
  }
  if (shouldAbort()) {
    return result;
  }
  if (
    result.code > 1 &&
    looksLikePasswordRequiredError(result.stdout ?? "", result.stderr ?? "")
  ) {
    if (shouldAbort()) {
      return result;
    }
    const cancelBtn = document.getElementById(
      "cancel-btn",
    ) as HTMLButtonElement | null;
    if (cancelBtn) cancelBtn.disabled = false;
    const { promptInput } = await import("./prompt-modal");
    const password = await promptInput({
      title: "Password required",
      label: "This archive is encrypted. Enter password:",
      password: true,
      confirmLabel: "Extract",
    });
    if (shouldAbort()) {
      return result;
    }
    if (password) {
      result = await invokeExtractRun({
        args: withPassword(args, password),
        ...(expectedArchiveIdentity ? { expectedArchiveIdentity } : {}),
      });
    }
  }
  return result;
}

function parentDir(filePath: string): string {
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (sep < 0) return ".";
  if (sep === 0) return "/";
  const parent = filePath.slice(0, sep);
  // Windows drive root: "C:" → "C:\\"
  if (parent.length === 2 && parent[1] === ":") return parent + "\\";
  return parent;
}

function setButtons(
  showCancel: boolean,
  showOpenDestination: boolean,
  showClose: boolean,
): void {
  $("cancel-btn").hidden = !showCancel;
  $("open-destination-btn").hidden = !showOpenDestination;
  $("close-btn").hidden = !showClose;
}

function stopProgressAt(widthPercent: number, error: boolean): void {
  const fill = $("progress-fill");
  fill.classList.toggle("extract-progress-fill--error", error);
  setProgressPercentClass(fill, widthPercent);
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(widthPercent));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.removeAttribute("aria-busy");
  }
}

function startIndeterminateProgress(): void {
  const fill = $("progress-fill");
  fill.classList.remove("extract-progress-fill--error");
  setProgressIndeterminateClass(fill);
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-busy", "true");
    bar.setAttribute("aria-valuenow", "0");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
  }
}

function setDeterminateProgress(widthPercent: number): void {
  const clamped = Math.max(0, Math.min(100, widthPercent));
  const fill = $("progress-fill");
  fill.classList.remove("extract-progress-fill--error");
  setProgressPercentClass(fill, clamped);
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(clamped));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.removeAttribute("aria-busy");
  }
}

async function closeWindowSafely(): Promise<void> {
  try {
    await invoke("close_extract_window");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const errorBox = document.getElementById("extract-error");
    if (errorBox) errorBox.hidden = false;
    const title = errorBox?.querySelector<HTMLElement>(".extract-error-title");
    if (title) title.textContent = "Could not close safely";
    const detailBox = document.getElementById("error-detail");
    if (detailBox) detailBox.textContent = detail;
    const status = document.getElementById("extract-status");
    if (status) status.textContent = "Waiting for cleanup";
  }
}

/** Match main-window Basic glass when the user has effects enabled. */
async function syncExtractWindowFx(): Promise<void> {
  let supports = false;
  try {
    supports = await invoke<boolean>("supports_workspace_window_fx");
  } catch {
    supports = false;
  }

  let effectsEnabled = true;
  let themePref = "system";
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw) as {
      basicWindowEffects?: unknown;
      theme?: unknown;
    };
    if (typeof parsed.basicWindowEffects === "boolean") {
      effectsEnabled = parsed.basicWindowEffects;
    }
    if (typeof parsed.theme === "string") {
      themePref = parsed.theme;
    }
  } catch {
    // Defaults match SETTING_DEFAULTS (effects on, system theme).
  }

  const dark =
    themePref === "dark" ||
    (themePref !== "light" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

  const enabled = supports && effectsEnabled;
  document.documentElement.dataset.windowFx = enabled ? "basic" : "opaque";
  try {
    await invoke("set_workspace_window_fx", { enabled, dark });
  } catch {
    // CSS still paints correctly if native vibrancy is unavailable.
  }
}

async function run() {
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

  if (closeTitlebarBtn) {
    closeTitlebarBtn.addEventListener("click", () => {
      // Arm local abort before teardown so an in-flight password prompt cannot
      // start another run_7z after the window is dismissed.
      cancelRequested = true;
      void closeWindowSafely();
    });
  }
  let operationFinished = false;
  let destination = "";

  let autoCloseDelay = 1.5;
  let debugMode = false;
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw) as {
      extractAutoCloseSeconds?: unknown;
      debug?: unknown;
    };
    autoCloseDelay = normalizeAutoCloseDelay(
      parsed.extractAutoCloseSeconds,
      1.5,
    );
    debugMode = parsed.debug === true;
  } catch {
    autoCloseDelay = -1;
    debugMode = false;
  }
  setNativeWebviewContextMenuAllowed(debugMode);

  let autoCloseInterval: ReturnType<typeof setInterval> | null = null;
  const autoCloseAbortEvents = ["mousemove", "keydown", "click"] as const;
  let autoCloseAbortListener: (() => void) | null = null;

  const removeAutoCloseAbortListeners = () => {
    if (!autoCloseAbortListener) return;
    for (const eventName of autoCloseAbortEvents) {
      window.removeEventListener(eventName, autoCloseAbortListener);
    }
    autoCloseAbortListener = null;
  };

  const abortAutoClose = () => {
    removeAutoCloseAbortListeners();
    if (autoCloseInterval !== null) {
      clearInterval(autoCloseInterval);
      autoCloseInterval = null;
      closeBtn.textContent = "Close";
    }
  };

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

      let remaining = autoCloseDelay;
      closeBtn.textContent = `Close (${Math.ceil(remaining)}s)`;

      autoCloseAbortListener = () => abortAutoClose();
      for (const eventName of autoCloseAbortEvents) {
        window.addEventListener(eventName, autoCloseAbortListener, {
          once: true,
        });
      }

      autoCloseInterval = setInterval(() => {
        remaining -= 0.1;
        if (remaining <= 0) {
          abortAutoClose();
          void closeWindowSafely();
        } else {
          closeBtn.textContent = `Close (${Math.ceil(remaining)}s)`;
        }
      }, 100);
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
    debugDump?: { args?: string[]; result?: Run7zResult; extra?: string },
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
      }
      if (debugDump.extra) parts.push(debugDump.extra);
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

  startIndeterminateProgress();
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
    // Claim is only needed to drain queue ownership; do not block extract start.
    void claimPaths.catch((err) => {
      console.warn(
        `Could not drain quick-extract launch queue: ${String(err)}`,
      );
    });
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
    await invoke<string>("probe_7z");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    showError(`Could not prepare 7-Zip: ${detail}`);
    return;
  }
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
    const detail = err instanceof Error ? err.message : String(err);
    showError(`Could not validate the archive: ${detail}`);
    return;
  }
  if (cancelRequested) {
    finish("Cancelled", 100, false, false, true);
    return;
  }

  let sawStructuredPercent = false;

  const startedAt = Date.now();
  let lastFile = "";

  // Register progress listeners without awaiting confirmation before run_7z;
  // backend prepare time usually dwarfs listener registration.
  const registerProgressListener = <T>(registration: Promise<T>) =>
    registration.catch((err) => {
      console.warn(
        `Could not register extraction progress listener: ${String(err)}`,
      );
      return null;
    });
  const structuredListen = registerProgressListener(
    listen<ProgressUpdate>("7z-progress-structured", (event) => {
      if (!extractRunInFlight) return;
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
      if (typeof update?.percent === "number") {
        sawStructuredPercent = true;
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
    listen<string>("7z-progress", (event) => {
      if (!extractRunInFlight || sawStructuredPercent) return;
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

  async function removeProgressListeners() {
    const [unlistenStructured, unlistenRaw] = await Promise.all([
      structuredListen,
      rawListen,
    ]);
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
    );
    await removeProgressListeners();

    if (cancelRequested && result.code !== 0) {
      finish("Cancelled", 100, false, false, true);
      return;
    }

    if (result.code !== 0) {
      const hint = describe7zError(result.stdout ?? "", result.stderr ?? "");
      const base =
        result.code === 1
          ? `7-Zip stopped with warnings (exit code 1). Extraction was not completed.\n\n${result.stderr?.trim() || "Check the application log for warning details."}`
          : result.stderr?.trim() || `Exit code ${result.code}`;
      showError(hint ? `${hint}\n\n${base}` : base, { args, result });
      return;
    }

    finish(result.warning_code ? "Done (warnings)" : "Done", 100);
  } catch (err) {
    await removeProgressListeners();
    if (cancelRequested) {
      finish("Cancelled", 100, false, false, true);
      return;
    }
    const messageText = err instanceof Error ? err.message : String(err);
    showError(messageText, {
      args,
      extra: `throw: ${messageText}`,
    });
  }
}

run().catch((err) => {
  document.body.textContent = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
});
