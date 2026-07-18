#!/usr/bin/env node
/**
 * Validate Tauri updater manifest JSON shape (latest-{{target}}-{{arch}}.json).
 * Usage:
 *   node scripts/validate-updater-manifest.js [path...]
 * Defaults to fixtures under testdata/updater/.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const defaultFixturesDir = path.join(root, "testdata", "updater");
const defaultFixtures = fs.existsSync(defaultFixturesDir)
  ? fs
      .readdirSync(defaultFixturesDir)
      .filter((name) => name.startsWith("latest-") && name.endsWith(".json"))
      .sort()
      .map((name) => path.join(defaultFixturesDir, name))
  : [];

function fail(message) {
  console.error(`updater-manifest: ${message}`);
  process.exitCode = 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateManifest(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(`${filePath}: invalid JSON (${error.message})`);
    return;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(`${filePath}: root must be an object`);
    return;
  }
  if (!isNonEmptyString(data.version)) {
    fail(`${filePath}: missing string "version"`);
  }
  if (!isNonEmptyString(data.pub_date)) {
    fail(`${filePath}: missing string "pub_date"`);
  }
  if (!data.platforms || typeof data.platforms !== "object") {
    fail(`${filePath}: missing object "platforms"`);
    return;
  }

  const entries = Object.entries(data.platforms);
  if (entries.length === 0) {
    fail(`${filePath}: platforms must not be empty`);
  }
  for (const [key, platform] of entries) {
    if (!platform || typeof platform !== "object") {
      fail(`${filePath}: platforms.${key} must be an object`);
      continue;
    }
    if (!isNonEmptyString(platform.url) || !/^https:\/\//i.test(platform.url)) {
      fail(`${filePath}: platforms.${key}.url must be an https URL`);
    }
    if (!isNonEmptyString(platform.signature)) {
      fail(
        `${filePath}: platforms.${key}.signature must be a non-empty string`,
      );
    }
  }
}

const targets = process.argv.slice(2);
const files =
  targets.length > 0 ? targets : defaultFixtures.filter(fs.existsSync);

if (files.length === 0) {
  fail("no updater fixtures found; expected testdata/updater/latest-*.json");
  process.exit(1);
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    fail(`missing file ${file}`);
    continue;
  }
  validateManifest(file);
}

if (!process.exitCode) {
  console.log(
    `updater-manifest: ok (${files.length} file${files.length === 1 ? "" : "s"})`,
  );
}
