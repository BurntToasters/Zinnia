import { invoke } from "@tauri-apps/api/core";
import { message, confirm } from "@tauri-apps/plugin-dialog";
import {
  $,
  parseThreads,
  escapeHtml,
  formatSize,
  splitArgs,
  trapFocus,
  releaseFocusTrap,
} from "./utils";
import {
  SETTING_DEFAULTS,
  state,
  cacheBrowseInfo,
  cacheSelection,
} from "./state";
import {
  log,
  devLog,
  setStatus,
  setProgress,
  hideProgress,
  setRunning,
  getMode,
  setBrowsePasswordFieldVisible,
} from "./ui";
import { ensureArchivePaths, validateExtraArgs } from "./archive-rules";
import { formatCommandOutputForLogs } from "./output-logging";
import {
  normalizeCompressionSecurityOptions,
  validateCompressionSecurityOptions,
} from "./compression-security";
import type { ArchiveInfo, BrowseEntry } from "./browse-model";
import { resolveExtractDestinationAutofill } from "./extract-path";
import {
  buildSelectiveExtractArgs,
  clearPathSelection,
  filterBrowseEntriesByQuery,
  selectEntries,
  toggleEntrySelection,
} from "./selective-extract";

export function truncateForDialog(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
}

function logCommandResult(stdout: string, stderr: string) {
  const entries = formatCommandOutputForLogs(
    stdout,
    stderr,
    state.currentSettings.logVerbosity,
  );
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

let commandPreviewTrigger: HTMLElement | null = null;
let commandPreviewCopyTimer: number | undefined;

function setCommandPreviewCopyButton(copied: boolean): void {
  const btn = document.getElementById(
    "copy-command-preview",
  ) as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = copied ? "Copied" : "Copy";
  btn.setAttribute("aria-label", copied ? "Command copied" : "Copy command");
}

function resetCommandPreviewCopyStateSoon(): void {
  if (commandPreviewCopyTimer !== undefined) {
    clearTimeout(commandPreviewCopyTimer);
  }
  commandPreviewCopyTimer = window.setTimeout(() => {
    setCommandPreviewCopyButton(false);
  }, 1300);
}

function logTruncationNotice(result: Run7zResult) {
  if (!result.stdout_truncated && !result.stderr_truncated) return;

  const streams: string[] = [];
  if (result.stdout_truncated) streams.push("stdout");
  if (result.stderr_truncated) streams.push("stderr");
  log(
    `7z ${streams.join(" and ")} output exceeded 50 MiB and was truncated.`,
    "error",
  );
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
    await message(`The bundled 7-Zip binary could not be started.\n\n${msg}`, {
      title: "Missing runtime dependency",
      kind: "error",
    });
    return false;
  }
}

export function isEncryptedFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "+" ||
    normalized === "yes" ||
    normalized === "true" ||
    normalized === "1"
  );
}

export function methodLooksEncrypted(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("7zaes") ||
    normalized.includes("aes") ||
    normalized.includes("zipcrypto")
  );
}

export function looksLikePasswordRequiredError(
  stdout: string,
  stderr: string,
): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("wrong password") ||
    combined.includes("can not open encrypted archive") ||
    combined.includes("can't open encrypted archive") ||
    combined.includes("data error in encrypted file") ||
    combined.includes("encrypted headers") ||
    combined.includes("enter password") ||
    combined.includes("is encrypted")
  );
}

