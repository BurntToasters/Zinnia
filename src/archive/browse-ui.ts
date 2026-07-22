import { message, confirm } from "@tauri-apps/plugin-dialog";
import {
  $,
  escapeHtml,
  formatSize,
  trapFocus,
  releaseFocusTrap,
} from "../utils";
import { state, cacheSelection } from "../state";
import {
  log,
  devLog,
  setStatus,
  hideProgress,
  setRunning,
  triggerIconRefresh,
} from "../ui";
import { ensureArchivePaths } from "../archive-rules";
import type { ArchiveInfo, BrowseEntry } from "../browse-model";
import { resolveExtractDestinationAutofill } from "../extract-path";
import { showToast } from "../toast";
import {
  buildEntryTree,
  computeNodeCheckState,
  clearPathSelection,
  filterBrowseEntriesByQuery,
  selectEntries,
  toggleEntrySelection,
} from "../selective-extract";
import type { TreeNode } from "../selective-extract";
import { buildExtractArgsFor } from "./args";
import { sanitizeCommandArgsForPreview } from "./preview";
import {
  ensureRuntimeReady,
  withLiveProgress,
  runWithPasswordRetry,
  logCommandResult,
  logTruncationNotice,
} from "./runtime";

let browseArchiveLoader: (() => Promise<ArchiveInfo | null>) | null = null;

export function registerBrowseArchiveLoader(
  loader: () => Promise<ArchiveInfo | null>,
): void {
  browseArchiveLoader = loader;
}
import { clearPasswordFields, showOperationError } from "./runtime";

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
    const iconName = entry.isFolder ? "folder" : "file";
    tdName.innerHTML = `<i data-lucide="${iconName}" class="lucide-icon lucide-icon--inline"></i><span></span>`;
    tdName.querySelector("span")!.textContent = entry.path;
    tdName.title = entry.path;
    tdName.classList.add("cell-break");

    const tdSize = document.createElement("td");
    tdSize.className = "size-col cell-tabular";
    tdSize.textContent = entry.isFolder ? "-" : formatSize(entry.size);

    const tdPacked = document.createElement("td");
    tdPacked.className = "size-col cell-tabular";
    tdPacked.textContent = entry.isFolder ? "-" : formatSize(entry.packedSize);

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
      const iconName = entry.isFolder ? "folder" : "file";
      tdName.innerHTML = `<i data-lucide="${iconName}" class="lucide-icon lucide-icon--inline"></i><span></span>`;
      tdName.querySelector("span")!.textContent = entry.path;
      tdName.title = entry.path;
      tdName.classList.add("cell-break");

      const tdSize = document.createElement("td");
      tdSize.classList.add("cell-tabular");
      tdSize.textContent = entry.isFolder ? "-" : formatSize(entry.size);

      const tdPacked = document.createElement("td");
      tdPacked.classList.add("cell-tabular");
      tdPacked.textContent = entry.isFolder
        ? "-"
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
  triggerIconRefresh();
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

function renderSelectiveFlatRow(
  archive: string,
  entry: BrowseEntry,
  allEntries: BrowseEntry[],
): HTMLElement {
  const selected = getOrCreateSelection(archive);
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
  const size = entry.isFolder ? "-" : formatSize(entry.size);
  meta.textContent = `${kind} \u00b7 ${size}`;

  row.appendChild(checkbox);
  row.appendChild(path);
  row.appendChild(meta);
  return row;
}

function renderSelectiveTreeNode(
  archive: string,
  node: TreeNode,
  allEntries: BrowseEntry[],
  list: HTMLElement,
): void {
  const selected = getOrCreateSelection(archive);
  const row = document.createElement("div");
  row.className = "selective-row selective-row--tree";
  row.dataset.depth = String(Math.min(Math.max(node.depth, 0), 20));
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(node.depth + 1));

  const expandable = node.isFolder && node.children.length > 0;
  const expanded = state.selectiveExpandedFolders.has(node.path);
  if (expandable)
    row.setAttribute("aria-expanded", expanded ? "true" : "false");

  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "selective-twisty";
  twisty.textContent = expandable ? (expanded ? "\u25be" : "\u25b8") : "";
  twisty.disabled = !expandable;
  twisty.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
  if (expandable) {
    twisty.addEventListener("click", () => {
      if (expanded) state.selectiveExpandedFolders.delete(node.path);
      else state.selectiveExpandedFolders.add(node.path);
      renderSelectiveExtractModal();
    });
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const checkState = computeNodeCheckState(node, selected);
  checkbox.checked = checkState === "checked";
  checkbox.indeterminate = checkState === "indeterminate";
  checkbox.disabled = state.running;
  row.setAttribute(
    "aria-selected",
    checkState === "checked" ? "true" : "false",
  );
  checkbox.addEventListener("change", () => {
    const current = getOrCreateSelection(archive);
    const entry: BrowseEntry = {
      path: node.path,
      isFolder: node.isFolder,
      size: node.size,
      packedSize: 0,
      modified: "",
    };
    const next = toggleEntrySelection(current, entry, allEntries);
    cacheSelection(archive, next);
    renderSelectiveExtractModal();
  });

  const name = document.createElement("span");
  name.className = "selective-row__path";
  name.textContent = node.isFolder ? `${node.name}/` : node.name;
  name.title = node.path;

  const meta = document.createElement("span");
  meta.className = "selective-row__meta";
  meta.textContent = node.isFolder ? "Folder" : formatSize(node.size);

  row.appendChild(twisty);
  row.appendChild(checkbox);
  row.appendChild(name);
  row.appendChild(meta);
  list.appendChild(row);

  if (expandable && expanded) {
    for (const child of node.children) {
      renderSelectiveTreeNode(archive, child, allEntries, list);
    }
  }
}

