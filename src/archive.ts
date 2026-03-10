import { invoke } from "@tauri-apps/api/core";
import { message, confirm } from "@tauri-apps/plugin-dialog";
import { $, parseThreads, escapeHtml, formatSize, splitArgs } from "./utils";
import { SETTING_DEFAULTS, state } from "./state";
import { log, devLog, setStatus, setProgress, hideProgress, setRunning, getMode } from "./ui";
import { ensureArchivePaths, validateExtraArgs } from "./archive-rules";
import { formatCommandOutputForLogs } from "./output-logging";

function truncateForDialog(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
}

function logCommandResult(stdout: string, stderr: string) {
  const entries = formatCommandOutputForLogs(stdout, stderr, state.currentSettings.logVerbosity);
  for (const entry of entries) {
    log(entry.text, entry.level === "error" ? "error" : "info");
  }
}

interface Run7zResult {
  stdout: string;
  stderr: string;
  code: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

function logTruncationNotice(result: Run7zResult) {
  if (!result.stdout_truncated && !result.stderr_truncated) return;

  const streams: string[] = [];
  if (result.stdout_truncated) streams.push("stdout");
  if (result.stderr_truncated) streams.push("stderr");
  log(`7z ${streams.join(" and ")} output exceeded 50 MiB and was truncated.`, "error");
}

async function ensureRuntimeReady(): Promise<boolean> {
  try {
    await invoke("probe_7z");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`7-Zip runtime check failed: ${msg}`, "error");
    setStatus("Missing runtime dependency", 3000);
    hideProgress();
    await message(
      `The bundled 7-Zip binary could not be started.\n\n${msg}`,
      { title: "Missing runtime dependency", kind: "error" }
    );
    return false;
  }
}

export interface BrowseEntry {
  path: string;
  size: number;
  packedSize: number;
  modified: string;
  isFolder: boolean;
}

export interface ArchiveInfo {
  type: string;
  physicalSize: number;
  method: string;
  solid: boolean;
  entries: BrowseEntry[];
}

export function buildExtractArgsFor(archive: string): string[] {
  const dest = $<HTMLInputElement>("extract-path").value.trim();
  const password = $<HTMLInputElement>("extract-password").value.trim();
  const extraArgs = splitArgs($<HTMLInputElement>("extract-extra-args").value.trim());
  if (extraArgs.length > 0) validateExtraArgs(extraArgs);

  if (!dest) throw new Error("Choose a destination folder.");

  const args = ["x", archive, `-o${dest}`, "-y"];
  if (password) args.push(`-p${password}`);
  args.push(...extraArgs);
  return args;
}

export function buildArgs() {
  const mode = getMode();

  if (mode === "extract") {
    if (!state.inputs[0]) throw new Error("Select an archive to extract.");
    return buildExtractArgsFor(state.inputs[0]);
  }

  const extraArgs = splitArgs($<HTMLInputElement>("extra-args").value.trim());

  if (extraArgs.length > 0) {
    validateExtraArgs(extraArgs);
  }

  const outputPath = $<HTMLInputElement>("output-path").value.trim();
  if (!outputPath) {
    throw new Error("Choose an output archive path.");
  }
  if (state.inputs.length === 0) {
    throw new Error("Add at least one input.");
  }

  const format = $<HTMLSelectElement>("format").value;
  const level = $<HTMLSelectElement>("level").value;
  const method = $<HTMLSelectElement>("method").value;
  const dict = $<HTMLSelectElement>("dict").value;
  const wordSize = $<HTMLSelectElement>("word-size").value;
  const solid = $<HTMLSelectElement>("solid").value;
  const threadsRaw = $<HTMLInputElement>("threads").value;
  const threads = parseThreads(threadsRaw, SETTING_DEFAULTS.threads);
  const pathMode = $<HTMLSelectElement>("path-mode").value;
  const password = $<HTMLInputElement>("password").value.trim();
  const encryptHeaders = $<HTMLInputElement>("encrypt-headers").checked;
  const sfx = $<HTMLInputElement>("sfx").checked;
  const deleteAfter = $<HTMLInputElement>("delete-after").checked;

  const switches: string[] = [];
  switches.push(`-t${format}`);
  switches.push(`-mx=${level}`);
  if (method) switches.push(`-m0=${method}`);
  if (dict) switches.push(`-md=${dict}`);
  if (wordSize) switches.push(`-mfb=${wordSize}`);
  if (solid === "solid") {
    switches.push("-ms=on");
  } else if (solid !== "off") {
    switches.push(`-ms=${solid}`);
  }
  if (threads) switches.push(`-mmt=${threads}`);
  if (pathMode === "absolute") switches.push("-spf");
  if (password) switches.push(`-p${password}`);
  if (encryptHeaders) switches.push("-mhe=on");
  if (sfx) switches.push("-sfx");
  if (deleteAfter) switches.push("-sdel");

  const args = ["a", ...switches, outputPath, ...state.inputs, ...extraArgs];
  return args;
}

