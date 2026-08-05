#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  macBundleVersionFromSemver,
  macMarketingVersionFromSemver,
  syncChangelogForVersion,
  updateCargoLockPackageVersion,
  updatePlistStringValue,
  updateWindowsAssemblyIdentityVersion,
  updateWindowsResourceVersion,
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
let updatedMacInfo;
try {
  updatedMacInfo = updatePlistStringValue(
    macInfo,
    "CFBundleShortVersionString",
    macMarketingVersion,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedMacInfo !== macInfo) {
  fs.writeFileSync(macInfoPath, updatedMacInfo);
  console.log(`Info.plist       → ${macMarketingVersion}`);
}

const finderInfoPath = path.join(
  root,
  "src-tauri",
  "macos",
  "ZinniaFinderSync",
  "Info.plist",
);
const finderInfo = fs.readFileSync(finderInfoPath, "utf8");
let updatedFinderInfo;
try {
  updatedFinderInfo = updatePlistStringValue(
    updatePlistStringValue(
      finderInfo,
      "CFBundleShortVersionString",
      macMarketingVersion,
    ),
    "CFBundleVersion",
    macBundleVersion,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedFinderInfo !== finderInfo) {
  fs.writeFileSync(finderInfoPath, updatedFinderInfo);
  console.log(
    `Finder Info.plist → ${macMarketingVersion} (${macBundleVersion})`,
  );
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

try {
  windowsPackageVersionFromSemver(version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
for (const rcName of ["zinnia_shell.rc", "zinnia_extract_shell.rc"]) {
  const rcPath = path.join(root, "src-tauri", "windows", "shell", rcName);
  const rc = fs.readFileSync(rcPath, "utf8");
  let updatedRc;
  try {
    updatedRc = updateWindowsResourceVersion(rc, version);
  } catch (error) {
    console.error(
      `${rcName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  if (updatedRc !== rc) {
    fs.writeFileSync(rcPath, updatedRc);
    console.log(`${rcName} → ${version}`);
  }
}

for (const manifestName of [
  "msix_identity.manifest.in",
  "msix_extract_identity.manifest.in",
]) {
  const manifestPath = path.join(
    root,
    "src-tauri",
    "windows",
    "shell",
    manifestName,
  );
  const manifest = fs.readFileSync(manifestPath, "utf8");
  let updatedManifest;
  try {
    updatedManifest = updateWindowsAssemblyIdentityVersion(manifest, version);
  } catch (error) {
    console.error(
      `${manifestName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  if (updatedManifest !== manifest) {
    fs.writeFileSync(manifestPath, updatedManifest);
    console.log(
      `${manifestName} → ${windowsPackageVersionFromSemver(version)}`,
    );
  }
}

const changelogPath = path.join(root, "CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");
let syncedChangelog;
try {
  syncedChangelog = syncChangelogForVersion(changelog, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (syncedChangelog !== changelog) {
  fs.writeFileSync(changelogPath, syncedChangelog);
  console.log(`CHANGELOG.md    → ${version} (download URLs + section)`);
}
