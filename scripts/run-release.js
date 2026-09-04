#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { usesWindowsCmdShell } from "./npm-safe-update.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONTINUE_SCRIPTS = {
  win: "release:win:continue",
  mac: "release:mac:continue",
  linux: "release:linux:continue",
  "linux:x64": "release:linux:x64:continue",
  "linux:arm64": "release:linux:arm64:continue",
};

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function parseReleaseArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const unknown = flags.filter((flag) => flag !== "--skip-e2e");
  if (unknown.length > 0) {
    throw new Error(`Unknown release flag: ${unknown.join(", ")}`);
  }
  const platforms = argv.filter((arg) => !arg.startsWith("-"));
  if (platforms.length !== 1 || !CONTINUE_SCRIPTS[platforms[0]]) {
    throw new Error(
      `Usage: node scripts/run-release.js <${Object.keys(CONTINUE_SCRIPTS).join("|")}> [--skip-e2e]`,
    );
  }
  return {
    platform: platforms[0],
    skipE2e: flags.includes("--skip-e2e"),
    continueScript: CONTINUE_SCRIPTS[platforms[0]],
  };
}

function runNpm(script, extraArgs = []) {
  const npm = npmCommand();
  const result = spawnSync(npm, ["run", script, ...extraArgs], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    shell: usesWindowsCmdShell(npm),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function main(argv = process.argv.slice(2)) {
  const { skipE2e, continueScript } = parseReleaseArgs(argv);
  runNpm("prerelease:prepare");
  runNpm("workspace:bootstrap");
  runNpm("test:all", [
    "--",
    "--require-clean-proof",
    ...(skipE2e ? ["--skip-e2e"] : []),
  ]);
  runNpm("dist:clean-release-artifacts");
  runNpm(continueScript);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  main();
}
