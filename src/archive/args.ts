import { $, parseThreads, splitArgs } from "../utils";
import { SETTING_DEFAULTS, state } from "../state";
import { getMode } from "../ui";
import { validateExtraArgs } from "../archive-rules";
import {
  normalizeCompressionSecurityOptions,
  validateCompressionSecurityOptions,
} from "../compression-security";
import { buildSelectiveExtractArgs } from "../selective-extract";

export function isEncryptedFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "+" ||
    normalized === "yes" ||
    normalized === "true" ||
    normalized === "1"
  );
}

export function methodLooksEncrypted(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("7zaes") ||
    normalized.includes("aes") ||
    normalized.includes("zipcrypto")
  );
}

// Inject or replace the -p password switch in a 7z arg list (before "--").
export function withPassword(args: string[], password: string): string[] {
  const sepIndex = args.indexOf("--");
  const head = sepIndex === -1 ? args.slice() : args.slice(0, sepIndex);
  const tail = sepIndex === -1 ? [] : args.slice(sepIndex);
  const filtered = head.filter((a) => !a.startsWith("-p"));
  filtered.push(`-p${password}`);
  return [...filtered, ...tail];
}

export function buildExtractArgsFor(
  archive: string,
  selectedPaths: string[] = [],
  passwordOverride?: string,
  destinationOverride?: string,
): string[] {
  const dest = destinationOverride ?? $<HTMLInputElement>("extract-path").value;
  const password =
    passwordOverride ?? $<HTMLInputElement>("extract-password").value;
  const extraArgs = splitArgs(
    $<HTMLInputElement>("extract-extra-args").value.trim(),
  );
  if (extraArgs.length > 0) validateExtraArgs(extraArgs);

  if (!dest) throw new Error("Choose a destination folder.");

  return buildSelectiveExtractArgs(
    archive,
    dest,
    password,
    extraArgs,
    selectedPaths,
  );
}

// Format/level/method/dict/word-size/solid/threads switches read from the
// compression form. Shared by buildArgs and convertArchive so they stay in sync.
export function buildCompressionMethodSwitches(format: string): string[] {
  const level = $<HTMLSelectElement>("level").value;
  const method = $<HTMLSelectElement>("method").value;
  const dict = $<HTMLSelectElement>("dict").value;
  const wordSize = $<HTMLSelectElement>("word-size").value;
  const solid = $<HTMLSelectElement>("solid").value;
  const threads = parseThreads(
    $<HTMLInputElement>("threads").value,
    SETTING_DEFAULTS.threads,
  );

  const switches = [`-t${format}`, `-mx=${level}`];
  if (method) switches.push(`-m0=${method}`);
  if (dict) switches.push(`-md=${dict}`);
  if (wordSize) switches.push(`-mfb=${wordSize}`);
  if (format === "7z") {
    if (solid === "solid") switches.push("-ms=on");
    else if (solid === "off") switches.push("-ms=off");
    else switches.push(`-ms=${solid}`);
  }
  if (threads) switches.push(`-mmt=${threads}`);
  return switches;
}

/**
 * GZIP, BZIP2, and XZ are single-stream formats in 7-Zip. A multi-file
 * selection must be wrapped in TAR first (for example, tar.gz); passing
 * multiple inputs directly makes 7-Zip fail with E_INVALIDARG.
 */
export function validateCompressionInputShape(
  format: string,
  inputCount: number,
): string | null {
  if (
    (format === "gzip" || format === "bzip2" || format === "xz") &&
    inputCount !== 1
  ) {
    return `${format.toUpperCase()} compression accepts exactly one input. Select one file, or use a TAR-based format for multiple files.`;
  }
  return null;
}

const OUTPUT_SUFFIXES: Record<string, string[]> = {
  "7z": [".7z"],
  zip: [".zip"],
  tar: [".tar"],
  gzip: [".gz", ".tgz"],
  bzip2: [".bz2", ".tbz2"],
  xz: [".xz", ".txz"],
};

