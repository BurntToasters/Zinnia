import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
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

export async function showOperationError(
  code: number,
  stdout: string,
  stderr: string,
): Promise<void> {
  if (isDebugEnabled()) {
    debugLog(
      `Operation error dialog (exit ${code}): ${describe7zError(stdout, stderr) || "(no hint)"}${stderr.trim() ? `\nstderr: ${stderr.trim().slice(0, 2000)}` : ""}`,
    );
  }
  if (getWorkspaceMode() === "basic") return;
  const hint = describe7zError(stdout, stderr);
  const detail = stderr.trim() ? `\n\n${truncateForDialog(stderr.trim())}` : "";
  const hintLine = hint ? `\n\n${hint}` : "";
  if (code === 1) {
    await message(
      `7-Zip stopped with warnings (exit code 1). The operation is treated as failed and its output was not published.${hintLine}${detail}`,
      {
        title: "Operation failed with warnings",
        kind: "warning",
      },
    );
    return;
  }
  await message(
    `Operation failed with exit code ${code}.${hintLine}${detail}`,
    {
      title: "Operation failed",
      kind: "error",
    },
  );
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
    await message(`The bundled 7-Zip runtime check failed.\n\n${msg}`, {
      title: "Missing runtime dependency",
      kind: "error",
    });
    return false;
  }
}

/** True only while a `run_7z` invoke is in flight (not during a password prompt). */
let sevenZipRunInFlight = false;

export function isSevenZipRunInFlight(): boolean {
  return sevenZipRunInFlight;
}

export function setSevenZipRunInFlight(active: boolean): void {
  sevenZipRunInFlight = active;
}

async function invokeRun7z(
  args: string[],
  expectedArchiveIdentity?: string,
): Promise<Run7zResult> {
  sevenZipRunInFlight = true;
  try {
    return await invokeRun7zRequest<Run7zResult>({
      args,
      ...(expectedArchiveIdentity ? { expectedArchiveIdentity } : {}),
    });
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
      if (typeof update?.percent !== "number") return;
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
    result = await invokeRun7z(effectiveArgs, expectedArchiveIdentity);
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
    const password = await promptInput({
      title: "Password required",
      label: "This archive is encrypted. Enter password:",
      password: true,
      confirmLabel,
    });
    if (state.cancelRequested) {
      return result;
    }
    if (password) {
      if (passwordCarry) passwordCarry.value = password;
      setStatus("Retrying with password");
      result = await invokeRun7z(
        withPassword(effectiveArgs, password),
        expectedArchiveIdentity,
      );
    }
  }
  return result;
}
