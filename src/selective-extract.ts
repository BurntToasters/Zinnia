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

function normalizeFolderPath(path: string): string {
  return path.replace(/[\\/]+$/g, "");
}

export function isPathWithinFolder(
  entryPath: string,
  folderPath: string,
): boolean {
  const normalizedFolder = normalizeFolderPath(folderPath);
  if (!normalizedFolder) return entryPath === folderPath;
  if (entryPath === normalizedFolder) return true;
  return (
    entryPath.startsWith(`${normalizedFolder}/`) ||
    entryPath.startsWith(`${normalizedFolder}\\`)
  );
}

export function getRecursiveSelectionPaths(
  allEntries: BrowseEntry[],
  targetPath: string,
  isFolder: boolean,
): string[] {
  if (!isFolder) return [targetPath];
  const recursive = allEntries
    .filter((entry) => isPathWithinFolder(entry.path, targetPath))
    .map((entry) => entry.path);
  return recursive.length > 0 ? recursive : [targetPath];
}

export function toggleEntrySelection(
  current: Set<string>,
  targetEntry: BrowseEntry,
  allEntries: BrowseEntry[],
): Set<string> {
  const recursiveTargets = getRecursiveSelectionPaths(
    allEntries,
    targetEntry.path,
    targetEntry.isFolder,
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
): Set<string> {
  const next = new Set(current);
  for (const entry of targetEntries) {
    const recursiveTargets = getRecursiveSelectionPaths(
      allEntries,
      entry.path,
      entry.isFolder,
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

function splitPathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0);
}

// Build a nested folder/file tree from flat archive entries. Intermediate
// folders missing from the entry list are synthesized so the tree is complete.
export function buildEntryTree(entries: BrowseEntry[]): TreeNode[] {
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

  const ensureNode = (
    path: string,
    isFolder: boolean,
    size: number,
  ): TreeNode => {
    const existing = byPath.get(path);
    if (existing) {
      if (isFolder) existing.isFolder = true;
      else existing.size = size;
      return existing;
    }
    const segments = splitPathSegments(path);
    const name = segments[segments.length - 1] ?? path;
    const parentPath = segments.slice(0, -1).join("/");
    const parent = ensureNode(parentPath, true, 0);
    const node: TreeNode = {
      name,
      path,
      isFolder,
      size,
      depth: segments.length - 1,
      children: [],
    };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };

  for (const entry of entries) {
    const normalized = splitPathSegments(entry.path).join("/");
    ensureNode(normalized, entry.isFolder, entry.size);
  }

  sortTree(root);
  return root.children;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
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
  const args = ["x", `-o${destination}`, SAFE_EXTRACT_OVERWRITE_MODE];
  if (password) args.push(`-p${password}`);
  args.push(...extraArgs);
  if (selectedPaths.length > 0) {
    args.push("-spd", "--", archive, ...selectedPaths);
  } else {
    args.push("--", archive);
  }
  return args;
}
