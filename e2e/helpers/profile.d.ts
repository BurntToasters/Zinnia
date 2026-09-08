export const REPO_ROOT: string;
export const ZIPS_DIR: string;
export const APP_ID: string;
export const E2E_WEBVIEW2_BROWSER_ARGS: string;

export function loadArchiveManifest(repoRoot?: string): {
  payloadFile: string;
  payloadText: string;
  password: string;
  [key: string]: unknown;
};
export function hostBinaryName(platform?: NodeJS.Platform): string;
export function e2eBinaryPath(repoRoot?: string): string;
export function e2eStampPath(repoRoot?: string): string;
export function seedE2eSettings(settingsDir: string): void;
export function settingsDirForProfile(
  profileDir: string,
  platform?: NodeJS.Platform,
): string;
export function windowsProfilePaths(home: string): {
  roaming: string;
  local: string;
  settingsRoaming: string;
  settingsLocal: string;
  webview2: string;
};
export function windowsHomeDriveAndPath(
  homeAbs: string,
  pathImpl?: { parse(p: string): { root: string } },
): { HOMEDRIVE: string; HOMEPATH: string };
export function createE2eProfile(
  repoRoot?: string,
  platform?: NodeJS.Platform,
): {
  profileDir: string;
  work: string;
  copies: Record<string, string>;
  env: Record<string, string>;
  manifest: ReturnType<typeof loadArchiveManifest>;
};
