import { looksLikePasswordRequiredError } from "../error-hints";
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
  let result: Run7zResult;
  try {
    result = await invokeExtractRun(invokeArgs, includeIoDiagnostics);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Header encryption can make backend safety listing request a password
    // before extraction returns a normal Run7zResult.
    if (!looksLikePasswordRequiredError("", detail)) throw error;
    result = { stdout: "", stderr: detail, code: 255 };
  }
  if (shouldAbort() || signal?.aborted) {
    return result;
  }
  if (
    result.code > 1 &&
    looksLikePasswordRequiredError(result.stdout ?? "", result.stderr ?? "")
  ) {
    if (shouldAbort() || signal?.aborted) {
      return result;
    }
    const cancelBtn = document.getElementById(
      "cancel-btn",
    ) as HTMLButtonElement | null;
    if (cancelBtn) cancelBtn.disabled = false;
    stopProgressAt(0, false);
    const { promptInput } = await import("../prompt-modal");
    const password = await promptInput({
      title: "Password required",
      label: "This archive is encrypted. Enter password:",
      password: true,
      confirmLabel: "Extract",
      signal,
    });
    if (shouldAbort() || signal?.aborted || !password) {
      throw new Error(EXTRACT_PASSWORD_PROMPT_CANCELLED);
    }
    startIndeterminateProgress();
    result = await invokeExtractRun(
      {
        args: withPassword(args, password),
        ...(expectedArchiveIdentity ? { expectedArchiveIdentity } : {}),
      },
      includeIoDiagnostics,
    );
  }
  return result;
}

export type { Run7zResult };
