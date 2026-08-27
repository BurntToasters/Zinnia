export function requiredDraftInstallerNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftSidecarNames(installers: string[]): string[];
export function requiredDraftStableManifestNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftBetaManifestNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftChecksumNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftAssetNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function assertDraftReleaseShape(options: {
  release: {
    draft?: boolean;
    prerelease?: boolean;
    target_commitish?: string;
  };
  assetNames: string[];
  version: string;
  headCommit?: string;
  requireLinuxAarch64?: boolean;
}): { tag: string; missing: string[] };
export function selectDraftRelease(
  releases: Array<{ tag_name?: string; draft?: boolean }>,
  tag: string,
): { tag_name?: string; draft?: boolean } | null;
