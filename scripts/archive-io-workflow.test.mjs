import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  waitForChild,
  waitForChildExit,
} from "../e2e/helpers/archive-benchmark.js";
import { validateStableMetadataChange } from "./check-stable-metadata-pr.mjs";
import { resolveBetaBaseline } from "./resolve-archive-io-baseline.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const readFile = (file, encoding) => readFileSync(file, encoding);

function readFileSyncExists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function assertProcessStopped(pid) {
  for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt += 1) {
    await delay(25);
  }
  assert.equal(processIsAlive(pid), false, `process ${pid} should be stopped`);
}

// Regression failure modes recorded before implementation:
// - a Windows baseline worktree lacks generated shell package stubs;
// - a hung nested benchmark or persistent runner can outlive its useful budget;
// - stable-promotion PRs can pass without six-platform release-scale evidence;
// - skipped promotion jobs are not distinguished from failed required jobs;
// - CI's Rust version can drift from the pinned local toolchain.
// Additional release-path failures to prevent:
// - promotion compares main instead of the accepted beta tag for this version;
// - baseline worktree builds with its floating Rust stable channel;
// - command timeout ignores the parent process environment;
// - runner timeout rejects the wrapper while leaving the app process tree alive;
// - timeout returns before abort cleanup and the underlying benchmark settle;
// - non-next PRs target main and pass with a skipped promotion job;
// - the documented release/* metadata PR is rejected or can change source;
// - exact Rust toolchain is installed without clippy for rust-check.

test("PR and push archive benchmark keeps x64 smoke matrix", () => {
  const workflow = read(".github/workflows/ci.yml");
  const benchmarkStart = workflow.indexOf("  archive-io-benchmark:");
  const benchmarkJob = workflow.slice(
    benchmarkStart,
    workflow.indexOf("\n  archive-io-promotion-benchmark:", benchmarkStart),
  );
  assert.match(workflow, /archive-io-benchmark:/);
  for (const runner of ["ubuntu-latest", "macos-26-intel", "windows-latest"]) {
    assert.match(
      benchmarkJob,
      new RegExp(`os: ${runner.replaceAll(".", "\\.")}`),
    );
  }
  assert.doesNotMatch(benchmarkJob, /ubuntu-24\.04-arm/);
  assert.doesNotMatch(benchmarkJob, /windows-11-arm/);
  assert.match(benchmarkJob, /retention-days: 30/);
  assert.match(benchmarkJob, /ZINNIA_BENCH_CANDIDATE_REF/);
  assert.match(benchmarkJob, /ZINNIA_BENCH_BASELINE_REF/);
  assert.match(benchmarkJob, /timeout-minutes:\s*120/);
  assert.match(benchmarkJob, /ZINNIA_BENCH_RUN_TIMEOUT_MS/);
});

test("promotion PR adds a required six-platform release-scale benchmark", () => {
  const workflow = read(".github/workflows/ci.yml");
  const promotionStart = workflow.indexOf("  archive-io-promotion-benchmark:");
  const gateStart = workflow.indexOf("  ci-gate:", promotionStart);
  const promotionJob = workflow.slice(promotionStart, gateStart);
  const gateJob = workflow.slice(gateStart);
  assert.ok(promotionStart >= 0, "promotion benchmark job must exist");
  assert.match(
    promotionJob,
    /github\.event_name == 'pull_request'[\s\S]*github\.event\.pull_request\.base\.ref == 'main'[\s\S]*startsWith\(github\.head_ref, 'next-'\)/,
  );
  for (const runner of [
    "ubuntu-latest",
    "ubuntu-24.04-arm",
    "macos-26",
    "macos-26-intel",
    "windows-latest",
    "windows-11-arm",
  ]) {
    assert.match(
      promotionJob,
      new RegExp(`os: ${runner.replaceAll(".", "\\.")}`),
    );
  }
  assert.match(promotionJob, /--scale release/);
  assert.match(promotionJob, /--compatibility/);
  assert.match(promotionJob, /ZINNIA_BENCH_REQUIRE_BASELINE_REPORT:\s*["']?1/);
  assert.match(promotionJob, /Resolve accepted beta baseline/);
  assert.match(promotionJob, /steps\.accepted-beta\.outputs\.sha/);
  assert.doesNotMatch(promotionJob, /github\.event\.pull_request\.base\.sha/);
  assert.match(promotionJob, /retention-days: 90/);
  assert.match(gateJob, /archive-io-promotion-benchmark/);
  assert.match(gateJob, /ARCHIVE_IO_PROMOTION_BENCHMARK/);
  assert.match(gateJob, /RELEASE_PROMOTION_PR/);
  assert.match(gateJob, /STABLE_METADATA_PR/);
  assert.match(gateJob, /PR_BASE_REF/);
  assert.match(
    gateJob,
    /test "\$PR_BASE_REF" != "main" \|\| test "\$RELEASE_PROMOTION_PR" = "true" \|\| test "\$STABLE_METADATA_PR" = "true"/,
  );
  assert.match(workflow, /Enforce stable metadata-only main PR/);
  assert.match(workflow, /check-stable-metadata-pr\.mjs/);
  assert.match(gateJob, /test "\$ARCHIVE_IO_PROMOTION_BENCHMARK" = success/);
  assert.match(gateJob, /test "\$ARCHIVE_IO_PROMOTION_BENCHMARK" = skipped/);
});

test("stable metadata policy allows only the beta-to-stable release surface", () => {
  const metadataPaths = [
    "package.json",
    "package-lock.json",
    "CHANGELOG.md",
    "run.rosie.zinnia.metainfo.xml",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  ];
  assert.doesNotThrow(() =>
    validateStableMetadataChange({
      baseVersion: "0.6.3-beta.3",
      headVersion: "0.6.3",
      changedPaths: metadataPaths,
    }),
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: "0.6.3-beta.3",
        headVersion: "0.6.3",
        changedPaths: [...metadataPaths, "src-tauri/src/main.rs"],
      }),
    /not release metadata/,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: "0.6.3-beta.3",
        headVersion: "0.6.4",
        changedPaths: metadataPaths,
      }),
    /must remove only the beta suffix/,
  );
});

