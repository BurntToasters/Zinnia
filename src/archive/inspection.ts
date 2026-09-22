import { $ } from "../utils";
import {
  state,
  cacheBrowseInfo,
  cacheBrowseIdentity,
  clearBrowseCache,
} from "../state";
import {
  getMode,
  hideProgress,
  log,
  setBrowsePasswordFieldVisible,
  setRunning,
  setStatus,
} from "../ui";
import { ensureArchivePaths } from "../archive-rules";
import { looksLikePasswordRequiredError } from "../error-hints";
import { parseArchiveListing } from "./listing";
import { registerBrowseArchiveLoader, renderBrowseTable } from "./browse-ui";
import {
  clearPasswordFields,
  ensureRuntimeReady,
  logCommandResult,
  logTruncationNotice,
  truncateForDialog,
  invokeGuardedRun7z,
  runWithPasswordRetry,
} from "./runtime";
import { debugLog, debugLogCommand, isDebugEnabled } from "../debug-mode";
import type { ArchiveInfo } from "../browse-model";
import { showToast } from "../toast";

export type ArchiveTestResult = "passed" | "failed" | "cancelled" | "error";

function requireFinalArchiveIdentity(
  result: { archiveIdentityAfter?: string },
  expectedIdentity: string,
  operation: "test" | "browse",
): string {
  const finalIdentity = result.archiveIdentityAfter;
  if (!finalIdentity) {
    throw new Error(
      `Archive identity was not returned after ${operation}. Operation was not accepted.`,
    );
  }
  if (finalIdentity !== expectedIdentity) {
    throw new Error(
      `Archive changed while ${operation} was running. Operation was not accepted.`,
    );
  }
  return finalIdentity;
}

