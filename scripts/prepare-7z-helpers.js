import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const MAX_IDENTITY_SCAN_ENTRIES = 100_000;
const MAX_IDENTITY_SCAN_DEPTH = 64;

export function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function canonicalizeAllowMissing(filePath) {
  const missingParts = [];
  let existing = path.resolve(filePath);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missingParts);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertNoMatchingFileIdentity(trustedStat, root, label) {
  const pending = [{ filePath: root, depth: 0 }];
  let inspectedEntries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const currentStat = fs.lstatSync(current.filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!currentStat || currentStat.isSymbolicLink()) continue;

    if (currentStat.isFile()) {
      if (sameFileIdentity(trustedStat, currentStat)) {
        throw new Error(
          `Trusted 7-Zip extractor must not be the same file as a ${label} file: ${current.filePath}`,
        );
      }
      continue;
    }
    if (!currentStat.isDirectory()) continue;
    if (current.depth >= MAX_IDENTITY_SCAN_DEPTH) {
      throw new Error(
        `Could not safely inspect ${label} directory beyond ${MAX_IDENTITY_SCAN_DEPTH} levels: ${root}`,
      );
    }

    const directory = fs.opendirSync(current.filePath);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) {
        inspectedEntries += 1;
        if (inspectedEntries > MAX_IDENTITY_SCAN_ENTRIES) {
          throw new Error(
            `Could not safely inspect ${label} directory with more than ${MAX_IDENTITY_SCAN_ENTRIES} entries: ${root}`,
          );
        }
        pending.push({
          filePath: path.join(current.filePath, entry.name),
          depth: current.depth + 1,
        });
      }
    } finally {
      directory.closeSync();
    }
  }
}

export function validateTrusted7zPath(
  suppliedPath,
  { assetsDirectory, outputDirectory },
) {
  if (!suppliedPath) {
    throw new Error(
      "Official .7z verification requires --trusted-7z <path> to an independently trusted extractor.",
    );
  }

  const resolvedPath = path.resolve(suppliedPath);
  let stat;
  try {
    stat = fs.statSync(resolvedPath, { bigint: true });
  } catch {
    throw new Error(`Trusted 7-Zip extractor does not exist: ${resolvedPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Trusted 7-Zip extractor is not a file: ${resolvedPath}`);
  }

  const canonicalPath = fs.realpathSync(resolvedPath);
  for (const [label, directory] of [
    ["candidate assets", assetsDirectory],
    ["generated output", outputDirectory],
  ]) {
    const resolvedDirectory = path.resolve(directory);
    const canonicalDirectory = canonicalizeAllowMissing(resolvedDirectory);
    if (
      isPathInside(resolvedPath, resolvedDirectory) ||
      isPathInside(canonicalPath, canonicalDirectory)
    ) {
      throw new Error(
        `Trusted 7-Zip extractor must be outside ${label} directory: ${resolvedDirectory}`,
      );
    }
  }

  const trustedStat = fs.statSync(canonicalPath, { bigint: true });
  for (const [label, directory] of [
    ["candidate assets", assetsDirectory],
    ["generated output", outputDirectory],
  ]) {
    assertNoMatchingFileIdentity(
      trustedStat,
      canonicalizeAllowMissing(path.resolve(directory)),
      label,
    );
  }
  return canonicalPath;
}

export function officialArchiveExtractionCommand({
  archivePath,
  destination,
  trusted7zPath,
}) {
  if (archivePath.endsWith(".tar.xz")) {
    return {
      command: "tar",
      args: ["-xJf", archivePath, "-C", destination],
    };
  }
  if (archivePath.endsWith(".7z") || archivePath.endsWith(".exe")) {
    if (!trusted7zPath) {
      throw new Error(
        "A trusted 7-Zip extractor is required for .7z archives.",
      );
    }
    return {
      command: trusted7zPath,
      args: ["x", "-y", `-o${destination}`, archivePath],
    };
  }
  throw new Error(
    `Unsupported official source archive ${path.basename(archivePath)}.`,
  );
}

export function assertArchiveMemberNameSafe(member, destination) {
  const normalized = String(member).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) return;
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(`Archive member is absolute: ${member}`);
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Archive member escapes destination: ${member}`);
  }
  const resolved = path.resolve(destination, ...parts);
  if (!isPathInside(resolved, path.resolve(destination))) {
    throw new Error(`Archive member escapes destination: ${member}`);
  }
}

function listTarMembers(archivePath) {
  const listed = spawnSync("tar", ["-tJf", archivePath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(
      `Could not list tar members: ${listed.stderr || listed.stdout || listed.status}`,
    );
  }
  return listed.stdout.split(/\r?\n/).filter(Boolean);
}

function listSevenZipMembers(trusted7zPath, archivePath) {
  const listed = spawnSync(trusted7zPath, ["l", "-slt", "-ba", archivePath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(
      `Could not list archive members: ${listed.stderr || listed.stdout || listed.status}`,
    );
  }
  const archiveName = path.basename(archivePath);
  const members = [];
  for (const line of `${listed.stdout}\n${listed.stderr}`.split(/\r?\n/)) {
    const match = /^Path = (.*)$/.exec(line);
    if (!match) continue;
    const member = match[1];
    if (!member || member === archiveName || member === archivePath) continue;
    members.push(member);
  }
  return members;
}

export function assertOfficialArchiveMembersSafe({
  archivePath,
  destination,
  trusted7zPath,
}) {
  const members = archivePath.endsWith(".tar.xz")
    ? listTarMembers(archivePath)
    : listSevenZipMembers(trusted7zPath, archivePath);
  for (const member of members) {
    assertArchiveMemberNameSafe(member, destination);
  }
}

export function assertExtractedTreeContained(rootDirectory) {
  const root = fs.realpathSync(rootDirectory);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing extracted symlink: ${candidate}`);
      }
      if (entry.isDirectory()) {
        const real = fs.realpathSync(candidate);
        if (!isPathInside(real, root)) {
          throw new Error(
            `Extracted directory escaped destination: ${candidate}`,
          );
        }
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const real = fs.realpathSync(candidate);
      if (!isPathInside(real, root)) {
        throw new Error(`Extracted file escaped destination: ${candidate}`);
      }
    }
  }
}

export function findExtractedRegularFile(rootDirectory, member) {
  const root = fs.realpathSync(rootDirectory);
  const directPath = path.join(rootDirectory, ...String(member).split("/"));
  let directStat;
  try {
    directStat = fs.lstatSync(directPath);
  } catch {
    directStat = null;
  }
  if (directStat?.isSymbolicLink()) {
    throw new Error(`Refusing extracted symlink member: ${directPath}`);
  }
  if (directStat?.isFile()) {
    const real = fs.realpathSync(directPath);
    if (!isPathInside(real, root)) {
      throw new Error(`Extracted member escaped destination: ${directPath}`);
    }
    return real;
  }

  const matches = [];
  const pending = [rootDirectory];
  const wanted = path.basename(member);
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing extracted symlink: ${candidate}`);
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === wanted) {
        const real = fs.realpathSync(candidate);
        if (!isPathInside(real, root)) {
          throw new Error(`Extracted member escaped destination: ${candidate}`);
        }
        matches.push(real);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Could not resolve unique ${member} in extracted ${rootDirectory}. Found ${matches.length}.`,
    );
  }
  return matches[0];
}