export function buildExtractArgsFor(
  archive: string,
  selectedPaths: string[] = [],
  passwordOverride?: string,
  destinationOverride?: string,
): string[] {
  const dest =
    destinationOverride?.trim() ??
    $<HTMLInputElement>("extract-path").value.trim();
  const password = (
    passwordOverride ?? $<HTMLInputElement>("extract-password").value
  ).trim();
  const extraArgs = splitArgs(
    $<HTMLInputElement>("extract-extra-args").value.trim(),
  );
  if (extraArgs.length > 0) validateExtraArgs(extraArgs);

  if (!dest) throw new Error("Choose a destination folder.");

  return buildSelectiveExtractArgs(
    archive,
    dest,
    password,
    extraArgs,
    selectedPaths,
  );
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
  const rawPassword = $<HTMLInputElement>("password").value;
  const rawEncryptHeaders = $<HTMLInputElement>("encrypt-headers").checked;
  const sfx = $<HTMLInputElement>("sfx").checked;
  const deleteAfter = $<HTMLInputElement>("delete-after").checked;

  const validationError = validateCompressionSecurityOptions(
    format,
    rawPassword,
    rawEncryptHeaders,
  );
  if (validationError) {
    throw new Error(validationError);
  }

  const { password, encryptHeaders } = normalizeCompressionSecurityOptions(
    format,
    rawPassword,
    rawEncryptHeaders,
  );

  const switches: string[] = [];
  switches.push(`-t${format}`);
  switches.push(`-mx=${level}`);
  if (method) switches.push(`-m0=${method}`);
  if (dict) switches.push(`-md=${dict}`);
  if (wordSize) switches.push(`-mfb=${wordSize}`);
  if (format === "7z") {
    if (solid === "solid") {
      switches.push("-ms=on");
    } else if (solid === "off") {
      switches.push("-ms=off");
    } else {
      switches.push(`-ms=${solid}`);
    }
  }
  if (threads) switches.push(`-mmt=${threads}`);
  if (pathMode === "absolute") switches.push("-spf");
  if (password) switches.push(`-p${password}`);
  if (encryptHeaders) switches.push("-mhe=on");
  if (sfx) switches.push("-sfx");
  if (deleteAfter) switches.push("-sdel");

  const args = [
    "a",
    ...switches,
    ...extraArgs,
    outputPath,
    "--",
    ...state.inputs,
  ];
  return args;
}

export function parseArchiveListing(stdout: string): ArchiveInfo {
  const lines = stdout.split(/\r?\n/);
  const info: ArchiveInfo = {
    type: "",
    physicalSize: 0,
    method: "",
    solid: false,
    encrypted: false,
    entries: [],
  };
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
      else if (key === "Physical Size")
        info.physicalSize = parseInt(value) || 0;
      else if (key === "Method") {
        info.method = value;
        if (methodLooksEncrypted(value)) info.encrypted = true;
      } else if (key === "Solid") info.solid = value === "+";
      else if (key === "Encrypted" && isEncryptedFlag(value))
        info.encrypted = true;
    } else if (inFiles) {
      if (key === "Path") current.path = value;
      else if (key === "Size") current.size = parseInt(value) || 0;
      else if (key === "Packed Size") current.packedSize = parseInt(value) || 0;
      else if (key === "Modified") current.modified = value;
      else if (key === "Folder") current.isFolder = value === "+";
      else if (key === "Encrypted" && isEncryptedFlag(value))
        info.encrypted = true;
      else if (key === "Method" && methodLooksEncrypted(value))
        info.encrypted = true;
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
    const fileCount = info.entries.filter((e) => !e.isFolder).length;
    const folderCount = info.entries.filter((e) => e.isFolder).length;
    const parts: string[] = [];
    parts.push(`<strong>${escapeHtml(info.type || "Archive")}</strong>`);
    if (info.method) parts.push(`Method: ${escapeHtml(info.method)}`);
    if (info.solid) parts.push("Solid");
    if (info.encrypted) parts.push("Encrypted");
    parts.push(
      `${fileCount} file${fileCount !== 1 ? "s" : ""}${folderCount > 0 ? `, ${folderCount} folder${folderCount !== 1 ? "s" : ""}` : ""}`,
    );
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
    tdPacked.textContent = entry.isFolder
      ? "\u2014"
      : formatSize(entry.packedSize);

    const tdModified = document.createElement("td");
    tdModified.textContent = entry.modified;

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdPacked);
    tr.appendChild(tdModified);
    tbody.appendChild(tr);
  }

  const basicTbody = document.getElementById("basic-browse-tbody");
  if (basicTbody) {
    basicTbody.innerHTML = "";
    for (const entry of info.entries) {
      const tr = document.createElement("tr");
      if (entry.isFolder) tr.className = "browse-folder";

      const tdName = document.createElement("td");
      tdName.textContent = entry.path;
      tdName.title = entry.path;
      tdName.style.wordBreak = "break-all";

      const tdSize = document.createElement("td");
      tdSize.style.fontVariantNumeric = "tabular-nums";
      tdSize.textContent = entry.isFolder ? "\u2014" : formatSize(entry.size);

      const tdPacked = document.createElement("td");
      tdPacked.style.fontVariantNumeric = "tabular-nums";
      tdPacked.textContent = entry.isFolder
        ? "\u2014"
        : formatSize(entry.packedSize);

      const tdModified = document.createElement("td");
      tdModified.textContent = entry.modified;

      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdPacked);
      tr.appendChild(tdModified);
      basicTbody.appendChild(tr);
    }
  }

  const basicSummary = document.getElementById("basic-browse-summary");
  if (basicSummary && summary) {
    basicSummary.innerHTML = summary.innerHTML;
  }
}

