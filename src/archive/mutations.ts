import { invoke } from "@tauri-apps/api/core";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { $, parseThreads } from "../utils";
import { SETTING_DEFAULTS, state } from "../state";
import { devLog, log, setRunning, setStatus } from "../ui";
import { normalizeCompressionSecurityOptions } from "../compression-security";
import { showToast } from "../toast";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import { buildCompressionMethodSwitches, readSplitSize } from "./args";
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

export async function addFilesToArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0]?.trim();
  if (!archive) {
    await message("Open an archive first to add files to it.", {
      title: "No archive",
      kind: "warning",
    });
    return;
  }

  const selection = await open({ multiple: true, directory: false });
  const files = Array.isArray(selection)
    ? selection
    : selection
      ? [selection]
      : [];
  if (files.length === 0) return;

  setRunning(true);
  try {
    if (!(await ensureRuntimeReady())) return;
    const threads = parseThreads(
      $<HTMLInputElement>("threads").value,
      SETTING_DEFAULTS.threads,
    );
    const args = ["u", "-sse"];
    if (threads) args.push(`-mmt=${threads}`);
    args.push(archive, "--", ...files);

    setStatus("Adding files");
    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
    const result = await invoke<Run7zResult>("run_7z", { args });
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
    void browseArchive();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`, "error");
    setStatus("Error", 3000, msg);
    await message(msg, { title: "Error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

export async function convertArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0]?.trim();
  if (!archive) {
    await message("Open an archive first to convert it.", {
      title: "No archive",
      kind: "warning",
    });
    return;
  }

  const format = $<HTMLSelectElement>("format").value;
  const dest = await save({
    title: "Convert archive to",
    defaultPath: `converted.${format === "gzip" ? "gz" : format}`,
  });
  if (!dest) return;

  setRunning(true);
  let tempDir: string | null = null;
  try {
    if (!(await ensureRuntimeReady())) return;
    tempDir = await invoke<string>("create_temp_extract_dir");

    const browsePassword = $<HTMLInputElement>("browse-password").value.trim();
    const extractPassword =
      $<HTMLInputElement>("extract-password").value.trim();
    const password = extractPassword || browsePassword;

    setStatus("Extracting for conversion");
    const extractArgs = ["x", `-o${tempDir}`, SAFE_EXTRACT_OVERWRITE_MODE];
    if (password) extractArgs.push(`-p${password}`);
    extractArgs.push("--", archive);
    const extract = await runWithPasswordRetry(extractArgs, true);
    if (extract.code !== 0) {
      setStatus("Error", 3000, extract.stderr || "Extraction failed.");
      await showOperationError(extract.code, extract.stdout, extract.stderr);
      return;
    }

    setStatus("Recompressing");
    const compress = ["a", "-sse", ...buildCompressionMethodSwitches(format)];
    const rawPassword = $<HTMLInputElement>("password").value;
    const rawEncryptHeaders = $<HTMLInputElement>("encrypt-headers").checked;
    const { password: compressPassword, encryptHeaders } =
      normalizeCompressionSecurityOptions(
        format,
        rawPassword,
        rawEncryptHeaders,
      );
    if (compressPassword) compress.push(`-p${compressPassword}`);
    if (compressPassword && format === "zip") compress.push("-mem=AES256");
    if (encryptHeaders) compress.push("-mhe=on");
    if ($<HTMLInputElement>("store-timestamps").checked) {
      compress.push("-mtc=on", "-mta=on");
    }
    const splitSize = readSplitSize();
    if (splitSize) compress.push(`-v${splitSize}`);
    compress.push(dest, "--", `${tempDir}/*`);

    const result = await invoke<Run7zResult>("run_7z", { args: compress });
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