export function parseArchiveListing(stdout: string): ArchiveInfo {
  const lines = stdout.split("\n");
  const info: ArchiveInfo = { type: "", physicalSize: 0, method: "", solid: false, entries: [] };
  let inArchiveInfo = false;
  let inFiles = false;
  let current: Partial<BrowseEntry> = {};

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed === "--") {
      inArchiveInfo = true;
      continue;
    }

    if (trimmed.startsWith("----------")) {
      if (!inFiles) {
        inArchiveInfo = false;
        inFiles = true;
      } else if (current.path !== undefined) {
        info.entries.push({
          path: current.path,
          size: current.size ?? 0,
          packedSize: current.packedSize ?? 0,
          modified: current.modified ?? "",
          isFolder: current.isFolder ?? false,
        });
        current = {};
      }
      continue;
    }

    const eqIdx = trimmed.indexOf(" = ");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 3);

    if (inArchiveInfo) {
      if (key === "Type") info.type = value;
      else if (key === "Physical Size") info.physicalSize = parseInt(value) || 0;
      else if (key === "Method") info.method = value;
      else if (key === "Solid") info.solid = value === "+";
    } else if (inFiles) {
      if (key === "Path") current.path = value;
      else if (key === "Size") current.size = parseInt(value) || 0;
      else if (key === "Packed Size") current.packedSize = parseInt(value) || 0;
      else if (key === "Modified") current.modified = value;
      else if (key === "Folder") current.isFolder = value === "+";
    }
  }

  if (current.path !== undefined) {
    info.entries.push({
      path: current.path,
      size: current.size ?? 0,
      packedSize: current.packedSize ?? 0,
      modified: current.modified ?? "",
      isFolder: current.isFolder ?? false,
    });
  }

  return info;
}

