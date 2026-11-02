import { formatSize } from "../utils";
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

function renderSelectiveFlatRow(
  archive: string,
  entry: BrowseEntry,
  scopeEntries: BrowseEntry[],
  windowsPaths: boolean,
): HTMLElement {
  const selected = getOrCreateSelection(archive);
  const row = document.createElement("label");
  row.className = "selective-row";
  row.setAttribute("role", "listitem");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.setAttribute("aria-label", `Select ${entry.path}`);
  checkbox.checked = selected.has(entry.path);
  checkbox.disabled = state.running;
  checkbox.addEventListener("change", () => {
    const current = getOrCreateSelection(archive);
    const next = toggleEntrySelection(
      current,
      entry,
      scopeEntries,
      windowsPaths,
    );
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
  const selected = getOrCreateSelection(archive);
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
  twisty.textContent = expandable ? (expanded ? "\u25be" : "\u25b8") : "";
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
    checkState === "indeterminate" ? "mixed" : String(checkState === "checked"),
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
    const next = toggleEntrySelection(
      current,
      entry,
      scopeEntries,
      windowsPaths,
    );
    cacheSelection(archive, next);
    renderSelectiveExtractModal();
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
    } else if (event.key === " " || event.key === "Enter") {
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

function renderSelectiveEntryList(
  archive: string,
  entries: BrowseEntry[],
  allEntries: BrowseEntry[],
  searching: boolean,
  windowsPaths: boolean,
): void {
  const list = document.getElementById("selective-list");
  if (!list) return;
  const activeRow = (
    document.activeElement as HTMLElement | null
  )?.closest<HTMLElement>('[role="treeitem"]');
  const focusedPath = list.contains(activeRow ?? null)
    ? activeRow?.dataset.memberPath
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
    ? collectRenderedSelectiveScope(entries, true, windowsPaths)
    : allEntries;

  // Searching shows a flat result list; otherwise a collapsible tree.
  if (searching) {
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Archive search results");
    for (const entry of entries.slice(0, MAX_RENDERED_SELECTIVE_ROWS)) {
      list.appendChild(
        renderSelectiveFlatRow(archive, entry, scopeEntries, windowsPaths),
      );
    }
    if (entries.length > MAX_RENDERED_SELECTIVE_ROWS) {
      const notice = document.createElement("div");
      notice.className = "selective-empty";
      notice.textContent = `Refine the search to view matches beyond the first ${MAX_RENDERED_SELECTIVE_ROWS.toLocaleString()}.`;
      list.appendChild(notice);
    }
    return;
  }

  list.setAttribute("role", "tree");
  list.setAttribute("aria-label", "Archive contents");
  list.setAttribute("aria-multiselectable", "true");

  const budget = {
    remaining: MAX_RENDERED_SELECTIVE_ROWS,
    truncated: false,
  };
  for (const node of buildEntryTree(entries, windowsPaths)) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    renderSelectiveTreeNode(
      archive,
      node,
      scopeEntries,
      windowsPaths,
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
  const filteredEntries = filterBrowseEntriesByQuery(
    info.entries,
    state.selectiveSearchQuery,
  );
  state.selectiveVisiblePaths = filteredEntries.map((entry) => entry.path);
  const windowsPaths = detectWindowsMemberPaths(info.entries);

  renderSelectiveEntryList(
    archive,
    filteredEntries,
    info.entries,
    searching,
    windowsPaths,
  );

  const summary = document.getElementById("selective-summary");
  if (summary) {
    const selectedCount = getOrCreateSelection(archive).size;
    const matchCount = filteredEntries.length;
    const shownCount =
      document
        .getElementById("selective-list")
        ?.querySelectorAll(".selective-row").length ?? 0;
    if (searching) {
      summary.textContent =
        matchCount > shownCount
          ? `${selectedCount} selected \u00b7 ${shownCount} shown of ${matchCount} matches \u00b7 ${info.entries.length} total`
          : `${selectedCount} selected \u00b7 ${shownCount} shown \u00b7 ${info.entries.length} total`;
    } else {
      const rowLabel = shownCount === 1 ? "row shown" : "rows shown";
      const entryLabel =
        info.entries.length === 1 ? "archive entry" : "archive entries";
      summary.textContent = `${selectedCount} selected \u00b7 ${shownCount} ${rowLabel} \u00b7 ${info.entries.length} ${entryLabel}`;
    }
  }
}
