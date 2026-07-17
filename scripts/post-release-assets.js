#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RELEASE_DIR = path.join(__dirname, "..", "release");

const BUILD_ONLY_DIRECTORIES = [
  "app",
  "appimage",
  "deb",
  "dmg",
  "macos",
  "msi",
  "nsis",
  "rpm",
];
const BUILD_ONLY_FILES = [
  "builder-debug.yml",
  "builder-effective-config.yaml",
  ".build-session.json",
];
const CLI_FLAG = "--finalize-release-assets";

function removePath(targetPath) {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}

function cleanReleaseArtifacts(releaseDir = RELEASE_DIR) {
  for (const dir of BUILD_ONLY_DIRECTORIES) {
    removePath(path.join(releaseDir, dir));
  }

  for (const file of BUILD_ONLY_FILES) {
    removePath(path.join(releaseDir, file));
  }
}

function getAfterPackLocation(env = process.env) {
  const value = env.AFTER_PACK_LOC;
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function pathsEqual(left, right, platform = process.platform) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (platform === "win32") {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

function isDirectExecution(argv = process.argv, platform = process.platform) {
  if (argv.includes(CLI_FLAG)) {
    return true;
  }
  const entry = argv[1];
  if (!entry) {
    return false;
  }
  // Basename-only check: full-path identity breaks on Windows ESM
  // (argv vs import.meta.url / slash / case / symlink mismatches) and
  // previously caused a silent no-op with zero log output.
  // Use the platform's path module so tests can simulate win32 on darwin/linux.
  const basename =
    platform === "win32" ? path.win32.basename(entry) : path.basename(entry);
  return basename.toLowerCase() === "post-release-assets.js";
}

function isMirrorableReleaseEntry(name) {
  // Dotfiles are build/session markers (e.g. .build-session.json), never ship artifacts.
  return Boolean(name) && !name.startsWith(".");
}

function getReleaseEntries(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }

  const entries = fs.readdirSync(releaseDir).filter(isMirrorableReleaseEntry);
  if (!entries.length) {
    throw new Error(`release directory is empty: ${releaseDir}`);
  }
  return entries;
}

function verifyCopiedPath(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  let destination;
  try {
    destination = fs.statSync(destinationPath);
  } catch {
    throw new Error(`mirrored path is missing: ${destinationPath}`);
  }

  if (source.isDirectory() !== destination.isDirectory()) {
    throw new Error(`mirrored path type differs: ${destinationPath}`);
  }
  if (source.isFile() && source.size !== destination.size) {
    throw new Error(
      `mirrored file size differs: ${destinationPath} (${destination.size} bytes; expected ${source.size})`,
    );
  }

  if (source.isDirectory()) {
    const sourceEntries = fs.readdirSync(sourcePath);
    for (const entry of sourceEntries) {
      verifyCopiedPath(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
  }
}

function progress(logger, message) {
  if (logger && typeof logger.error === "function") {
    logger.error(`[release:mirror] ${message}`);
  }
}

/**
 * Copy without fs.cpSync's native recursive fast-path.
 * On Windows mapped drives (Z:), that native path can abort the whole Node
 * process instead of throwing a catchable error — which matched the
 * "banners print, then silent exit, nothing mirrored" failure mode.
 */
function copyFileForMirror(sourcePath, destinationPath) {
  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (error) {
    // SMB/CIFS often rejects permission-bit preservation; plain bytes work.
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "EPERM" && code !== "EACCES") {
      throw error;
    }
    fs.writeFileSync(destinationPath, fs.readFileSync(sourcePath));
  }
}

function copyPathRecursive(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  if (source.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyPathRecursive(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileForMirror(sourcePath, destinationPath);
}

function copyReleaseAssets(
  releaseDir = RELEASE_DIR,
  destination,
  { logger = console } = {},
) {
  if (!destination) {
    throw new Error("AFTER_PACK_LOC is empty");
  }

  const resolvedReleaseDir = path.resolve(releaseDir);
  const resolvedDestination = path.resolve(destination);
  progress(
    logger,
    `copy resolve: src=${resolvedReleaseDir} dest=${resolvedDestination}`,
  );

  if (pathsEqual(resolvedDestination, resolvedReleaseDir)) {
    throw new Error("AFTER_PACK_LOC cannot be the release directory");
  }

  const releasePrefix = `${resolvedReleaseDir}${path.sep}`;
  const destinationForComparison =
    process.platform === "win32"
      ? resolvedDestination.toLowerCase()
      : resolvedDestination;
  const releasePrefixForComparison =
    process.platform === "win32" ? releasePrefix.toLowerCase() : releasePrefix;
  if (destinationForComparison.startsWith(releasePrefixForComparison)) {
    throw new Error("AFTER_PACK_LOC cannot be inside the release directory");
  }

  progress(logger, `mkdir ${resolvedDestination}`);
  fs.mkdirSync(resolvedDestination, { recursive: true });
  // Prove the destination is actually writable before copying big artifacts.
  const probePath = path.join(
    resolvedDestination,
    `.zinnia-mirror-probe-${process.pid}`,
  );
  fs.writeFileSync(probePath, "ok");
  fs.rmSync(probePath, { force: true });
  progress(logger, "destination writable");

  const entries = getReleaseEntries(resolvedReleaseDir);
  progress(logger, `copying ${entries.length} entries`);

  for (const entry of entries) {
    const sourcePath = path.join(resolvedReleaseDir, entry);
    const destinationPath = path.join(resolvedDestination, entry);
    progress(logger, `copy ${entry}`);
    copyPathRecursive(sourcePath, destinationPath);
    verifyCopiedPath(sourcePath, destinationPath);
    progress(logger, `verified ${entry}`);
  }

  return entries.length;
}

function run({
  releaseDir = RELEASE_DIR,
  env = process.env,
  logger = console,
} = {}) {
  progress(logger, "cleaning build-only release artifacts");
  cleanReleaseArtifacts(releaseDir);
  progress(logger, "clean complete");

  const destination = getAfterPackLocation(env);
  if (!destination) {
    return { mirrored: false, destination: null };
  }

  const copiedEntries = copyReleaseAssets(releaseDir, destination, { logger });
  return {
    mirrored: true,
    destination: path.resolve(destination),
    copiedEntries,
  };
}

function finalizeReleaseAssets({
  releaseDir = RELEASE_DIR,
  env = process.env,
  logger = console,
} = {}) {
  const result = run({ releaseDir, env, logger });
  if (result.mirrored) {
    logger.log(
      `Mirrored and verified ${result.copiedEntries} cleaned release entries to: ${result.destination}`,
    );
  } else {
    logger.warn(
      "WARNING: Cleaned release assets, but AFTER_PACK_LOC is not set; mirror intentionally skipped.",
    );
  }
  return result;
}

function main() {
  try {
    return finalizeReleaseAssets();
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    console.error(`Failed to finalize release assets: ${message}`);
    console.error(`Source release directory: ${RELEASE_DIR}`);
    console.error(
      `Configured AFTER_PACK_LOC: ${JSON.stringify(getAfterPackLocation())}`,
    );
    console.error(
      `Platform: ${process.platform}; Node: ${process.version}; cwd: ${process.cwd()}`,
    );
    console.error(
      "The following git reset/clean was blocked. Correct the problem and rerun npm run release:finalize.",
    );
    process.exitCode = 1;
    return null;
  }
}

if (isDirectExecution()) main();

export {
  RELEASE_DIR,
  BUILD_ONLY_DIRECTORIES,
  BUILD_ONLY_FILES,
  CLI_FLAG,
  cleanReleaseArtifacts,
  getAfterPackLocation,
  pathsEqual,
  isDirectExecution,
  isMirrorableReleaseEntry,
  getReleaseEntries,
  verifyCopiedPath,
  copyReleaseAssets,
  run,
  finalizeReleaseAssets,
  main,
};