function renderSelectiveEntryList(
  archive: string,
  entries: BrowseEntry[],
  allEntries: BrowseEntry[],
  searching: boolean,
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

  // Searching shows a flat result list; otherwise a collapsible tree.
  if (searching) {
    list.removeAttribute("role");
    for (const entry of entries) {
      list.appendChild(renderSelectiveFlatRow(archive, entry, allEntries));
    }
    return;
  }

  list.setAttribute("role", "tree");

  for (const node of buildEntryTree(entries)) {
    renderSelectiveTreeNode(archive, node, allEntries, list);
  }
}

export function renderSelectiveExtractModal(): void {
  const archive = state.selectiveActiveArchive;
  if (!archive) return;
  const info = getCachedArchiveInfo(archive);
  if (!info) return;

  const searching = state.selectiveSearchQuery.trim().length > 0;
  const filteredEntries = filterBrowseEntriesByQuery(
    info.entries,
    state.selectiveSearchQuery,
  );
  state.selectiveVisiblePaths = filteredEntries.map((entry) => entry.path);

  renderSelectiveEntryList(archive, filteredEntries, info.entries, searching);

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
  if (!browseArchiveLoader) {
    throw new Error("Archive browsing is not initialized.");
  }
  return await browseArchiveLoader();
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
  state.selectiveExpandedFolders.clear();
  if (selectiveTrigger) {
    selectiveTrigger.focus();
    selectiveTrigger = null;
  }
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

let selectiveTrigger: HTMLElement | null = null;

export async function openSelectiveExtractModal(): Promise<void> {
  if (state.running) return;
  selectiveTrigger = document.activeElement as HTMLElement | null;

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
  state.selectiveExpandedFolders.clear();
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
  setRunning(true);
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
      const extractAll = await confirm(
        "No entries are selected. Extract all files from the archive?",
        {
          title: "No selection",
          kind: "warning",
          okLabel: "Extract all",
          cancelLabel: "Cancel",
        },
      );
      if (!extractAll) return;
    }
    const args = buildExtractArgsFor(
      archive,
      selectedPaths,
      password,
      destination,
    );
    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);

    closeSelectiveExtractModal();

    setStatus(
      selectedPaths.length > 0
        ? "Extracting selected entries"
        : "Extracting archive",
    );

    const result = await withLiveProgress(() =>
      runWithPasswordRetry(args, true),
    );
    if (state.cancelRequested) {
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
      state.lastClearedQuarantineApps = null;
      state.lastRestoredExecuteBits = null;
      setStatus("Error", 3000, result.stderr || "Operation failed.");
      hideProgress();
      await showOperationError(result.code, result.stdout, result.stderr);
    } else {
      state.lastClearedQuarantineApps = result.cleared_quarantine_apps ?? null;
      state.lastRestoredExecuteBits = result.restored_execute_bits ?? null;
      setStatus("Done", 2000);
      hideProgress();
      const notes: string[] = [];
      const cleared = result.cleared_quarantine_apps;
      if (cleared && cleared > 0) {
        notes.push(
          `Cleared Gatekeeper quarantine on ${cleared} app bundle${cleared === 1 ? "" : "s"}`,
        );
      }
      const execBits = result.restored_execute_bits;
      if (execBits && execBits > 0) {
        notes.push(
          `restored execute permission on ${execBits} file${execBits === 1 ? "" : "s"}`,
        );
      }
      const note = notes.length > 0 ? ` ${notes.join("; ")}.` : "";
      showToast(
        selectedPaths.length > 0
          ? `Selected entries extracted.${note}`
          : `Extraction complete.${note}`,
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

    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`);
    setStatus("Error", 3000, msg);
    hideProgress();
    await message(msg, { title: "Error", kind: "error" });
  } finally {
    clearPasswordFields();
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
