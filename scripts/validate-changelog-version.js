#!/usr/bin/env node
/**
 * Fail if package.json version is missing from CHANGELOG.md
 * (section heading and/or download URLs).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

if (!version || typeof version !== "string") {
  console.error("changelog-version: package.json has no version");
  process.exit(1);
}

const tag = `v${version}`;
const sectionOk =
  changelog.includes(`## Changes in \`${tag}:\``) ||
  changelog.includes(`## Changes in \`${version}:\``);
const urlsOk = changelog.includes(`/download/${tag}/`);

if (!sectionOk) {
  console.error(
    `changelog-version: CHANGELOG.md missing section for ${tag} (expected "## Changes in \`${tag}:\`")`,
  );
  process.exitCode = 1;
}
if (!urlsOk) {
  console.error(
    `changelog-version: CHANGELOG.md download links should include /download/${tag}/`,
  );
  process.exitCode = 1;
}

if (!process.exitCode) {
  console.log(`changelog-version: ok (${tag})`);
}
