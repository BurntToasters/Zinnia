import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
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
  type Run7zResult,
} from "./runtime";
import { debugLog, debugLogCommand, isDebugEnabled } from "../debug-mode";
import type { ArchiveInfo } from "../browse-model";

export type ArchiveTestResult = "passed" | "failed" | "cancelled" | "error";

export async function testArchive(): Promise<ArchiveTestResult> {
  if (state.running) return "cancelled";
  setRunning(true);
  state.cancelRequested = false;
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

    const passwordField =
      getMode() === "browse" ? "browse-password" : "extract-password";
    const password = $<HTMLInputElement>(passwordField).value;
    const args = ["t", "-spd"];
    if (password) args.push(`-p${password}`);
    args.push("--", archive);

    if (!(await ensureRuntimeReady())) return "error";
    setStatus("Testing archive integrity");
    debugLogCommand(args);
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return "cancelled";
    }
    logCommandResult(result.stdout, result.stderr, result.code);
    logTruncationNotice(result);

    if (result.code === 0) {
      setStatus("Integrity test passed", 3000);
      log("Archive integrity test: OK");
      await message("Archive integrity test passed. No errors found.", {
        title: "Test passed",
      });
      clearPasswordFields();
      return "passed";
    }
    if (result.code === 1) {
      setStatus("Integrity test failed with warnings", 3000);
      log("Archive integrity test: FAILED WITH WARNINGS (exit code 1)");
      const warningDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Archive integrity test stopped with warnings (exit code 1) and is not considered a pass.${warningDetails}`,
        { title: "Test failed with warnings", kind: "warning" },
      );
      return "failed";
    }

    setStatus("Integrity test failed", 3000);
    log(`Archive integrity test: FAILED (exit code ${result.code})`);
    const errorDetails = result.stderr
      ? `\n\n${truncateForDialog(result.stderr.trim())}`
      : "";
    await message(
      `Archive integrity test failed (exit code ${result.code}).${errorDetails}`,
      {
        title: "Test failed",
        kind: "error",
      },
    );
    return "failed";
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
  state.cancelRequested = false;
  try {
    const archive = state.inputs[0];
    if (!archive) {
      await message("Select an archive to browse.", {
        title: "No archive selected",
      });
      return null;
    }
    // Keep identity local until the listing succeeds so a failed browse does
    // not leave an orphan identity cache entry without archive info.
    let listingIdentity = "";
    try {
      const [validation] = await ensureArchivePaths(
        [archive],
        "browse",
        undefined,
        true,
      );
      if (!validation?.identity) {
        throw new Error("Could not capture a stable archive identity.");
      }
      listingIdentity = validation.identity;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message(msg, { title: "Invalid input", kind: "error" });
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
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return null;
    }
    logTruncationNotice(result);

    if (result.code !== 0) {
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
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Failed to list archive contents (exit code ${result.code}).${passwordHint}${errorDetails}`,
        {
          title: "Browse failed",
          kind: "error",
        },
      );
      return null;
    }

    if (result.stdout_truncated) {
      setStatus("Archive listing too large", 3000);
      await message(
        "The archive listing exceeded Zinnia's safe output limit, so it cannot be displayed completely.",
        {
          title: "Browse incomplete",
          kind: "error",
        },
      );
      return null;
    }

    const [afterListing] = await ensureArchivePaths(
      [archive],
      "browse",
      undefined,
      true,
    );
    if (
      !afterListing?.identity ||
      !listingIdentity ||
      afterListing.identity !== listingIdentity
    ) {
      clearBrowseCache(archive);
      throw new Error(
        "Archive changed while its contents were being listed. Browse it again.",
      );
    }
    const info = parseArchiveListing(result.stdout);
    clearBrowseCache(archive);
    cacheBrowseInfo(archive, info);
    cacheBrowseIdentity(archive, afterListing.identity);
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
    await message(msg, { title: "Browse error", kind: "error" });
    return null;
  } finally {
    setRunning(false);
  }
}

registerBrowseArchiveLoader(browseArchive);
