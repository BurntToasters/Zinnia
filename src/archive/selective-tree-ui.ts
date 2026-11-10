import { formatSize, isImeComposing } from "../utils";
import { state, cacheSelection } from "../state";
import type { BrowseEntry } from "../browse-model";
import {
  buildEntryTree,
  computeNodeCheckState,
  detectWindowsMemberPaths,
  filterBrowseEntriesByQuery,
  toggleEntrySelection,
} from "../selective-extract";
import type { TreeNode } from "../selective-extract";
import {
  getOrCreateSelection,
  getCachedArchiveInfo,
} from "./browse-selective-helpers";

const MAX_RENDERED_SELECTIVE_ROWS = 1_000;

/**
 * Work derived from one archive listing: separator style, the tree, and the
 * last filter result. Keyed by the listing array, so a re-browse starts fresh
 * and toggles or expansions reuse the same objects.
 */
interface ListingModel {
  entries: BrowseEntry[];
  windowsPaths: boolean;
  tree: TreeNode[] | null;
  filterQuery: string | null;
  filtered: BrowseEntry[];
}

let listingModel: ListingModel | null = null;

function modelFor(entries: BrowseEntry[]): ListingModel {
  if (listingModel?.entries !== entries) {
    listingModel = {
      entries,
      windowsPaths: detectWindowsMemberPaths(entries),
      tree: null,
      filterQuery: null,
      filtered: entries,
    };
  }
  return listingModel;
}

function filteredFor(model: ListingModel, query: string): BrowseEntry[] {
  if (model.filterQuery !== query) {
    model.filtered = filterBrowseEntriesByQuery(model.entries, query);
    model.filterQuery = query;
  }
  return model.filtered;
}

/** Re-applies one rendered row's checked state from a selection set. */
type RowRefresh = (selected: Set<string>) => void;

interface SummaryShape {
  total: number;
  matches: number;
  searching: boolean;
}

// Rows in the DOM right now. A toggle updates these in place; a full render
// replaces them.
let renderedRows: RowRefresh[] = [];
let pickerSummary: { archive: string; shape: SummaryShape } | null = null;

