export function updateCargoLockPackageVersion(
  lockfile: string,
  packageName: string,
  version: string,
): string;

export function updateWindowsResourceFlags(
  resource: string,
  version: string,
): string;

export function macBundleVersionFromSemver(version: string): string;

export function macMarketingVersionFromSemver(version: string): string;
