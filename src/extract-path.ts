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

/** File name without a known archive suffix, or "" when there is none. */
function stripKnownArchiveSuffix(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const suffix of KNOWN_ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix) && fileName.length > suffix.length) {
      return fileName.slice(0, fileName.length - suffix.length);
    }
  }
  return "";
}

export function archiveExtensionForFormat(format: string): string {
  return format === "gzip" ? "gz" : format === "bzip2" ? "bz2" : format;
}

// Win32 device names, matched on the dot-stem, case-insensitively, with the
// superscript digits folded to ASCII. Mirrors validation.rs::is_win32_reserved_device_name.
const WIN32_RESERVED_STEM =
  /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9]|LPT[0-9])$/;

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "¹": "1",
  "²": "2",
  "³": "3",
};

function isWin32ReservedDeviceName(component: string): boolean {
  const stem = component
    .split(".")[0]
    .replace(/[¹²³]/g, (ch) => SUPERSCRIPT_DIGITS[ch])
    .toUpperCase();
  return WIN32_RESERVED_STEM.test(stem);
}

// Mirrors validation.rs::windows_component_name_is_unsafe.
function windowsComponentNameIsUnsafe(component: string): boolean {
  if (component.length === 0) return false;
  if (component.endsWith(".") || component.endsWith(" ")) return true;
  if (component.includes(":")) return true;
  return isWin32ReservedDeviceName(component);
}

// Mirrors open_path.rs::contains_braced_clsid. Windows shell parsing resolves a
// `name.{GUID}` folder to a namespace extension, so a derived name must not carry one.
const BRACED_CLSID =
  /\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}/i;

function sanitizeExtractFolderName(folder: string): string {
  if (folder === "." || folder === "..") return "_extracted";
  if (folder.length > 0 && /^[.]+$/.test(folder)) return "_extracted";
  if (folder.endsWith(".") || folder.endsWith(" ")) return "_extracted";
  if (folder.includes(":")) return "_extracted";
  for (const component of folder.split(/[/\\]/)) {
    if (
      component === ".." ||
      windowsComponentNameIsUnsafe(component) ||
      BRACED_CLSID.test(component)
    ) {
      return "_extracted";
    }
  }
  return folder;
}

/**
 * Base name of a split volume (`a.7z.001`, `a.zip.001`, `a.part1.rar`,
 * `a.z01`), or null when the name is not a volume. A bare numeric suffix only
 * counts when the base already ends in a known archive extension, so a name
 * such as `report.2024` is left alone.
 */
function splitVolumeBaseName(archiveName: string): string | null {
  const partMatch = archiveName.match(/^(.+)\.part0*\d+\.rar$/i);
  if (partMatch) return partMatch[1];
  const zipSplitMatch = archiveName.match(/^(.+)\.z\d{2,}$/i);
  if (zipSplitMatch) return zipSplitMatch[1];
  const numericMatch = archiveName.match(/^(.+)\.\d{3,}$/);
  if (numericMatch && stripKnownArchiveSuffix(numericMatch[1])) {
    return numericMatch[1];
  }
  return null;
}

