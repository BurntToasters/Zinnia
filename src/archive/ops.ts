import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { $, parseThreads, splitArgs } from "../utils";
import { SETTING_DEFAULTS, state, cacheBrowseInfo } from "../state";
import {
  log,
  devLog,
  setStatus,
  setProgress,
  hideProgress,
  setRunning,
  getMode,
  getWorkspaceMode,
  setBrowsePasswordFieldVisible,
} from "../ui";
import { ensureArchivePaths, validateExtraArgs } from "../archive-rules";
import { formatCommandOutputForLogs } from "../output-logging";
import { normalizeCompressionSecurityOptions } from "../compression-security";
import type { ArchiveInfo } from "../browse-model";
import {
  looksLikePasswordRequiredError,
  describe7zError,
} from "../error-hints";
import { showToast } from "../toast";
import { promptInput } from "../prompt-modal";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import {
  buildArgs,
  buildExtractArgsFor,
  buildCompressionMethodSwitches,
  readSplitSize,
  withPassword,
} from "./args";
import { parseArchiveListing } from "./listing";
import { sanitizeCommandArgsForPreview } from "./preview";

export function truncateForDialog(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
}

export function logCommandResult(stdout: string, stderr: string) {
  const entries = formatCommandOutputForLogs(
    stdout,
    stderr,
    state.currentSettings.logVerbosity,
  );
  for (const entry of entries) {
    log(entry.text, entry.level === "error" ? "error" : "info");
  }
}

export interface Run7zResult {
  stdout: string;
  stderr: string;
  code: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

interface ProgressUpdate {
  percent?: number;
  filesDone?: number;
  currentFile?: string;
}

function basename(filePath: string): string {
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return sep >= 0 ? filePath.slice(sep + 1) : filePath;
}

// Estimate remaining time for the current archive from elapsed time and percent.
export function formatBatchEta(elapsedMs: number, percent: number): string {
  if (percent <= 0 || percent >= 100 || elapsedMs <= 0) return "";
  const totalMs = elapsedMs / (percent / 100);
  const remainingSec = Math.max(0, Math.round((totalMs - elapsedMs) / 1000));
  if (remainingSec < 1) return "";
  if (remainingSec < 60) return `~${remainingSec}s left`;
  const min = Math.floor(remainingSec / 60);
  const sec = remainingSec % 60;
  return `~${min}m ${sec.toString().padStart(2, "0")}s left`;
}

export type ArchiveTestResult =
  "passed" | "passed_with_warnings" | "failed" | "cancelled" | "error";

const OUTPUT_TRUNCATION_LIMIT_MIB = 10;
const RUNTIME_PROBE_TIMEOUT_MS = 7000;
let runtimeProbePromise: Promise<string> | null = null;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: number | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function logTruncationNotice(result: Run7zResult) {
  if (!result.stdout_truncated && !result.stderr_truncated) return;

  const streams: string[] = [];
  if (result.stdout_truncated) streams.push("stdout");
  if (result.stderr_truncated) streams.push("stderr");
  log(
    `7z ${streams.join(" and ")} output exceeded ${OUTPUT_TRUNCATION_LIMIT_MIB} MiB and was truncated.`,
    "error",
  );
}

export async function ensureRuntimeReady(): Promise<boolean> {
  try {
    runtimeProbePromise ??= withTimeout(
      invoke<string>("probe_7z"),
      RUNTIME_PROBE_TIMEOUT_MS,
      `7-Zip runtime probe timed out after ${RUNTIME_PROBE_TIMEOUT_MS / 1000} seconds.`,
    );
    await runtimeProbePromise;
    return true;
  } catch (err) {
    runtimeProbePromise = null;
    const msg = err instanceof Error ? err.message : String(err);
    log(`7-Zip runtime check failed: ${msg}`, "error");
    setStatus("Missing runtime dependency", 3000);
    hideProgress();
    await message(`The bundled 7-Zip runtime check failed.\n\n${msg}`, {
      title: "Missing runtime dependency",
      kind: "error",
    });
    return false;
  }
}

// Attach a live progress listener for the duration of `fn`, updating the status
// bar with percent + current file + ETA. Returns whatever `fn` resolves to.
export async function withLiveProgress<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const unlisten = await listen<ProgressUpdate>(
    "7z-progress-structured",
    (event) => {
      const u = event.payload;
      if (typeof u?.percent !== "number") return;
      if (u.currentFile === "Finalizing…") {
        setProgress("Finalizing…");
        return;
      }
      const eta = formatBatchEta(Date.now() - startedAt, u.percent);
      const file = u.currentFile ? ` ${basename(u.currentFile)}` : "";
      setProgress(`${u.percent}%${file}${eta ? ` · ${eta}` : ""}`);
    },
  );
  try {
    return await fn();
  } finally {
    if (typeof unlisten === "function") unlisten();
  }
}

