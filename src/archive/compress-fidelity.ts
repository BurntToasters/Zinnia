import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";

export interface CompressInputProbe {
  nestedSymlinks: number;
  appBundles: number;
  nestedReparsePoints: number;
  examples: string[];
}

/** Formats where nested symlinks / .app trees often fail to round-trip. */
export function formatWeakForSymlinks(format: string): boolean {
  return format.toLowerCase() === "zip";
}

export async function probeCompressInputs(
  paths: string[],
): Promise<CompressInputProbe> {
  return invoke<CompressInputProbe>("probe_compress_inputs", { paths });
}

/**
 * Warn when ZIP is asked to archive trees with symlinks or .app bundles.
 * Returns false if the user cancels.
 */
export async function confirmZipSymlinkRisk(
  format: string,
  paths: string[],
): Promise<boolean> {
  if (!formatWeakForSymlinks(format) || paths.length === 0) {
    return true;
  }
  let probe: CompressInputProbe;
  try {
    probe = await probeCompressInputs(paths);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return confirm(
      `Could not fully scan inputs before ZIP compress (${detail}). ZIP may break symbolic links in app bundles. Prefer 7z or TAR.\n\nContinue with ZIP anyway?`,
      { title: "ZIP compress scan incomplete", kind: "warning" },
    );
  }
  if (probe.nestedSymlinks === 0 && probe.appBundles === 0) {
    return true;
  }
  const bits: string[] = [];
  if (probe.appBundles > 0) {
    bits.push(
      `${probe.appBundles} macOS app bundle${probe.appBundles === 1 ? "" : "s"}`,
    );
  }
  if (probe.nestedSymlinks > 0) {
    bits.push(
      `${probe.nestedSymlinks} symbolic link${probe.nestedSymlinks === 1 ? "" : "s"}`,
    );
  }
  const sample = probe.examples[0] ? `\n\nExample: ${probe.examples[0]}` : "";
  return confirm(
    `ZIP often fails to preserve ${bits.join(" and ")} (framework Versions/Current links break). Prefer 7z or TAR for a faithful archive.\n\nContinue with ZIP anyway?${sample}`,
    { title: "ZIP may break app bundles", kind: "warning" },
  );
}
