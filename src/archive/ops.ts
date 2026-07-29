import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
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
import { buildArgs, buildExtractArgsFor } from "./args";
import { sanitizeCommandArgsForPreview } from "./preview";
import { confirmZipSymlinkRisk } from "./compress-fidelity";
import {
  ensureRuntimeReady,
  formatBatchEta,
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

interface ProgressUpdate {
  percent?: number;
  filesDone?: number;
  currentFile?: string;
}

function basename(filePath: string): string {
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return sep >= 0 ? filePath.slice(sep + 1) : filePath;
}

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
    if (mode === "extract") {
      if (!state.inputs[0]) throw new Error("Select an archive to extract.");
      await ensureArchivePaths([state.inputs[0]], "extract");
      args = buildExtractArgsFor(state.inputs[0]);
    } else {
      const format = (
        document.getElementById("format") as HTMLSelectElement | null
      )?.value;
      if (format && !(await confirmZipSymlinkRisk(format, state.inputs))) {
        setStatus("Cancelled", 2000);
        return;
      }
      args = buildArgs();
    }

    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);

    setStatus("Running");

    const result = await withLiveProgress(() =>
      runWithPasswordRetry(args, mode === "extract"),
    );
    if (state.cancelRequested && result.code !== 0) {
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
    await ensureArchivePaths(archives, "extract");

    const dest = $<HTMLInputElement>("extract-path").value;
    if (!dest) throw new Error("Choose a destination folder.");
    const password = $<HTMLInputElement>("extract-password").value;
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
        const args = [
          "x",
          `-o${dest}`,
          SAFE_EXTRACT_OVERWRITE_MODE,
          "-bb1",
          "-bsp1",
          "-spd",
        ];
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
  // Always record user intent. Idle cancel_7z (password gap / between batch
  // items) returns false — clearing flags here made Cancel a no-op and left
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
