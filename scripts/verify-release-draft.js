#!/usr/bin/env node
/**
 * Read-only whole-draft gate. Does not upload, publish, or mutate GitHub.
 *
 * Usage:
 *   npm run release:verify:draft
 *   REQUIRE_LINUX_AARCH64=1 npm run release:verify:draft
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  githubApi,
  githubApiRaw,
  assertGitHubCliAuthenticated,
} = require("./github-cli.cjs");
const { isExplicitTruthy } = require("./release-policy.cjs");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageVersion(repositoryRoot = root) {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ).version;
}

function isPrereleaseVersion(version) {
  return /-beta\.\d+$/.test(String(version || ""));
}

export function requiredDraftInstallerNames({
  requireLinuxAarch64 = false,
} = {}) {
  const names = [
    "Zinnia-Windows-x64.exe",
    "Zinnia-Windows-arm64.exe",
    "Zinnia-macOS.dmg",
    "Zinnia-macOS.zip",
    "Zinnia-Linux-x64.AppImage",
    "Zinnia-Linux-x64.deb",
    "Zinnia-Linux-x64.rpm",
    "Zinnia-Linux-x64.flatpak",
  ];
  if (requireLinuxAarch64) {
    names.push(
      "Zinnia-Linux-arm64.AppImage",
      "Zinnia-Linux-arm64.deb",
      "Zinnia-Linux-arm64.rpm",
    );
  }
  return names;
}

export function requiredDraftSidecarNames(installers) {
  return installers.flatMap((name) => {
    const names = [`${name}.asc`];
    if (/\.(?:exe|deb|rpm)$/i.test(name) || /\.AppImage$/i.test(name)) {
      names.unshift(`${name}.sig`);
    }
    return names;
  });
}

export function requiredDraftStableManifestNames({
  requireLinuxAarch64 = false,
} = {}) {
  const keys = [
    "windows-x86_64",
    "windows-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
  ];
  if (requireLinuxAarch64) {
    keys.push("linux-aarch64");
  }
  return keys.map((key) => `latest-${key}.json`);
}

export function requiredDraftBetaManifestNames({
  requireLinuxAarch64 = false,
} = {}) {
  const keys = [
    "windows-beta-x86_64",
    "windows-beta-x86_64-nsis",
    "windows-beta-aarch64",
    "windows-beta-aarch64-nsis",
    "darwin-beta-x86_64",
    "darwin-beta-x86_64-app",
    "darwin-beta-aarch64",
    "darwin-beta-aarch64-app",
    "linux-beta-x86_64",
    "linux-beta-x86_64-appimage",
    "linux-beta-x86_64-deb",
    "linux-beta-x86_64-rpm",
  ];
  if (requireLinuxAarch64) {
    for (const suffix of ["", "-appimage", "-deb", "-rpm"]) {
      keys.push(`linux-beta-aarch64${suffix}`);
    }
  }
  return keys.map((key) => `latest-${key}.json`);
}

export function requiredDraftChecksumNames({
  requireLinuxAarch64 = false,
} = {}) {
  const keys = [
    "windows-x86_64",
    "windows-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
    "windows-beta-x86_64",
    "windows-beta-aarch64",
    "darwin-beta-x86_64",
    "darwin-beta-aarch64",
    "linux-beta-x86_64",
  ];
  if (requireLinuxAarch64) {
    keys.push("linux-aarch64", "linux-beta-aarch64");
  }
  return keys.flatMap((key) => [
    `SHA256SUMS-${key}.txt`,
    `SHA256SUMS-${key}.txt.asc`,
  ]);
}

export function requiredDraftAssetNames(options = {}) {
  const requireLinuxAarch64 = Boolean(options.requireLinuxAarch64);
  const installers = requiredDraftInstallerNames({ requireLinuxAarch64 });
  return Array.from(
    new Set([
      ...installers,
      ...requiredDraftSidecarNames(installers),
      ...requiredDraftChecksumNames({ requireLinuxAarch64 }),
      ...requiredDraftStableManifestNames({ requireLinuxAarch64 }),
      ...requiredDraftBetaManifestNames({ requireLinuxAarch64 }),
    ]),
  ).sort();
}

export function assertDraftReleaseShape({
  release,
  assetNames,
  version,
  headCommit,
  requireLinuxAarch64 = false,
}) {
  const tag = `v${version}`;
  const prerelease = isPrereleaseVersion(version);
  if (!release?.draft) {
    throw new Error(
      `Release ${tag} must still be a draft for release:verify:draft.`,
    );
  }
  if (Boolean(release.prerelease) !== prerelease) {
    throw new Error(
      `Release ${tag} prerelease=${release.prerelease} does not match version ${version}.`,
    );
  }
  if (headCommit && release.target_commitish !== headCommit) {
    throw new Error(
      `Release ${tag} targets ${release.target_commitish || "an unknown commit"}, not HEAD ${headCommit}.`,
    );
  }
  const present = new Set(assetNames);
  const missing = requiredDraftAssetNames({ requireLinuxAarch64 }).filter(
    (name) => !present.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Draft ${tag} is missing required assets: ${missing.join(", ")}.`,
    );
  }
  return { tag, missing };
}

export function selectDraftRelease(releases, tag) {
  const match = (releases || []).find((release) => release?.tag_name === tag);
  if (!match) {
    return null;
  }
  if (!match.draft) {
    throw new Error(`Release ${tag} is already published.`);
  }
  return match;
}

async function listAllGithubPages(fetchPage, { perPage = 100 } = {}) {
  const pageSize = Math.max(1, Number(perPage) || 100);
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

async function loadDraftRelease(repoOwner, repoName, tag) {
  let tagged;
  try {
    tagged = githubApi(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/tags/${tag}`,
    );
  } catch (error) {
    if (error?.statusCode !== 404) {
      throw new Error(
        `Could not load draft ${tag}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (tagged) {
    if (tagged.draft) {
      return tagged;
    }
    throw new Error(`Release ${tag} is already published.`);
  }

  const releases = await listAllGithubPages((page, perPage) =>
    githubApi(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases?per_page=${perPage}&page=${page}`,
    ),
  );
  const match = selectDraftRelease(releases, tag);
  if (!match) {
    throw new Error(
      `No GitHub draft exists for ${tag}. Create it with npm run release:draft on Windows first.`,
    );
  }
  return match;
}

async function listDraftReleaseAssets(repoOwner, repoName, releaseId) {
  return listAllGithubPages((page, perPage) =>
    githubApi(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
    ),
  );
}

function currentHeadCommit() {
  const commit = execSync("git rev-parse HEAD", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

async function main() {
  const version = readPackageVersion();
  const tag = `v${version}`;
  const repoOwner = process.env.GH_REPO_OWNER || "BurntToasters";
  const repoName = process.env.GH_REPO_NAME || "zinnia";
  const requireLinuxAarch64 = isExplicitTruthy(
    process.env.REQUIRE_LINUX_AARCH64,
  );
  assertGitHubCliAuthenticated();
  const headCommit = currentHeadCommit();
  const release = await loadDraftRelease(repoOwner, repoName, tag);
  const listedAssets = await listDraftReleaseAssets(
    repoOwner,
    repoName,
    release.id,
  );
  const assets = listedAssets.map((asset) => asset?.name).filter(Boolean);
  assertDraftReleaseShape({
    release,
    assetNames: assets,
    version,
    headCommit,
    requireLinuxAarch64,
  });
  const manifestAssets = listedAssets.filter((asset) =>
    /^latest-[a-z0-9_-]+\.json$/i.test(asset?.name || ""),
  );
  for (const asset of manifestAssets) {
    if (typeof asset.id !== "number") {
      throw new Error(`Draft asset ${asset.name} is missing a GitHub id.`);
    }
    const body = githubApiRaw(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/assets/${asset.id}`,
    );
    let manifest;
    try {
      manifest = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `${asset.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (manifest?.version !== version) {
      throw new Error(
        `${asset.name} reports version ${JSON.stringify(manifest?.version)}, expected ${version}.`,
      );
    }
  }
  console.log(
    `verify-draft: ok (${tag}, draft, HEAD ${headCommit.slice(0, 12)}, ${assets.length} assets, prerelease=${isPrereleaseVersion(version)})`,
  );
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
