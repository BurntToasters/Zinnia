#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { validateTrusted7zPath } from "./prepare-7z-helpers.js";

const root = process.cwd();
const assetsDirectory = path.join(root, "assets");
const outputDirectory = path.join(root, "src-tauri", "binaries");
const provenancePath = path.join(assetsDirectory, "7z-provenance.json");
const latestReleaseUrl = "https://github.com/ip7z/7zip/releases/latest";
const officialDownloadPage = "https://www.7-zip.org/download.html";

const obsoletePaths = [
  "assets/linux/arm64/7zz",
  "assets/linux/x64/7zz",
  "assets/win/arm64/7-ZipFar.dll",
  "assets/win/arm64/7za.dll",
  "assets/win/arm64/7za.exe",
  "assets/win/arm64/7zxa.dll",
  "assets/win/x64/7za.dll",
  "assets/win/x64/7za.exe",
  "assets/win/x64/7zxa.dll",
  "assets/7ZIP_LICENSE_WINDOWS_EXTRA.txt",
  "public/7zip-license-windows-extra.txt",
];

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function normalizeVersion(version) {
  const normalized = version.replace(/^v/, "");
  if (!/^\d+\.\d+$/.test(normalized)) {
    throw new Error(`Unsupported 7-Zip release version: ${version}`);
  }
  return normalized;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function compactVersion(version) {
  return version.replace(".", "");
}

function sourceDefinitions(version) {
  const compact = compactVersion(version);
  return [
    {
      name: "linux-arm64",
      url: `https://www.7-zip.org/a/7z${compact}-linux-arm64.tar.xz`,
      format: "tar.xz",
      artifacts: [{ asset: "linux/arm64/7zzs", member: "7zzs" }],
    },
    {
      name: "linux-x64",
      url: `https://www.7-zip.org/a/7z${compact}-linux-x64.tar.xz`,
      format: "tar.xz",
      artifacts: [{ asset: "linux/x64/7zzs", member: "7zzs" }],
      license: {
        asset: "7ZIP_LICENSE_LINUX_MACOS.txt",
        member: "License.txt",
        normalization: "LF",
      },
    },
    {
      name: "mac",
      url: `https://www.7-zip.org/a/7z${compact}-mac.tar.xz`,
      format: "tar.xz",
      artifacts: [{ asset: "mac/7zz", member: "7zz" }],
    },
    {
      name: "windows-arm64-installer",
      url: `https://github.com/ip7z/7zip/releases/download/${version}/7z${compact}-arm64.exe`,
      format: "7z",
      artifacts: [
        { asset: "win/arm64/7z.dll", member: "7z.dll" },
        { asset: "win/arm64/7z.exe", member: "7z.exe" },
      ],
    },
    {
      name: "windows-x64-installer",
      url: `https://github.com/ip7z/7zip/releases/download/${version}/7z${compact}-x64.exe`,
      format: "7z",
      artifacts: [
        { asset: "win/x64/7z.dll", member: "7z.dll" },
        { asset: "win/x64/7z.exe", member: "7z.exe" },
      ],
      license: {
        asset: "7ZIP_LICENSE_WINDOWS.txt",
        member: "License.txt",
        normalization: "none",
      },
    },
  ];
}

async function fetchLatestVersion() {
  const response = await fetch(latestReleaseUrl, {
    headers: { "User-Agent": "Zinnia-7z-updater" },
    redirect: "follow",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Could not query ${latestReleaseUrl}: HTTP ${response.status}`,
    );
  }

  const candidates = [
    response.url,
    ...Array.from(
      body.matchAll(/\/releases\/tag\/v?(\d+\.\d+)/g),
      (match) => match[0],
    ),
  ];
  for (const candidate of candidates) {
    const match = candidate.match(/\/releases\/tag\/v?(\d+\.\d+)(?:[/?#]|$)/);
    if (match) return normalizeVersion(match[1]);
  }
  throw new Error(
    `Could not determine latest 7-Zip version from ${response.url}.`,
  );
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Zinnia-7z-updater" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination, { flags: "wx" }),
  );
}

function run(command, args, { inherit = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = inherit
      ? ""
      : `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    throw new Error(
      `${command} exited with code ${result.status}${output ? `: ${output}` : ""}`,
    );
  }
}

function resolveOnPath(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout.split(/\r?\n/).find(Boolean);
}

function resolveTrustedExtractor() {
  const supplied = optionValue("--trusted-7z") || process.env.ZINNIA_TRUSTED_7Z;
  const suppliedPath = supplied
    ? path.isAbsolute(supplied)
      ? supplied
      : resolveOnPath(supplied) || path.resolve(supplied)
    : undefined;
  const external =
    suppliedPath || ["7z", "7zz"].map(resolveOnPath).find(Boolean);
  if (external) {
    return validateTrusted7zPath(external, {
      assetsDirectory,
      outputDirectory,
    });
  }

  throw new Error(
    "No trusted 7-Zip extractor found. Install 7-Zip, set ZINNIA_TRUSTED_7Z, or pass --trusted-7z <path>.",
  );
}

function extractArchive(source, archivePath, destination, extractor) {
  fs.mkdirSync(destination, { recursive: true });
  if (source.format === "tar.xz") {
    run("tar", ["-xJf", archivePath, "-C", destination]);
    return;
  }
  run(extractor, ["x", "-y", `-o${destination}`, archivePath]);
}

function findMember(rootDirectory, member) {
  const directPath = path.join(rootDirectory, ...member.split("/"));
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }

  const matches = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === path.basename(member)) {
        matches.push(candidate);
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

function normalizeLicense(bytes, normalization) {
  if (normalization !== "LF") return bytes;
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

function writeStagedFile(
  stagingDirectory,
  relativePath,
  sourcePath,
  executable,
) {
  const destination = path.join(stagingDirectory, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination);
  if (executable && process.platform !== "win32") {
    fs.chmodSync(destination, 0o755);
  }
  return destination;
}

function removeObsoletePaths() {
  for (const relativePath of obsoletePaths) {
    const target = path.join(root, relativePath);
    if (!fs.existsSync(target)) continue;
    const metadata = fs.lstatSync(target);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-file obsolete asset: ${target}`);
    }
    fs.rmSync(target, { force: true });
  }
}

function commitStaging(stagingDirectory, files) {
  for (const relativePath of files) {
    const source = path.join(stagingDirectory, relativePath);
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    if (
      process.platform !== "win32" &&
      (relativePath.endsWith("/7zz") || relativePath.endsWith("/7zzs"))
    ) {
      fs.chmodSync(destination, 0o755);
    }
  }
  removeObsoletePaths();
}

async function update(version) {
  const sources = sourceDefinitions(version);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-7z-update-"),
  );
  const stagingDirectory = path.join(temporaryDirectory, "staged");
  const downloadDirectory = path.join(temporaryDirectory, "downloads");
  const extractionDirectory = path.join(temporaryDirectory, "extracted");
  fs.mkdirSync(downloadDirectory);
  fs.mkdirSync(extractionDirectory);
  const sourceArchives = {};
  const artifacts = {};
  const licenseNotices = {};
  const stagedFiles = [];

  try {
    const extractor = resolveTrustedExtractor();
    for (const source of sources) {
      const archiveName = path.basename(new URL(source.url).pathname);
      const archivePath = path.join(downloadDirectory, archiveName);
      console.log(`Downloading ${archiveName}...`);
      await downloadFile(source.url, archivePath);
      sourceArchives[source.name] = {
        url: source.url,
        sha256: sha256File(archivePath),
      };

      const extracted = path.join(extractionDirectory, source.name);
      extractArchive(source, archivePath, extracted, extractor);
      for (const artifact of source.artifacts) {
        const memberPath = findMember(extracted, artifact.member);
        const executable =
          artifact.asset.endsWith("/7zz") || artifact.asset.endsWith("/7zzs");
        writeStagedFile(
          stagingDirectory,
          `assets/${artifact.asset}`,
          memberPath,
          executable,
        );
        const relativeAsset = artifact.asset;
        artifacts[relativeAsset] = {
          source: source.name,
          member: artifact.member,
        };
        stagedFiles.push(`assets/${relativeAsset}`);
      }
      if (source.license) {
        const memberPath = findMember(extracted, source.license.member);
        const licenseBytes = normalizeLicense(
          fs.readFileSync(memberPath),
          source.license.normalization,
        );
        const licensePath = path.join(
          stagingDirectory,
          `assets/${source.license.asset}`,
        );
        fs.mkdirSync(path.dirname(licensePath), { recursive: true });
        fs.writeFileSync(licensePath, licenseBytes);
        stagedFiles.push(`assets/${source.license.asset}`);
        licenseNotices[source.license.asset] = {
          source: source.name,
          member: source.license.member,
          normalization: source.license.normalization,
          sha256: crypto
            .createHash("sha256")
            .update(licenseBytes)
            .digest("hex"),
        };
      }
    }

    const checksums = Object.fromEntries(
      Object.keys(artifacts)
        .sort()
        .map((asset) => [
          asset,
          sha256File(path.join(stagingDirectory, `assets/${asset}`)),
        ]),
    );
    const provenance = {
      schemaVersion: 1,
      product: "7-Zip",
      version,
      recordedOn: new Date().toISOString().slice(0, 10),
      officialDownloadPage,
      sourceArchives: Object.fromEntries(
        Object.entries(sourceArchives).map(([name, source]) => [
          name,
          { url: source.url, sha256: source.sha256 },
        ]),
      ),
      licenseNotices,
      artifacts: Object.fromEntries(
        Object.keys(artifacts)
          .sort()
          .map((asset) => [asset, artifacts[asset]]),
      ),
    };
    fs.writeFileSync(
      path.join(stagingDirectory, "assets/7z-checksums.json"),
      `${JSON.stringify(checksums, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(stagingDirectory, "assets/7z-provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    stagedFiles.push("assets/7z-checksums.json", "assets/7z-provenance.json");

    commitStaging(stagingDirectory, stagedFiles);
    run(
      process.execPath,
      [path.join(root, "scripts", "copy-7zip-license.js")],
      {
        inherit: true,
      },
    );
    run(
      process.execPath,
      [path.join(root, "scripts", "prepare-7z.js"), "--all"],
      { inherit: true },
    );
    console.log(`Updated official 7-Zip assets to ${version}.`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const currentProvenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  const currentVersion = normalizeVersion(currentProvenance.version);
  const latestVersion = await fetchLatestVersion();

  if (process.argv.includes("--check")) {
    console.log(`Current official 7-Zip: ${currentVersion}`);
    console.log(`Latest official 7-Zip: ${latestVersion}`);
    if (compareVersions(latestVersion, currentVersion) > 0) {
      console.log(`Update available. Run npm run 7z:update.`);
    } else {
      console.log("No newer official 7-Zip release found.");
    }
    return;
  }

  if (
    compareVersions(latestVersion, currentVersion) <= 0 &&
    !process.argv.includes("--force")
  ) {
    console.log(
      `7-Zip ${currentVersion} already matches or exceeds latest ${latestVersion}. Use --force to refresh assets.`,
    );
    return;
  }
  await update(latestVersion);
}

main().catch((error) => {
  console.error(`7z update failed: ${error.message}`);
  process.exitCode = 1;
});
