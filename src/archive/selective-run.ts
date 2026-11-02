import { confirm } from "@tauri-apps/plugin-dialog";
import { $ } from "../utils";
import { state, clearBrowseCache } from "../state";
import { log, devLog, setStatus, hideProgress, setRunning } from "../ui";
import { ensureArchivePaths } from "../archive-rules";
import { confirmExtractDestination } from "../extract-destination";
import { showToast } from "../toast";
import { buildExtractArgsFor } from "./args";
import { sanitizeCommandArgsForPreview } from "./preview";
import { debugLog, debugLogCommand, isDebugEnabled } from "../debug-mode";
import {
  ensureRuntimeReady,
  withLiveProgress,
  runWithPasswordRetry,
  logCommandResult,
  logTruncationNotice,
  truncateForDialog,
  clearPasswordFields,
  showOperationError,
} from "./runtime";
import {
  userFacing7zErrorDetail,
  userFacingBackendError,
} from "../error-hints";
import {
  getCachedArchiveInfo,
  getCurrentArchiveSelectionPaths,
  archiveHasRawSelection,
} from "./browse-selective-helpers";
import { closeSelectiveExtractModal } from "./browse-ui";
import { confirmWithE2eQueue } from "../e2e-dialog";

export async function runSelectiveExtractFromModal(): Promise<void> {
  if (state.running) return;
  state.batchCancelled = false;
  state.cancelRequested = false;
  setRunning(true);
  try {
    const archive = state.selectiveActiveArchive ?? state.inputs[0] ?? null;
    if (!archive) {
      showToast("Select an archive to extract.", "info");
      return;
    }

    if (!(await ensureRuntimeReady())) return;
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    const [validation] = await ensureArchivePaths(
      [archive],
      "extract",
      undefined,
      true,
    );

    const info = getCachedArchiveInfo(archive);
    if (!info) {
      throw new Error(
        "Browse archive contents first before selective extraction.",
      );
    }
    const browsedIdentity = state.browseArchiveIdentityByPath.get(archive);
    if (
      !validation?.identity ||
      !browsedIdentity ||
      validation.identity !== browsedIdentity
    ) {
      clearBrowseCache(archive);
      throw new Error(
        "Archive changed after it was browsed. Browse the current contents before extracting.",
      );
    }

    const destinationInput = document.getElementById(
      "selective-dest",
    ) as HTMLInputElement | null;
    const destination = destinationInput?.value ?? "";
    if (!destination) throw new Error("Choose a destination folder.");

    const extractPathInput = $<HTMLInputElement>("extract-path");
    extractPathInput.value = destination;
    if (destination !== state.lastAutoExtractDestination) {
      state.lastAutoExtractDestination = null;
    }

    const browsePassword = $<HTMLInputElement>("browse-password").value;
    const extractPassword = $<HTMLInputElement>("extract-password").value;
    const password = extractPassword || browsePassword;

    const selectedPaths = getCurrentArchiveSelectionPaths(archive, info);
    if (selectedPaths.length === 0) {
      if (archiveHasRawSelection(archive)) {
        throw new Error(
          "Selected folders do not include any extractable files or empty folders. Expand the tree or select individual files.",
        );
      }
      const extractAll = await confirmWithE2eQueue(() =>
        confirm(
          "No entries are selected. Extract all files from the archive?",
          {
            title: "No selection",
            kind: "warning",
            okLabel: "Extract all",
            cancelLabel: "Cancel",
          },
        ),
      );
      if (!extractAll) return;
    }
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    if (!(await confirmExtractDestination(destination))) {
      setStatus("Cancelled", 2000);
      return;
    }
    const args = buildExtractArgsFor(
      archive,
      selectedPaths,
      password,
      destination,
    );
    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
    debugLogCommand(args);

    closeSelectiveExtractModal();

    setStatus(
      selectedPaths.length > 0
        ? "Extracting selected entries"
        : "Extracting archive",
    );
    if (isDebugEnabled()) {
      debugLog(
        selectedPaths.length > 0
          ? `Selective extract starting (${selectedPaths.length} path(s)).`
          : "Selective extract starting (full archive).",
      );
    }

    const result = await withLiveProgress(() =>
      runWithPasswordRetry(args, true, "Extract", browsedIdentity),
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

    if (result.code !== 0) {
      log(`7z exited with code ${result.code}`);
      if (isDebugEnabled()) {
        debugLog(`Selective extract failed with exit code ${result.code}.`);
      }
      setStatus(
        "Error",
        3000,
        userFacing7zErrorDetail(result.stdout, result.stderr),
      );
      hideProgress();
      showOperationError(result.code, result.stdout, result.stderr);
    } else {
      setStatus("Done", 2000);
      hideProgress();
      if (isDebugEnabled()) {
        debugLog("Selective extract finished successfully.");
      }
      showToast(
        selectedPaths.length > 0
          ? "Selected entries extracted."
          : "Extraction complete.",
        "success",
      );
      clearPasswordFields();
    }
  } catch (err) {
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      hideProgress();
      log("Operation cancelled by user");
      return;
    }

    const raw = err instanceof Error ? err.message : String(err);
    log(`Error: ${raw}`);
    if (isDebugEnabled()) debugLog(`Selective extract threw: ${raw}`);
    const msg = userFacingBackendError(raw);
    setStatus("Error", 3000, msg);
    hideProgress();
    showToast(
      `Selective extraction failed: ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
  } finally {
    clearPasswordFields();
    setRunning(false);
  }
}
