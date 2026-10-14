#!/usr/bin/env node
// Refuses to continue when the working tree has changes that `git reset --hard`
// and `git clean -fd` (used by `npm run b` and `npm run r`) would destroy.
// Ignored files are not listed by git status and are not touched by git clean -fd.
// With --branch <name>, also refuses when that local branch holds commits that
// no origin ref contains, because `git switch -C` would repoint it.
import { spawnSync } from "node:child_process";

const cliArgs = process.argv.slice(2);
const forced =
  cliArgs.includes("--force") || process.env.ZINNIA_ALLOW_DISCARD === "1";
const branchIndex = cliArgs.indexOf("--branch");
const branch = branchIndex === -1 ? null : cliArgs[branchIndex + 1];
if (branchIndex !== -1 && (!branch || branch.startsWith("-"))) {
  console.error("guard-clean-tree: --branch requires a branch name.");
  process.exit(1);
}

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

if (branch) {
  const ref = `refs/heads/${branch}`;
  const exists = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    encoding: "utf8",
  });
  if (exists.status === 0) {
    const unpushed = spawnSync(
      "git",
      ["rev-list", "--oneline", ref, "--not", "--remotes=origin"],
      { encoding: "utf8" },
    );
    if (unpushed.error || unpushed.status !== 0) {
      console.error(
        `guard-clean-tree: could not compare ${branch} with origin: ${unpushed.error?.message || unpushed.stderr.trim() || `exit ${unpushed.status}`}`,
      );
      process.exit(1);
    }
    for (const line of unpushed.stdout.split("\n")) {
      if (line.length > 0) dirty.push(`unpushed on ${branch}: ${line}`);
    }
  }
}

if (dirty.length === 0) {
  process.exit(0);
}

if (forced) {
  console.warn(
    `guard-clean-tree: override enabled; ${dirty.length} local change(s) will be discarded:`,
  );
  for (const line of dirty) console.warn(`  ${line}`);
  process.exit(0);
}

console.error(
  `guard-clean-tree: ${dirty.length} local change(s) would be lost (uncommitted, untracked, or unpushed):`,
);
for (const line of dirty) console.error(`  ${line}`);
console.error(
  [
    "",
    "npm run b and npm run r would destroy these changes (git reset --hard, git clean -fd, git switch -C).",
    "Commit, push, stash, or move them first. To discard them anyway, set ZINNIA_ALLOW_DISCARD=1:",
    "  POSIX shell:  ZINNIA_ALLOW_DISCARD=1 npm run b",
    "  PowerShell:   $env:ZINNIA_ALLOW_DISCARD='1'; npm run b; Remove-Item Env:ZINNIA_ALLOW_DISCARD",
  ].join("\n"),
);
process.exit(1);
