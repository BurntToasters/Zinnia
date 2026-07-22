import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { isDeepStrictEqual } from "util";

if (process.platform !== "darwin") {
  console.log("zip-macos can only run on macOS.");
  process.exit(0);
}

const root = process.cwd();
const targetArg = process.argv.indexOf("--target");
const target =
  targetArg >= 0 ? process.argv[targetArg + 1] : "universal-apple-darwin";
if (!target || target.startsWith("--")) {
  console.error("Usage: node scripts/zip-macos.js [--target <rust-target>]");
  process.exit(1);
}

const appPath = path.join(
  root,
  "src-tauri",
  "target",
  target,
  "release",
  "bundle",
  "macos",
  "Zinnia.app",
);
if (!fs.existsSync(appPath)) {
  console.error(`Expected macOS bundle was not found: ${appPath}`);
  process.exit(1);
}

const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const requiredMacOS = tauriConfig.bundle?.macOS?.minimumSystemVersion;
const expectedBundleVersion = tauriConfig.bundle?.macOS?.bundleVersion;
const marketingVersionMatch = tauriConfig.version?.match(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?$/,
);
const expectedMarketingVersion = marketingVersionMatch
  ? `${marketingVersionMatch[1]}.${marketingVersionMatch[2]}.${marketingVersionMatch[3]}`
  : undefined;
if (!requiredMacOS || !expectedBundleVersion || !expectedMarketingVersion) {
  throw new Error(
    "tauri.conf.json must define a supported version, bundle.macOS.minimumSystemVersion, and bundleVersion",
  );
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function readMachOMinimumVersion(binary, arch) {
  const output = execFileSync("otool", ["-arch", arch, "-l", binary], {
    encoding: "utf8",
  });
  const match = output.match(
    /cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+(\d+(?:\.\d+)*)/,
  );
  if (!match?.[1]) {
    throw new Error(
      `Could not read LC_BUILD_VERSION minos for ${binary} (${arch})`,
    );
  }
  return match[1];
}

function verifyMachOCompatibility(binary) {
  for (const arch of ["x86_64", "arm64"]) {
    const minos = readMachOMinimumVersion(binary, arch);
    if (compareVersions(minos, requiredMacOS) > 0) {
      throw new Error(
        `${path.basename(binary)} (${arch}) requires macOS ${minos}, above Zinnia's declared ${requiredMacOS} floor`,
      );
    }
  }
}

function verifySignedEntitlements(targetPath, expected) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-entitlements-"),
  );
  const plistPath = path.join(temporaryDirectory, "entitlements.plist");
  try {
    // Without --xml, modern codesign writes a textual DER dump that starts
    // with "[Dict]" and cannot be parsed by plutil.
    const inspection = spawnSync(
      "codesign",
      ["--display", "--entitlements", plistPath, "--xml", targetPath],
      { encoding: "utf8" },
    );
    if (inspection.error || inspection.status !== 0) {
      throw (
        inspection.error ??
        new Error(
          `Could not inspect entitlements for ${targetPath}: ${inspection.stderr}`,
        )
      );
    }
    const actual = fs.existsSync(plistPath)
      ? JSON.parse(
          execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
            encoding: "utf8",
          }),
        )
      : {};
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `Unexpected signed entitlements for ${targetPath}: ${JSON.stringify(actual)}`,
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function verifyDeveloperIdSignature(targetPath, label) {
  const inspection = spawnSync(
    "codesign",
    ["--display", "--verbose=4", targetPath],
    { encoding: "utf8" },
  );
  if (inspection.error || inspection.status !== 0) {
    throw inspection.error ?? new Error(inspection.stderr);
  }
  const details = `${inspection.stdout}${inspection.stderr}`;
  if (
    /Signature=adhoc/i.test(details) ||
    !/Authority=Developer ID Application:/i.test(details)
  ) {
    throw new Error(
      `${label} is not signed with a Developer ID Application certificate.`,
    );
  }
  const teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error(`${label} signature has no TeamIdentifier.`);
  }
  return teamIdentifier;
}

function readEntitlementsTemplate(templatePath) {
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", templatePath], {
      encoding: "utf8",
    }),
  );
}

