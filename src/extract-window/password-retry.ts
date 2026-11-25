import {
  hasClosedStdinBreakSignal,
  isClosedStdinPasswordRejection,
  looksLikePasswordRequiredError,
} from "../error-hints";
import { withPassword } from "../password-args";
import { invokeRun7z, type Run7zRequest } from "../archive/backend-ipc";
import { assertRunResult } from "../utils";
import { startIndeterminateProgress, stopProgressAt } from "./dom";

export const EXTRACT_PASSWORD_PROMPT_CANCELLED =
  "EXTRACT_PASSWORD_PROMPT_CANCELLED";

/** True only while this window's `run_7z` invoke is in flight. */
let extractRunInFlight = false;

export function isExtractRunInFlight(): boolean {
  return extractRunInFlight;
}

interface Run7zResult {
  stdout: string;
  stderr: string;
  code: number;
  warning_code?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  ioDiagnostics?: import("../archive/backend-ipc").ArchiveIoDiagnostics;
  passwordRequired?: boolean;
}

function isPasswordRequiredResult(result: Run7zResult): boolean {
  if (
    result.passwordRequired === true ||
    looksLikePasswordRequiredError(result.stdout ?? "", result.stderr ?? "")
  ) {
    return true;
  }
  if (result.code !== 2 && result.code !== 255) return false;
  // With stdin closed, 7-Zip aborts a password prompt with "Break signaled" on
  // stderr. Stderr is never truncated, so this is the only reliable signal.
  // Truncated stdout alone says nothing about a password (CRC, disk-full, etc.).
  return hasClosedStdinBreakSignal(result.stderr ?? "");
}

async function invokeExtractRun(
  args: Run7zRequest,
  includeIoDiagnostics = false,
): Promise<Run7zResult> {
  extractRunInFlight = true;
  try {
    const result = await invokeRun7z<unknown>({
      ...args,
      ...(includeIoDiagnostics ? { includeIoDiagnostics: true } : {}),
    });
    assertRunResult(result);
    return result;
  } finally {
    extractRunInFlight = false;
  }
}

async function invokeExtractRunForPassword(
  args: Run7zRequest,
  includeIoDiagnostics: boolean,
  passwordAlreadySent = false,
): Promise<Run7zResult> {
  try {
    return await invokeExtractRun(args, includeIoDiagnostics);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Header encryption can make backend safety listing request a password
    // before extraction returns a normal Run7zResult. Once a password was sent,
    // a closed-stdin abort is a hard failure: the nested child cannot accept
    // `-p`, and converting it again would re-prompt forever.
    if (!isClosedStdinPasswordRejection(detail)) throw error;
    if (passwordAlreadySent && hasClosedStdinBreakSignal(detail)) throw error;
    return { stdout: "", stderr: detail, code: 255, passwordRequired: true };
  }
}

export async function runWithPasswordRetry(
  args: string[],
  shouldAbort: () => boolean,
  expectedArchiveIdentity?: string,
  signal?: AbortSignal,
  includeIoDiagnostics = false,
): Promise<Run7zResult> {
  const invokeArgs = {
    args,
    ...(expectedArchiveIdentity ? { expectedArchiveIdentity } : {}),
  };
  let result = await invokeExtractRunForPassword(
    invokeArgs,
    includeIoDiagnostics,
  );
  // A password that was already sent is known to be wrong when 7-Zip asks again.
  let passwordSent = false;
  while (result.code > 1 && isPasswordRequiredResult(result)) {
    if (shouldAbort() || signal?.aborted) {
      return result;
    }
    // Same closed-stdin prompt after a password: the child never received `-p`.
    // Returning the failure surfaces the hard error instead of looping.
    if (passwordSent && hasClosedStdinBreakSignal(result.stderr ?? "")) {
      return result;
    }
    const cancelBtn = document.getElementById(
      "cancel-btn",
    ) as HTMLButtonElement | null;
    if (cancelBtn) cancelBtn.disabled = false;
    stopProgressAt(0, false);
    const { promptPassword } = await import("../prompt-modal");
    const outcome = await promptPassword({
      title: "Password required",
      label: passwordSent
        ? "Incorrect password. Enter the archive password:"
        : "This archive is encrypted. Enter password:",
      confirmLabel: "Extract",
      signal,
    });
    if (shouldAbort() || signal?.aborted || outcome.kind !== "submit") {
      throw new Error(EXTRACT_PASSWORD_PROMPT_CANCELLED);
    }
    startIndeterminateProgress();
    result = await invokeExtractRunForPassword(
      {
        args: withPassword(args, outcome.value),
        ...(expectedArchiveIdentity ? { expectedArchiveIdentity } : {}),
      },
      includeIoDiagnostics,
      true,
    );
    passwordSent = true;
  }
  return result;
}

export type { Run7zResult };
