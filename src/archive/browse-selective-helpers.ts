import { state, cacheSelection } from "../state";
import type { ArchiveInfo } from "../browse-model";
import {
  detectWindowsMemberPaths,
  resolveSelectiveExtractMemberPaths,
} from "../selective-extract";

export function getOrCreateSelection(archive: string): Set<string> {
  const existing = state.browseSelectionsByArchive.get(archive);
  if (existing) return existing;
  const created = new Set<string>();
  cacheSelection(archive, created);
  return created;
}

export function getCachedArchiveInfo(archive: string): ArchiveInfo | null {
  return state.browseArchiveInfoByPath.get(archive) ?? null;
}

export function getCurrentArchiveSelectionPaths(
  archive: string,
  info: ArchiveInfo,
): string[] {
  const selected = state.browseSelectionsByArchive.get(archive);
  if (!selected || selected.size === 0) return [];
  const selectedEntries = info.entries
    .filter((entry) => selected.has(entry.path))
    .map((entry) => entry.path);
  // Strip non-empty folders so 7z cannot expand past the selection Set.
  return resolveSelectiveExtractMemberPaths(
    selectedEntries,
    info.entries,
    detectWindowsMemberPaths(info.entries),
  );
}

export function archiveHasRawSelection(archive: string): boolean {
  const selected = state.browseSelectionsByArchive.get(archive);
  return Boolean(selected && selected.size > 0);
}
