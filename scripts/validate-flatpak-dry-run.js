#!/usr/bin/env node
/**
 * Flatpak packaging dry-run: verify required metadata/templates exist so CI
 * can catch drift without needing a full flatpak-builder install.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { hasExactReleaseVersion } from "./update-metainfo.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "run.rosie.zinnia.metainfo.xml",
  "run.rosie.zinnia.yml",
  "run.rosie.zinnia.desktop",
  "src-tauri/linux/desktop-template.hbs",
  "scripts/prepare-flatpak-source.js",
];
const expectedRuntime = 'runtime-version: "50"';

let failed = false;
for (const rel of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`flatpak-dry-run: missing ${rel}`);
    failed = true;
  }
}

const sourceExporter = path.join(root, "scripts", "prepare-flatpak-source.js");
if (fs.existsSync(sourceExporter)) {
  const source = fs.readFileSync(sourceExporter, "utf8");
  for (const marker of [
    "git",
    "archive",
    "--porcelain=v1",
    ".zinnia-source-commit",
    "src-tauri/gen/schemas/",
  ]) {
    if (!source.includes(marker)) {
      console.error(`flatpak-dry-run: source exporter missing ${marker}`);
      failed = true;
    }
  }
}

const manifest = path.join(root, "run.rosie.zinnia.yml");
if (fs.existsSync(manifest)) {
  const yaml = fs.readFileSync(manifest, "utf8");
  if (!yaml.includes(expectedRuntime)) {
    console.error(`flatpak-dry-run: expected ${expectedRuntime}`);
    failed = true;
  }
  if (!yaml.includes("path: .flatpak-source")) {
    console.error(
      "flatpak-dry-run: build source must be a clean commit export",
    );
    failed = true;
  }
  if (!yaml.includes("npm ci") || !yaml.includes("--share=network")) {
    console.error(
      "flatpak-dry-run: sideload build must fetch integrity-locked dependencies explicitly",
    );
    failed = true;
  }
  if (!yaml.includes("tauri build --no-bundle -- --locked")) {
    console.error("flatpak-dry-run: Cargo build must enforce Cargo.lock");
    failed = true;
  }
}

const metainfo = path.join(root, "run.rosie.zinnia.metainfo.xml");
if (fs.existsSync(metainfo)) {
  const xml = fs.readFileSync(metainfo, "utf8");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (!hasExactReleaseVersion(xml, pkg.version)) {
    console.error(
      `flatpak-dry-run: metainfo needs an exact release version="${pkg.version}" attribute`,
    );
    failed = true;
  }
  for (const requiredMarkup of [
    '<component type="desktop-application">',
    '<developer id="run.rosie">',
    '<launchable type="desktop-id">run.rosie.zinnia.desktop</launchable>',
  ]) {
    if (!xml.includes(requiredMarkup)) {
      console.error(`flatpak-dry-run: metainfo missing ${requiredMarkup}`);
      failed = true;
    }
  }
}

function runValidator(command, args) {
  const probe = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    console.log(`flatpak-dry-run: ${command} unavailable; static checks only`);
    return;
  }
  if (probe.error || probe.status !== 0) {
    console.error(
      `flatpak-dry-run: ${command} validation failed:\n${probe.stderr || probe.stdout || probe.error?.message}`,
    );
    failed = true;
  }
}

runValidator("appstreamcli", [
  "validate",
  "--no-net",
  "run.rosie.zinnia.metainfo.xml",
]);
runValidator("desktop-file-validate", ["run.rosie.zinnia.desktop"]);

if (failed) process.exit(1);
console.log("flatpak-dry-run: ok");
