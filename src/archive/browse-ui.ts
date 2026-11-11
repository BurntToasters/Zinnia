import { $, formatSize, trapFocus, releaseFocusTrap } from "../utils";
import { state, cacheSelection, clearBrowseCache } from "../state";
import { getMode, triggerIconRefresh } from "../ui";
import { ensureArchivePaths } from "../archive-rules";
import type { ArchiveInfo, BrowseEntry } from "../browse-model";
import { resolveExtractDestinationAutofill } from "../extract-path";
import { showToast } from "../toast";
import { userFacingBackendError } from "../error-hints";
import { log } from "../ui";
import { truncateForDialog } from "./runtime";
import {
  filterBrowseEntriesByQuery,
  clearPathSelection,
  selectEntries,
  detectWindowsMemberPaths,
} from "../selective-extract";
import {
  getOrCreateSelection,
  getCachedArchiveInfo,
} from "./browse-selective-helpers";
import {
  renderSelectiveExtractModal,
  collectRenderedSelectiveScope,
} from "./selective-tree-ui";

let browseArchiveLoader:
  ((expectedArchiveIdentity?: string) => Promise<ArchiveInfo | null>) | null =
  null;
// Matches the rendered output of the former " &nbsp;·&nbsp; " HTML separator.
const BROWSE_SUMMARY_SEPARATOR = " \u00a0\u00b7\u00a0 ";

const MAX_RENDERED_BROWSE_ROWS = 1_000;
const SELECTIVE_SEARCH_DEBOUNCE_MS = 120;
let selectiveSearchTimer: number | undefined;

export function registerBrowseArchiveLoader(
  loader: (expectedArchiveIdentity?: string) => Promise<ArchiveInfo | null>,
): void {
  browseArchiveLoader = loader;
}

function renderBrowseRows(
  tbody: HTMLElement,
  entries: BrowseEntry[],
  folderClass: string,
): void {
  tbody.replaceChildren();
  const fragment = document.createDocumentFragment();
  if (entries.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "browse-empty";
    td.textContent = "Archive is empty.";
    tr.appendChild(td);
    fragment.appendChild(tr);
    tbody.appendChild(fragment);
    return;
  }
  for (const entry of entries.slice(0, MAX_RENDERED_BROWSE_ROWS)) {
    const tr = document.createElement("tr");
    if (entry.isFolder) tr.className = folderClass;

    const tdName = document.createElement("td");
    const iconName = entry.isFolder ? "folder" : "file";
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", iconName);
    icon.className = "lucide-icon lucide-icon--inline";
    const label = document.createElement("span");
    label.textContent = entry.path;
    tdName.replaceChildren(icon, label);
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
    tr.append(tdName, tdSize, tdPacked, tdModified);
    fragment.appendChild(tr);
  }
  if (entries.length > MAX_RENDERED_BROWSE_ROWS) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "browse-empty";
    const basicCap = folderClass === "browse-folder";
    td.textContent = basicCap
      ? `Showing the first ${MAX_RENDERED_BROWSE_ROWS.toLocaleString()} of ${entries.length.toLocaleString()} entries.`
      : `Showing the first ${MAX_RENDERED_BROWSE_ROWS.toLocaleString()} of ${entries.length.toLocaleString()} entries. Use selective extraction search to find other entries.`;
    tr.appendChild(td);
    fragment.appendChild(tr);
  }
  tbody.appendChild(fragment);
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
    const parts: Array<string | HTMLElement> = [];
    const typeEl = document.createElement("strong");
    typeEl.textContent = info.type || "Archive";
    parts.push(typeEl);
    if (info.method) parts.push(`Method: ${info.method}`);
    if (info.solid) parts.push("Solid");
    if (info.encrypted) parts.push("Encrypted");
    parts.push(
      `${fileCount} file${fileCount !== 1 ? "s" : ""}${folderCount > 0 ? `, ${folderCount} folder${folderCount !== 1 ? "s" : ""}` : ""}`,
    );
    parts.push(`${formatSize(totalSize)} \u2192 ${formatSize(totalPacked)}`);
    const nodes: Array<string | HTMLElement> = [];
    parts.forEach((part, index) => {
      if (index > 0) nodes.push(BROWSE_SUMMARY_SEPARATOR);
      nodes.push(part);
    });
    summary.replaceChildren(...nodes);
  }

  const tbody = document.getElementById("browse-tbody");
  if (!tbody) return;
  renderBrowseRows(tbody, info.entries, "is-folder");

  const basicTbody = document.getElementById("basic-browse-tbody");
  if (basicTbody) {
    renderBrowseRows(basicTbody, info.entries, "browse-folder");
  }

  const basicSummary = document.getElementById("basic-browse-summary");
  if (basicSummary && summary) {
    basicSummary.replaceChildren(
      ...Array.from(summary.childNodes, (node) => node.cloneNode(true)),
    );
  }
  triggerIconRefresh();
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
  selectiveDest.value = extractPath.value;
}

