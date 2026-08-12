import { invoke } from "@tauri-apps/api/core";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { $, parseThreads } from "../utils";
import { SETTING_DEFAULTS, state } from "../state";
import { devLog, getMode, log, setRunning, setStatus } from "../ui";
import {
  acquireIncomingPathLock,
  isIncomingPathBusy,
  releaseIncomingPathLock,
} from "../incoming-paths";
import { ensureArchivePaths } from "../archive-rules";
import {
  normalizeCompressionSecurityOptions,
  validateCompressionSecurityOptions,
} from "../compression-security";
import { showToast } from "../toast";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import { debugLog, debugLogCommand, isDebugEnabled } from "../debug-mode";
import {
  buildCompressionMethodSwitches,
  readSplitSize,
  validateArchiveOutputExtension,
} from "./args";
import { browseArchive } from "./inspection";
import { sanitizeCommandArgsForPreview } from "./preview";
import {
  clearPasswordFields,
  ensureRuntimeReady,
  logCommandResult,
  runWithPasswordRetry,
  showOperationError,
  type Run7zResult,
} from "./runtime";
import { confirmZipSymlinkRisk } from "./compress-fidelity";

let mutationDialogOpen = false;

type MutationDialogLease<T> = {
  value: T;
  release: () => void;
};

async function runMutationDialog<T>(
  dialog: () => Promise<T>,
): Promise<MutationDialogLease<T> | null> {
  if (mutationDialogOpen || isIncomingPathBusy()) return null;
  mutationDialogOpen = true;
  let locked = false;
  let leased = false;
  const release = () => {
    if (locked) {
      locked = false;
      releaseIncomingPathLock();
    }
    mutationDialogOpen = false;
  };
  try {
    await acquireIncomingPathLock();
    locked = true;
    const mode = getMode();
    const inputs = JSON.stringify(state.inputs);
    const value = await dialog();
    if (
      state.running ||
      state.operationPreparing ||
      getMode() !== mode ||
      JSON.stringify(state.inputs) !== inputs
    ) {
      return null;
    }
    leased = true;
    return { value, release };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open archive mutation dialog: ${msg}`, "error");
    setStatus("Could not open the file dialog", 3000);
    return null;
  } finally {
    if (!leased) release();
  }
}

export async function addFilesToArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0];
  if (!archive) {
    await message("Open an archive first to add files to it.", {
      title: "No archive",
      kind: "warning",
    });
    return;
  }
  if (!/\.(?:7z|zip|tar)$/i.test(archive)) {
    await message(
      "This archive format cannot be updated in place. Convert it to 7z, ZIP, or TAR, or create a new archive.",
      { title: "Update unavailable", kind: "warning" },
    );
    return;
  }

  const picked = await runMutationDialog(() =>
    open({ multiple: true, directory: false }),
  );
  if (!picked) return;
  const selection = picked.value;
  const files = Array.isArray(selection)
    ? selection
    : selection
      ? [selection]
      : [];
  if (files.length === 0) {
    picked.release();
    return;
  }

  let refreshAfterRun = false;
  state.cancelRequested = false;
  setRunning(true);
  picked.release();
  try {
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
    if (!validation?.identity) {
      throw new Error("Could not capture a stable archive identity.");
    }
    const threads = parseThreads(
      $<HTMLInputElement>("threads").value,
      SETTING_DEFAULTS.threads,
    );
    const args = ["u", "-sse", "-snl", "-snh", "-spd"];
    const archivePassword = $<HTMLInputElement>("browse-password").value;
    if (archivePassword) args.push(`-p${archivePassword}`);
    if (threads) args.push(`-mmt=${threads}`);
    args.push(archive, "--", ...files);

    const zipDest = archive.toLowerCase().endsWith(".zip");
    if (zipDest && !(await confirmZipSymlinkRisk("zip", files))) {
      setStatus("Cancelled", 2000);
      return;
    }

    setStatus("Adding files");
    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
    debugLogCommand(args);
    const result = await runWithPasswordRetry(
      args,
      true,
      "Add files",
      validation.identity,
    );
    if (state.cancelRequested && result.code !== 0) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(result.stdout, result.stderr, result.code);

    if (result.code !== 0) {
      setStatus("Error", 3000, result.stderr || "Operation failed.");
      if (isDebugEnabled()) {
        debugLog(`Add files failed with exit code ${result.code}.`);
      }
      await showOperationError(result.code, result.stdout, result.stderr);
      return;
    }

    setStatus("Done", 2000);
    if (isDebugEnabled()) {
      debugLog(`Added ${files.length} file(s) to archive.`);
    }
    showToast(
      `Added ${files.length} file${files.length === 1 ? "" : "s"} to the archive.`,
      "success",
    );
    refreshAfterRun = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`, "error");
    if (isDebugEnabled()) debugLog(`Add files threw: ${msg}`);
    setStatus("Error", 3000, msg);
    await message(msg, { title: "Error", kind: "error" });
  } finally {
    setRunning(false);
    if (!refreshAfterRun) clearPasswordFields();
  }
  if (refreshAfterRun) await browseArchive();
  clearPasswordFields();
}