// Run 7z; if an extract fails because the archive is encrypted, prompt once for
// a password and retry. Returns the final result.
export async function runWithPasswordRetry(
  args: string[],
  isExtract: boolean,
): Promise<Run7zResult> {
  let result = await invoke<Run7zResult>("run_7z", { args });
  if (
    isExtract &&
    result.code > 1 &&
    looksLikePasswordRequiredError(result.stdout, result.stderr)
  ) {
    const password = await promptInput({
      title: "Password required",
      label: "This archive is encrypted. Enter password:",
      password: true,
      confirmLabel: "Extract",
    });
    if (password) {
      setStatus("Retrying with password");
      result = await invoke<Run7zResult>("run_7z", {
        args: withPassword(args, password),
      });
    }
  }
  return result;
}

// Add user-picked files into the currently browsed archive via the 7z update
// command. Surfaces errors with hints and a success toast.
export async function addFilesToArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0]?.trim();
  if (!archive) {
    await message("Open an archive first to add files to it.", {
      title: "No archive",
      kind: "warning",
    });
    return;
  }

  const selection = await open({ multiple: true, directory: false });
  const files = Array.isArray(selection)
    ? selection
    : selection
      ? [selection]
      : [];
  if (files.length === 0) return;

  setRunning(true);
  try {
    if (!(await ensureRuntimeReady())) return;
    const threads = parseThreads(
      $<HTMLInputElement>("threads").value,
      SETTING_DEFAULTS.threads,
    );
    const args = ["u", "-sse"];
    if (threads) args.push(`-mmt=${threads}`);
    args.push(archive, "--", ...files);

    setStatus("Adding files");
    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
    const result = await invoke<Run7zResult>("run_7z", { args });
    logCommandResult(result.stdout, result.stderr);

    if (result.code !== 0) {
      setStatus("Error", 3000, result.stderr || "Operation failed.");
      await showOperationError(result.code, result.stdout, result.stderr);
    } else {
      setStatus("Done", 2000);
      showToast(
        `Added ${files.length} file${files.length === 1 ? "" : "s"} to the archive.`,
        "success",
      );
      void browseArchive();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`, "error");
    setStatus("Error", 3000, msg);
    await message(msg, { title: "Error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

// Convert the browsed archive to another format: extract to a managed temp dir,
// recompress its contents with the current compression options, then clean up.
export async function convertArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0]?.trim();
  if (!archive) {
    await message("Open an archive first to convert it.", {
      title: "No archive",
      kind: "warning",
    });
    return;
  }

  const format = $<HTMLSelectElement>("format").value;
  const dest = await save({
    title: "Convert archive to",
    defaultPath: `converted.${format === "gzip" ? "gz" : format}`,
  });
  if (!dest) return;

  setRunning(true);
  let tempDir: string | null = null;
  try {
    if (!(await ensureRuntimeReady())) return;

    tempDir = await invoke<string>("create_temp_extract_dir");

    // Use the browse/extract password field for encrypted archives.
    const browsePassword = $<HTMLInputElement>("browse-password").value.trim();
    const extractPassword =
      $<HTMLInputElement>("extract-password").value.trim();
    const password = extractPassword || browsePassword;

    setStatus("Extracting for conversion");
    const extractArgs = ["x", `-o${tempDir}`, SAFE_EXTRACT_OVERWRITE_MODE];
    if (password) extractArgs.push(`-p${password}`);
    extractArgs.push("--", archive);
    const extract = await runWithPasswordRetry(extractArgs, true);
    if (extract.code !== 0) {
      setStatus("Error", 3000, extract.stderr || "Extraction failed.");
      await showOperationError(extract.code, extract.stdout, extract.stderr);
      return;
    }

    setStatus("Recompressing");
    // Honor the full compression options (level/method/dict/solid/threads),
    // plus password/encrypt-headers/sfx/split/timestamps from the form.
    const compress = ["a", "-sse", ...buildCompressionMethodSwitches(format)];

    // Carry security options from the compression form
    const rawPassword = $<HTMLInputElement>("password").value;
    const rawEncryptHeaders = $<HTMLInputElement>("encrypt-headers").checked;
    const { password: compressPassword, encryptHeaders } =
      normalizeCompressionSecurityOptions(
        format,
        rawPassword,
        rawEncryptHeaders,
      );
    if (compressPassword) compress.push(`-p${compressPassword}`);
    if (compressPassword && format === "zip") compress.push("-mem=AES256");
    if (encryptHeaders) compress.push("-mhe=on");

    // Carry additional options
    const storeTimestamps = $<HTMLInputElement>("store-timestamps").checked;
    if (storeTimestamps) compress.push("-mtc=on", "-mta=on");

    const splitSize = readSplitSize();
    if (splitSize) compress.push(`-v${splitSize}`);

    // Compress the extracted contents (everything inside the temp dir).
    compress.push(dest, "--", `${tempDir}/*`);

    const result = await invoke<Run7zResult>("run_7z", { args: compress });
    logCommandResult(result.stdout, result.stderr);
    if (result.code !== 0) {
      setStatus("Error", 3000, result.stderr || "Conversion failed.");
      await showOperationError(result.code, result.stdout, result.stderr);
    } else {
      setStatus("Done", 2000);
      showToast(`Converted archive to ${format.toUpperCase()}.`, "success");
      clearPasswordFields();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`, "error");
    setStatus("Error", 3000, msg);
    await message(msg, { title: "Conversion error", kind: "error" });
  } finally {
    if (tempDir) {
      try {
        await invoke("remove_managed_temp_dir", { path: tempDir });
      } catch (err) {
        devLog(
          `Failed to clean up temp dir: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    clearPasswordFields();
    setRunning(false);
  }
}

export async function showOperationError(
  code: number,
  stdout: string,
  stderr: string,
): Promise<void> {
  // Basic mode already surfaces failures in the in-app completion panel.
  if (getWorkspaceMode() === "basic") return;
  const hint = describe7zError(stdout, stderr);
  const detail = stderr.trim() ? `\n\n${truncateForDialog(stderr.trim())}` : "";
  const hintLine = hint ? `\n\n${hint}` : "";
  await message(
    `Operation failed with exit code ${code}.${hintLine}${detail}`,
    { title: "Operation failed", kind: "error" },
  );
}

export async function runAction() {
  if (state.running) return;

  const mode = getMode();

  if (mode === "extract" && state.inputs.length > 1) {
    return runBatchExtract();
  }

  setRunning(true);
  try {
    if (!(await ensureRuntimeReady())) return;

    state.batchCancelled = false;
    state.cancelRequested = false;

    let args: string[];
    if (mode === "extract") {
      if (!state.inputs[0]) throw new Error("Select an archive to extract.");
      await ensureArchivePaths([state.inputs[0]], "extract");
      args = buildExtractArgsFor(state.inputs[0]);
    } else {
      args = buildArgs();
    }

    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);

    setStatus("Running");

    const result = await withLiveProgress(() =>
      runWithPasswordRetry(args, mode === "extract"),
    );
    if (state.cancelRequested) {
      hideProgress();
      setStatus("Cancelled", 2000);
      log("Operation cancelled by user");
      return;
    }

    logCommandResult(result.stdout, result.stderr);
    logTruncationNotice(result);
    devLog(`Exit code: ${result.code}`);

    if (result.code !== 0) {
      log(`7z exited with code ${result.code}`);
      setStatus("Error", 3000, result.stderr || "Operation failed.");
      hideProgress();
      await showOperationError(result.code, result.stdout, result.stderr);
    } else {
      setStatus("Done", 2000);
      hideProgress();
      showToast(
        mode === "extract" ? "Extraction complete." : "Archive created.",
        "success",
      );
      // Clear every mirrored password field after a successful operation.
      clearPasswordFields();
    }
  } catch (err) {
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      hideProgress();
      log("Operation cancelled by user");
      return;
    }

    const messageText = err instanceof Error ? err.message : String(err);
    log(`Error: ${messageText}`);
    setStatus("Error", 3000, messageText);
    hideProgress();
    // Basic mode already shows the in-app completion panel for failures.
    if (getWorkspaceMode() !== "basic") {
      await message(messageText, { title: "Error", kind: "error" });
    }
  } finally {
    clearPasswordFields();
    setRunning(false);
  }
}

export async function runBatchExtract() {
  if (state.running) return;
  setRunning(true);
  let unlistenProgress: (() => void) | null = null;
  try {
    if (!(await ensureRuntimeReady())) return;

    state.batchCancelled = false;
    state.cancelRequested = false;
    const archives = [...state.inputs];
    await ensureArchivePaths(archives, "extract");

    const dest = $<HTMLInputElement>("extract-path").value.trim();
    if (!dest) throw new Error("Choose a destination folder.");
    const password = $<HTMLInputElement>("extract-password").value.trim();
    const extraArgs = splitArgs(
      $<HTMLInputElement>("extract-extra-args").value.trim(),
    );
    if (extraArgs.length > 0) validateExtraArgs(extraArgs);

    let succeeded = 0;
    let failed = 0;
    let current = 0;
    let archiveStartedAt = Date.now();

    // Live progress for the whole batch: show percent of the current archive,
    // which file it's on, and an ETA, alongside the N-of-M counter.
    unlistenProgress = await listen<ProgressUpdate>(
      "7z-progress-structured",
      (event) => {
        const u = event.payload;
        const counter = `(${current}/${archives.length})`;
        if (typeof u?.percent === "number") {
          const eta = formatBatchEta(Date.now() - archiveStartedAt, u.percent);
          const file = u.currentFile ? ` ${basename(u.currentFile)}` : "";
          setProgress(
            `${u.percent}% ${counter}${file}${eta ? ` · ${eta}` : ""}`,
          );
        }
      },
    );

    for (let i = 0; i < archives.length; i++) {
      if (state.batchCancelled || state.cancelRequested) break;

      const archive = archives[i];
      current = i + 1;
      archiveStartedAt = Date.now();
      setStatus(`Extracting ${i + 1} of ${archives.length}`);

      try {
        const args = ["x", `-o${dest}`, SAFE_EXTRACT_OVERWRITE_MODE, "-bb1"];
        if (password) args.push(`-p${password}`);
        args.push(...extraArgs);
        args.push("--", archive);
        devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);

        const result = await runWithPasswordRetry(args, true);

        logCommandResult(result.stdout, result.stderr);
        logTruncationNotice(result);

        if (result.code === 0) {
          succeeded++;
        } else {
          failed++;
          log(`Failed: ${archive} (exit code ${result.code})`);
        }
      } catch (err) {
        if (state.batchCancelled || state.cancelRequested) break;
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error extracting ${archive}: ${msg}`);
      }
    }

    hideProgress();
    const basic = getWorkspaceMode() === "basic";
    if (state.batchCancelled || state.cancelRequested) {
      setStatus("Cancelled", 3000);
      if (!basic) {
        await message("Batch extraction was cancelled.", {
          title: "Cancelled",
        });
      }
    } else if (failed === 0) {
      setStatus("Done", 3000);
      if (!basic) {
        await message(
          `Successfully extracted ${succeeded} archive${succeeded !== 1 ? "s" : ""}.`,
          { title: "Batch extraction complete" },
        );
      }
    } else {
      setStatus("Error", 4000, `${succeeded} succeeded, ${failed} failed.`);
      if (!basic) {
        await message(`${succeeded} succeeded, ${failed} failed.`, {
          title: "Batch extraction complete",
          kind: "warning",
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`);
    setStatus("Error", 3000, msg);
    hideProgress();
    if (getWorkspaceMode() !== "basic") {
      await message(msg, { title: "Extraction error", kind: "error" });
    }
  } finally {
    if (unlistenProgress) unlistenProgress();
    clearPasswordFields();
    setRunning(false);
  }
}

export async function cancelAction() {
  if (!state.running) return;
  state.batchCancelled = true;
  state.cancelRequested = true;
  setStatus("Cancelling...");
  try {
    await invoke("cancel_7z");
    devLog("Cancel signal sent to running process.");
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    state.batchCancelled = false;
    state.cancelRequested = false;
    log(`Cancel failed: ${messageText}`, "error");
    setStatus("Cancel failed", 3000, messageText);
    await message(`Could not cancel the archive operation.\n\n${messageText}`, {
      title: "Cancel failed",
      kind: "error",
    });
  }
}

export function clearPasswordFields(): void {
  for (const id of [
    "password",
    "extract-password",
    "browse-password",
    "basic-password",
    "basic-extract-password",
  ]) {
    const field = document.getElementById(id) as HTMLInputElement | null;
    if (field) field.value = "";
  }
}

export async function testArchive(): Promise<ArchiveTestResult> {
  if (state.running) return "cancelled";
  setRunning(true);
  try {
    const archive = state.inputs[0];
    if (!archive) {
      await message("Select an archive to test.", {
        title: "No archive selected",
      });
      return "failed";
    }
    try {
      await ensureArchivePaths([archive], "test");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message(msg, { title: "Invalid input", kind: "error" });
      return "failed";
    }

    const mode = getMode();
    const passwordField =
      mode === "browse" ? "browse-password" : "extract-password";
    const password = $<HTMLInputElement>(passwordField).value.trim();

    const args = ["t"];
    if (password) args.push(`-p${password}`);
    args.push("--", archive);

    if (!(await ensureRuntimeReady())) return "error";

    setStatus("Testing archive integrity");

    const result = await invoke<Run7zResult>("run_7z", { args });

    logCommandResult(result.stdout, result.stderr);
    logTruncationNotice(result);

    if (result.code === 0) {
      setStatus("Integrity test passed", 3000);
      log("Archive integrity test: OK");
      await message("Archive integrity test passed. No errors found.", {
        title: "Test passed",
      });
      clearPasswordFields();
      return "passed";
    } else if (result.code === 1) {
      setStatus("Integrity test passed with warnings", 3000);
      log("Archive integrity test: OK (with warnings)");
      await message(
        "Archive integrity test passed with warnings. Check the log for details.",
        { title: "Test passed" },
      );
      clearPasswordFields();
      return "passed_with_warnings";
    } else {
      setStatus("Integrity test failed", 3000);
      log(`Archive integrity test: FAILED (exit code ${result.code})`);
      const errorDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Archive integrity test failed (exit code ${result.code}).${errorDetails}`,
        { title: "Test failed", kind: "error" },
      );
      return "failed";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Test error: ${msg}`);
    setStatus("Error", 3000, msg);
    hideProgress();
    await message(msg, { title: "Test error", kind: "error" });
    return "error";
  } finally {
    clearPasswordFields();
    setRunning(false);
  }
}

export async function browseArchive(): Promise<ArchiveInfo | null> {
  if (state.running) return null;
  setRunning(true);
  try {
    const archive = state.inputs[0];
    if (!archive) {
      await message("Select an archive to browse.", {
        title: "No archive selected",
      });
      return null;
    }
    try {
      await ensureArchivePaths([archive], "browse");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message(msg, { title: "Invalid input", kind: "error" });
      return null;
    }

    const password = $<HTMLInputElement>("browse-password").value.trim();
    const args = ["l", "-slt"];
    if (password) args.push(`-p${password}`);
    args.push("--", archive);

    if (!(await ensureRuntimeReady())) return null;

    setStatus("Listing archive contents");

    const result = await invoke<Run7zResult>("run_7z", { args });
    logTruncationNotice(result);

    if (result.code !== 0) {
      const needsPassword = looksLikePasswordRequiredError(
        result.stdout,
        result.stderr,
      );
      setBrowsePasswordFieldVisible(needsPassword);
      logCommandResult(result.stdout, result.stderr);
      setStatus("Failed to list archive", 3000);
      if (needsPassword) {
        log("Archive appears to be encrypted. Enter a password and try again.");
      }
      const passwordHint = needsPassword
        ? "\n\nThis archive appears to be encrypted. Enter the archive password and try again."
        : "";
      const errorDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Failed to list archive contents (exit code ${result.code}).${passwordHint}${errorDetails}`,
        { title: "Browse failed", kind: "error" },
      );
      return null;
    }

    if (result.stdout_truncated) {
      setStatus("Archive listing too large", 3000);
      await message(
        "The archive listing exceeded Zinnia's safe output limit, so it cannot be displayed completely.",
        { title: "Browse incomplete", kind: "error" },
      );
      return null;
    }

    const info = parseArchiveListing(result.stdout);
    cacheBrowseInfo(archive, info);
    setBrowsePasswordFieldVisible(info.encrypted);
    // Late import avoids a cycle with browse-ui (which imports browseArchive).
    const { renderBrowseTable } = await import("./browse-ui");
    renderBrowseTable(info);
    setStatus(`${info.entries.length} entries listed`, 3000);
    return info;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Browse error: ${msg}`);
    setStatus("Error", 3000, msg);
    await message(msg, { title: "Browse error", kind: "error" });
    return null;
  } finally {
    setRunning(false);
  }
}
