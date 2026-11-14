import type { BrowseEntry } from "./browse-model.ts";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "./extract-policy";

export function normalizeSelectiveSearchQuery(query: string): string {
  return query.trim().toLowerCase().normalize("NFC");
}

export function filterBrowseEntriesByQuery(
  entries: BrowseEntry[],
  query: string,
): BrowseEntry[] {
  const normalized = normalizeSelectiveSearchQuery(query);
  if (!normalized) return entries;
  return entries.filter((entry) =>
    entry.path.toLowerCase().normalize("NFC").includes(normalized),
  );
}

export function togglePathSelection(
  current: Set<string>,
  path: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

export function selectPaths(
  current: Set<string>,
  paths: string[],
): Set<string> {
  const next = new Set(current);
  for (const path of paths) next.add(path);
  return next;
}

export function clearPathSelection(): Set<string> {
  return new Set();
}

function normalizeFolderPath(path: string, windowsPaths: boolean): string {
  return windowsPaths
    ? path.replace(/[\\/]+$/g, "")
    : path.replace(/\/+$/g, "");
}

export function isPathWithinFolder(
  entryPath: string,
  folderPath: string,
  windowsPaths = false,
): boolean {
  const normalizedFolder = normalizeFolderPath(folderPath, windowsPaths);
  if (!normalizedFolder) return entryPath === folderPath;
  if (entryPath === normalizedFolder) return true;
  return windowsPaths
    ? entryPath.startsWith(`${normalizedFolder}/`) ||
        entryPath.startsWith(`${normalizedFolder}\\`)
    : entryPath.startsWith(`${normalizedFolder}/`);
}

export function getRecursiveSelectionPaths(
  scopeEntries: BrowseEntry[],
  targetPath: string,
  isFolder: boolean,
  windowsPaths = false,
): string[] {
  if (!isFolder) return [targetPath];
  const recursive = scopeEntries
    .filter((entry) => isPathWithinFolder(entry.path, targetPath, windowsPaths))
    .map((entry) => entry.path);
  return recursive.length > 0 ? recursive : [targetPath];
}

export function toggleEntrySelection(
  current: Set<string>,
  targetEntry: BrowseEntry,
  scopeEntries: BrowseEntry[],
  windowsPaths = false,
): Set<string> {
  const recursiveTargets = getRecursiveSelectionPaths(
    scopeEntries,
    targetEntry.path,
    targetEntry.isFolder,
    windowsPaths,
  );
  const shouldSelect = recursiveTargets.some((path) => !current.has(path));
  const next = new Set(current);
  if (shouldSelect) {
    for (const path of recursiveTargets) next.add(path);
  } else {
    for (const path of recursiveTargets) next.delete(path);
  }
  return next;
}

export function selectEntries(
  current: Set<string>,
  targetEntries: BrowseEntry[],
  scopeEntries: BrowseEntry[],
  windowsPaths = false,
): Set<string> {
  const next = new Set(current);
  const index = indexArchiveChildren(scopeEntries, windowsPaths);
  for (const entry of targetEntries) {
    if (!entry.isFolder) {
      next.add(entry.path);
      continue;
    }
    const members = folderMembers(entry.path, index, windowsPaths);
    for (const path of members.length > 0 ? members : [entry.path]) {
      next.add(path);
    }
  }
  return next;
}

/**
 * Infer member-path separator style from the listing, not the host OS.
 * Windows-built archives usually use `\`; POSIX archives use `/`. A lone
 * literal `\` in a name is rare; majority wins when both appear.
 */
export function detectWindowsMemberPaths(entries: BrowseEntry[]): boolean {
  let backslashPaths = 0;
  let forwardPaths = 0;
  for (const entry of entries) {
    if (entry.path.includes("\\")) backslashPaths += 1;
    if (entry.path.includes("/")) forwardPaths += 1;
  }
  return backslashPaths > forwardPaths;
}

export interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  size: number;
  depth: number;
  children: TreeNode[];
}

