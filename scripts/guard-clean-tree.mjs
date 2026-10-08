#!/usr/bin/env node
// Refuses to continue when the working tree has changes that `git reset --hard`
// and `git clean -fd` (used by `npm run b` and `npm run r`) would destroy.
// Ignored files are not listed by git status and are not touched by git clean -fd.
import { spawnSync } from "node:child_process";

const forced =
  process.argv.slice(2).includes("--force") ||
  process.env.ZINNIA_ALLOW_DISCARD === "1";

const status = spawnSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { encoding: "utf8" },
);

if (status.error) {
  console.error(`guard-clean-tree: could not run git: ${status.error.message}`);
  process.exit(1);
}
if (status.status !== 0) {
  console.error(
    `guard-clean-tree: git status failed: ${status.stderr.trim() || `exit ${status.status}`}`,
  );
  process.exit(1);
}

const dirty = status.stdout.split("\n").filter((line) => line.length > 0);
if (dirty.length === 0) {
  process.exit(0);
}

if (forced) {
  console.warn(
    `guard-clean-tree: override enabled; ${dirty.length} local path(s) will be discarded:`,
  );
  for (const line of dirty) console.warn(`  ${line}`);
  process.exit(0);
}

console.error(
  `guard-clean-tree: ${dirty.length} local path(s) have uncommitted or untracked changes:`,
);
for (const line of dirty) console.error(`  ${line}`);
console.error(
  [
    "",
    "npm run b and npm run r would destroy these paths (git reset --hard && git clean -fd).",
    "Commit, stash, or move them first. To discard them anyway, set ZINNIA_ALLOW_DISCARD=1",
    "(for example: ZINNIA_ALLOW_DISCARD=1 npm run b).",
  ].join("\n"),
);
process.exit(1);