function getOrCreateSelection(archive: string): Set<string> {
  const existing = state.browseSelectionsByArchive.get(archive);
  if (existing) return existing;
  const created = new Set<string>();
  cacheSelection(archive, created);
  return created;
}

function getCachedArchiveInfo(archive: string): ArchiveInfo | null {
  return state.browseArchiveInfoByPath.get(archive) ?? null;
}

function getCurrentArchiveSelectionPaths(
  archive: string,
  info: ArchiveInfo,
): string[] {
  const selected = state.browseSelectionsByArchive.get(archive);
  if (!selected || selected.size === 0) return [];
  return info.entries
    .filter((entry) => selected.has(entry.path))
    .map((entry) => entry.path);
}

function renderSelectiveEntryList(
  archive: string,
  entries: BrowseEntry[],
  allEntries: BrowseEntry[],
): void {
  const list = document.getElementById("selective-list");
  if (!list) return;
  list.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "selective-empty";
    empty.textContent = "No archive entries match this search.";
    list.appendChild(empty);
    return;
  }

  const selected = getOrCreateSelection(archive);
  for (const entry of entries) {
    const row = document.createElement("label");
    row.className = "selective-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(entry.path);
    checkbox.disabled = state.running;
    checkbox.addEventListener("change", () => {
      const current = getOrCreateSelection(archive);
      const next = toggleEntrySelection(current, entry, allEntries);
      cacheSelection(archive, next);
      renderSelectiveExtractModal();
    });

    const path = document.createElement("span");
    path.className = "selective-row__path";
    path.textContent = entry.path;
    path.title = entry.path;

    const meta = document.createElement("span");
    meta.className = "selective-row__meta";
    const kind = entry.isFolder ? "Folder" : "File";
    const size = entry.isFolder ? "\u2014" : formatSize(entry.size);
    meta.textContent = `${kind} \u00b7 ${size}`;

    row.appendChild(checkbox);
    row.appendChild(path);
    row.appendChild(meta);
    list.appendChild(row);
  }
}

export function renderSelectiveExtractModal(): void {
  const archive = state.selectiveActiveArchive;
  if (!archive) return;
  const info = getCachedArchiveInfo(archive);
  if (!info) return;

  const filteredEntries = filterBrowseEntriesByQuery(
    info.entries,
    state.selectiveSearchQuery,
  );
  state.selectiveVisiblePaths = filteredEntries.map((entry) => entry.path);

  renderSelectiveEntryList(archive, filteredEntries, info.entries);

  const summary = document.getElementById("selective-summary");
  if (summary) {
    const selectedCount = getOrCreateSelection(archive).size;
    const shownCount = filteredEntries.length;
    summary.textContent = `${selectedCount} selected \u00b7 ${shownCount} shown \u00b7 ${info.entries.length} total`;
  }
}

function ensureExtractDestinationDefaultFromArchive(archive: string): void {
  const extractPath = $<HTMLInputElement>("extract-path");
  const next = resolveExtractDestinationAutofill(
    extractPath.value,
    state.lastAutoExtractDestination,
    archive,
  );
  if (!next) return;
  extractPath.value = next;
  state.lastAutoExtractDestination = next;
}

