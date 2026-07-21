#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  macBundleVersionFromSemver,
  updateWindowsResourceFlags,
} from "./sync-version-helpers.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8"),
).version;

const tauriConf = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
const macBundleVersion = macBundleVersionFromSemver(version);
if (
  conf.version !== version ||
  conf.bundle?.macOS?.bundleVersion !== macBundleVersion
) {
  conf.version = version;
  if (!conf.bundle?.macOS) {
    console.error("tauri.conf.json is missing bundle.macOS configuration");
    process.exit(1);
  }
  conf.bundle.macOS.bundleVersion = macBundleVersion;
  fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + "\n");
  const verify = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
  if (
    verify.version !== version ||
    verify.bundle?.macOS?.bundleVersion !== macBundleVersion
  ) {
    console.error(`tauri.conf.json write verification failed`);
    process.exit(1);
  }
  console.log(`tauri.conf.json → ${version} (macOS build ${macBundleVersion})`);
}

const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf-8");
const updated = cargo.replace(
  /(\[package\][^[]*?\nversion\s*=\s*)"[^"]*"/s,
  `$1"${version}"`,
);
if (updated !== cargo) {
  fs.writeFileSync(cargoPath, updated);
  const cargoVerify = fs.readFileSync(cargoPath, "utf-8");
  if (!cargoVerify.includes(`version = "${version}"`)) {
    console.error(`Cargo.toml write verification failed`);
    process.exit(1);
  }
  console.log(`Cargo.toml      → ${version}`);
}

const windowsVersionMatch = version.match(
  /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]*?(\d+))?$/,
);
if (!windowsVersionMatch) {
  console.error(
    `Version cannot be represented in Windows resources: ${version}`,
  );
  process.exit(1);
}
const windowsVersion = [
  windowsVersionMatch[1],
  windowsVersionMatch[2],
  windowsVersionMatch[3],
  windowsVersionMatch[4] ?? "0",
];
if (windowsVersion.some((part) => Number(part) > 65535)) {
  console.error(`Windows resource version component exceeds 65535: ${version}`);
  process.exit(1);
}
const rcPath = path.join(
  root,
  "src-tauri",
  "windows",
  "shell",
  "zinnia_shell.rc",
);
const rc = fs.readFileSync(rcPath, "utf8");
const numericVersion = windowsVersion.join(",");
const updatedRc = updateWindowsResourceFlags(rc, version)
  .replace(/^ FILEVERSION .+$/m, ` FILEVERSION ${numericVersion}`)
  .replace(/^ PRODUCTVERSION .+$/m, ` PRODUCTVERSION ${numericVersion}`)
  .replace(
    /^      VALUE "FileVersion", ".*\\0"$/m,
    `      VALUE "FileVersion", "${version}\\0"`,
  )
  .replace(
    /^      VALUE "ProductVersion", ".*\\0"$/m,
    `      VALUE "ProductVersion", "${version}\\0"`,
  );
if (updatedRc !== rc) {
  fs.writeFileSync(rcPath, updatedRc);
  console.log(`zinnia_shell.rc → ${version}`);
}
