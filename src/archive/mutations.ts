import { invoke } from "@tauri-apps/api/core";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { $, parseThreads } from "../utils";
import { SETTING_DEFAULTS, state } from "../state";
import { devLog, log, setRunning, setStatus } from "../ui";
import {
  normalizeCompressionSecurityOptions,
  validateCompressionSecurityOptions,
} from "../compression-security";
import { showToast } from "../toast";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
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

async function runMutationDialog<T>(
  dialog: () => Promise<T>,
): Promise<T | null> {
  if (mutationDialogOpen || state.running) return null;
  mutationDialogOpen = true;
  try {
    return await dialog();
  } finally {
    mutationDialogOpen = false;
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

  const selection = await runMutationDialog(() =>
    open({ multiple: true, directory: false }),
  );
  const files = Array.isArray(selection)
    ? selection
    : selection
      ? [selection]
      : [];
  if (files.length === 0) return;

  let refreshAfterRun = false;
  setRunning(true);
  state.cancelRequested = false;
  try {
    if (!(await ensureRuntimeReady())) return;
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
    const result = await runWithPasswordRetry(args, true, "Add files");
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(result.stdout, result.stderr);

    if (result.code !== 0) {
      setStatus("Error", 3000, result.stderr || "Operation failed.");
      await showOperationError(result.code, result.stdout, result.stderr);
      return;
    }

    setStatus("Done", 2000);
    showToast(
      `Added ${files.length} file${files.length === 1 ? "" : "s"} to the archive.`,
      "success",
    );
    refreshAfterRun = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`, "error");
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
  const dest = await runMutationDialog(() =>
    save({
      title: "Convert archive to",
      defaultPath: `converted.${format === "gzip" ? "gz" : format === "bzip2" ? "bz2" : format}`,
    }),
  );
  if (!dest) return;
  const extensionError = validateArchiveOutputExtension(dest, format);
  if (extensionError) {
    await message(extensionError, {
      title: "Invalid output filename",
      kind: "warning",
    });
    return;
  }

  setRunning(true);
  state.cancelRequested = false;
  let tempDir: string | null = null;
  try {
    if (!(await ensureRuntimeReady())) return;
    tempDir = await invoke<string>("create_temp_extract_dir");

    const browsePassword = $<HTMLInputElement>("browse-password").value;
    const extractPassword = $<HTMLInputElement>("extract-password").value;
    const password = extractPassword || browsePassword;

    setStatus("Extracting for conversion");
    const extractArgs = ["x", `-o${tempDir}`, SAFE_EXTRACT_OVERWRITE_MODE];
    if (password) extractArgs.push(`-p${password}`);
    extractArgs.push("--", archive);
    const extract = await runWithPasswordRetry(extractArgs, true);
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    if (extract.code !== 0) {
      setStatus("Error", 3000, extract.stderr || "Extraction failed.");
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

    const result = await invoke<Run7zResult>("run_7z", { args: compress });
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(result.stdout, result.stderr);
    if (result.code !== 0) {
      setStatus("Error", 3000, result.stderr || "Conversion failed.");
      await showOperationError(result.code, result.stdout, result.stderr);
      return;
    }

    setStatus("Done", 2000);
    showToast(`Converted archive to ${format.toUpperCase()}.`, "success");
    clearPasswordFields();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`, "error");
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
