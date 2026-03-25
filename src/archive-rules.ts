import { invoke } from "@tauri-apps/api/core";

export const ALLOWED_EXTRA_PREFIXES = [
  "-m",
  "-x",
  "-i",
  "-ao",
  "-bb",
  "-bs",
  "-bt",
  "-scs",
  "-slt",
  "-sns",
  "-snl",
  "-sni",
  "-stl",
  "-slp",
  "-ssp",
  "-ssw",
  "-y",
  "-r",
  "-w",
];

export interface ArchivePathValidation {
  path: string;
  valid: boolean;
  reason?: string;
}

export type ProbeArchivePaths = (
  paths: string[],
) => Promise<ArchivePathValidation[]>;

interface ArchiveValidationCacheEntry {
  result: ArchivePathValidation;
  expiresAt: number;
}

const ARCHIVE_VALIDATION_CACHE_TTL_MS = 10_000;
const ARCHIVE_VALIDATION_CACHE_MAX_ENTRIES = 2_000;
const archiveValidationCache = new Map<string, ArchiveValidationCacheEntry>();

function normalizePath(path: string): string {
  return path.trim();
}

function getCachedValidation(path: string): ArchivePathValidation | null {
  const cached = archiveValidationCache.get(path);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    archiveValidationCache.delete(path);
    return null;
  }
  return cached.result;
}

function setCachedValidation(
  path: string,
  result: ArchivePathValidation,
): void {
  archiveValidationCache.delete(path);
  archiveValidationCache.set(path, {
    result,
    expiresAt: Date.now() + ARCHIVE_VALIDATION_CACHE_TTL_MS,
  });
  while (archiveValidationCache.size > ARCHIVE_VALIDATION_CACHE_MAX_ENTRIES) {
    const oldest = archiveValidationCache.keys().next().value;
    if (!oldest) break;
    archiveValidationCache.delete(oldest);
  }
}

export async function validateArchivePaths(
  paths: string[],
): Promise<ArchivePathValidation[]> {
  const normalized = paths.map(normalizePath);
  const byPath = new Map<string, ArchivePathValidation>();
  const toProbe = new Set<string>();

  for (const path of normalized) {
    if (!path) {
      byPath.set(path, { path, valid: false, reason: "Path is empty." });
      continue;
    }
    const cached = getCachedValidation(path);
    if (cached) {
      byPath.set(path, cached);
      continue;
    }
    toProbe.add(path);
  }

  if (toProbe.size > 0) {
    const probeList = [...toProbe];
    const probed = await invoke<ArchivePathValidation[]>(
      "validate_archive_paths",
      { paths: probeList },
    );
    for (const result of probed) {
      const normalizedPath = normalizePath(result.path);
      const normalizedResult: ArchivePathValidation = {
        path: normalizedPath,
        valid: result.valid,
        reason: result.reason,
      };
      setCachedValidation(normalizedPath, normalizedResult);
      byPath.set(normalizedPath, normalizedResult);
    }
    for (const path of probeList) {
      if (!byPath.has(path)) {
        const fallback: ArchivePathValidation = {
          path,
          valid: false,
          reason: "Validation returned no result.",
        };
        setCachedValidation(path, fallback);
        byPath.set(path, fallback);
      }
    }
  }

  return normalized.map((path) => {
    const resolved = byPath.get(path);
    if (resolved) return resolved;
    return { path, valid: false, reason: "Validation unavailable." };
  });
}

export function validateExtraArgs(args: string[]): void {
  const blocked = ["-sdel", "-p", "-mhe", "-o", "-si", "-so", "-t"];

  for (const arg of args) {
    if (!arg.startsWith("-")) {
      throw new Error(`Extra arguments must start with '-'. Invalid: ${arg}`);
    }

    const lower = arg.toLowerCase();
    if (blocked.some((b) => lower.startsWith(b))) {
      throw new Error(
        `"${arg}" is not allowed in extra args. Use the dedicated fields instead.`,
      );
    }

    if (!ALLOWED_EXTRA_PREFIXES.some((p) => lower.startsWith(p))) {
      throw new Error(
        `Unknown argument "${arg}". Only recognized 7z switches are allowed.`,
      );
    }
  }
}

export async function ensureArchivePaths(
  paths: string[],
  context: "browse" | "extract" | "test",
  probe: ProbeArchivePaths = validateArchivePaths,
): Promise<void> {
  const normalized = paths.map(normalizePath).filter((path) => path.length > 0);
  if (normalized.length === 0) return;

  let invalid: ArchivePathValidation[];
  try {
    invalid = (await probe(normalized)).filter((result) => !result.valid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to validate selected inputs for ${context}: ${msg}`,
    );
  }
  if (invalid.length === 0) return;

  const sample = invalid
    .slice(0, 3)
    .map(
      (result) => `${result.path}${result.reason ? ` (${result.reason})` : ""}`,
    )
    .join(", ");
  const more = invalid.length > 3 ? ` (+${invalid.length - 3} more)` : "";
  const noun = invalid.length === 1 ? "input is" : "inputs are";
  throw new Error(
    `Only supported archive files can be used for ${context}. ${invalid.length} ${noun} invalid: ${sample}${more}`,
  );
}
