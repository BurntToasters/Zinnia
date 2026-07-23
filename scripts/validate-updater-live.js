#!/usr/bin/env node
/**
 * Read-only check of published Tauri updater manifests on GitHub.
 * Does not build or release packages; CI smoke only.
 *
 * Usage:
 *   node scripts/validate-updater-live.js
 *   REQUIRE_UPDATER_LIVE=1 node scripts/validate-updater-live.js
 *
 * Missing manifests (HTTP 404) are skipped with a warning. Present manifests
 * must pass the same shape checks as validate-updater-manifest.js.
 * When REQUIRE_UPDATER_LIVE=1, all-404 exits non-zero (post-publish gate).
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

const BASE = "https://github.com/BurntToasters/zinnia/releases/latest/download";

async function fetchManifest(target) {
  const url = `${BASE}/latest-${target}.json`;
  const headers = {
    Accept: "application/json",
    "User-Agent": "zinnia-ci",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-updater-live-"));
const files = [];
let skipped = 0;

try {
  for (const target of TARGETS) {
    const result = await fetchManifest(target);
    if (result.status === 404) {
      console.warn(`updater-live: skip missing ${result.url}`);
      skipped += 1;
      continue;
    }
    const filePath = path.join(tmpDir, `latest-${target}.json`);
    fs.writeFileSync(filePath, result.body, "utf8");
    files.push(filePath);
    console.log(`updater-live: fetched ${result.url}`);
  }

  if (files.length === 0) {
    const message =
      "updater-live: no published manifests found (all 404); nothing to validate";
    if (requireLive) {
      console.error(`${message} (REQUIRE_UPDATER_LIVE=1)`);
      process.exit(1);
    }
    console.warn(message);
    process.exit(0);
  }
  if (requireLive && skipped > 0) {
    console.error(
      `updater-live: ${skipped} required platform manifest${skipped === 1 ? " is" : "s are"} missing (REQUIRE_UPDATER_LIVE=1)`,
    );
    process.exit(1);
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
    `updater-live: ok (${files.length} published, ${skipped} missing)`,
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
