import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { state } from "../state";
import {
  getWorkspaceMode,
  hideProgress,
  log,
  resetPasswordFieldControl,
  setProgress,
  setCancelAvailable,
  setStatus,
} from "../ui";
import { formatCommandOutputForLogs } from "../output-logging";
import {
  describe7zError,
  looksLikePasswordRequiredError,
} from "../error-hints";
import { promptInput } from "../prompt-modal";
import { withPassword } from "./args";
import { basename } from "../path-display";
import { formatEta, type ProgressUpdate } from "../progress-update";
import { debugLog, isDebugEnabled } from "../debug-mode";
import { invokeRun7z as invokeRun7zRequest } from "./backend-ipc";
import { showToast } from "../toast";
import { assertRunResult } from "../utils";

export const formatBatchEta = formatEta;

export interface Run7zResult {
  stdout: string;
  stderr: string;
  code: number;
  warning_code?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

const OUTPUT_TRUNCATION_LIMIT_MIB = 10;
const RUNTIME_PROBE_TIMEOUT_MS = 7000;
let runtimeProbePromise: Promise<string> | null = null;

export function truncateForDialog(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
}

/**
 * Surface an operation failure without creating a native modal. Native error
 * dialogs keep the process alive until a user clicks them, which is unsafe for
 * close/unattended flows. Full stderr remains in the log and status detail;
 * toast text is capped so hostile tool output cannot create an enormous DOM
 * node.
 */
export function showOperationError(
  code: number,
  stdout: string,
  stderr: string,
): void {
  if (isDebugEnabled()) {
    debugLog(
      `Operation error (exit ${code}): ${describe7zError(stdout, stderr) || "(no hint)"}${stderr.trim() ? `\nstderr: ${stderr.trim().slice(0, 2000)}` : ""}`,
    );
  }
  if (getWorkspaceMode() === "basic") return;
  const hint = describe7zError(stdout, stderr);
  const hintLine = hint ? ` ${hint}` : "";
  if (code === 1) {
    showToast(
      `7-Zip stopped with warnings (exit code 1). Output was not published.${hintLine}`,
      "error",
      0,
    );
    return;
  }
  showToast(`Operation failed with exit code ${code}.${hintLine}`, "error", 0);
}

// Paired with each field's Show/Hide toggle button id. Clearing `.value`
// alone left a field's `type="text"` state (and "Hide"/aria-pressed) intact
// after a user clicked "Show", so the next password typed into that field
// stayed visible in plaintext for the rest of the session.
const PASSWORD_FIELD_TOGGLES: ReadonlyArray<readonly [string, string]> = [
  ["password", "toggle-password"],
  ["extract-password", "toggle-extract-password"],
  ["browse-password", "toggle-browse-password"],
  ["basic-password", "basic-toggle-password"],
  ["basic-extract-password", "basic-toggle-extract-password"],
  ["basic-browse-password", "basic-toggle-browse-password"],
];

export function clearPasswordFields(): void {
  for (const [inputId, toggleId] of PASSWORD_FIELD_TOGGLES) {
    resetPasswordFieldControl(inputId, toggleId);
  }
}

export function logCommandResult(
  stdout: string,
  stderr: string,
  code?: number,
): void {
  const entries = formatCommandOutputForLogs(
    stdout,
    stderr,
    state.currentSettings.logVerbosity,
  );
  for (const entry of entries) {
    log(entry.text, entry.level === "error" ? "error" : "info");
  }
  if (isDebugEnabled()) {
    const parts: string[] = [];
    if (typeof code === "number") parts.push(`Exit code: ${code}`);
    const debugEntries = formatCommandOutputForLogs(stdout, stderr, "debug");
    if (debugEntries.length === 0) {
      parts.push("7z finished with empty stdout/stderr.");
    } else {
      for (const entry of debugEntries) parts.push(entry.text);
    }
    debugLog(parts.join("\n"));
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: number | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error(timeoutMessage)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function logTruncationNotice(result: Run7zResult): void {
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
    showToast(
      `Bundled 7-Zip runtime check failed. ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
    return false;
  }
}

/** Clear cached runtime health when bundled runtime may have changed. */
export function invalidateRuntimeProbe(): void {
  runtimeProbePromise = null;
}

/** True only while a `run_7z` invoke is in flight (not during a password prompt). */
let sevenZipRunInFlight = false;

export function isSevenZipRunInFlight(): boolean {
  return sevenZipRunInFlight;
}

export function setSevenZipRunInFlight(active: boolean): void {
  sevenZipRunInFlight = active;
}

export async function invokeGuardedRun7z(
  args: string[],
  expectedArchiveIdentity?: string,
): Promise<Run7zResult> {
  sevenZipRunInFlight = true;
  try {
    const result = await invokeRun7zRequest<unknown>({
      args,
      ...(expectedArchiveIdentity ? { expectedArchiveIdentity } : {}),
    });
    assertRunResult(result);
    return result;
  } finally {
    sevenZipRunInFlight = false;
  }
}

export async function withLiveProgress<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let sawPercent = false;
  const unlisten = await listen<ProgressUpdate>(
    "7z-progress-structured",
    (event) => {
      if (!sevenZipRunInFlight) return;
      const update = event.payload;
      if (update?.currentFile === "Working…") {
        // Heartbeats fill a blank status only. Never replace a live percent/ETA.
        if (!sawPercent) setProgress("Still working…");
        return;
      }
      if (
        typeof update?.percent !== "number" ||
        !Number.isFinite(update.percent)
      )
        return;
      if (update.currentFile === "Finalizing…") {
        setCancelAvailable(false);
        setProgress("Finalizing…");
        return;
      }
      sawPercent = true;
      const eta = formatBatchEta(Date.now() - startedAt, update.percent);
      const file = update.currentFile ? ` ${basename(update.currentFile)}` : "";
      setProgress(`${update.percent}%${file}${eta ? ` · ${eta}` : ""}`);
    },
  );
  try {
    return await fn();
  } finally {
    if (typeof unlisten === "function") unlisten();
  }
}

export type PasswordCarry = { value: string };

export async function runWithPasswordRetry(
  args: string[],
  retryForMissingPassword: boolean,
  confirmLabel = "Extract",
  expectedArchiveIdentity?: string,
  passwordCarry?: PasswordCarry,
): Promise<Run7zResult> {
  if (state.cancelRequested || state.batchCancelled) {
    return {
      stdout: "",
      stderr: "Operation cancelled by user",
      code: -1,
    };
  }
  const hasPasswordSwitch = args.some(
    (arg) => arg.length > 2 && arg.slice(0, 2).toLowerCase() === "-p",
  );
  let effectiveArgs =
    passwordCarry?.value && !hasPasswordSwitch
      ? withPassword(args, passwordCarry.value)
      : args;
  let result: Run7zResult;
  try {
    result = await invokeGuardedRun7z(effectiveArgs, expectedArchiveIdentity);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Header-encrypted archives can fail backend member-safety listing before
    // `run_7z` has a normal result. Convert only a recognized password prompt
    // into retry flow; all other backend errors remain rejected.
    if (
      !retryForMissingPassword ||
      !looksLikePasswordRequiredError("", detail)
    ) {
      throw error;
    }
    result = { stdout: "", stderr: detail, code: 255 };
  }
  if (
    retryForMissingPassword &&
    result.code > 1 &&
    looksLikePasswordRequiredError(result.stdout, result.stderr)
  ) {
    if (state.cancelRequested || state.batchCancelled) {
      return result;
    }
    setCancelAvailable(true);
    const abort = new AbortController();
    const cancelBtn = document.getElementById("cancel-action");
    const onCancel = () => abort.abort();
    cancelBtn?.addEventListener("click", onCancel);
    let password: string | null;
    try {
      password = await promptInput({
        title: "Password required",
        label: "This archive is encrypted. Enter password:",
        password: true,
        confirmLabel,
        signal: abort.signal,
      });
    } finally {
      cancelBtn?.removeEventListener("click", onCancel);
    }
    if (state.cancelRequested || !password) {
      state.cancelRequested = true;
      return {
        stdout: "",
        stderr: "Operation cancelled by user",
        code: -1,
      };
    }
    if (password) {
      if (passwordCarry) passwordCarry.value = password;
      setStatus("Retrying with password");
      result = await invokeGuardedRun7z(
        withPassword(effectiveArgs, password),
        expectedArchiveIdentity,
      );
    }
  }
  return result;
}
