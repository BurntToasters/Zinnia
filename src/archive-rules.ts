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
  "-stl",
  "-slp",
  "-ssp",
  "-ssw",
  "-sse",
  "-y",
  "-r",
];

export interface ArchivePathValidation {
  path: string;
  valid: boolean;
  reason?: string;
}

export type ProbeArchivePaths = (
  paths: string[],
) => Promise<ArchivePathValidation[]>;

const SWITCH_PATH_PREFIXES = ["-i", "-x", "-w", "-o"];

function normalizePath(path: string): string {
  return path.trim();
}

function hasParentDirComponent(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === "..");
}

function switchContainsParentTraversal(arg: string): boolean {
  const lower = arg.toLowerCase();
  if (!SWITCH_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return false;
  }
  const payload = arg.slice(2);
  return payload
    .split(/[!:@]/)
    .some((segment) => hasParentDirComponent(segment));
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
      byPath.set(normalizedPath, normalizedResult);
    }
    for (const path of probeList) {
      if (!byPath.has(path)) {
        const fallback: ArchivePathValidation = {
          path,
          valid: false,
          reason: "Validation returned no result.",
        };
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

    if (switchContainsParentTraversal(arg)) {
      throw new Error(
        `"${arg}" must not contain a '..' parent-directory segment.`,
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
