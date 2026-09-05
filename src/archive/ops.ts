import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { $, splitArgs } from "../utils";
import { state } from "../state";
import {
  log,
  devLog,
  setStatus,
  setProgress,
  hideProgress,
  setRunning,
  getMode,
  getWorkspaceMode,
} from "../ui";
import { ensureArchivePaths, validateExtraArgs } from "../archive-rules";
import { showToast } from "../toast";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import { confirmExtractDestination } from "../extract-destination";
import { debugLog, debugLogCommand, isDebugEnabled } from "../debug-mode";
import { buildArgs, buildExtractArgsFor } from "./args";
import { sanitizeCommandArgsForPreview } from "./preview";
import { confirmZipSymlinkRisk } from "./compress-fidelity";
import { basename } from "../path-display";
import type { ProgressUpdate } from "../progress-update";
import {
  ensureRuntimeReady,
  formatBatchEta,
  truncateForDialog,
  logCommandResult,
  logTruncationNotice,
  runWithPasswordRetry,
  withLiveProgress,
  clearPasswordFields,
  showOperationError,
} from "./runtime";

export {
  ensureRuntimeReady,
  formatBatchEta,
  logCommandResult,
  logTruncationNotice,
  runWithPasswordRetry,
  truncateForDialog,
  type Run7zResult,
  withLiveProgress,
  clearPasswordFields,
  showOperationError,
} from "./runtime";

export {
  browseArchive,
  testArchive,
  type ArchiveTestResult,
} from "./inspection";

export { addFilesToArchive, convertArchive } from "./mutations";

export async function runAction() {
  if (state.running) return;

  const mode = getMode();

  if (mode === "extract" && state.inputs.length > 1) {
    return runBatchExtract();
  }

  state.batchCancelled = false;
  state.cancelRequested = false;
  setRunning(true);
  try {
    if (!(await ensureRuntimeReady())) return;
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }

    let args: string[];
    let expectedArchiveIdentity: string | undefined;
    if (mode === "extract") {
      if (!state.inputs[0]) throw new Error("Select an archive to extract.");
      const [validation] = await ensureArchivePaths(
        [state.inputs[0]],
        "extract",
        undefined,
        true,
      );
      if (!validation?.identity) {
        throw new Error("Could not capture a stable archive identity.");
      }
      expectedArchiveIdentity = validation.identity;
      args = buildExtractArgsFor(state.inputs[0]);
      const destination = $<HTMLInputElement>("extract-path").value;
      if (!(await confirmExtractDestination(destination))) {
        setStatus("Cancelled", 2000);
        return;
      }
    } else {
      const format = (
        document.getElementById("format") as HTMLSelectElement | null
      )?.value;
      if (format && !(await confirmZipSymlinkRisk(format, state.inputs))) {
        setStatus("Cancelled", 2000);
        return;
      }
      args = buildArgs();
      const outputPath = $<HTMLInputElement>("output-path").value;
      expectedArchiveIdentity = await invoke<string>(
        "archive_output_selection_token",
        { path: outputPath },
      );
    }

    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
    debugLogCommand(args);

    setStatus("Running");
    if (isDebugEnabled()) debugLog(`Starting ${mode} operation.`);

    const result = await withLiveProgress(() =>
      runWithPasswordRetry(
        args,
        mode === "extract",
        "Extract",
        expectedArchiveIdentity,
      ),
    );
    if (state.cancelRequested && result.code !== 0) {
      hideProgress();
      setStatus("Cancelled", 2000);
      log("Operation cancelled by user");
      return;
    }

    logCommandResult(result.stdout, result.stderr, result.code);
    logTruncationNotice(result);
    devLog(`Exit code: ${result.code}`);

    if (result.code === 0) {
      setStatus("Done", 2000);
      hideProgress();
      if (isDebugEnabled()) {
        debugLog(`${mode} operation finished successfully.`);
      }
      showToast(
        mode === "extract" ? "Extraction complete." : "Archive created.",
        "success",
      );
      // Clear every mirrored password field after a successful operation.
      clearPasswordFields();
    } else {
      log(`7z exited with code ${result.code}`);
      if (isDebugEnabled()) {
        debugLog(`${mode} operation failed with exit code ${result.code}.`);
      }
      setStatus("Error", 3000, result.stderr || "Operation failed.");
      hideProgress();
      showOperationError(result.code, result.stdout, result.stderr);
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
    if (isDebugEnabled()) debugLog(`${mode} operation threw: ${messageText}`);
    setStatus("Error", 3000, messageText);
    hideProgress();
    // Basic mode already shows the in-app completion panel for failures.
    if (getWorkspaceMode() !== "basic") {
      showToast(
        `Operation failed: ${truncateForDialog(messageText, 1000)}`,
        "error",
        0,
      );
    }
  } finally {
    clearPasswordFields();
    setRunning(false);
  }
}

