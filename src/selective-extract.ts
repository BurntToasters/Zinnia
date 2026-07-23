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
  allEntries: BrowseEntry[],
  targetPath: string,
  isFolder: boolean,
  windowsPaths = false,
): string[] {
  if (!isFolder) return [targetPath];
  const recursive = allEntries
    .filter((entry) => isPathWithinFolder(entry.path, targetPath, windowsPaths))
    .map((entry) => entry.path);
  return recursive.length > 0 ? recursive : [targetPath];
}

export function toggleEntrySelection(
  current: Set<string>,
  targetEntry: BrowseEntry,
  allEntries: BrowseEntry[],
  windowsPaths = false,
): Set<string> {
  const recursiveTargets = getRecursiveSelectionPaths(
    allEntries,
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
  allEntries: BrowseEntry[],
  windowsPaths = false,
): Set<string> {
  const next = new Set(current);
  for (const entry of targetEntries) {
    const recursiveTargets = getRecursiveSelectionPaths(
      allEntries,
      entry.path,
      entry.isFolder,
      windowsPaths,
    );
    for (const path of recursiveTargets) next.add(path);
  }
  return next;
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
export const MAX_ARCHIVE_MEMBER_PATH_LENGTH = 32_768;

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
    if (entry.path.length > MAX_ARCHIVE_MEMBER_PATH_LENGTH) {
      throw new Error(
        `Archive member path exceeds the ${MAX_ARCHIVE_MEMBER_PATH_LENGTH}-character browsing limit.`,
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
          path: nodePath,
          isFolder: isLeaf ? entry.isFolder : true,
          size: isLeaf && !entry.isFolder ? entry.size : 0,
          depth: index,
          children: [],
        };
        parent.children.push(node);
        byPath.set(nodePath, node);
      } else if (isLeaf) {
        if (entry.isFolder) node.isFolder = true;
        else node.size = entry.size;
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
  let hasChecked = false;
  let hasUnchecked = false;
  const visit = (n: TreeNode): void => {
    if (!n.isFolder) {
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

export function buildSelectiveExtractArgs(
  archive: string,
  destination: string,
  password: string,
  extraArgs: string[],
  selectedPaths: string[],
): string[] {
  const args = ["x", `-o${destination}`, SAFE_EXTRACT_OVERWRITE_MODE, "-spd"];
  if (password) args.push(`-p${password}`);
  args.push(...extraArgs);
  if (selectedPaths.length > 0) {
    args.push("--", archive, ...selectedPaths);
  } else {
    args.push("--", archive);
  }
  return args;
}
