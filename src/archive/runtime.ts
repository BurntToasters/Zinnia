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
  setStatus,
} from "../ui";
import { formatCommandOutputForLogs } from "../output-logging";
import {
  describe7zError,
  looksLikePasswordRequiredError,
} from "../error-hints";
import { promptInput } from "../prompt-modal";
import { withPassword } from "./args";

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

const OUTPUT_TRUNCATION_LIMIT_MIB = 10;
const RUNTIME_PROBE_TIMEOUT_MS = 7000;
let runtimeProbePromise: Promise<string> | null = null;

function basename(filePath: string): string {
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return sep >= 0 ? filePath.slice(sep + 1) : filePath;
}

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
  if (getWorkspaceMode() === "basic") return;
  const hint = describe7zError(stdout, stderr);
  const detail = stderr.trim() ? `\n\n${truncateForDialog(stderr.trim())}` : "";
  const hintLine = hint ? `\n\n${hint}` : "";
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

export function logCommandResult(stdout: string, stderr: string): void {
  const entries = formatCommandOutputForLogs(
    stdout,
    stderr,
    state.currentSettings.logVerbosity,
  );
  for (const entry of entries) {
    log(entry.text, entry.level === "error" ? "error" : "info");
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

export async function withLiveProgress<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const unlisten = await listen<ProgressUpdate>(
    "7z-progress-structured",
    (event) => {
      const update = event.payload;
      if (typeof update?.percent !== "number") return;
      if (update.currentFile === "Finalizing…") {
        setProgress("Finalizing…");
        return;
      }
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

export async function runWithPasswordRetry(
  args: string[],
  retryForMissingPassword: boolean,
  confirmLabel = "Extract",
): Promise<Run7zResult> {
  let result = await invoke<Run7zResult>("run_7z", { args });
  if (
    retryForMissingPassword &&
    result.code > 1 &&
    looksLikePasswordRequiredError(result.stdout, result.stderr)
  ) {
    if (state.cancelRequested) {
      return result;
    }
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
      setStatus("Retrying with password");
      result = await invoke<Run7zResult>("run_7z", {
        args: withPassword(args, password),
      });
    }
  }
  return result;
}