export async function runBatchExtract() {
  if (state.running) return;
  state.batchCancelled = false;
  state.cancelRequested = false;
  setRunning(true);
  let unlistenProgress: (() => void) | null = null;
  try {
    if (!(await ensureRuntimeReady())) return;
    if (state.batchCancelled || state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    const archives = [...state.inputs];
    const validations = await ensureArchivePaths(
      archives,
      "extract",
      undefined,
      true,
    );
    const identities = validations.map((validation) => validation.identity);
    if (identities.some((identity) => !identity)) {
      throw new Error("Could not capture stable identities for every archive.");
    }

    const dest = $<HTMLInputElement>("extract-path").value;
    if (!dest) throw new Error("Choose a destination folder.");
    if (!(await confirmExtractDestination(dest))) {
      setStatus("Cancelled", 2000);
      return;
    }
    const password = $<HTMLInputElement>("extract-password").value;
    const extraArgs = splitArgs(
      $<HTMLInputElement>("extract-extra-args").value.trim(),
    );
    if (extraArgs.length > 0) validateExtraArgs(extraArgs, "extract");
    // Snapshot captured; freeze the fields so mid-batch edits cannot drift.
    $<HTMLInputElement>("extract-path").disabled = true;
    $<HTMLInputElement>("extract-password").disabled = true;
    $<HTMLInputElement>("extract-extra-args").disabled = true;

    let succeeded = 0;
    let failed = 0;
    let warningFailures = 0;
    let current = 0;
    let archiveStartedAt = Date.now();
    let sawPercent = false;
    const passwordCarry = { value: password };

    // Live progress for the whole batch: show percent of the current archive,
    // which file it's on, and an ETA, alongside the N-of-M counter.
    unlistenProgress = await listen<ProgressUpdate>(
      "7z-progress-structured",
      (event) => {
        const u = event.payload;
        const counter = `(${current}/${archives.length})`;
        if (u?.currentFile === "Working…") {
          if (!sawPercent) setProgress(`Still working… ${counter}`);
          return;
        }
        if (typeof u?.percent !== "number") return;
        if (u.currentFile === "Finalizing…") {
          setProgress(`Finalizing… ${counter}`);
          return;
        }
        sawPercent = true;
        const eta = formatBatchEta(Date.now() - archiveStartedAt, u.percent);
        const file = u.currentFile ? ` ${basename(u.currentFile)}` : "";
        setProgress(`${u.percent}% ${counter}${file}${eta ? ` · ${eta}` : ""}`);
      },
    );

    for (let i = 0; i < archives.length; i++) {
      if (state.batchCancelled || state.cancelRequested) break;

      const archive = archives[i];
      current = i + 1;
      archiveStartedAt = Date.now();
      sawPercent = false;
      setStatus(`Extracting ${i + 1} of ${archives.length}`);

      try {
        const args = [
          "x",
          `-o${dest}`,
          SAFE_EXTRACT_OVERWRITE_MODE,
          "-bb1",
          "-bsp1",
          "-spd",
        ];
        if (passwordCarry.value) args.push(`-p${passwordCarry.value}`);
        args.push(...extraArgs);
        args.push("--", archive);
        devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
        debugLogCommand(args);
        if (isDebugEnabled()) {
          debugLog(`Batch extract ${i + 1}/${archives.length}: ${archive}`);
        }

        const result = await runWithPasswordRetry(
          args,
          true,
          "Extract",
          identities[i],
          passwordCarry,
        );

        logCommandResult(result.stdout, result.stderr, result.code);
        logTruncationNotice(result);

        if (state.batchCancelled || state.cancelRequested) break;

        if (result.code === 0) {
          succeeded++;
        } else {
          failed++;
          if (result.code === 1) {
            warningFailures++;
            log(
              `Failed with warnings: ${archive} (exit code 1; output was not published)`,
              "error",
            );
          } else {
            log(`Failed: ${archive} (exit code ${result.code})`);
          }
          if (isDebugEnabled()) {
            debugLog(
              `Batch extract failed for ${archive} (exit ${result.code}).`,
            );
          }
        }
      } catch (err) {
        if (state.batchCancelled || state.cancelRequested) break;
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error extracting ${archive}: ${msg}`);
        if (isDebugEnabled()) {
          debugLog(`Batch extract threw for ${archive}: ${msg}`);
        }
      }
    }

    hideProgress();
    const basic = getWorkspaceMode() === "basic";
    if (state.batchCancelled || state.cancelRequested) {
      setStatus("Cancelled", 3000);
      if (!basic) {
        // Completion feedback must not block the event loop or automation.
        showToast("Batch extraction was cancelled.", "info", 5000);
      }
    } else if (failed === 0) {
      setStatus("Done", 3000);
      if (!basic) {
        showToast(
          `Successfully extracted ${succeeded} archive${succeeded !== 1 ? "s" : ""}.`,
          "success",
          5000,
        );
      }
    } else {
      const warningDetail = warningFailures
        ? ` (${warningFailures} warning exit${warningFailures === 1 ? "" : "s"})`
        : "";
      const summary = `${succeeded} succeeded, ${failed} failed${warningDetail}.`;
      setStatus("Error", 4000, summary);
      if (!basic) {
        showToast(summary, "error", 7000);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`);
    setStatus("Error", 3000, msg);
    hideProgress();
    if (getWorkspaceMode() !== "basic") {
      showToast(
        `Batch extraction failed: ${truncateForDialog(msg, 1000)}`,
        "error",
        0,
      );
    }
  } finally {
    if (unlistenProgress) unlistenProgress();
    clearPasswordFields();
    $<HTMLInputElement>("extract-path").disabled = false;
    $<HTMLInputElement>("extract-password").disabled = false;
    $<HTMLInputElement>("extract-extra-args").disabled = false;
    setRunning(false);
  }
}

export async function cancelAction() {
  if (!state.running) return;
  // Always record user intent. Idle cancel_7z (password gap / between batch
  // items) returns false  -  clearing flags here made Cancel a no-op and left
  // password-retry / batch loops running.
  state.batchCancelled = true;
  state.cancelRequested = true;
  setStatus("Cancelling...");
  try {
    const armed = await invoke<boolean>("cancel_7z");
    if (armed) {
      devLog("Cancel signal sent to running process.");
    } else {
      devLog("Cancel requested while 7z was idle; aborting in-flight UI flow.");
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Cancel failed: ${messageText}`, "error");
    setStatus("Cancelling...", 3000, messageText);
  }
}