export async function convertArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0];
  if (!archive) {
    await message("Open an archive first to convert it.", {
      title: "No archive",
      kind: "warning",
    });
    return;
  }

  const format = $<HTMLSelectElement>("format").value;
  const rawPassword = $<HTMLInputElement>("password").value;
  const rawEncryptHeaders = $<HTMLInputElement>("encrypt-headers").checked;
  const securityError = validateCompressionSecurityOptions(
    format,
    rawPassword,
    rawEncryptHeaders,
  );
  if (securityError) {
    await message(securityError, { title: "Invalid encryption options" });
    return;
  }
  const { password: compressPassword, encryptHeaders } =
    normalizeCompressionSecurityOptions(format, rawPassword, rawEncryptHeaders);
  const picked = await runMutationDialog(() =>
    save({
      title: "Convert archive to",
      defaultPath: `converted.${format === "gzip" ? "gz" : format === "bzip2" ? "bz2" : format}`,
    }),
  );
  if (!picked) return;
  const dest = picked.value;
  if (!dest) {
    picked.release();
    return;
  }
  if ($<HTMLSelectElement>("format").value !== format) {
    picked.release();
    return;
  }
  const extensionError = validateArchiveOutputExtension(dest, format);
  if (extensionError) {
    picked.release();
    await message(extensionError, {
      title: "Invalid output filename",
      kind: "warning",
    });
    return;
  }

  // Snapshot before the long extract so a file created in that window cannot
  // be mistaken for an intentional overwrite target at recompress time.
  let outputSelectionToken: string;
  try {
    outputSelectionToken = await invoke<string>(
      "archive_output_selection_token",
      {
        path: dest,
      },
    );
  } catch (err) {
    picked.release();
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, { title: "Conversion error", kind: "error" });
    return;
  }

  state.cancelRequested = false;
  setRunning(true);
  picked.release();
  let tempDir: string | null = null;
  try {
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
    if (!validation?.identity) {
      throw new Error("Could not capture a stable archive identity.");
    }
    tempDir = await invoke<string>("create_temp_extract_dir");

    const browsePassword = $<HTMLInputElement>("browse-password").value;
    const extractPassword = $<HTMLInputElement>("extract-password").value;
    const password = extractPassword || browsePassword;

    setStatus("Extracting for conversion");
    const extractArgs = [
      "x",
      `-o${tempDir}`,
      SAFE_EXTRACT_OVERWRITE_MODE,
      "-bb1",
      "-bsp1",
      "-spd",
    ];
    if (password) extractArgs.push(`-p${password}`);
    extractArgs.push("--", archive);
    debugLogCommand(extractArgs);
    const extract = await runWithPasswordRetry(
      extractArgs,
      true,
      "Extract",
      validation.identity,
    );
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(extract.stdout, extract.stderr, extract.code);
    if (extract.code !== 0) {
      setStatus("Error", 3000, extract.stderr || "Extraction failed.");
      if (isDebugEnabled()) {
        debugLog(`Convert extract failed with exit code ${extract.code}.`);
      }
      await showOperationError(extract.code, extract.stdout, extract.stderr);
      return;
    }

    setStatus("Recompressing");
    const compress = [
      "a",
      "-sse",
      "-snl",
      "-snh",
      "-spd",
      ...buildCompressionMethodSwitches(format),
    ];
    if (compressPassword) compress.push(`-p${compressPassword}`);
    if (compressPassword && format === "zip") compress.push("-mem=AES256");
    if (encryptHeaders) compress.push("-mhe=on");
    if ($<HTMLInputElement>("store-timestamps").checked) {
      compress.push("-mtc=on", "-mta=on");
    }
    const splitSize = readSplitSize();
    if (splitSize) compress.push(`-v${splitSize}`);
    // List children explicitly (includes dotfiles). `tempDir/*` drops `.*`.
    const children = await invoke<string[]>("list_managed_temp_children", {
      path: tempDir,
    });
    if (children.length === 0) {
      throw new Error("Conversion extract produced no files to recompress.");
    }
    if (["gzip", "bzip2", "xz"].includes(format) && children.length !== 1) {
      throw new Error(
        "GZIP, BZIP2, and XZ can contain exactly one file. Convert this archive to TAR or 7z instead.",
      );
    }
    if (!(await confirmZipSymlinkRisk(format, children))) {
      setStatus("Cancelled", 2000);
      return;
    }
    compress.push(dest, "--", ...children);

    debugLogCommand(compress);
    const result = await invoke<Run7zResult>("run_7z", {
      args: compress,
      expectedArchiveIdentity: outputSelectionToken,
    });
    if (state.cancelRequested && result.code !== 0) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(result.stdout, result.stderr, result.code);
    if (result.code !== 0) {
      setStatus("Error", 3000, result.stderr || "Conversion failed.");
      if (isDebugEnabled()) {
        debugLog(`Convert failed with exit code ${result.code}.`);
      }
      await showOperationError(result.code, result.stdout, result.stderr);
      return;
    }

    setStatus("Done", 2000);
    if (isDebugEnabled()) {
      debugLog(`Converted archive to ${format.toUpperCase()}.`);
    }
    showToast(`Converted archive to ${format.toUpperCase()}.`, "success");
    clearPasswordFields();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`, "error");
    if (isDebugEnabled()) debugLog(`Convert threw: ${msg}`);
    setStatus("Error", 3000, msg);
    await message(msg, { title: "Conversion error", kind: "error" });
  } finally {
    if (tempDir) {
      try {
        await invoke("remove_managed_temp_dir", { path: tempDir });
      } catch (err) {
        devLog(
          `Failed to clean up temp dir: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    clearPasswordFields();
    setRunning(false);
  }
}