export const MAX_ARCHIVE_TREE_DEPTH = 256;
export const MAX_ARCHIVE_MEMBER_PATH_BYTES = 8_192;

function splitPathSegments(path: string, windowsPaths: boolean): string[] {
  return path
    .split(windowsPaths ? /[\\/]+/ : /\/+/)
    .filter((s) => s.length > 0);
}

// Build a nested folder/file tree from flat archive entries. Intermediate
// folders missing from the entry list are synthesized so the tree is complete.
export function buildEntryTree(
  entries: BrowseEntry[],
  windowsPaths = false,
): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    isFolder: true,
    size: 0,
    depth: -1,
    children: [],
  };
  const byPath = new Map<string, TreeNode>();
  byPath.set("", root);

  const separator = windowsPaths ? "\\" : "/";
  for (const entry of entries) {
    if (
      new TextEncoder().encode(entry.path).byteLength >
      MAX_ARCHIVE_MEMBER_PATH_BYTES
    ) {
      throw new Error(
        `Archive member path exceeds the ${MAX_ARCHIVE_MEMBER_PATH_BYTES}-byte browsing limit.`,
      );
    }
    const segments = splitPathSegments(entry.path, windowsPaths);
    if (segments.length > MAX_ARCHIVE_TREE_DEPTH) {
      throw new Error(
        `Archive member path exceeds the ${MAX_ARCHIVE_TREE_DEPTH}-level browsing limit.`,
      );
    }
    let parent = root;
    const pathSegments: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      pathSegments.push(name);
      const nodePath = pathSegments.join(separator);
      const isLeaf = index === segments.length - 1;
      let node = byPath.get(nodePath);
      if (!node) {
        node = {
          name,
          // Keep the archive-native path on leaves so selection Sets match
          // `entry.path` even when majority-separator rewriting would diverge
          // for mixed `/`+`\` listings. Intermediate folders stay synthesized.
          path: isLeaf ? entry.path : nodePath,
          isFolder: isLeaf ? entry.isFolder : true,
          size: isLeaf && !entry.isFolder ? entry.size : 0,
          depth: index,
          children: [],
        };
        parent.children.push(node);
        byPath.set(nodePath, node);
        if (isLeaf && entry.path !== nodePath) {
          byPath.set(entry.path, node);
        }
      } else if (isLeaf) {
        if (entry.isFolder) node.isFolder = true;
        else node.size = entry.size;
      } else if (!node.isFolder) {
        // A malformed/unsorted listing can describe a path as a file before a
        // later entry requires it to be a parent. The tree shape wins.
        node.isFolder = true;
        node.size = 0;
      }
      parent = node;
    }
  }

  sortTree(root);
  return root.children;
}

const TREE_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function sortTree(node: TreeNode): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    current.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return TREE_NAME_COLLATOR.compare(a.name, b.name);
    });
    pending.push(...current.children);
  }
}

export type NodeCheckState = "checked" | "unchecked" | "indeterminate";

interface LeafSummary {
  checked: boolean;
  unchecked: boolean;
}

function stateFromSummary(summary: LeafSummary): NodeCheckState {
  if (summary.checked && summary.unchecked) return "indeterminate";
  return summary.checked ? "checked" : "unchecked";
}

// Tri-state for a node: checked if all descendant files are selected,
// unchecked if none, indeterminate if mixed.
export function computeNodeCheckStates(
  roots: TreeNode[],
  selected: Set<string>,
): Map<TreeNode, NodeCheckState> {
  const states = new Map<TreeNode, NodeCheckState>();
  const summarize = (node: TreeNode): LeafSummary => {
    if (!node.isFolder || node.children.length === 0) {
      const checked = selected.has(node.path);
      states.set(node, checked ? "checked" : "unchecked");
      return { checked, unchecked: !checked };
    }
    const summary: LeafSummary = { checked: false, unchecked: false };
    for (const child of node.children) {
      const childSummary = summarize(child);
      if (childSummary.checked) summary.checked = true;
      if (childSummary.unchecked) summary.unchecked = true;
    }
    states.set(node, stateFromSummary(summary));
    return summary;
  };
  for (const root of roots) summarize(root);
  return states;
}

