import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import {
  macBundleVersionFromSemver,
  macMarketingVersionFromSemver,
  syncChangelogForVersion,
  syncNpmLockfileVersion,
  updateCargoLockPackageVersion,
  updatePlistStringValue,
  updateWindowsAssemblyIdentityVersion,
  updateWindowsResourceVersion,
  updateWindowsShellResourceDestinations,
} from "./sync-version-helpers.js";
import { run as updateMetainfo } from "./update-metainfo.js";

const STABLE_METADATA_PATHS = new Set([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "run.rosie.zinnia.metainfo.xml",
  "src-tauri/Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/macos/ZinniaFinderSync/Info.plist",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/windows/shell/msix_extract_identity.manifest.in",
  "src-tauri/windows/shell/msix_identity.manifest.in",
  "src-tauri/windows/shell/zinnia_extract_shell.rc",
  "src-tauri/windows/shell/zinnia_shell.rc",
]);

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function assertExactJson(path, actual, expected) {
  let parsed;
  try {
    parsed = JSON.parse(actual);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error(`${path} contains non-version content changes.`);
  }
}

function expectedMetainfo(baseContent, headContent, headVersion) {
  const escapedVersion = headVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const releases = [
    ...headContent.matchAll(
      new RegExp(
        `<release\\b(?=[^>]*\\bversion=["']${escapedVersion}["'])(?=[^>]*\\bdate=["'](\\d{4}-\\d{2}-\\d{2})["'])[^>]*>`,
        "g",
      ),
    ),
  ];
  if (releases.length !== 1) {
    throw new Error(
      `run.rosie.zinnia.metainfo.xml must contain one dated ${headVersion} release.`,
    );
  }
  const date = new Date(`${releases[0][1]}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(
      "run.rosie.zinnia.metainfo.xml has an invalid release date.",
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "zinnia-stable-metadata-"));
  const packagePath = join(directory, "package.json");
  const metadataPath = join(directory, "metainfo.xml");
  try {
    writeFileSync(packagePath, `${JSON.stringify({ version: headVersion })}\n`);
    writeFileSync(metadataPath, baseContent);
    updateMetainfo({ now: date, packagePath, metadataPath });
    return readFileSync(metadataPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validateStableChangelog(baseContent, headContent, headVersion) {
  const synchronized = syncChangelogForVersion(baseContent, headVersion);
  const heading = `## Changes in \`v${headVersion}:\``;
  const sectionStart = synchronized.indexOf(heading);
  const bodyStart = sectionStart + heading.length;
  const nextSection = synchronized.indexOf("\n## Changes in `", bodyStart);
  if (sectionStart < 0 || nextSection < 0) {
    throw new Error("CHANGELOG.md has no bounded stable release section.");
  }
  const prefix = synchronized.slice(0, bodyStart);
  const suffix = synchronized.slice(nextSection);
  if (!headContent.startsWith(prefix) || !headContent.endsWith(suffix)) {
    throw new Error("CHANGELOG.md changes outside the stable release section.");
  }
  const currentSection = headContent.slice(
    bodyStart,
    headContent.length - suffix.length,
  );
  if (!currentSection.trim() || /^##\s/mu.test(currentSection)) {
    throw new Error("CHANGELOG.md stable release section is invalid.");
  }
  if (syncChangelogForVersion(headContent, headVersion) !== headContent) {
    throw new Error("CHANGELOG.md is not synchronized to the stable version.");
  }
}

export function validateStableMetadataFile({
  path,
  baseContent,
  headContent,
  baseVersion,
  headVersion,
}) {
  const normalizedPath = normalizePath(path);
  let expected;

  switch (normalizedPath) {
    case "package.json": {
      const basePackage = JSON.parse(baseContent);
      if (basePackage.version !== baseVersion) {
        throw new Error(
          "package.json base version does not match the PR base.",
        );
      }
      basePackage.version = headVersion;
      assertExactJson(normalizedPath, headContent, basePackage);
      return;
    }
    case "package-lock.json":
      expected = syncNpmLockfileVersion(baseContent, headVersion);
      assertExactJson(normalizedPath, headContent, JSON.parse(expected));
      return;
    case "src-tauri/tauri.conf.json": {
      const config = JSON.parse(baseContent);
      config.version = headVersion;
      if (!config.bundle?.macOS) {
        throw new Error("src-tauri/tauri.conf.json is missing bundle.macOS.");
      }
      config.bundle.macOS.bundleVersion =
        macBundleVersionFromSemver(headVersion);
      assertExactJson(normalizedPath, headContent, config);
      return;
    }
    case "src-tauri/tauri.windows.conf.json": {
      const config = updateWindowsShellResourceDestinations(
        JSON.parse(baseContent),
        headVersion,
      );
      assertExactJson(normalizedPath, headContent, config);
      return;
    }
    case "src-tauri/Cargo.toml":
      expected = baseContent.replace(
        /(\[package\][^[]*?\nversion\s*=\s*)"[^"]*"/s,
        `$1"${headVersion}"`,
      );
      break;
    case "src-tauri/Cargo.lock":
      expected = updateCargoLockPackageVersion(
        baseContent,
        "zinnia",
        headVersion,
      );
      break;
    case "src-tauri/macos/ZinniaFinderSync/Info.plist":
      expected = updatePlistStringValue(
        updatePlistStringValue(
          baseContent,
          "CFBundleShortVersionString",
          macMarketingVersionFromSemver(headVersion),
        ),
        "CFBundleVersion",
        macBundleVersionFromSemver(headVersion),
      );
      break;
    case "src-tauri/windows/shell/zinnia_shell.rc":
    case "src-tauri/windows/shell/zinnia_extract_shell.rc":
      expected = updateWindowsResourceVersion(baseContent, headVersion);
      break;
    case "src-tauri/windows/shell/msix_identity.manifest.in":
    case "src-tauri/windows/shell/msix_extract_identity.manifest.in":
      expected = updateWindowsAssemblyIdentityVersion(baseContent, headVersion);
      break;
    case "CHANGELOG.md":
      validateStableChangelog(baseContent, headContent, headVersion);
      return;
    case "run.rosie.zinnia.metainfo.xml":
      expected = expectedMetainfo(baseContent, headContent, headVersion);
      break;
    default:
      throw new Error(`${normalizedPath} is not release metadata.`);
  }

  if (headContent !== expected) {
    throw new Error(`${normalizedPath} contains non-version content changes.`);
  }
}

export function validateStableMetadataChange({
  baseVersion,
  headVersion,
  changedEntries,
}) {
  const match = String(baseVersion).match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/u);
  if (!match || headVersion !== match[1]) {
    throw new Error(
      `Stable metadata must remove only the beta suffix (${baseVersion} -> ${headVersion}).`,
    );
  }
  if (!Array.isArray(changedEntries) || changedEntries.length === 0) {
    throw new Error("Stable metadata pull request has no changed files.");
  }
  const notModified = changedEntries.filter(({ status }) => status !== "M");
  if (notModified.length > 0) {
    throw new Error(
      `Stable metadata files must be modified in place; found:\n${notModified.map(({ status, path }) => `${status}\t${path}`).join("\n")}`,
    );
  }
  const changedPaths = changedEntries.map(({ path }) => normalizePath(path));
  const unexpected = changedPaths.filter(
    (path) => !STABLE_METADATA_PATHS.has(path),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Stable metadata pull request changed files that are not release metadata:\n${unexpected.join("\n")}`,
    );
  }
  const changedSet = new Set(changedPaths);
  const missing = [...STABLE_METADATA_PATHS].filter(
    (path) => !changedSet.has(path),
  );
  if (missing.length > 0 || changedSet.size !== STABLE_METADATA_PATHS.size) {
    throw new Error(
      `Stable metadata pull request must contain the exact synchronized metadata set; missing:\n${missing.join("\n")}`,
    );
  }
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function fileAt(ref, path) {
  return git(["show", `${ref}:${path}`]);
}

function packageVersionAt(ref) {
  return JSON.parse(fileAt(ref, "package.json")).version;
}

function main() {
  const [baseRef, headRef] = process.argv.slice(2);
  if (!baseRef || !headRef) {
    throw new Error(
      "Usage: node scripts/check-stable-metadata-pr.mjs <base-ref> <head-ref>",
    );
  }
  const changedEntries = git([
    "diff",
    "--name-status",
    "--no-renames",
    `${baseRef}..${headRef}`,
  ])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { status, path };
    });
  const baseVersion = packageVersionAt(baseRef);
  const headVersion = packageVersionAt(headRef);
  validateStableMetadataChange({ baseVersion, headVersion, changedEntries });
  for (const path of STABLE_METADATA_PATHS) {
    validateStableMetadataFile({
      path,
      baseContent: fileAt(baseRef, path),
      headContent: fileAt(headRef, path),
      baseVersion,
      headVersion,
    });
  }
  console.log("Stable metadata pull request scope and content are valid.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
