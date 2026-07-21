const KNOWN_ARCHIVE_SUFFIXES = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
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

function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function splitPathParts(rawPath: string): PathParts {
  const archivePath = rawPath;
  if (!archivePath) return { parent: "", name: "", separator: "/" };

  const windowsLike = looksLikeWindowsPath(archivePath);
  const slashIndex = archivePath.lastIndexOf("/");
  const backslashIndex = windowsLike ? archivePath.lastIndexOf("\\") : -1;
  const splitIndex = Math.max(slashIndex, backslashIndex);
  const separator: "/" | "\\" =
    splitIndex < 0
      ? windowsLike
        ? "\\"
        : "/"
      : backslashIndex > slashIndex
        ? "\\"
        : "/";

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
  const cleanedName = archiveName;
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
  const archive = primaryArchivePath ?? "";
  if (!archive) return null;
  if (!shouldAutofillExtractDestination(currentValue, lastAutoValue))
    return null;

  const next = deriveExtractDestinationPath(archive);
  return next || null;
}

// ---------------------------------------------------------------------------
// Output archive path autofill (compress / add mode)
// ---------------------------------------------------------------------------

/**
 * True when `parent` is a reasonable default save location for a new archive.
 * Start Menu shortcuts, Program Files, and other protected Windows folders
 * often deny creating Zinnia's staging directory beside the source.
 */
export function isPreferredCompressParent(parent: string): boolean {
  if (!parent) return false;
  const normalized = parent.replace(/\//g, "\\").toLowerCase();
  if (normalized.includes("\\start menu\\")) return false;
  if (normalized.includes("\\program files")) return false;
  if (normalized.includes("\\programdata\\")) return false;
  if (normalized.includes("\\system32") || normalized.includes("\\syswow64")) {
    return false;
  }
  // Only the OS Windows directory (e.g. C:\Windows), not …\Microsoft\Windows\….
  if (/^[a-z]:\\windows(\\|$)/.test(normalized)) return false;
  return true;
}

/** Prefer Desktop under the user's profile when the source parent is protected. */
export function fallbackCompressParent(sourcePath: string): string | null {
  const windowsUser = sourcePath.match(/^([A-Za-z]:)\\Users\\([^\\/]+)/i);
  if (windowsUser) {
    return `${windowsUser[1]}\\Users\\${windowsUser[2]}\\Desktop`;
  }
  const unixHome = sourcePath.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (unixHome) return unixHome[1];
  return null;
}

/**
 * Derives the default output archive path from the first input and the chosen
 * format.  For files the full filename is kept as the stem (so `file.exe`
 * becomes `file.exe.7z`).  For folders the folder name is used.  A trailing
 * separator is stripped so both `/folder` and `/folder/` work correctly.
 *
 * When `customName` is provided it replaces the auto-derived stem.
 * Protected parents (Start Menu, Program Files, …) fall back to the user's
 * Desktop (or home) so staging never lands under a relative CWD / install dir.
 */
export function deriveOutputArchivePath(
  inputs: string[],
  format: string,
  customName?: string,
): string | null {
  const firstRaw = inputs[0] ?? "";
  const first = (() => {
    if (!firstRaw) return "";
    if (firstRaw === "/" || firstRaw === "\\") return firstRaw;
    if (/^[A-Za-z]:[\\/]*$/.test(firstRaw)) return `${firstRaw.slice(0, 2)}\\`;
    return firstRaw.replace(/[/\\]+$/, "");
  })();
  if (!first) return null;
  const { parent, name, separator } = splitPathParts(first);
  if (!name) return null;
  const trimmedCustomName = customName?.trim();
  const archiveStem =
    trimmedCustomName && trimmedCustomName.length > 0
      ? trimmedCustomName
      : name;
  if (!archiveStem) return null;
  const fileName = `${archiveStem}.${format}`;
  if (isPreferredCompressParent(parent)) {
    return joinPath(parent, fileName, separator);
  }
  const fallback = fallbackCompressParent(first);
  if (fallback) {
    const fallbackSep = fallback.includes("\\") ? "\\" : "/";
    return joinPath(fallback, fileName, fallbackSep);
  }
  // Last resort: bare name for OS save dialogs only, never for silent Run.
  return fileName;
}

export function shouldAutofillOutputPath(
  currentValue: string,
  lastAutoValue: string | null,
): boolean {
  const current = currentValue.trim();
  if (!current) return true;
  if (!lastAutoValue) return false;
  return current === lastAutoValue.trim();
}

export function resolveOutputArchiveAutofill(
  currentValue: string,
  lastAutoValue: string | null,
  inputs: string[],
  format: string,
  customName?: string,
): string | null {
  if (inputs.length === 0) return null;
  if (!shouldAutofillOutputPath(currentValue, lastAutoValue)) return null;
  return deriveOutputArchivePath(inputs, format, customName);
}
