#!/usr/bin/env node
/**
 * Flatpak packaging dry-run: verify required metadata/templates exist so CI
 * can catch drift without needing a full flatpak-builder install.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "run.rosie.zinnia.metainfo.xml",
  "run.rosie.zinnia.yml",
  "run.rosie.zinnia.desktop",
  "src-tauri/linux/desktop-template.hbs",
];

let failed = false;
for (const rel of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`flatpak-dry-run: missing ${rel}`);
    failed = true;
  }
}

const metainfo = path.join(root, "run.rosie.zinnia.metainfo.xml");
if (fs.existsSync(metainfo)) {
  const xml = fs.readFileSync(metainfo, "utf8");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (!xml.includes(pkg.version)) {
    console.error(
      `flatpak-dry-run: metainfo should mention package version ${pkg.version}`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("flatpak-dry-run: ok");