export function renderBrowseTable(info: ArchiveInfo) {
  const container = document.getElementById("browse-contents");
  if (!container) return;
  container.hidden = false;

  const summary = document.getElementById("browse-summary");
  if (summary) {
    const totalSize = info.entries.reduce((sum, e) => sum + e.size, 0);
    const totalPacked = info.entries.reduce((sum, e) => sum + e.packedSize, 0);
    const fileCount = info.entries.filter(e => !e.isFolder).length;
    const folderCount = info.entries.filter(e => e.isFolder).length;
    const parts: string[] = [];
    parts.push(`<strong>${escapeHtml(info.type || "Archive")}</strong>`);
    if (info.method) parts.push(`Method: ${escapeHtml(info.method)}`);
    if (info.solid) parts.push("Solid");
    parts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}${folderCount > 0 ? `, ${folderCount} folder${folderCount !== 1 ? "s" : ""}` : ""}`);
    parts.push(`${formatSize(totalSize)} \u2192 ${formatSize(totalPacked)}`);
    summary.innerHTML = parts.join(" &nbsp;\u00b7&nbsp; ");
  }

  const tbody = document.getElementById("browse-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (info.entries.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "browse-empty";
    td.textContent = "Archive is empty.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const entry of info.entries) {
    const tr = document.createElement("tr");
    if (entry.isFolder) tr.className = "is-folder";

    const tdName = document.createElement("td");
    tdName.textContent = entry.path;
    tdName.title = entry.path;

    const tdSize = document.createElement("td");
    tdSize.className = "size-col";
    tdSize.textContent = entry.isFolder ? "\u2014" : formatSize(entry.size);

    const tdPacked = document.createElement("td");
    tdPacked.className = "size-col";
    tdPacked.textContent = entry.isFolder ? "\u2014" : formatSize(entry.packedSize);

    const tdModified = document.createElement("td");
    tdModified.textContent = entry.modified;

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdPacked);
    tr.appendChild(tdModified);
    tbody.appendChild(tr);
  }
}

export async function runAction() {
  if (state.running) return;

  const mode = getMode();

  if (mode === "extract" && state.inputs.length > 1) {
    return runBatchExtract();
  }

  if (!(await ensureRuntimeReady())) return;

  try {
    state.batchCancelled = false;
    state.cancelRequested = false;

    if (mode === "add") {
      const deleteAfter = $<HTMLInputElement>("delete-after").checked;
      if (deleteAfter) {
        const confirmed = await confirm(
          "This will permanently delete source files after compression. Continue?",
          { title: "Confirm deletion", kind: "warning", okLabel: "Delete files" }
        );
        if (!confirmed) return;
      }
    }

    let args: string[];
    if (mode === "extract") {
      if (!state.inputs[0]) throw new Error("Select an archive to extract.");
      await ensureArchivePaths([state.inputs[0]], "extract");
      args = buildExtractArgsFor(state.inputs[0]);
    } else {
      args = buildArgs();
    }

    const logSafe = args.map(a => a.startsWith("-p") ? "-p***" : a);
    devLog(`7z ${logSafe.join(" ")}`);

    setRunning(true);
    setStatus("Running");

    const result = await invoke<Run7zResult>("run_7z", { args });
    if (state.cancelRequested) {
      hideProgress();
      setStatus("Cancelled", 2000);
      log("Operation cancelled by user");
      return;
    }

    const outputLines = result.stdout.split('\n');
    for (const line of outputLines) {
      const percentMatch = line.match(/(\d+)%/);
      if (percentMatch) {
        setProgress(`${percentMatch[1]}%`);
      }
    }

    logCommandResult(result.stdout, result.stderr);
    logTruncationNotice(result);
    devLog(`Exit code: ${result.code}`);

    if (result.code !== 0) {
      log(`7z exited with code ${result.code}`);
      setStatus("Error", 3000);
      hideProgress();
      const errorDetails = result.stderr ? `\n\n${truncateForDialog(result.stderr.trim())}` : "";
      await message(`Operation failed with exit code ${result.code}.${errorDetails}`, { title: "Operation failed", kind: "error" });
    } else {
      setStatus("Done", 2000);
      hideProgress();
      await message(mode === "extract" ? "Extraction completed successfully." : "Archive created successfully.", { title: "Done" });
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
    setStatus("Error", 3000);
    hideProgress();
    await message(messageText, { title: "Error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

export async function runBatchExtract() {
  try {
    if (!(await ensureRuntimeReady())) return;

    state.batchCancelled = false;
    state.cancelRequested = false;
    const archives = [...state.inputs];
    await ensureArchivePaths(archives, "extract");

    const dest = $<HTMLInputElement>("extract-path").value.trim();
    if (!dest) throw new Error("Choose a destination folder.");
    const password = $<HTMLInputElement>("extract-password").value.trim();
    const extraArgs = splitArgs($<HTMLInputElement>("extract-extra-args").value.trim());
    if (extraArgs.length > 0) validateExtraArgs(extraArgs);

    setRunning(true);
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < archives.length; i++) {
      if (state.batchCancelled || state.cancelRequested) break;

      const archive = archives[i];
      setStatus(`Extracting ${i + 1} of ${archives.length}`);

      try {
        const args = ["x", archive, `-o${dest}`, "-y"];
        if (password) args.push(`-p${password}`);
        args.push(...extraArgs);
        const logSafe = args.map(a => a.startsWith("-p") ? "-p***" : a);
        devLog(`7z ${logSafe.join(" ")}`);

        const result = await invoke<Run7zResult>("run_7z", { args });

        const outputLines = result.stdout.split('\n');
        for (const line of outputLines) {
          const percentMatch = line.match(/(\d+)%/);
          if (percentMatch) setProgress(`${percentMatch[1]}% (${i + 1}/${archives.length})`);
        }

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
    if (state.batchCancelled || state.cancelRequested) {
      setStatus("Batch cancelled", 3000);
      await message("Batch extraction was cancelled.", { title: "Cancelled" });
    } else if (failed === 0) {
      setStatus(`Done \u2014 ${succeeded} archive(s) extracted`, 3000);
      await message(`Successfully extracted ${succeeded} archive${succeeded !== 1 ? "s" : ""}.`, { title: "Batch extraction complete" });
    } else {
      setStatus(`Done \u2014 ${succeeded} succeeded, ${failed} failed`, 4000);
      await message(`${succeeded} succeeded, ${failed} failed.`, { title: "Batch extraction complete", kind: "warning" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`);
    setStatus("Error", 3000);
    hideProgress();
    await message(msg, { title: "Extraction error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

export async function cancelAction() {
  state.batchCancelled = true;
  state.cancelRequested = true;
  setStatus("Cancelling...");
  try {
    await invoke("cancel_7z");
    devLog("Cancel signal sent to running process.");
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    devLog(`Cancel error: ${messageText}`);
  }
}

export async function testArchive() {
  if (state.running) return;
  const archive = state.inputs[0];
  if (!archive) {
    await message("Select an archive to test.", { title: "No archive selected" });
    return;
  }
  try {
    await ensureArchivePaths([archive], "test");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, { title: "Invalid input", kind: "error" });
    return;
  }

  const mode = getMode();
  const passwordField = mode === "browse" ? "browse-password" : "extract-password";
  const password = $<HTMLInputElement>(passwordField).value.trim();

  const args = ["t", archive];
  if (password) args.push(`-p${password}`);

  if (!(await ensureRuntimeReady())) return;

  setRunning(true);
  setStatus("Testing archive integrity");

  try {
    const result = await invoke<Run7zResult>("run_7z", { args });

    logCommandResult(result.stdout, result.stderr);
    logTruncationNotice(result);

    if (result.code === 0) {
      setStatus("Integrity test passed", 3000);
      log("Archive integrity test: OK");
      await message("Archive integrity test passed. No errors found.", { title: "Test passed" });
    } else {
      setStatus("Integrity test failed", 3000);
      log(`Archive integrity test: FAILED (exit code ${result.code})`);
      const errorDetails = result.stderr ? `\n\n${truncateForDialog(result.stderr.trim())}` : "";
      await message(`Archive integrity test failed (exit code ${result.code}).${errorDetails}`, { title: "Test failed", kind: "error" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Test error: ${msg}`);
    setStatus("Error", 3000);
    await message(msg, { title: "Test error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

export async function browseArchive() {
  if (state.running) return;
  const archive = state.inputs[0];
  if (!archive) {
    await message("Select an archive to browse.", { title: "No archive selected" });
    return;
  }
  try {
    await ensureArchivePaths([archive], "browse");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, { title: "Invalid input", kind: "error" });
    return;
  }

  const password = $<HTMLInputElement>("browse-password").value.trim();
  const args = ["l", "-slt", archive];
  if (password) args.push(`-p${password}`);

  if (!(await ensureRuntimeReady())) return;

  setRunning(true);
  setStatus("Listing archive contents");

  try {
    const result = await invoke<Run7zResult>("run_7z", { args });
    logTruncationNotice(result);

    if (result.code !== 0) {
      logCommandResult(result.stdout, result.stderr);
      setStatus("Failed to list archive", 3000);
      const errorDetails = result.stderr ? `\n\n${truncateForDialog(result.stderr.trim())}` : "";
      await message(`Failed to list archive contents (exit code ${result.code}).${errorDetails}`, { title: "Browse failed", kind: "error" });
      return;
    }

    const info = parseArchiveListing(result.stdout);
    renderBrowseTable(info);
    setStatus(`${info.entries.length} entries listed`, 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Browse error: ${msg}`);
    setStatus("Error", 3000);
    await message(msg, { title: "Browse error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

export async function previewCommand() {
  try {
    const args = buildArgs();
    const sanitized = args.map(arg => {
      if (arg.startsWith("-p")) return "-p***";
      return arg;
    });
    await message(`7z ${sanitized.join(" ")}`, { title: "Command preview" });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await message(messageText, { title: "Missing info" });
  }
}