export function computeNodeCheckState(
  node: TreeNode,
  selected: Set<string>,
): NodeCheckState {
  return computeNodeCheckStates([node], selected).get(node) ?? "unchecked";
}

type ArchiveChildIndex = {
  children: Map<string, string[]>;
  paths: Set<string>;
};

/**
 * For each folder prefix, list the distinct archive paths nested under it.
 * Built once per call so folder checks cost O(1) instead of a scan of every
 * entry. Matches `isPathWithinFolder` at separator boundaries only.
 */
function indexArchiveChildren(
  entries: BrowseEntry[],
  windowsPaths: boolean,
): ArchiveChildIndex {
  const children = new Map<string, string[]>();
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) continue;
    paths.add(entry.path);
    const path = entry.path;
    for (let i = 0; i < path.length; i += 1) {
      const ch = path[i];
      if (ch !== "/" && !(windowsPaths && ch === "\\")) continue;
      const prefix = path.slice(0, i);
      const nested = children.get(prefix);
      if (nested) nested.push(path);
      else children.set(prefix, [path]);
    }
  }
  return { children, paths };
}

function folderMembers(
  folderPath: string,
  index: ArchiveChildIndex,
  windowsPaths: boolean,
): string[] {
  const normalized = normalizeFolderPath(folderPath, windowsPaths);
  if (!normalized) return index.paths.has(folderPath) ? [folderPath] : [];
  const nested = index.children.get(normalized) ?? [];
  return index.paths.has(normalized) ? [normalized, ...nested] : nested;
}

/** Same answer as `entries.some(c => c.path !== folder && within(c, folder))`. */
function folderHasArchiveChildren(
  folderPath: string,
  index: ArchiveChildIndex,
  windowsPaths: boolean,
): boolean {
  const normalized = normalizeFolderPath(folderPath, windowsPaths);
  // isPathWithinFolder matches nothing but the folder itself for an empty name.
  if (!normalized) return false;
  // A folder with trailing separators is itself counted under its own
  // normalized prefix, so remove that one self-match.
  const selfMatch = normalized !== folderPath ? 1 : 0;
  if ((index.children.get(normalized)?.length ?? 0) - selfMatch > 0) {
    return true;
  }
  // The same folder without its trailing separators is a distinct child.
  return normalized !== folderPath && index.paths.has(normalized);
}

/**
 * Map UI selection paths to 7-Zip member filters. Never pass a non-empty folder
 * path: `7z x … folder` expands the full archive subtree, including members
 * outside the rendered/search selection scope.
 */
export function resolveSelectiveExtractMemberPaths(
  selectedPaths: string[],
  entries: BrowseEntry[],
  windowsPaths = false,
): string[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const index = indexArchiveChildren(entries, windowsPaths);
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const path of selectedPaths) {
    const entry = byPath.get(path);
    if (!entry) continue;
    if (!entry.isFolder) {
      if (!seen.has(path)) {
        seen.add(path);
        resolved.push(path);
      }
      continue;
    }
    const hasArchiveChildren = folderHasArchiveChildren(
      path,
      index,
      windowsPaths,
    );
    // Empty folders must still be passed so 7-Zip creates the directory.
    if (!hasArchiveChildren && !seen.has(path)) {
      seen.add(path);
      resolved.push(path);
    }
  }
  return resolved;
}

export function buildSelectiveExtractArgs(
  archive: string,
  destination: string,
  password: string,
  extraArgs: string[],
  selectedPaths: string[],
): string[] {
  const args = [
    "x",
    `-o${destination}`,
    SAFE_EXTRACT_OVERWRITE_MODE,
    "-bb1",
    "-spd",
    "-bsp1",
  ];
  if (password) args.push(`-p${password}`);
  args.push(...extraArgs);
  if (selectedPaths.length > 0) {
    args.push("--", archive, ...selectedPaths);
  } else {
    args.push("--", archive);
  }
  return args;
}
