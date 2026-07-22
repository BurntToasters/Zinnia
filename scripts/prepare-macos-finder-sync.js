#!/usr/bin/env node
/** Build the macOS Finder Sync appex before Tauri bundles (no-op off macOS). */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin") {
  process.exit(0);
}

if (process.env.ZINNIA_FINDERSYNC_ALREADY_PREPARED === "1") {
  const requiredOutputs = [
    path.join(
      root,
      "src-tauri",
      "macos",
      "build",
      "ZinniaFinderSync.appex",
      "Contents",
      "MacOS",
      "ZinniaFinderSync",
    ),
    path.join(root, "src-tauri", "macos", "build", "Zinnia.entitlements"),
    path.join(
      root,
      "src-tauri",
      "macos",
      "build",
      "ZinniaFinderSync.entitlements",
    ),
    path.join(
      root,
      "src-tauri",
      "macos",
      "build",
      "ZinniaFinderSync.appex",
      "Contents",
      "Resources",
      "zinnia-menu.png",
    ),
  ];
  const missing = requiredOutputs.filter((output) => !fs.existsSync(output));
  if (missing.length > 0) {
    throw new Error(
      `Finder Sync was marked prepared but outputs are missing: ${missing.join(", ")}`,
    );
  }
  console.log("prepare-macos-finder-sync: already prepared for this build");
  process.exit(0);
}

const result = spawnSync(
  "bash",
  [path.join(root, "scripts", "build-macos-finder-sync.sh")],
  { cwd: root, stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