async function ensureArchiveInfoForPicker(
  archive: string,
  validatedIdentity?: string,
): Promise<ArchiveInfo | null> {
  if (state.inputs[0] !== archive) return null;
  let identity = validatedIdentity;
  if (!identity) {
    const [validation] = await ensureArchivePaths(
      [archive],
      "browse",
      undefined,
      true,
    );
    identity = validation?.identity;
  }
  if (state.inputs[0] !== archive || !identity) return null;
  const cached = getCachedArchiveInfo(archive);
  const cachedIdentity = state.browseArchiveIdentityByPath.get(archive);
  if (cached && cachedIdentity === identity) return cached;
  if (cached || cachedIdentity) {
    clearBrowseCache(archive);
  }
  if (!browseArchiveLoader) {
    throw new Error("Archive browsing is not initialized.");
  }
  return await browseArchiveLoader(identity);
}

export function closeSelectiveExtractModal(): void {
  state.selectiveOpenRequestId += 1;
  if (selectiveSearchTimer !== undefined) {
    window.clearTimeout(selectiveSearchTimer);
    selectiveSearchTimer = undefined;
  }
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

export function setSelectiveExtractSearch(
  query: string,
  debounceRender = false,
): void {
  state.selectiveSearchQuery = query;
  if (selectiveSearchTimer !== undefined) {
    window.clearTimeout(selectiveSearchTimer);
    selectiveSearchTimer = undefined;
  }
  if (!debounceRender) {
    renderSelectiveExtractModal();
    return;
  }
  selectiveSearchTimer = window.setTimeout(() => {
    selectiveSearchTimer = undefined;
    renderSelectiveExtractModal();
  }, SELECTIVE_SEARCH_DEBOUNCE_MS);
}

export function selectAllVisibleInPicker(): void {
  const archive = state.selectiveActiveArchive;
  if (!archive) return;
  const info = getCachedArchiveInfo(archive);
  if (!info) return;
  const searching = state.selectiveSearchQuery.trim().length > 0;
  const visibleEntries = filterBrowseEntriesByQuery(
    info.entries,
    state.selectiveSearchQuery,
  );
  const windowsPaths = detectWindowsMemberPaths(info.entries);
  // Select all must only touch rendered rows (same budget + expansion state as
  // the picker), including non-search tree views with collapsed folders.
  const scopeEntries = collectRenderedSelectiveScope(
    searching ? visibleEntries : info.entries,
    searching,
    windowsPaths,
  );
  // Rendered rows are the selection targets, but collapsed folders still need
  // the complete archive as their recursion scope. Search remains visible-only.
  const recursionScope = searching ? scopeEntries : info.entries;
  const current = getOrCreateSelection(archive);
  const next = selectEntries(
    current,
    scopeEntries,
    recursionScope,
    windowsPaths,
  );
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
let selectiveOpening = false;

async function openSelectiveExtractModalOnce(): Promise<void> {
  if (state.running) return;
  selectiveTrigger = document.activeElement as HTMLElement | null;

  const archive = state.inputs[0];
  const mode = getMode();
  const requestId = ++state.selectiveOpenRequestId;
  const requestIsCurrent = () =>
    requestId === state.selectiveOpenRequestId &&
    state.inputs[0] === archive &&
    getMode() === mode &&
    !state.running;
  if (!archive) {
    showToast("Select an archive to browse first.", "info");
    return;
  }

  let validatedIdentity: string | undefined;
  try {
    const [validation] = await ensureArchivePaths(
      [archive],
      "browse",
      undefined,
      true,
    );
    validatedIdentity = validation?.identity;
    if (!validatedIdentity) {
      throw new Error("Could not capture a stable archive identity.");
    }
    if (!requestIsCurrent()) return;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    log(`Selective extract validation failed: ${raw}`, "error");
    showToast(userFacingBackendError(raw), "error", 0);
    return;
  }

  const info = await ensureArchiveInfoForPicker(archive, validatedIdentity);
  if (!info || !requestIsCurrent()) return;

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

  try {
    // Render while the overlay is still hidden. Hostile member depth/length
    // limits become a controlled toast error instead of a half-open modal and
    // an unhandled promise rejection.
    renderSelectiveExtractModal();
  } catch (err) {
    closeSelectiveExtractModal();
    const raw = err instanceof Error ? err.message : String(err);
    log(`Selective extract browse render failed: ${raw}`, "error");
    const msg = userFacingBackendError(raw);
    showToast(
      `This archive cannot be browsed safely: ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
    return;
  }

  const overlay = document.getElementById(
    "selective-overlay",
  ) as HTMLElement | null;
  if (overlay) {
    overlay.hidden = false;
    const modal = overlay.querySelector<HTMLElement>(".modal");
    if (modal) trapFocus(modal);
  }
}

export async function openSelectiveExtractModal(): Promise<void> {
  if (selectiveOpening || state.running) return;
  selectiveOpening = true;
  try {
    await openSelectiveExtractModalOnce();
  } finally {
    selectiveOpening = false;
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
  if (value && value !== state.lastAutoExtractDestination) {
    state.lastAutoExtractDestination = null;
  }
}