/** Selection scope matches rendered rows so folder toggles cannot reach hidden members. */
export function collectRenderedSelectiveScope(
  entries: BrowseEntry[],
  searching: boolean,
  windowsPaths: boolean,
): BrowseEntry[] {
  if (searching) {
    return entries.slice(0, MAX_RENDERED_SELECTIVE_ROWS);
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const budget = { remaining: MAX_RENDERED_SELECTIVE_ROWS };
  const scoped = new Map<string, BrowseEntry>();
  const visit = (node: TreeNode) => {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    // ZIP/TAR listings commonly omit explicit directory records. Those
    // folders are still rendered by buildEntryTree, so include an equivalent
    // synthetic entry in the bulk-selection target set. Otherwise "Select
    // all visible" silently skips a collapsed rendered folder and all of its
    // children even though clicking that folder's own checkbox works.
    const entry = byPath.get(node.path) ?? {
      path: node.path,
      isFolder: node.isFolder,
      size: node.size,
      packedSize: 0,
      modified: "",
    };
    scoped.set(entry.path, entry);
    if (
      node.isFolder &&
      node.children.length > 0 &&
      state.selectiveExpandedFolders.has(node.path)
    ) {
      for (const child of node.children) visit(child);
    }
  };
  for (const node of buildEntryTree(entries, windowsPaths)) {
    visit(node);
    if (budget.remaining <= 0) break;
  }
  return [...scoped.values()];
}

function writeSelectiveSummary(archive: string, shape: SummaryShape): void {
  const summary = document.getElementById("selective-summary");
  if (!summary) return;
  const selectedCount = getOrCreateSelection(archive).size;
  const shownCount = renderedRows.length;
  if (shape.searching) {
    summary.textContent =
      shape.matches > shownCount
        ? `${selectedCount} selected · ${shownCount} shown of ${shape.matches} matches · ${shape.total} total`
        : `${selectedCount} selected · ${shownCount} shown · ${shape.total} total`;
  } else {
    const rowLabel = shownCount === 1 ? "row shown" : "rows shown";
    const entryLabel = shape.total === 1 ? "archive entry" : "archive entries";
    summary.textContent = `${selectedCount} selected · ${shownCount} ${rowLabel} · ${shape.total} ${entryLabel}`;
  }
}

/**
 * Toggle path: refresh the checkboxes already on screen. Rows keep their
 * identity, so keyboard focus stays where the user left it.
 */
function refreshRenderedRows(archive: string): void {
  const selected = getOrCreateSelection(archive);
  for (const refresh of renderedRows) refresh(selected);
  if (pickerSummary?.archive === archive) {
    writeSelectiveSummary(archive, pickerSummary.shape);
  }
}

function renderSelectiveFlatRow(
  archive: string,
  entry: BrowseEntry,
  scopeEntries: BrowseEntry[],
  windowsPaths: boolean,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "selective-row";
  row.dataset.memberPath = entry.path;
  row.setAttribute("role", "listitem");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.setAttribute("aria-label", `Select ${entry.path}`);
  const applyState: RowRefresh = (selected) => {
    checkbox.checked = selected.has(entry.path);
    checkbox.disabled = state.running;
  };
  applyState(getOrCreateSelection(archive));
  renderedRows.push(applyState);
  checkbox.addEventListener("change", () => {
    const current = getOrCreateSelection(archive);
    const next = toggleEntrySelection(
      current,
      entry,
      scopeEntries,
      windowsPaths,
    );
    cacheSelection(archive, next);
    refreshRenderedRows(archive);
  });

  const path = document.createElement("span");
  path.className = "selective-row__path";
  path.textContent = entry.path;
  path.title = entry.path;

  const meta = document.createElement("span");
  meta.className = "selective-row__meta";
  const kind = entry.isFolder ? "Folder" : "File";
  const size = entry.isFolder ? "-" : formatSize(entry.size);
  meta.textContent = `${kind} · ${size}`;

  row.appendChild(checkbox);
  row.appendChild(path);
  row.appendChild(meta);
  return row;
}

function renderSelectiveTreeNode(
  archive: string,
  node: TreeNode,
  scopeEntries: BrowseEntry[],
  windowsPaths: boolean,
  list: HTMLElement,
  budget: { remaining: number; truncated: boolean },
): void {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return;
  }
  budget.remaining -= 1;
  const row = document.createElement("div");
  row.className = "selective-row selective-row--tree";
  row.dataset.depth = String(Math.min(Math.max(node.depth, 0), 20));
  row.dataset.memberPath = node.path;
  row.tabIndex = -1;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(node.depth + 1));

  const expandable = node.isFolder && node.children.length > 0;
  const expanded = state.selectiveExpandedFolders.has(node.path);
  if (expandable)
    row.setAttribute("aria-expanded", expanded ? "true" : "false");

  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.tabIndex = -1;
  twisty.className = "selective-twisty";
  twisty.textContent = expandable ? (expanded ? "▾" : "▸") : "";
  twisty.disabled = !expandable;
  if (expandable) {
    const twistyName = node.name || node.path;
    twisty.setAttribute(
      "aria-label",
      expanded ? `Collapse ${twistyName}` : `Expand ${twistyName}`,
    );
    twisty.addEventListener("click", () => {
      if (expanded) state.selectiveExpandedFolders.delete(node.path);
      else state.selectiveExpandedFolders.add(node.path);
      renderSelectiveExtractModal();
    });
  } else {
    twisty.setAttribute("aria-hidden", "true");
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.tabIndex = -1;
  checkbox.setAttribute("aria-label", `Select ${node.path}`);
  const applyState: RowRefresh = (selected) => {
    const checkState = computeNodeCheckState(node, selected);
    checkbox.checked = checkState === "checked";
    checkbox.indeterminate = checkState === "indeterminate";
    checkbox.disabled = state.running;
    row.setAttribute(
      "aria-selected",
      checkState === "checked" ? "true" : "false",
    );
    row.setAttribute(
      "aria-checked",
      checkState === "indeterminate"
        ? "mixed"
        : String(checkState === "checked"),
    );
  };
  applyState(getOrCreateSelection(archive));
  renderedRows.push(applyState);
  checkbox.addEventListener("change", () => {
    const current = getOrCreateSelection(archive);
    const entry: BrowseEntry = {
      path: node.path,
      isFolder: node.isFolder,
      size: node.size,
      packedSize: 0,
      modified: "",
    };
    const next = toggleEntrySelection(
      current,
      entry,
      scopeEntries,
      windowsPaths,
    );
    cacheSelection(archive, next);
    refreshRenderedRows(archive);
  });

  row.addEventListener("keydown", (event) => {
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    const index = rows.indexOf(row);
    const focusRow = (next: HTMLElement | undefined) => {
      if (!next) return;
      for (const candidate of rows) candidate.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(rows[index + 1]);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(rows[index - 1]);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(rows[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(rows.at(-1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (expandable && !expanded) {
        state.selectiveExpandedFolders.add(node.path);
        renderSelectiveExtractModal();
      } else if (expandable && expanded) {
        focusRow(rows[index + 1]);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (expandable && expanded) {
        state.selectiveExpandedFolders.delete(node.path);
        renderSelectiveExtractModal();
      } else {
        const level = Number(row.getAttribute("aria-level") ?? "1");
        for (let parent = index - 1; parent >= 0; parent -= 1) {
          if (Number(rows[parent].getAttribute("aria-level") ?? "1") < level) {
            focusRow(rows[parent]);
            break;
          }
        }
      }
    } else if (
      event.key === " " ||
      (event.key === "Enter" && !isImeComposing(event))
    ) {
      // Enter that confirms IME text must not toggle the row.
      event.preventDefault();
      checkbox.click();
    }
  });

  const name = document.createElement("span");
  name.className = "selective-row__path";
  name.textContent = node.isFolder
    ? `${node.name}${windowsPaths ? "\\" : "/"}`
    : node.name;
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
      if (budget.remaining <= 0) {
        budget.truncated = true;
        break;
      }
      renderSelectiveTreeNode(
        archive,
        child,
        scopeEntries,
        windowsPaths,
        list,
        budget,
      );
    }
  }
}

function findRowByMemberPath(
  list: HTMLElement,
  memberPath: string,
): HTMLElement | undefined {
  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-member-path]"),
  ).find((row) => row.dataset.memberPath === memberPath);
}

function renderSelectiveEntryList(
  archive: string,
  entries: BrowseEntry[],
  allEntries: BrowseEntry[],
  searching: boolean,
  model: ListingModel,
): void {
  renderedRows = [];
  const list = document.getElementById("selective-list");
  if (!list) return;
  // Remember focus inside the list so a full re-render can restore it.
  const active = document.activeElement as HTMLElement | null;
  const focusedPath =
    active && list.contains(active)
      ? active.closest<HTMLElement>("[data-member-path]")?.dataset.memberPath
      : undefined;
  list.replaceChildren();
  list.removeAttribute("role");
  list.removeAttribute("aria-label");
  list.removeAttribute("aria-multiselectable");

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "selective-empty";
    empty.textContent = "No archive entries match this search.";
    list.appendChild(empty);
    return;
  }

  // Search selection is intentionally limited to visible results. Tree folder
  // selection must include the folder's complete archive subtree even while
  // collapsed, otherwise its checkbox appears to work but extracts nothing.
  const scopeEntries = searching
    ? collectRenderedSelectiveScope(entries, true, model.windowsPaths)
    : allEntries;

  // Searching shows a flat result list; otherwise a collapsible tree.
  if (searching) {
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Archive search results");
    for (const entry of entries.slice(0, MAX_RENDERED_SELECTIVE_ROWS)) {
      list.appendChild(
        renderSelectiveFlatRow(
          archive,
          entry,
          scopeEntries,
          model.windowsPaths,
        ),
      );
    }
    if (entries.length > MAX_RENDERED_SELECTIVE_ROWS) {
      const notice = document.createElement("div");
      notice.className = "selective-empty";
      notice.textContent = `Refine the search to view matches beyond the first ${MAX_RENDERED_SELECTIVE_ROWS.toLocaleString()}.`;
      list.appendChild(notice);
    }
    if (focusedPath !== undefined) {
      const control = findRowByMemberPath(
        list,
        focusedPath,
      )?.querySelector<HTMLInputElement>("input");
      if (control) queueMicrotask(() => control.focus());
    }
    return;
  }

  list.setAttribute("role", "tree");
  list.setAttribute("aria-label", "Archive contents");
  list.setAttribute("aria-multiselectable", "true");

  // The tree depends only on the listing, so build it once per listing.
  model.tree ??= buildEntryTree(allEntries, model.windowsPaths);
  const budget = {
    remaining: MAX_RENDERED_SELECTIVE_ROWS,
    truncated: false,
  };
  for (const node of model.tree) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    renderSelectiveTreeNode(
      archive,
      node,
      scopeEntries,
      model.windowsPaths,
      list,
      budget,
    );
  }
  if (budget.truncated) {
    const notice = document.createElement("div");
    notice.className = "selective-empty";
    notice.textContent = `Expand fewer folders or search to keep this view responsive. At most ${MAX_RENDERED_SELECTIVE_ROWS.toLocaleString()} rows are shown at once.`;
    list.appendChild(notice);
  }
  const rows = Array.from(
    list.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  );
  const focusTarget =
    rows.find((row) => row.dataset.memberPath === focusedPath) ?? rows[0];
  if (focusTarget) {
    focusTarget.tabIndex = 0;
    if (focusedPath) queueMicrotask(() => focusTarget.focus());
  }
}

export function renderSelectiveExtractModal(): void {
  const archive = state.selectiveActiveArchive;
  if (!archive) return;
  const info = getCachedArchiveInfo(archive);
  if (!info) return;

  const searching = state.selectiveSearchQuery.trim().length > 0;
  const model = modelFor(info.entries);
  const filteredEntries = filteredFor(model, state.selectiveSearchQuery);
  state.selectiveVisiblePaths = filteredEntries.map((entry) => entry.path);

  renderSelectiveEntryList(
    archive,
    filteredEntries,
    info.entries,
    searching,
    model,
  );

  const shape: SummaryShape = {
    total: info.entries.length,
    matches: filteredEntries.length,
    searching,
  };
  pickerSummary = { archive, shape };
  writeSelectiveSummary(archive, shape);
}
