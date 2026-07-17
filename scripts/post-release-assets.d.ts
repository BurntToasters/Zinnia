export const RELEASE_DIR: string;
export const BUILD_ONLY_DIRECTORIES: string[];
export const BUILD_ONLY_FILES: string[];
export const CLI_FLAG: string;

export function cleanReleaseArtifacts(releaseDir?: string): void;
export function getAfterPackLocation(
  env?: Record<string, string | undefined>,
): string;
export function pathsEqual(
  left: string,
  right: string,
  platform?: NodeJS.Platform,
): boolean;
export function isDirectExecution(
  argv?: string[],
  platform?: NodeJS.Platform,
): boolean;
export function getReleaseEntries(releaseDir: string): string[];
export function verifyCopiedPath(
  sourcePath: string,
  destinationPath: string,
): void;
export function copyReleaseAssets(
  releaseDir: string | undefined,
  destination: string,
  options?: { logger?: Pick<Console, "log" | "warn" | "error"> },
): number;

export type FinalizeResult =
  | { mirrored: false; destination: null }
  | {
      mirrored: true;
      destination: string;
      copiedEntries: number;
    };

export function run(options?: {
  releaseDir?: string;
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}): FinalizeResult;