export async function testArchive(): Promise<ArchiveTestResult> {
  if (state.running) return "cancelled";
  setRunning(true);
  state.cancelRequested = false;
  state.batchCancelled = false;
  try {
    const archive = state.inputs[0];
    if (!archive) {
      showToast("Select an archive to test.", "info");
      return "failed";
    }
    let expectedArchiveIdentity = "";
    try {
      const [validation] = await ensureArchivePaths(
        [archive],
        "test",
        undefined,
        true,
      );
      if (!validation?.identity) {
        throw new Error("Could not capture a stable archive identity.");
      }
      expectedArchiveIdentity = validation.identity;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, "error", 0);
      return "failed";
    }

    const passwordField =
      getMode() === "browse" ? "browse-password" : "extract-password";
    const password = $<HTMLInputElement>(passwordField).value;
    const args = ["t", "-spd"];
    if (password) args.push(`-p${password}`);
    args.push("--", archive);

    if (!(await ensureRuntimeReady())) return "error";
    setStatus("Testing archive integrity");
    debugLogCommand(args);
    const result = await runWithPasswordRetry(
      args,
      true,
      "Test",
      expectedArchiveIdentity,
    );
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return "cancelled";
    }
    requireFinalArchiveIdentity(result, expectedArchiveIdentity, "test");
    logCommandResult(result.stdout, result.stderr, result.code);
    logTruncationNotice(result);

    if (result.code === 0 && result.warning_code) {
      setStatus("Integrity test passed with warnings", 3000);
      log(
        `Archive integrity test: PASSED WITH WARNINGS (warning_code ${result.warning_code})`,
      );
      showToast(
        `Archive integrity test reported warnings (exit code ${result.warning_code}) and is not considered a clean pass.`,
        "error",
        0,
      );
      return "failed";
    }
    if (result.code === 0) {
      setStatus("Integrity test passed", 3000);
      log("Archive integrity test: OK");
      showToast("Archive integrity test passed. No errors found.", "success");
      clearPasswordFields();
      return "passed";
    }
    if (result.code === 1) {
      setStatus("Integrity test failed with warnings", 3000);
      log("Archive integrity test: FAILED WITH WARNINGS (exit code 1)");
      const warningDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim(), 1000)}`
        : "";
      showToast(
        `Archive integrity test stopped with warnings (exit code 1) and is not considered a pass.${warningDetails}`,
        "error",
        0,
      );
      return "failed";
    }

    setStatus("Integrity test failed", 3000);
    log(`Archive integrity test: FAILED (exit code ${result.code})`);
    const errorDetails = result.stderr
      ? `\n\n${truncateForDialog(result.stderr.trim(), 1000)}`
      : "";
    showToast(
      `Archive integrity test failed (exit code ${result.code}).${errorDetails}`,
      "error",
      0,
    );
    return "failed";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Test error: ${msg}`);
    setStatus("Error", 3000, msg);
    hideProgress();
    showToast(
      `Archive integrity test failed: ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
    return "error";
  } finally {
    clearPasswordFields();
    setRunning(false);
  }
}

export function browseArchive(): Promise<ArchiveInfo | null>;
export function browseArchive(
  validatedArchiveIdentity: string,
): Promise<ArchiveInfo | null>;
export async function browseArchive(
  validatedArchiveIdentity?: string,
): Promise<ArchiveInfo | null> {
  if (state.running) return null;
  setRunning(true);
  state.cancelRequested = false;
  state.batchCancelled = false;
  try {
    const archive = state.inputs[0];
    if (!archive) {
      showToast("Select an archive to browse.", "info");
      return null;
    }
    // Keep identity local until the listing succeeds so a failed browse does
    // not leave an orphan identity cache entry without archive info.
    let listingIdentity = validatedArchiveIdentity ?? "";
    try {
      if (!listingIdentity) {
        const [validation] = await ensureArchivePaths(
          [archive],
          "browse",
          undefined,
          true,
        );
        listingIdentity = validation?.identity ?? "";
      }
      if (!listingIdentity) {
        throw new Error("Could not capture a stable archive identity.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, "error", 0);
      return null;
    }

    const password = $<HTMLInputElement>("browse-password").value;
    const args = ["l", "-slt", "-spd"];
    if (password) args.push(`-p${password}`);
    args.push("--", archive);

    if (!(await ensureRuntimeReady())) return null;
    setStatus("Listing archive contents");
    if (isDebugEnabled()) debugLog(`Listing archive: ${archive}`);
    debugLogCommand(args);
    const result = await invokeGuardedRun7z(args, listingIdentity);
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return null;
    }
    logTruncationNotice(result);

    if (result.code !== 0) {
      // Do not retain stale browse cache when backend cannot prove the
      // archive identity after a failed listing.
      if (!result.archiveIdentityAfter) {
        clearBrowseCache(archive);
      } else if (result.archiveIdentityAfter !== listingIdentity) {
        clearBrowseCache(archive);
        throw new Error(
          "Archive changed while its contents were being listed. Browse it again.",
        );
      }
      const needsPassword = looksLikePasswordRequiredError(
        result.stdout,
        result.stderr,
      );
      setBrowsePasswordFieldVisible(needsPassword);
      logCommandResult(result.stdout, result.stderr, result.code);
      setStatus("Failed to list archive", 3000);
      if (needsPassword)
        log("Archive appears to be encrypted. Enter a password and try again.");
      const passwordHint = needsPassword
        ? "\n\nThis archive appears to be encrypted. Enter the archive password and try again."
        : "";
      const errorDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim(), 1000)}`
        : "";
      showToast(
        `Failed to list archive contents (exit code ${result.code}).${passwordHint}${errorDetails}`,
        "error",
        0,
      );
      return null;
    }

    if (result.stdout_truncated) {
      if (
        !result.archiveIdentityAfter ||
        result.archiveIdentityAfter !== listingIdentity
      ) {
        clearBrowseCache(archive);
      }
      setStatus("Archive listing too large", 3000);
      showToast(
        "The archive listing exceeded Zinnia's safe output limit, so it cannot be displayed completely.",
        "error",
        0,
      );
      return null;
    }

    // Backend validates expected identity before listing and returns final
    // identity from same operation. Never substitute pre-run identity.
    let afterListingIdentity: string;
    try {
      afterListingIdentity = requireFinalArchiveIdentity(
        result,
        listingIdentity,
        "browse",
      );
    } catch (error) {
      clearBrowseCache(archive);
      throw error;
    }
    const info = parseArchiveListing(result.stdout);
    clearBrowseCache(archive);
    cacheBrowseInfo(archive, info);
    cacheBrowseIdentity(archive, afterListingIdentity);
    setBrowsePasswordFieldVisible(info.encrypted);
    renderBrowseTable(info);
    setStatus(`${info.entries.length} entries listed`, 3000);
    if (isDebugEnabled()) {
      debugLog(
        `Browse finished: ${info.entries.length} entries (encrypted=${info.encrypted}).`,
      );
    }
    return info;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Browse error: ${msg}`);
    if (isDebugEnabled()) debugLog(`Browse error: ${msg}`);
    setStatus("Error", 3000, msg);
    showToast(`Browse failed: ${truncateForDialog(msg, 1000)}`, "error", 0);
    return null;
  } finally {
    setRunning(false);
  }
}

registerBrowseArchiveLoader(browseArchive);
