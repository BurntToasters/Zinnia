const KNOWN_ARCHIVE_SUFFIXES = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tar.zst",
  ".tbz2",
  ".tgz",
  ".txz",
  ".7z",
  ".zip",
  ".rar",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
];

interface PathParts {
  parent: string;
  name: string;
  separator: "/" | "\\";
}

function splitPathParts(rawPath: string): PathParts {
  const archivePath = rawPath.trim();
  if (!archivePath) return { parent: "", name: "", separator: "/" };

  const slashIndex = archivePath.lastIndexOf("/");
  const backslashIndex = archivePath.lastIndexOf("\\");
  const splitIndex = Math.max(slashIndex, backslashIndex);
  const separator: "/" | "\\" = backslashIndex > slashIndex ? "\\" : "/";

  if (splitIndex < 0) {
    return { parent: "", name: archivePath, separator };
  }

  let parent = archivePath.slice(0, splitIndex);
  const name = archivePath.slice(splitIndex + 1);

  if (!parent && separator === "/") {
    parent = "/";
  } else if (/^[A-Za-z]:$/.test(parent)) {
    parent = `${parent}${separator}`;
  }

  return { parent, name, separator };
}

function joinPath(parent: string, name: string, separator: "/" | "\\"): string {
  if (!parent) return name;
  if (parent.endsWith("/") || parent.endsWith("\\")) return `${parent}${name}`;
  return `${parent}${separator}${name}`;
}

function stripKnownArchiveSuffix(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const suffix of KNOWN_ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix) && fileName.length > suffix.length) {
      return fileName.slice(0, fileName.length - suffix.length);
    }
  }
  return "";
}

export function deriveExtractFolderName(archiveName: string): string {
  const cleanedName = archiveName.trim();
  if (!cleanedName) return "";

  const stripped = stripKnownArchiveSuffix(cleanedName);
  if (stripped) return stripped;

  return `${cleanedName}_extracted`;
}

export function deriveExtractDestinationPath(archivePath: string): string {
  const { parent, name, separator } = splitPathParts(archivePath);
  if (!name) return "";

  const folderName = deriveExtractFolderName(name);
  if (!folderName) return "";

  return joinPath(parent, folderName, separator);
}

export function shouldAutofillExtractDestination(
  currentValue: string,
  lastAutoValue: string | null,
): boolean {
  const current = currentValue.trim();
  if (!current) return true;
  if (!lastAutoValue) return false;
  return current === lastAutoValue.trim();
}

export function resolveExtractDestinationAutofill(
  currentValue: string,
  lastAutoValue: string | null,
  primaryArchivePath: string | null | undefined,
): string | null {
  const archive = primaryArchivePath?.trim() ?? "";
  if (!archive) return null;
  if (!shouldAutofillExtractDestination(currentValue, lastAutoValue))
    return null;

  const next = deriveExtractDestinationPath(archive);
  return next || null;
}
