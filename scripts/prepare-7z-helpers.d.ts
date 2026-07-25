export function isPathInside(candidate: string, root: string): boolean;

export function validateTrusted7zPath(
  suppliedPath: string | undefined,
  directories: {
    assetsDirectory: string;
    outputDirectory: string;
  },
): string;

export function officialArchiveExtractionCommand(options: {
  archivePath: string;
  destination: string;
  trusted7zPath?: string;
}): {
  command: string;
  args: string[];
};
