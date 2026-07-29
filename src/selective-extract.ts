import type { BrowseEntry } from "./browse-model.ts";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "./extract-policy";

export function normalizeSelectiveSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function filterBrowseEntriesByQuery(
  entries: BrowseEntry[],
  query: string,
): BrowseEntry[] {
  const normalized = normalizeSelectiveSearchQuery(query);
  if (!normalized) return entries;
  return entries.filter((entry) =>
    entry.path.toLowerCase().includes(normalized),
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
  for (const entry of targetEntries) {
    const recursiveTargets = getRecursiveSelectionPaths(
      scopeEntries,
      entry.path,
      entry.isFolder,
      windowsPaths,
    );
    for (const path of recursiveTargets) next.add(path);
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

function sortTree(node: TreeNode): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    current.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    pending.push(...current.children);
  }
}

export type NodeCheckState = "checked" | "unchecked" | "indeterminate";

// Tri-state for a node: checked if all descendant files are selected,
// unchecked if none, indeterminate if mixed.
export function computeNodeCheckState(
  node: TreeNode,
  selected: Set<string>,
): NodeCheckState {
  if (!node.isFolder) {
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  if (node.children.length === 0) {
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  let hasChecked = false;
  let hasUnchecked = false;
  const visit = (n: TreeNode): void => {
    if (!n.isFolder) {
      if (selected.has(n.path)) hasChecked = true;
      else hasUnchecked = true;
      return;
    }
    if (n.children.length === 0) {
      if (selected.has(n.path)) hasChecked = true;
      else hasUnchecked = true;
      return;
    }
    for (const child of n.children) visit(child);
  };
  for (const child of node.children) visit(child);
  if (hasChecked && hasUnchecked) return "indeterminate";
  if (hasChecked) return "checked";
  return "unchecked";
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
    const hasArchiveChildren = entries.some(
      (candidate) =>
        candidate.path !== path &&
        isPathWithinFolder(candidate.path, path, windowsPaths),
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