function readPlistValue(plistPath, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print:${key}`, plistPath],
    { encoding: "utf8" },
  ).trim();
}

function verifyAppGroup(entitlements, expectedGroup, label) {
  const groups = entitlements["com.apple.security.application-groups"];
  if (!isDeepStrictEqual(groups, [expectedGroup])) {
    throw new Error(
      `${label} must have exactly App Group ${expectedGroup}: ${JSON.stringify(groups)}`,
    );
  }
}

const infoPlist = path.join(appPath, "Contents", "Info.plist");
const bundleVersion = readPlistValue(infoPlist, "CFBundleVersion");
if (!/^\d+(?:\.\d+){0,2}$/.test(bundleVersion)) {
  throw new Error(`CFBundleVersion must be numeric: ${bundleVersion}`);
}
if (bundleVersion !== expectedBundleVersion) {
  throw new Error(
    `CFBundleVersion ${bundleVersion} does not match configured ${expectedBundleVersion}`,
  );
}
const marketingVersion = readPlistValue(
  infoPlist,
  "CFBundleShortVersionString",
);
if (marketingVersion !== expectedMarketingVersion) {
  throw new Error(
    `CFBundleShortVersionString ${marketingVersion} does not match expected ${expectedMarketingVersion}`,
  );
}

verifyMachOCompatibility(path.join(appPath, "Contents", "MacOS", "zinnia"));
const sidecarPath = path.join(appPath, "Contents", "MacOS", "7z");
verifyMachOCompatibility(sidecarPath);

const finderSyncAppex = path.join(
  appPath,
  "Contents",
  "PlugIns",
  "ZinniaFinderSync.appex",
);
if (!fs.existsSync(finderSyncAppex)) {
  throw new Error(
    `Missing Finder Sync extension: ${finderSyncAppex}. Run npm run prepare:macos:finder-sync before building.`,
  );
}
execFileSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", finderSyncAppex],
  { stdio: "inherit" },
);
verifySignedEntitlements(finderSyncAppex, {
  ...readEntitlementsTemplate(
    path.join(
      root,
      "src-tauri",
      "macos",
      "build",
      "ZinniaFinderSync.entitlements",
    ),
  ),
});
const extensionTeam = verifyDeveloperIdSignature(
  finderSyncAppex,
  "Finder Sync extension",
);

const extensionInfoPlist = path.join(finderSyncAppex, "Contents", "Info.plist");
if (
  readPlistValue(extensionInfoPlist, "CFBundleShortVersionString") !==
    expectedMarketingVersion ||
  readPlistValue(extensionInfoPlist, "CFBundleVersion") !==
    expectedBundleVersion
) {
  throw new Error("Finder Sync extension versions do not match the host app.");
}

execFileSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { stdio: "inherit" },
);
const hostTeam = verifyDeveloperIdSignature(appPath, "macOS app");
if (hostTeam !== extensionTeam) {
  throw new Error(
    `Host TeamIdentifier ${hostTeam} does not match Finder Sync ${extensionTeam}.`,
  );
}
const hostEntitlements = readEntitlementsTemplate(
  path.join(root, "src-tauri", "macos", "build", "Zinnia.entitlements"),
);
const extensionEntitlements = readEntitlementsTemplate(
  path.join(
    root,
    "src-tauri",
    "macos",
    "build",
    "ZinniaFinderSync.entitlements",
  ),
);
const expectedAppGroup = `${hostTeam}.run.rosie.zinnia.findersync`;
verifyAppGroup(hostEntitlements, expectedAppGroup, "macOS app");
verifyAppGroup(
  extensionEntitlements,
  expectedAppGroup,
  "Finder Sync extension",
);
if (
  readPlistValue(extensionInfoPlist, "ZinniaAppGroupIdentifier") !==
  expectedAppGroup
) {
  throw new Error(
    "Finder Sync Info.plist App Group does not match its Team ID.",
  );
}
verifySignedEntitlements(appPath, hostEntitlements);
// Tauri signs externalBin sidecars with the same entitlements.plist as the app.
verifySignedEntitlements(sidecarPath, hostEntitlements);
const sidecarTeam = verifyDeveloperIdSignature(sidecarPath, "7-Zip sidecar");
if (sidecarTeam !== hostTeam) {
  throw new Error(
    `7-Zip TeamIdentifier ${sidecarTeam} does not match host ${hostTeam}.`,
  );
}
execFileSync("xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });
execFileSync(
  "spctl",
  ["--assess", "--type", "execute", "--verbose=2", appPath],
  {
    stdio: "inherit",
  },
);

const baseName = path.basename(appPath, ".app");
const zipPath = path.join(path.dirname(appPath), `${baseName}.zip`);
execFileSync(
  "ditto",
  ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
  { stdio: "inherit" },
);

console.log(`Created ${zipPath}`);
