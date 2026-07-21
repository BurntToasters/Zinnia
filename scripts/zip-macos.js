import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";

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
if (!requiredMacOS || !expectedBundleVersion) {
  throw new Error(
    "tauri.conf.json must define bundle.macOS.minimumSystemVersion and bundleVersion",
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
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Unexpected signed entitlements for ${targetPath}: ${JSON.stringify(actual)}`,
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const infoPlist = path.join(appPath, "Contents", "Info.plist");
const bundleVersion = execFileSync(
  "/usr/libexec/PlistBuddy",
  ["-c", "Print:CFBundleVersion", infoPlist],
  { encoding: "utf8" },
).trim();
if (!/^\d+(?:\.\d+){0,2}$/.test(bundleVersion)) {
  throw new Error(`CFBundleVersion must be numeric: ${bundleVersion}`);
}
if (bundleVersion !== expectedBundleVersion) {
  throw new Error(
    `CFBundleVersion ${bundleVersion} does not match configured ${expectedBundleVersion}`,
  );
}

verifyMachOCompatibility(path.join(appPath, "Contents", "MacOS", "zinnia"));
const sidecarPath = path.join(appPath, "Contents", "MacOS", "7z");
verifyMachOCompatibility(sidecarPath);

execFileSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { stdio: "inherit" },
);
const signatureInspection = spawnSync(
  "codesign",
  ["--display", "--verbose=4", appPath],
  { encoding: "utf8" },
);
if (signatureInspection.error || signatureInspection.status !== 0) {
  throw signatureInspection.error ?? new Error(signatureInspection.stderr);
}
const signatureDetails = `${signatureInspection.stdout}${signatureInspection.stderr}`;
if (
  /Signature=adhoc/i.test(signatureDetails) ||
  !/Authority=Developer ID Application:/i.test(signatureDetails)
) {
  console.error(
    "The macOS app is not signed with a Developer ID Application certificate.",
  );
  process.exit(1);
}
verifySignedEntitlements(appPath, {
  "com.apple.security.cs.allow-jit": true,
});
// Tauri signs externalBin sidecars with the same entitlements.plist as the app.
verifySignedEntitlements(sidecarPath, {
  "com.apple.security.cs.allow-jit": true,
});
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