test("workflow Rust version matches the pinned toolchain", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /RUST_VERSION:\s*["']1\.98\.1["']/);
  assert.match(workflow, /toolchain:\s*\$\{\{ env\.RUST_VERSION \}\}/);
  const rustCheckStart = workflow.indexOf("  rust-check:");
  const updaterStart = workflow.indexOf(
    "\n  updater-manifest:",
    rustCheckStart,
  );
  assert.match(
    workflow.slice(rustCheckStart, updaterStart),
    /components:\s*clippy/,
  );
});

test("accepted beta baseline is resolved and verified from candidate version", () => {
  const workflow = read(".github/workflows/ci.yml");
  const resolver = read("scripts/resolve-archive-io-baseline.mjs");
  assert.match(workflow, /node scripts\/resolve-archive-io-baseline\.mjs/);
  assert.match(workflow, /id: accepted-beta/);
  assert.match(resolver, /v\$\{packageVersion\}/);
  assert.match(resolver, /refs\/tags\/\$\{tag\}\^\{commit\}/);

  assert.deepEqual(
    resolveBetaBaseline("0.6.3-beta.2", () => "a".repeat(40)),
    { tag: "v0.6.3-beta.2", sha: "a".repeat(40) },
  );
  assert.throws(
    () => resolveBetaBaseline("0.6.3", () => "a".repeat(40)),
    /must be a beta version/,
  );
  assert.throws(
    () => resolveBetaBaseline("0.6.3-beta.2", () => null),
    /accepted beta tag v0.6.3-beta.2 is unavailable/,
  );
});

test("archive benchmark checkout ref agrees with candidate metadata", () => {
  const workflow = read(".github/workflows/ci.yml");
  const benchmarkStart = workflow.indexOf("  archive-io-benchmark:");
  const benchmarkJob = workflow.slice(
    benchmarkStart,
    workflow.indexOf("\n  archive-io-promotion-benchmark:", benchmarkStart),
  );
  const checkoutRef = benchmarkJob.match(
    /uses: actions\/checkout[^\n]*\n\s+with:\s*\n\s+ref:\s*(\$\{\{[^\n]+\}\})/,
  )?.[1];
  const candidateRef = benchmarkJob.match(
    /ZINNIA_BENCH_CANDIDATE_REF:\s*(\$\{\{[^\n]+\}\})/,
  )?.[1];
  const expectedRef =
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";

  assert.equal(checkoutRef, expectedRef);
  assert.equal(candidateRef, expectedRef);
  assert.match(benchmarkJob, /fetch-depth:\s*0/);
});

test("nightly archive benchmark covers all hosted architectures", () => {
  const workflow = read(".github/workflows/archive-io-benchmark.yml");
  assert.match(workflow, /cron: ['"]17 9 \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  for (const runner of [
    "ubuntu-latest",
    "ubuntu-24.04-arm",
    "macos-26",
    "macos-26-intel",
    "windows-latest",
    "windows-11-arm",
  ]) {
    assert.match(workflow, new RegExp(`os: ${runner.replaceAll(".", "\\.")}`));
  }
  assert.match(
    workflow,
    /\n    timeout-minutes:\s*360\s*\n/,
    "release benchmark must retain the six-hour hosted-job budget",
  );
  assert.match(workflow, /retention-days: 90/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /peter-evans\/create-pull-request/);
});

