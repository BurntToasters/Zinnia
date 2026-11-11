#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

const OVERRIDE_ENV = "ZINNIA_FORCE_RESET";
const LISTED_ENTRY_LIMIT = 10;

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function describeWorkingTree() {
  const entries = git(["status", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (entries.length === 0) {
    return [];
  }
  const shown = entries
    .slice(0, LISTED_ENTRY_LIMIT)
    .map((line) => `    ${line}`);
  const hidden = entries.length - shown.length;
  if (hidden > 0) {
    shown.push(`    ...and ${hidden} more`);
  }
  return [
    `Working tree has ${entries.length} uncommitted or untracked path(s):`,
    ...shown,
  ];
}

function describeUnpushedCommits() {
  if (gitOrNull(["rev-parse", "--verify", "--quiet", "HEAD"]) === null) {
    return [];
  }
  const aheadOfUpstream = gitOrNull(["rev-list", "--count", "@{u}..HEAD"]);
  if (aheadOfUpstream !== null) {
    const count = Number(aheadOfUpstream.trim());
    return count > 0
      ? [`Current branch has ${count} commit(s) not on its upstream.`]
      : [];
  }
  const notOnRemotes = Number(
    git(["rev-list", "--count", "HEAD", "--not", "--remotes"]).trim(),
  );
  return notOnRemotes > 0
    ? [
        `Current branch has ${notOnRemotes} commit(s) not on any remote branch, and it has no upstream.`,
      ]
    : [];
}

function errorText(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : "";
  return stderr || error?.message || String(error);
}

function main() {
  if (process.env[OVERRIDE_ENV] === "1") {
    console.warn(`${OVERRIDE_ENV}=1 is set, so the reset guard is skipped.`);
    return 0;
  }

  const reasons = [...describeWorkingTree(), ...describeUnpushedCommits()];
  if (reasons.length === 0) {
    return 0;
  }

  console.error("Refusing to reset: the reset would discard local work.");
  for (const reason of reasons) {
    console.error(reason);
  }
  console.error("");
  console.error(
    "Commit or back up your changes, push unpushed commits, then rerun.",
  );
  console.error(
    "Upstream state comes from the last git fetch, so fetch first if you pushed recently.",
  );
  console.error(
    `To discard this work anyway, set ${OVERRIDE_ENV}=1 and rerun.`,
  );
  console.error("  POSIX shell: ZINNIA_FORCE_RESET=1 npm run b");
  console.error('  PowerShell:  $env:ZINNIA_FORCE_RESET = "1"; npm run b');
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(
    `Reset guard could not inspect this repository: ${errorText(error)}`,
  );
  process.exitCode = 1;
}
