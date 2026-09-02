import { invokeCompressInputProbe } from "./backend-ipc";

export interface CompressInputProbe {
  nestedSymlinks: number;
  appBundles: number;
  nestedReparsePoints: number;
  examples: string[];
}

/** Current bundled 7-Zip preserves links for every exposed archive format. */
export function formatWeakForSymlinks(_format: string): boolean {
  return false;
}

export async function probeCompressInputs(
  paths: string[],
): Promise<CompressInputProbe> {
  return invokeCompressInputProbe<CompressInputProbe>(paths);
}

/**
 * Compatibility hook retained for callers. ZIP link storage is enabled in the
 * backend, so no warning or preflight scan is needed.
 */
export async function confirmZipSymlinkRisk(
  format: string,
  paths: string[],
): Promise<boolean> {
  void format;
  void paths;
  return true;
}
