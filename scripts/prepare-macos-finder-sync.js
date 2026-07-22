#!/usr/bin/env node
/** Build the macOS Finder Sync appex before Tauri bundles (no-op off macOS). */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin") {
  process.exit(0);
}

const result = spawnSync(
  "bash",
  [path.join(root, "scripts", "build-macos-finder-sync.sh")],
  { cwd: root, stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
