#!/usr/bin/env node
/**
 * Re-sign ZinniaFinderSync.appex inside the built .app with Finder Sync
 * entitlements, then re-sign the outer app. Tauri may otherwise stamp the
 * host entitlements onto nested PlugIns and break the extension.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

if (process.platform !== "darwin") {
  console.log("resign-macos-finder-sync: skipping (not macOS)");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetArg = process.argv.indexOf("--target");
const target =
  targetArg >= 0 ? process.argv[targetArg + 1] : "universal-apple-darwin";

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
const appexPath = path.join(
  appPath,
  "Contents",
  "PlugIns",
  "ZinniaFinderSync.appex",
);
const appexEntitlements = path.join(
  root,
  "src-tauri",
  "macos",
  "ZinniaFinderSync",
  "ZinniaFinderSync.entitlements",
);
const hostEntitlements = path.join(root, "src-tauri", "entitlements.plist");

if (!fs.existsSync(appPath)) {
  console.error(`resign-macos-finder-sync: missing ${appPath}`);
  process.exit(1);
}
if (!fs.existsSync(appexPath)) {
  console.error(`resign-macos-finder-sync: missing ${appexPath}`);
  process.exit(1);
}

const identity = (process.env.APPLE_SIGNING_IDENTITY || "").trim();
if (!identity || identity === "-") {
  console.error(
    "resign-macos-finder-sync: APPLE_SIGNING_IDENTITY is required for release signing",
  );
  process.exit(1);
}

function run(args) {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `codesign failed: ${result.stderr || result.stdout || args.join(" ")}`,
    );
  }
}

run([
  "--force",
  "--sign",
  identity,
  "--entitlements",
  appexEntitlements,
  "--options",
  "runtime",
  "--timestamp",
  appexPath,
]);
run([
  "--force",
  "--sign",
  identity,
  "--entitlements",
  hostEntitlements,
  "--options",
  "runtime",
  "--timestamp",
  appPath,
]);

console.log("resign-macos-finder-sync: ok");