export function deriveExtractFolderName(archiveName: string): string {
  const cleanedName = archiveName;
  if (!cleanedName) return "";

  const volumeBase = splitVolumeBaseName(cleanedName);
  if (volumeBase) {
    const volumeStem = stripKnownArchiveSuffix(volumeBase) || volumeBase;
    return sanitizeExtractFolderName(volumeStem);
  }

  const stripped = stripKnownArchiveSuffix(cleanedName);
  const folder = stripped || `${cleanedName}_extracted`;
  return sanitizeExtractFolderName(folder);
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
  const current = currentValue;
  if (!current) return true;
  if (!lastAutoValue) return false;
  return current === lastAutoValue;
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

function normalizeInputPath(raw: string): string {
  if (!raw) return "";
  if (raw === "/" || raw === "\\") return raw;
  if (/^[A-Za-z]:[\\/]*$/.test(raw)) return `${raw.slice(0, 2)}\\`;
  return raw.replace(/[/\\]+$/, "");
}

/**
 * Folder name shared by every input, or "" when the inputs come from different
 * folders or the shared folder has no name (a drive or filesystem root).
 */
function sharedParentFolderName(inputs: string[]): string {
  if (inputs.length < 2) return "";
  const parents = inputs.map(
    (raw) => splitPathParts(normalizeInputPath(raw)).parent,
  );
  const [first] = parents;
  if (!first || parents.some((parent) => parent !== first)) return "";
  return splitPathParts(first).name;
}

/**
 * Derives the default output archive path from the first input and the chosen
 * format.  For files the full filename is kept as the stem (so `file.exe`
 * becomes `file.exe.7z`).  For folders the folder name is used.  A trailing
 * separator is stripped so both `/folder` and `/folder/` work correctly.
 *
 * When `customName` is provided it replaces the auto-derived stem. Several
 * inputs in one folder are named after that folder. Protected parents (Start
 * Menu, Program Files, …) fall back to the user's Desktop (or home) so staging
 * never lands under a relative CWD / install dir.
 */
export function deriveOutputArchivePath(
  inputs: string[],
  format: string,
  customName?: string,
): string | null {
  const first = normalizeInputPath(inputs[0] ?? "");
  if (!first) return null;
  const { parent, name, separator } = splitPathParts(first);
  if (!name) return null;
  const archiveStem =
    customName && customName.length > 0
      ? customName
      : sharedParentFolderName(inputs) || name;
  if (!archiveStem) return null;
  const extension = archiveExtensionForFormat(format);
  const fileName = `${archiveStem}.${extension}`;
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

/** Typed names are a file name only; folders come from the output path. */
export function archiveNameHasSeparator(typed: string): boolean {
  return /[\\/]/.test(typed);
}

export const ARCHIVE_NAME_SEPARATOR_MESSAGE =
  "Archive names cannot contain / or \\. Use Browse to choose a folder.";

/**
 * Typed archive name without the format's own extension, so `photos.7z` with
 * format 7z becomes `photos`. Returns "" when nothing is left.
 */
export function normalizeTypedArchiveStem(
  typed: string,
  format: string,
): string {
  const trimmed = typed.trim();
  const suffix = `.${archiveExtensionForFormat(format.toLowerCase())}`;
  if (trimmed.toLowerCase() === suffix) return "";
  if (
    trimmed.length > suffix.length &&
    trimmed.toLowerCase().endsWith(suffix)
  ) {
    return trimmed.slice(0, trimmed.length - suffix.length).trimEnd();
  }
  return trimmed;
}

/** Output path for the current folder with the file name of `derivedPath`. */
export function withArchiveFileName(
  currentPath: string,
  derivedPath: string,
): string {
  const derived = splitPathParts(derivedPath);
  if (!derived.name) return derivedPath;
  if (!currentPath) return derivedPath;
  const current = splitPathParts(currentPath);
  // A bare current name has no folder, so use the derived folder.
  const folder = current.parent ? current : derived;
  return joinPath(folder.parent, derived.name, folder.separator);
}

/**
 * Output path for a typed archive name. `deriveDefault` builds the default
 * path for the inputs (with an optional custom stem). The folder of
 * `currentPath` is kept, so a Browse choice survives typing.
 */
export function outputPathForArchiveName(
  currentPath: string,
  format: string,
  typedName: string,
  deriveDefault: (customName?: string) => string | null,
): string | null {
  if (archiveNameHasSeparator(typedName)) return null;
  const stem = normalizeTypedArchiveStem(typedName, format);
  const derived = deriveDefault(stem || undefined);
  if (!derived) return null;
  return withArchiveFileName(currentPath, derived);
}

/**
 * Output path after a manual or autofilled format change. An empty path gets
 * the default. An autofilled path is rebuilt from the typed name. A manual
 * path only swaps its extension (compound extensions included).
 */
export function outputPathForFormatChange(
  currentPath: string,
  lastAutoPath: string | null,
  format: string,
  typedName: string,
  deriveDefault: (customName?: string) => string | null,
): string | null {
  if (!currentPath) {
    const stem = normalizeTypedArchiveStem(typedName, format);
    return deriveDefault(stem || undefined);
  }
  if (currentPath === lastAutoPath) {
    return outputPathForArchiveName(
      currentPath,
      format,
      typedName,
      deriveDefault,
    );
  }
  return swapArchiveExtension(currentPath, format);
}

/** Output path with the format's extension, keeping the folder and name. */
export function swapArchiveExtension(path: string, format: string): string {
  const { parent, name, separator } = splitPathParts(path);
  if (!name) return path;
  const stem = stripKnownArchiveSuffix(name) || name;
  const extension = archiveExtensionForFormat(format.toLowerCase());
  return joinPath(parent, `${stem}.${extension}`, separator);
}

export function shouldAutofillOutputPath(
  currentValue: string,
  lastAutoValue: string | null,
): boolean {
  const current = currentValue;
  if (!current) return true;
  if (!lastAutoValue) return false;
  return current === lastAutoValue;
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
