#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isStableReleaseVersion } = require("./release-policy.cjs");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cargoScript = isStableReleaseVersion(version)
  ? "licenses:cargo:strict"
  : "licenses:cargo";

for (const script of ["licenses:npm", cargoScript, "licenses:7zip"]) {
  const result = spawnSync(npm, ["run", script], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
