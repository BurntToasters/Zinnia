import { $ } from "../utils";
import {
  state,
  cacheBrowseInfo,
  cacheBrowseIdentity,
  clearBrowseCache,
} from "../state";
import {
  getMode,
  getWorkspaceMode,
  hideProgress,
  log,
  setBrowsePasswordFieldVisible,
  setRunning,
  setStatus,
} from "../ui";
import { ensureArchivePaths, validateArchivePaths } from "../archive-rules";
import {
  describe7zError,
  looksLikePasswordRequiredError,
  userFacing7zErrorDetail,
  userFacingBackendError,
} from "../error-hints";
import { parseArchiveListing } from "./listing";
import { registerBrowseArchiveLoader, renderBrowseTable } from "./browse-ui";
import {
  clearPasswordFields,
  ensureRuntimeReady,
  logCommandResult,
  logTruncationNotice,
  truncateForDialog,
  runWithPasswordRetry,
} from "./runtime";
import { debugLog, debugLogCommand, isDebugEnabled } from "../debug-mode";
import type { ArchiveInfo } from "../browse-model";
import { showToast } from "../toast";

export type ArchiveTestResult = "passed" | "failed" | "cancelled" | "error";

/**
 * Password that opened the most recently browsed archive. Only one archive is
 * remembered, so the value never outlives the browse that needed it.
 */
let browsedArchivePassword: {
  archive: string;
  identity: string;
  password: string;
} | null = null;

/**
 * Password that opened `archive` in its last successful browse, or null when
 * the file changed since then. Basic "Extract all" uses it instead of asking
 * again.
 */
export async function browsedArchivePasswordFor(
  archive: string,
): Promise<string | null> {
  const remembered = browsedArchivePassword;
  if (remembered?.archive !== archive) return null;
  try {
    const [current] = await validateArchivePaths([archive], true);
    if (current?.valid && current.identity === remembered.identity) {
      return remembered.password;
    }
  } catch {
    // An unverifiable identity is never reused; fall through and forget it.
  }
  browsedArchivePassword = null;
  return null;
}

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
  // Password fields are cleared only once 7-Zip has been started.
  let sevenZipStarted = false;
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
      const raw = err instanceof Error ? err.message : String(err);
      log(`Test archive validation failed: ${raw}`, "error");
      showToast(userFacingBackendError(raw), "error", 0);
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
    sevenZipStarted = true;
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
      const warnHint = describe7zError(result.stdout, result.stderr);
      setStatus(
        "Error",
        3000,
        warnHint ||
          "Archive integrity test stopped with warnings (exit code 1).",
      );
      log("Archive integrity test: FAILED WITH WARNINGS (exit code 1)");
      const warningHint = describe7zError(result.stdout, result.stderr);
      const warningHintLine = warningHint ? `\n\n${warningHint}` : "";
      showToast(
        `Archive integrity test stopped with warnings (exit code 1) and is not considered a pass.${warningHintLine}`,
        "error",
        0,
      );
      return "failed";
    }

    log(`Archive integrity test: FAILED (exit code ${result.code})`);
    const failHint = userFacing7zErrorDetail(
      result.stdout,
      result.stderr,
      `Operation failed with exit code ${result.code}.`,
    );
    setStatus("Error", 3000, failHint);
    showToast(
      `Archive integrity test failed (exit code ${result.code}).\n\n${failHint}`,
      "error",
      0,
    );
    return "failed";
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    log(`Test error: ${raw}`, "error");
    const msg = userFacingBackendError(raw);
    setStatus("Error", 3000, msg);
    hideProgress();
    showToast(
      `Archive integrity test failed: ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
    return "error";
  } finally {
    if (sevenZipStarted) clearPasswordFields();
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
      const raw = err instanceof Error ? err.message : String(err);
      log(`Browse archive validation failed: ${raw}`, "error");
      showToast(userFacingBackendError(raw), "error", 0);
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
    // Power prompts once for a password-required listing and retries. Basic
    // keeps its own browse password field, so its failure stays in that flow.
    const passwordCarry = { value: password };
    browsedArchivePassword = null;
    const result = await runWithPasswordRetry(
      args,
      getWorkspaceMode() !== "basic",
      "Browse",
      listingIdentity,
      passwordCarry,
    );
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
      const listHint = userFacing7zErrorDetail(
        result.stdout,
        result.stderr,
        needsPassword
          ? "This archive appears to be encrypted. Enter the archive password and try again."
          : `Failed to list archive contents (exit code ${result.code}).`,
      );
      setStatus("Error", 3000, listHint);
      if (needsPassword)
        log("Archive appears to be encrypted. Enter a password and try again.");
      showToast(
        `Failed to list archive contents (exit code ${result.code}).\n\n${listHint}`,
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
        "This archive has too many entries to show (listing over 64 MiB, roughly 200,000 entries). You can still extract all of it.",
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
    browsedArchivePassword = passwordCarry.value
      ? {
          archive,
          identity: afterListingIdentity,
          password: passwordCarry.value,
        }
      : null;
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
    const raw = err instanceof Error ? err.message : String(err);
    log(`Browse error: ${raw}`, "error");
    if (isDebugEnabled()) debugLog(`Browse error: ${raw}`);
    const msg = userFacingBackendError(raw);
    setStatus("Error", 3000, msg);
    showToast(`Browse failed: ${truncateForDialog(msg, 1000)}`, "error", 0);
    return null;
  } finally {
    setRunning(false);
  }
}

registerBrowseArchiveLoader(browseArchive);