export function validateArchiveOutputExtension(
  outputPath: string,
  format: string,
): string | null {
  const suffixes = OUTPUT_SUFFIXES[format];
  if (!suffixes) return `Unsupported archive format: ${format}`;
  const lower = outputPath.toLocaleLowerCase("en-US");
  if (suffixes.some((suffix) => lower.endsWith(suffix))) return null;
  return `Output filename must end in ${suffixes.join(" or ")} for ${format.toUpperCase()} format.`;
}

export function buildArgs() {
  const mode = getMode();

  if (mode === "extract") {
    if (!state.inputs[0]) throw new Error("Select an archive to extract.");
    return buildExtractArgsFor(state.inputs[0]);
  }

  const extraArgs = splitArgs($<HTMLInputElement>("extra-args").value.trim());

  if (extraArgs.length > 0) {
    validateExtraArgs(extraArgs);
  }

  const outputPath = $<HTMLInputElement>("output-path").value;
  if (!outputPath) {
    throw new Error("Choose an output archive path.");
  }
  if (state.inputs.length === 0) {
    throw new Error("Add at least one input.");
  }

  const format = $<HTMLSelectElement>("format").value;
  const extensionError = validateArchiveOutputExtension(outputPath, format);
  if (extensionError) throw new Error(extensionError);
  const inputShapeError = validateCompressionInputShape(
    format,
    state.inputs.length,
  );
  if (inputShapeError) throw new Error(inputShapeError);
  const rawPassword = $<HTMLInputElement>("password").value;
  const rawEncryptHeaders = $<HTMLInputElement>("encrypt-headers").checked;
  const updateMode = $<HTMLInputElement>("update-mode").checked;
  const deleteAfter = $<HTMLInputElement>("delete-after").checked;
  const storeTimestamps = $<HTMLInputElement>("store-timestamps").checked;

  const validationError = validateCompressionSecurityOptions(
    format,
    rawPassword,
    rawEncryptHeaders,
  );
  if (validationError) {
    throw new Error(validationError);
  }

  const { password, encryptHeaders } = normalizeCompressionSecurityOptions(
    format,
    rawPassword,
    rawEncryptHeaders,
  );

  // -snl/-snh preserve symlinks/hardlinks (macOS .app / .framework bundles).
  const switches = [
    "-sse",
    "-snl",
    "-snh",
    "-spd",
    ...buildCompressionMethodSwitches(format),
  ];
  if (password) switches.push(`-p${password}`);
  // ZIP defaults to weak ZipCrypto; upgrade to AES-256 when a password is set.
  if (password && format === "zip") switches.push("-mem=AES256");
  if (encryptHeaders) switches.push("-mhe=on");
  if (storeTimestamps) switches.push("-mtc=on", "-mta=on");
  // Modification time is stored by default (-mtm=on). -mtc/-mta add creation
  // and access; 7-Zip has no separate portable "birth" switch beyond -mtc.
  if (deleteAfter) {
    throw new Error(
      "Delete after compression is unavailable because source deletion cannot be rolled back safely. Delete the sources manually after testing the archive.",
    );
  }

  if (!updateMode) {
    const splitSize = readSplitSize();
    if (splitSize) switches.push(`-v${splitSize}`);
  }

  const args = [
    updateMode ? "u" : "a",
    ...switches,
    ...extraArgs,
    outputPath,
    "--",
    ...state.inputs,
  ];
  return args;
}

const SPLIT_SIZE_PATTERN = /^\d+(?:b|k|m|g)?$/i;

export function readSplitSize(): string {
  const select = $<HTMLSelectElement>("split-size");
  const choice = select.value;
  if (!choice) return "";
  const raw =
    choice === "custom"
      ? $<HTMLInputElement>("split-custom").value.trim().toLowerCase()
      : choice;
  if (!raw) return "";
  if (!SPLIT_SIZE_PATTERN.test(raw)) {
    throw new Error(
      `Invalid split size "${raw}". Use a number with optional b/k/m/g, e.g. 100m.`,
    );
  }
  return raw;
}
