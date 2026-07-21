#!/usr/bin/env node
/** Export the exact committed tree used for a sideload Flatpak build. */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exportDirectory = path.join(root, ".flatpak-source");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

const dirtyEntries = run("git", [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
]);
// `tauri build` rewrites generated ACL schemas under src-tauri/gen/schemas/.
// Flatpak exports `git archive HEAD`, so those dirty generated files never enter
// the bundle — only refuse unexpected workspace dirt.
const blockingDirty = dirtyEntries
  .split("\n")
  .map((line) => line.trimEnd())
  .filter(Boolean)
  .filter((line) => {
    // Porcelain: XY PATH  or  XY ORIG -> PATH
    const pathPart = line.slice(3);
    const filePath = pathPart.includes(" -> ")
      ? pathPart.split(" -> ").at(-1)
      : pathPart;
    return !filePath.startsWith("src-tauri/gen/schemas/");
  });
if (blockingDirty.length) {
  throw new Error(
    `Flatpak source export requires a clean committed tree:\n${blockingDirty.join("\n")}`,
  );
}
const commit = run("git", ["rev-parse", "--verify", "HEAD"]);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "zinnia-flatpak-source-"),
);
const archive = path.join(temporaryDirectory, "source.tar");
try {
  fs.rmSync(exportDirectory, { recursive: true, force: true });
  fs.mkdirSync(exportDirectory, { recursive: true });
  run("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
  run("tar", ["-xf", archive, "-C", exportDirectory]);
  fs.writeFileSync(
    path.join(exportDirectory, ".zinnia-source-commit"),
    `${commit}\n`,
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
console.log(`Flatpak source exported from ${commit}.`);
