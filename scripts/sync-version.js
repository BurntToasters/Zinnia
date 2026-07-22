#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  macBundleVersionFromSemver,
  macMarketingVersionFromSemver,
  updateCargoLockPackageVersion,
  updateWindowsResourceFlags,
  updateWindowsShellResourceDestinations,
  windowsPackageVersionFromSemver,
} from "./sync-version-helpers.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8"),
).version;

const tauriConf = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
const macBundleVersion = macBundleVersionFromSemver(version);
const macMarketingVersion = macMarketingVersionFromSemver(version);
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

const windowsConfPath = path.join(root, "src-tauri", "tauri.windows.conf.json");
const windowsConf = JSON.parse(fs.readFileSync(windowsConfPath, "utf-8"));
let updatedWindowsConf;
try {
  updatedWindowsConf = updateWindowsShellResourceDestinations(
    windowsConf,
    version,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (JSON.stringify(updatedWindowsConf) !== JSON.stringify(windowsConf)) {
  fs.writeFileSync(
    windowsConfPath,
    JSON.stringify(updatedWindowsConf, null, 2) + "\n",
  );
  console.log(`tauri.windows.conf.json → shell-${version}`);
}

const macInfoPath = path.join(root, "src-tauri", "Info.plist");
const macInfo = fs.readFileSync(macInfoPath, "utf8");
const marketingVersionPattern =
  /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/;
if (!marketingVersionPattern.test(macInfo)) {
  console.error("src-tauri/Info.plist is missing CFBundleShortVersionString");
  process.exit(1);
}
const updatedMacInfo = macInfo.replace(
  marketingVersionPattern,
  `$1${macMarketingVersion}$2`,
);
if (updatedMacInfo !== macInfo) {
  fs.writeFileSync(macInfoPath, updatedMacInfo);
  console.log(`Info.plist       → ${macMarketingVersion}`);
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

const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
const cargoLock = fs.readFileSync(cargoLockPath, "utf-8");
let updatedLock;
try {
  updatedLock = updateCargoLockPackageVersion(cargoLock, "zinnia", version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedLock !== cargoLock) {
  fs.writeFileSync(cargoLockPath, updatedLock);
  const lockVerify = fs.readFileSync(cargoLockPath, "utf-8");
  if (
    !lockVerify.includes(`name = "zinnia"\nversion = "${version}"`) &&
    !lockVerify.includes(`name = "zinnia"\r\nversion = "${version}"`)
  ) {
    console.error(`Cargo.lock write verification failed`);
    process.exit(1);
  }
  console.log(`Cargo.lock      → ${version}`);
}

let windowsPackageVersion;
try {
  windowsPackageVersion = windowsPackageVersionFromSemver(version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const numericVersion = windowsPackageVersion.replaceAll(".", ",");
for (const rcName of ["zinnia_shell.rc", "zinnia_extract_shell.rc"]) {
  const rcPath = path.join(root, "src-tauri", "windows", "shell", rcName);
  const rc = fs.readFileSync(rcPath, "utf8");
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
    console.log(`${rcName} → ${version}`);
  }
}