function syncSelectiveDestinationWithExtractInput(): void {
  const selectiveDest = document.getElementById(
    "selective-dest",
  ) as HTMLInputElement | null;
  const extractPath = document.getElementById(
    "extract-path",
  ) as HTMLInputElement | null;
  if (!selectiveDest || !extractPath) return;
  selectiveDest.value = extractPath.value.trim();
}

async function ensureArchiveInfoForPicker(
  archive: string,
): Promise<ArchiveInfo | null> {
  const cached = getCachedArchiveInfo(archive);
  if (cached) return cached;
  if (state.inputs[0] !== archive) {
    state.inputs[0] = archive;
  }
  return await browseArchive();
}

export function closeSelectiveExtractModal(): void {
  const overlay = document.getElementById("selective-overlay");
  if (overlay) {
    (overlay as HTMLElement).hidden = true;
    const modal = overlay.querySelector<HTMLElement>(".modal");
    if (modal) releaseFocusTrap(modal);
  }
  state.selectiveSearchQuery = "";
  state.selectiveActiveArchive = null;
  state.selectiveVisiblePaths = [];
}

export function setSelectiveExtractSearch(query: string): void {
  state.selectiveSearchQuery = query;
  renderSelectiveExtractModal();
}

export function selectAllVisibleInPicker(): void {
  const archive = state.selectiveActiveArchive;
  if (!archive) return;
  const info = getCachedArchiveInfo(archive);
  if (!info) return;
  const visibleEntries = filterBrowseEntriesByQuery(
    info.entries,
    state.selectiveSearchQuery,
  );
  const current = getOrCreateSelection(archive);
  const next = selectEntries(current, visibleEntries, info.entries);
  cacheSelection(archive, next);
  renderSelectiveExtractModal();
}

export function clearPickerSelection(): void {
  const archive = state.selectiveActiveArchive;
  if (!archive) return;
  cacheSelection(archive, clearPathSelection());
  renderSelectiveExtractModal();
}

export async function openSelectiveExtractModal(): Promise<void> {
  if (state.running) return;

  const archive = state.inputs[0];
  if (!archive) {
    await message("Select an archive to browse first.", {
      title: "No archive selected",
    });
    return;
  }

  try {
    await ensureArchivePaths([archive], "browse");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, { title: "Invalid input", kind: "error" });
    return;
  }

  const info = await ensureArchiveInfoForPicker(archive);
  if (!info) return;

  ensureExtractDestinationDefaultFromArchive(archive);
  syncSelectiveDestinationWithExtractInput();

  state.selectiveActiveArchive = archive;
  state.selectiveSearchQuery = "";
  getOrCreateSelection(archive);

  const search = document.getElementById(
    "selective-search",
  ) as HTMLInputElement | null;
  if (search) search.value = "";

  const overlay = document.getElementById(
    "selective-overlay",
  ) as HTMLElement | null;
  if (overlay) {
    overlay.hidden = false;
    const modal = overlay.querySelector<HTMLElement>(".modal");
    if (modal) trapFocus(modal);
  }

  renderSelectiveExtractModal();
}