test("archive benchmark wrapper uses release persistent runner contract", () => {
  const script = read("scripts/run-archive-io-benchmark.mjs");
  const runner = read("e2e/helpers/archive-benchmark.js");
  assert.match(script, /buildProfile: "release"/);
  assert.match(script, /persistent: true/);
  assert.match(script, /excludeTransportTime: true/);
  assert.match(script, /runArchiveBenchmarkOperation/);
  assert.match(script, /GITHUB_STEP_SUMMARY/);
  assert.match(script, /failure \?\?= error/);
  assert.match(script, /ZINNIA_BENCH_RUN_TIMEOUT_MS/);
  assert.match(
    script,
    /Archive benchmark exceeded its \$\{timeoutMs\}ms run timeout/,
  );
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /abortController\.abort\(\)/);
  assert.match(script, /await onTimeout\?\.\(error\)/);
  assert.match(script, /Cancellation did not settle underlying benchmark/);
  assert.match(script, /abort: session\?\.abort\?\.bind\(session\)/);
  assert.match(script, /const mergedEnv = \{ \.\.\.process\.env, \.\.\.env \}/);
  assert.match(script, /benchmarkCommandTimeoutMs\(mergedEnv\)/);
  assert.match(script, /RUSTUP_TOOLCHAIN: process\.env\.RUST_VERSION/);
  assert.match(script, /ZINNIA_BENCH_REQUIRE_BASELINE_REPORT/);
  assert.match(runner, /tauri/);
  assert.match(runner, /--features/);
  assert.match(runner, /"target",\s+"release"/);
  assert.match(runner, /ZINNIA_BENCH_SOCKET_PORT/);
  assert.match(
    runner,
    /const buildTimeoutMs = buildCommandTimeoutMs\(mergedEnv\)/,
  );
  assert.match(runner, /setTimeout\([\s\S]{0,300}buildTimeoutMs/);
  assert.match(runner, /ZINNIA_BENCH_BUILD_TIMEOUT_MS/);
  assert.match(runner, /Archive benchmark build command .*timed out after/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
  assert.match(runner, /taskkill/);
  assert.match(runner, /terminateProcessTree/);
  assert.match(runner, /signal\?\.addEventListener\("abort", onAbort/);
  assert.match(runner, /Archive benchmark runner was aborted before startup/);
});

test("archive benchmark E2E spec matches the persistent socket transport", () => {
  const spec = read("e2e/specs/archive-io-benchmark.spec.js");
  assert.match(spec, /node:net/);
  assert.match(spec, /net\.createConnection/);
  assert.match(spec, /ZINNIA_BENCH_SOCKET_HOST/);
  assert.match(spec, /ZINNIA_BENCH_SOCKET_PORT/);
  assert.match(spec, /ready:\s*true/);
  assert.match(spec, /message\.close\s*===\s*true/);
  assert.match(spec, /message\.id/);
  assert.match(spec, /runArchiveBenchmarkOperation/);
  assert.doesNotMatch(spec, /ZINNIA_BENCH_REQUESTS/);
});

test("archive benchmark smoke compares a base revision when available", () => {
  const workflow = read(".github/workflows/ci.yml");
  const benchmarkStart = workflow.indexOf("  archive-io-benchmark:");
  const benchmarkJob = workflow.slice(
    benchmarkStart,
    workflow.indexOf("\n  archive-io-promotion-benchmark:", benchmarkStart),
  );
  assert.match(benchmarkJob, /ZINNIA_BENCH_BASE_RUN:\s*["']?1["']?/);
  assert.match(benchmarkJob, /ZINNIA_BENCH_BASELINE_REF/);
});

test("baseline worktree recreates generated platform build inputs", () => {
  const script = read("scripts/run-archive-io-benchmark.mjs");
  assert.match(
    script,
    /if \(process\.platform === "win32"\) \{[\s\S]*?runCommand\([\s\S]*?"prepare:win-shell-stubs"[\s\S]*?\n    \}/,
  );
  assert.match(
    script,
    /ZINNIA_BENCH_REQUIRE_BASELINE_REPORT[\s\S]{0,120}Required baseline archive benchmark report is unavailable\./,
  );
});

test("release E2E helper refuses unstamped or stale production binaries", () => {
  const helper = read("e2e/helpers/archive-benchmark.js");
  assert.match(helper, /ARCHIVE_BENCHMARK_E2E_STAMP_VERSION/);
  assert.match(helper, /binaryMtimeMs/);
  assert.match(helper, /sourceMtimeMs/);
  assert.match(helper, /releaseE2eBinaryIsFresh/);
  assert.match(helper, /refusing to reuse a production binary/);
});

test("archive benchmark runner requirements remain role-specific", () => {
  const script = read("scripts/run-archive-io-benchmark.mjs");
  assert.match(
    script,
    /role === "baseline"\s*\? envFlag\("ZINNIA_BENCH_REQUIRE_BASELINE"\)/,
  );
  assert.match(
    script,
    /Baseline archive benchmark requires persistent release E2E runner; runner module not found\./,
  );
  assert.match(script, /metadata\.baselineUnavailable = true/);
  assert.match(script, /baselineRef && !baselineReport/);
});

test("release E2E freshness covers frontend and Tauri build inputs", () => {
  const helper = read("e2e/helpers/archive-benchmark.js");
  for (const input of [
    'path.join(REPO_ROOT, "public")',
    'path.join(REPO_ROOT, "assets")',
    'path.join(REPO_ROOT, "vite.config.ts")',
    'path.join(REPO_ROOT, "tsconfig.json")',
    'path.join(REPO_ROOT, "src-tauri", "build.rs")',
    'path.join(REPO_ROOT, "src-tauri", "tauri.conf.json")',
    'path.join(REPO_ROOT, "src-tauri", "tauri.linux.conf.json")',
    'path.join(REPO_ROOT, "src-tauri", "tauri.macos.conf.json")',
    'path.join(REPO_ROOT, "src-tauri", "tauri.windows.conf.json")',
    "const VENDORED_UPDATER_DIR = path.join(",
    '"tauri-plugin-updater",',
    "VENDORED_UPDATER_DIR,",
  ]) {
    assert.ok(helper.includes(input), `freshness list missing ${input}`);
  }
});

test("archive E2E timeout kills WDIO and descendant processes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zinnia-benchmark-tree-"));
  const pidFile = join(directory, "descendant.pid");
  let child;
  let descendantPid;
  t.after(() => {
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
    if (descendantPid) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });

  const source = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "fs.writeFileSync(process.env.ZINNIA_BENCH_TEST_PID_FILE, String(descendant.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  child = spawn(process.execPath, ["-e", source], {
    env: { ...process.env, ZINNIA_BENCH_TEST_PID_FILE: pidFile },
    stdio: "ignore",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const childExit = waitForChild(child);
  childExit.catch(() => {});
  for (
    let attempt = 0;
    attempt < 100 && !readFileSyncExists(pidFile);
    attempt += 1
  ) {
    await delay(10);
  }
  assert.ok(
    readFileSyncExists(pidFile),
    "fixture child must launch a descendant",
  );
  descendantPid = Number(readFile(pidFile, "utf8"));

  await assert.rejects(
    waitForChildExit(childExit, child, 50),
    /did not exit after close request/,
  );
  await assertProcessStopped(child.pid);
  await assertProcessStopped(descendantPid);
});

test("package scripts expose benchmark and comparison entry points", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(
    packageJson.scripts["benchmark:archive-io"],
    "node scripts/run-archive-io-benchmark.mjs",
  );
  assert.equal(
    packageJson.scripts["benchmark:archive-io:compare"],
    "node bench/archive-io/compare.mjs",
  );
});

test("link-bearing compatibility fixture requires real 7-Zip link metadata", () => {
  const benchmark = read("bench/archive-io/benchmark.mjs");
  assert.match(benchmark, /compatibility-links\.tar/);
  assert.match(benchmark, /["']-ttar["']/);
  assert.match(benchmark, /["']-snh["']/);
  assert.match(benchmark, /hasArchiveLinkMetadata\(listing\.stdout\)/);
  assert.match(
    benchmark,
    /Generated link-bearing compatibility fixture has no non-empty Hard Link or Symbolic Link metadata/,
  );
});

test("unsupported compatibility capabilities are explicit non-timing rows", () => {
  const benchmark = read("bench/archive-io/benchmark.mjs");
  assert.match(
    benchmark,
    /unavailableCompatibilityReport\(\s*"unsupported-filesystem"/s,
  );
  assert.match(benchmark, /unavailableCompatibilityReport\(\s*"custom-acl"/s);
  assert.match(benchmark, /status: "not-available"/);
  assert.match(benchmark, /target\/trend rollups/);
});
