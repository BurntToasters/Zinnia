#!/usr/bin/env node
/**
 * Sync the version from package.json → tauri.conf.json + Cargo.toml
 * so package.json is the single source of truth.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;

// ── tauri.conf.json ─────────────────────────────────────────
const tauriConf = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
if (conf.version !== version) {
  conf.version = version;
  fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + "\n");
  console.log(`tauri.conf.json → ${version}`);
}

// ── Cargo.toml ──────────────────────────────────────────────
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf-8");
const updated = cargo.replace(
  /^(version\s*=\s*)"[^"]*"/m,
  `$1"${version}"`
);
if (updated !== cargo) {
  fs.writeFileSync(cargoPath, updated);
  console.log(`Cargo.toml      → ${version}`);
}
