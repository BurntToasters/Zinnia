export function parseUpdate7zArgv(argv: string[]): {
  help: boolean;
  check: boolean;
  update: boolean;
  force: boolean;
};
export function printUpdate7zUsage(): void;
export function syncChangelog7zVersion(
  changelog: string,
  appVersion: string,
  sevenZipVersion: string,
): string;