export async function runSelectiveExtractFromModal(): Promise<void> {
  if (state.running) return;
  state.running = true;
  state.batchCancelled = false;
  state.cancelRequested = false;
  try {
    const archive = state.selectiveActiveArchive ?? state.inputs[0] ?? null;
    if (!archive) {
      await message("Select an archive to extract.", {
        title: "No archive selected",
      });
      return;
    }

    if (!(await ensureRuntimeReady())) return;
    await ensureArchivePaths([archive], "extract");

    const info = getCachedArchiveInfo(archive);
    if (!info) {
      throw new Error(
        "Browse archive contents first before selective extraction.",
      );
    }

    const destinationInput = document.getElementById(
      "selective-dest",
    ) as HTMLInputElement | null;
    const destination = destinationInput?.value.trim() ?? "";
    if (!destination) throw new Error("Choose a destination folder.");

    const extractPathInput = $<HTMLInputElement>("extract-path");
    extractPathInput.value = destination;
    if (destination !== state.lastAutoExtractDestination) {
      state.lastAutoExtractDestination = null;
    }

    const browsePassword = $<HTMLInputElement>("browse-password").value.trim();
    const extractPassword =
      $<HTMLInputElement>("extract-password").value.trim();
    const password = extractPassword || browsePassword;

    const selectedPaths = getCurrentArchiveSelectionPaths(archive, info);
    if (selectedPaths.length === 0) {
      log("No entries selected in picker. Falling back to extract all.");
    }
    const args = buildExtractArgsFor(
      archive,
      selectedPaths,
      password,
      destination,
    );
    const logSafe = args.map((a) => (a.startsWith("-p") ? "-p***" : a));
    devLog(`7z ${logSafe.join(" ")}`);

    closeSelectiveExtractModal();

    setRunning(true);
    setStatus(
      selectedPaths.length > 0
        ? "Extracting selected entries"
        : "Extracting archive",
    );

    const result = await invoke<Run7zResult>("run_7z", { args });
    if (state.cancelRequested) {
      hideProgress();
      setStatus("Cancelled", 2000);
      log("Operation cancelled by user");
      return;
    }

    const outputLines = result.stdout.split(/\r?\n/);
    for (const line of outputLines) {
      const percentMatch = line.match(/(\d+)%/);
      if (percentMatch) setProgress(`${percentMatch[1]}%`);
    }

    logCommandResult(result.stdout, result.stderr);
    logTruncationNotice(result);
    devLog(`Exit code: ${result.code}`);

    if (result.code > 1) {
      log(`7z exited with code ${result.code}`);
      setStatus("Error", 3000);
      hideProgress();
      const errorDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Operation failed with exit code ${result.code}.${errorDetails}`,
        { title: "Operation failed", kind: "error" },
      );
    } else {
      if (result.code === 1) {
        log("Operation completed with warnings.");
      }
      setStatus("Done", 2000);
      hideProgress();
      await message(
        selectedPaths.length > 0
          ? "Selected entries extracted successfully."
          : "Extraction completed successfully.",
        { title: "Done" },
      );
    }
  } catch (err) {
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      hideProgress();
      log("Operation cancelled by user");
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`);
    setStatus("Error", 3000);
    hideProgress();
    await message(msg, { title: "Error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

export function syncSelectiveDestinationAfterBrowseChoice(): void {
  syncSelectiveDestinationWithExtractInput();
}

export function syncDestinationWhilePickerOpen(value: string): void {
  const extractPath = document.getElementById(
    "extract-path",
  ) as HTMLInputElement | null;
  if (!extractPath) return;
  extractPath.value = value;
  if (value.trim() && value.trim() !== state.lastAutoExtractDestination) {
    state.lastAutoExtractDestination = null;
  }
}

export async function runAction() {
  if (state.running) return;

  const mode = getMode();

  if (mode === "extract" && state.inputs.length > 1) {
    return runBatchExtract();
  }

  state.running = true;
  try {
    if (!(await ensureRuntimeReady())) return;

    state.batchCancelled = false;
    state.cancelRequested = false;

    if (mode === "add") {
      const deleteAfter = $<HTMLInputElement>("delete-after").checked;
      if (deleteAfter) {
        const confirmed = await confirm(
          "This will permanently delete source files after compression. Continue?",
          {
            title: "Confirm deletion",
            kind: "warning",
            okLabel: "Delete files",
          },
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

    const logSafe = args.map((a) => (a.startsWith("-p") ? "-p***" : a));
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

    const outputLines = result.stdout.split(/\r?\n/);
    for (const line of outputLines) {
      const percentMatch = line.match(/(\d+)%/);
      if (percentMatch) {
        setProgress(`${percentMatch[1]}%`);
      }
    }

    logCommandResult(result.stdout, result.stderr);
    logTruncationNotice(result);
    devLog(`Exit code: ${result.code}`);

    if (result.code > 1) {
      log(`7z exited with code ${result.code}`);
      setStatus("Error", 3000);
      hideProgress();
      const errorDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Operation failed with exit code ${result.code}.${errorDetails}`,
        { title: "Operation failed", kind: "error" },
      );
    } else {
      if (result.code === 1) {
        log("Operation completed with warnings.");
      }
      setStatus("Done", 2000);
      hideProgress();
      await message(
        mode === "extract"
          ? "Extraction completed successfully."
          : "Archive created successfully.",
        { title: "Done" },
      );
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
  if (state.running) return;
  state.running = true;
  try {
    if (!(await ensureRuntimeReady())) return;

    state.batchCancelled = false;
    state.cancelRequested = false;
    const archives = [...state.inputs];
    await ensureArchivePaths(archives, "extract");

    const dest = $<HTMLInputElement>("extract-path").value.trim();
    if (!dest) throw new Error("Choose a destination folder.");
    const password = $<HTMLInputElement>("extract-password").value.trim();
    const extraArgs = splitArgs(
      $<HTMLInputElement>("extract-extra-args").value.trim(),
    );
    if (extraArgs.length > 0) validateExtraArgs(extraArgs);

    setRunning(true);
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < archives.length; i++) {
      if (state.batchCancelled || state.cancelRequested) break;

      const archive = archives[i];
      setStatus(`Extracting ${i + 1} of ${archives.length}`);

      try {
        const args = ["x", `-o${dest}`, "-y"];
        if (password) args.push(`-p${password}`);
        args.push(...extraArgs);
        args.push("--", archive);
        const logSafe = args.map((a) => (a.startsWith("-p") ? "-p***" : a));
        devLog(`7z ${logSafe.join(" ")}`);

        const result = await invoke<Run7zResult>("run_7z", { args });

        const outputLines = result.stdout.split(/\r?\n/);
        for (const line of outputLines) {
          const percentMatch = line.match(/(\d+)%/);
          if (percentMatch)
            setProgress(`${percentMatch[1]}% (${i + 1}/${archives.length})`);
        }

        logCommandResult(result.stdout, result.stderr);
        logTruncationNotice(result);

        if (result.code === 0 || result.code === 1) {
          if (result.code === 1) {
            log(`Warnings: ${archive}`);
          }
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
      await message(
        `Successfully extracted ${succeeded} archive${succeeded !== 1 ? "s" : ""}.`,
        { title: "Batch extraction complete" },
      );
    } else {
      setStatus(`Done \u2014 ${succeeded} succeeded, ${failed} failed`, 4000);
      await message(`${succeeded} succeeded, ${failed} failed.`, {
        title: "Batch extraction complete",
        kind: "warning",
      });
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
  if (!state.running) return;
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
  state.running = true;
  try {
    const archive = state.inputs[0];
    if (!archive) {
      await message("Select an archive to test.", {
        title: "No archive selected",
      });
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
    const passwordField =
      mode === "browse" ? "browse-password" : "extract-password";
    const password = $<HTMLInputElement>(passwordField).value.trim();

    const args = ["t", archive];
    if (password) args.push(`-p${password}`);

    if (!(await ensureRuntimeReady())) return;

    setRunning(true);
    setStatus("Testing archive integrity");

    const result = await invoke<Run7zResult>("run_7z", { args });

    logCommandResult(result.stdout, result.stderr);
    logTruncationNotice(result);

    if (result.code === 0) {
      setStatus("Integrity test passed", 3000);
      log("Archive integrity test: OK");
      await message("Archive integrity test passed. No errors found.", {
        title: "Test passed",
      });
    } else if (result.code === 1) {
      setStatus("Integrity test passed with warnings", 3000);
      log("Archive integrity test: OK (with warnings)");
      await message(
        "Archive integrity test passed with warnings. Check the log for details.",
        { title: "Test passed" },
      );
    } else {
      setStatus("Integrity test failed", 3000);
      log(`Archive integrity test: FAILED (exit code ${result.code})`);
      const errorDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Archive integrity test failed (exit code ${result.code}).${errorDetails}`,
        { title: "Test failed", kind: "error" },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Test error: ${msg}`);
    setStatus("Error", 3000);
    hideProgress();
    await message(msg, { title: "Test error", kind: "error" });
  } finally {
    setRunning(false);
  }
}

export async function browseArchive(): Promise<ArchiveInfo | null> {
  if (state.running) return null;
  state.running = true;
  try {
    const archive = state.inputs[0];
    if (!archive) {
      await message("Select an archive to browse.", {
        title: "No archive selected",
      });
      return null;
    }
    try {
      await ensureArchivePaths([archive], "browse");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message(msg, { title: "Invalid input", kind: "error" });
      return null;
    }

    const password = $<HTMLInputElement>("browse-password").value.trim();
    const args = ["l", "-slt", archive];
    if (password) args.push(`-p${password}`);

    if (!(await ensureRuntimeReady())) return null;

    setRunning(true);
    setStatus("Listing archive contents");

    const result = await invoke<Run7zResult>("run_7z", { args });
    logTruncationNotice(result);

    if (result.code > 1) {
      const needsPassword = looksLikePasswordRequiredError(
        result.stdout,
        result.stderr,
      );
      setBrowsePasswordFieldVisible(needsPassword);
      logCommandResult(result.stdout, result.stderr);
      setStatus("Failed to list archive", 3000);
      if (needsPassword) {
        log("Archive appears to be encrypted. Enter a password and try again.");
      }
      const passwordHint = needsPassword
        ? "\n\nThis archive appears to be encrypted. Enter the archive password and try again."
        : "";
      const errorDetails = result.stderr
        ? `\n\n${truncateForDialog(result.stderr.trim())}`
        : "";
      await message(
        `Failed to list archive contents (exit code ${result.code}).${passwordHint}${errorDetails}`,
        { title: "Browse failed", kind: "error" },
      );
      return null;
    }

    const info = parseArchiveListing(result.stdout);
    cacheBrowseInfo(archive, info);
    setBrowsePasswordFieldVisible(info.encrypted);
    renderBrowseTable(info);
    setStatus(`${info.entries.length} entries listed`, 3000);
    return info;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Browse error: ${msg}`);
    setStatus("Error", 3000);
    await message(msg, { title: "Browse error", kind: "error" });
    return null;
  } finally {
    setRunning(false);
  }
}

export function sanitizeCommandArgsForPreview(args: string[]): string[] {
  return args.map((arg) => {
    if (arg.startsWith("-p")) return "-p***";
    return arg;
  });
}

export function buildCommandPreviewText(args: string[]): string {
  return `7z ${sanitizeCommandArgsForPreview(args).join(" ")}`;
}

export function closeCommandPreviewModal() {
  const overlay = document.getElementById(
    "command-preview-overlay",
  ) as HTMLElement | null;
  if (!overlay) return;
  overlay.hidden = true;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
  if (commandPreviewTrigger) {
    commandPreviewTrigger.focus();
    commandPreviewTrigger = null;
  } else {
    document.getElementById("show-command")?.focus();
  }
}

export async function copyCommandPreview(): Promise<void> {
  const preview = document.getElementById(
    "command-preview-text",
  ) as HTMLElement | null;
  const text = preview?.textContent?.trim() ?? "";
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCommandPreviewCopyButton(true);
    resetCommandPreviewCopyStateSoon();
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await message(`Could not copy command.\n\n${messageText}`, {
      title: "Copy failed",
      kind: "error",
    });
  }
}

export async function previewCommand(trigger?: HTMLElement) {
  try {
    const args = buildArgs();
    const previewText = buildCommandPreviewText(args);
    const overlay = document.getElementById(
      "command-preview-overlay",
    ) as HTMLElement | null;
    const preview = document.getElementById(
      "command-preview-text",
    ) as HTMLElement | null;
    if (!overlay || !preview) {
      await message(previewText, { title: "Command preview" });
      return;
    }

    commandPreviewTrigger = trigger ?? null;
    setCommandPreviewCopyButton(false);
    preview.textContent = previewText;
    overlay.hidden = false;
    const modal = overlay.querySelector<HTMLElement>(".modal");
    if (modal) trapFocus(modal);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await message(messageText, { title: "Missing info" });
  }
}
