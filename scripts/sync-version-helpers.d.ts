export function updateCargoLockPackageVersion(
  lockfile: string,
  packageName: string,
  version: string,
): string;

export function updateWindowsResourceFlags(
  resource: string,
  version: string,
): string;
export function updateWindowsResourceVersion(
  resource: string,
  version: string,
): string;

export function updateWindowsShellResourceDestinations<
  T extends { bundle?: { resources?: Record<string, string> } },
>(config: T, version: string): T;

export function windowsPackageVersionFromSemver(version: string): string;

export function macBundleVersionFromSemver(version: string): string;

export function macMarketingVersionFromSemver(version: string): string;
