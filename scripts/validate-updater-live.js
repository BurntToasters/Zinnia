#!/usr/bin/env node
/**
 * Read-only check of published Tauri updater manifests on GitHub.
 * Does not build or release packages; CI smoke only.
 *
 * Usage:
 *   node scripts/validate-updater-live.js --shape-only
 *   node scripts/validate-updater-live.js --expected-version=current
 *   EXPECTED_UPDATER_VERSION=0.6.0-beta.16 REQUIRED_UPDATER_TARGETS=windows-beta-x86_64 node scripts/validate-updater-live.js
 *
 * Missing manifests (HTTP 404) are skipped with a warning during the soft CI
 * smoke. Present manifests must pass the same shape checks as
 * validate-updater-manifest.js. `--expected-version=current` requires Zinnia's
 * standard release matrix for that channel; stable candidates also require
 * beta-target transition endpoints. REQUIRE_UPDATER_LIVE=1 requires both
 * standard live channel matrices when no expected version is supplied.
 * REQUIRED_UPDATER_TARGETS adds intentional optional targets (for example,
 * Linux ARM64) to the required set.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const validator = path.join(root, "scripts", "validate-updater-manifest.js");
const requireLive = process.env.REQUIRE_UPDATER_LIVE === "1";
const args = process.argv.slice(2);
const shapeOnly = args.includes("--shape-only");

function optionValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function currentPackageVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return String(packageJson.version || "").trim();
}

function parseTargets(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean),
    ),
  );
}

const TARGETS = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
  "windows-beta-x86_64",
  "windows-beta-x86_64-nsis",
  "windows-beta-aarch64",
  "windows-beta-aarch64-nsis",
  "darwin-beta-aarch64",
  "darwin-beta-aarch64-app",
  "darwin-beta-x86_64",
  "darwin-beta-x86_64-app",
  "linux-beta-x86_64",
  "linux-beta-x86_64-appimage",
  "linux-beta-x86_64-deb",
  "linux-beta-x86_64-rpm",
  "linux-beta-aarch64",
  "linux-beta-aarch64-appimage",
  "linux-beta-aarch64-deb",
  "linux-beta-aarch64-rpm",
];

const STANDARD_STABLE_TARGETS = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
];

const STANDARD_BETA_TARGETS = [
  "windows-beta-x86_64",
  "windows-beta-x86_64-nsis",
  "windows-beta-aarch64",
  "windows-beta-aarch64-nsis",
  "darwin-beta-aarch64",
  "darwin-beta-aarch64-app",
  "darwin-beta-x86_64",
  "darwin-beta-x86_64-app",
  "linux-beta-x86_64",
  "linux-beta-x86_64-appimage",
  "linux-beta-x86_64-deb",
  "linux-beta-x86_64-rpm",
];

const requestedExpectedVersion =
  optionValue("--expected-version") ||
  process.env.EXPECTED_UPDATER_VERSION ||
  "";
const expectedVersion =
  requestedExpectedVersion === "current"
    ? currentPackageVersion()
    : requestedExpectedVersion.trim();
const explicitlyRequiredTargets = parseTargets(
  process.env.REQUIRED_UPDATER_TARGETS,
);
const expectedIsBeta = /-beta\.\d+$/.test(expectedVersion);
const standardRequiredTargets =
  requestedExpectedVersion === "current"
    ? expectedIsBeta
      ? STANDARD_BETA_TARGETS
      : [...STANDARD_STABLE_TARGETS, ...STANDARD_BETA_TARGETS]
    : requireLive
      ? expectedVersion
        ? expectedIsBeta
          ? STANDARD_BETA_TARGETS
          : [...STANDARD_STABLE_TARGETS, ...STANDARD_BETA_TARGETS]
        : [...STANDARD_STABLE_TARGETS, ...STANDARD_BETA_TARGETS]
      : [];
const requiredTargets = Array.from(
  new Set([...standardRequiredTargets, ...explicitlyRequiredTargets]),
);
const selectedTargets =
  requiredTargets.length > 0
    ? requiredTargets
    : expectedVersion
      ? TARGETS.filter((target) => target.includes("-beta-") === expectedIsBeta)
      : TARGETS;

const BASE = (
  process.env.UPDATER_LIVE_BASE_URL ||
  "https://github.com/BurntToasters/zinnia/releases/latest/download"
).replace(/\/+$/, "");

async function fetchManifest(target) {
  const url = `${BASE}/latest-${target}.json`;
  const headers = {
    Accept: "application/json",
    "User-Agent": "zinnia-ci",
  };
  const response = await fetch(url, {
    headers,
    redirect: "follow",
  });
  if (response.status === 404) {
    return { target, url, status: 404, body: null };
  }
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const body = await response.text();
  return { target, url, status: response.status, body };
}

function assertExpectedVersion(target, body) {
  if (!expectedVersion) return;
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `latest-${target}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `latest-${target}.json reports version ${JSON.stringify(manifest.version)}, expected ${expectedVersion}.`,
    );
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-updater-live-"));
const files = [];
const skipped = [];

try {
  for (const target of selectedTargets) {
    const result = await fetchManifest(target);
    if (result.status === 404) {
      console.warn(`updater-live: skip missing ${result.url}`);
      skipped.push(target);
      continue;
    }
    assertExpectedVersion(target, result.body);
    const filePath = path.join(tmpDir, `latest-${target}.json`);
    fs.writeFileSync(filePath, result.body, "utf8");
    files.push(filePath);
    console.log(`updater-live: fetched ${result.url}`);
  }

  if (files.length === 0) {
    const message =
      "updater-live: no published manifests found (all 404); nothing to validate";
    if (requireLive || expectedVersion || requiredTargets.length > 0) {
      const requirements = [
        requireLive && "REQUIRE_UPDATER_LIVE=1",
        expectedVersion && `expected version ${expectedVersion}`,
        requiredTargets.length > 0 &&
          `required targets ${requiredTargets.join(", ")}`,
      ].filter(Boolean);
      console.error(`${message} (${requirements.join("; ")})`);
      process.exit(1);
    }
    console.warn(message);
    process.exit(0);
  }
  if (requiredTargets.length > 0 && skipped.length > 0) {
    console.error(
      `updater-live: required manifest${skipped.length === 1 ? " is" : "s are"} missing: ${skipped.join(", ")}.`,
    );
    process.exit(1);
  }

  // Soft CI smoke still shape-checks whatever /latest has. When no explicit
  // --expected-version was set, also fail if a same-channel feed is stale
  // relative to package.json (avoids all-404 soft-pass hiding a wrong beta).
  if (!requestedExpectedVersion && !shapeOnly) {
    const pkg = currentPackageVersion();
    const pkgIsBeta = /-beta\.\d+$/.test(pkg);
    for (const filePath of files) {
      const base = path.basename(filePath, ".json"); // latest-<target>
      const target = base.replace(/^latest-/, "");
      if (target.includes("-beta-") !== pkgIsBeta) continue;
      const body = fs.readFileSync(filePath, "utf8");
      let manifest;
      try {
        manifest = JSON.parse(body);
      } catch (error) {
        console.error(
          `updater-live: ${base}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
      if (manifest.version !== pkg) {
        console.error(
          `updater-live: ${base}.json reports version ${JSON.stringify(manifest.version)}, expected package.json ${pkg} (same-channel stale feed). Pass --expected-version=… to override.`,
        );
        process.exit(1);
      }
    }
  }

  const check = spawnSync(process.execPath, [validator, ...files], {
    encoding: "utf8",
  });
  if (check.stdout) process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);
  if (check.status !== 0) {
    process.exit(check.status ?? 1);
  }
  console.log(
    `updater-live: ok (${files.length} published, ${skipped.length} missing${expectedVersion ? `, version ${expectedVersion}` : ""})`,
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
