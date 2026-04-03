import type { BrowseEntry } from "./browse-model.ts";

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

export function buildSelectiveExtractArgs(
  archive: string,
  destination: string,
  password: string,
  extraArgs: string[],
  selectedPaths: string[],
): string[] {
  const args = ["x", `-o${destination}`, "-y"];
  if (password) args.push(`-p${password}`);
  args.push(...extraArgs);
  if (selectedPaths.length > 0) {
    args.push("-spd", "--", archive, ...selectedPaths);
  } else {
    args.push("--", archive);
  }
  return args;
}
