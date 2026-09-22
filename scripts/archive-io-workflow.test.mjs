import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(ROOT, file), "utf8");

test("PR and push archive benchmark keeps x64 smoke matrix", () => {
  const workflow = read(".github/workflows/ci.yml");
  const benchmarkJob = workflow.slice(
    workflow.indexOf("  archive-io-benchmark:"),
    workflow.indexOf(
      "\n  rust-check:",
      workflow.indexOf("  archive-io-benchmark:"),
    ),
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
});

test("archive benchmark checkout ref agrees with candidate metadata", () => {
  const workflow = read(".github/workflows/ci.yml");
  const benchmarkStart = workflow.indexOf("  archive-io-benchmark:");
  const benchmarkJob = workflow.slice(
    benchmarkStart,
    workflow.indexOf("\n  rust-check:", benchmarkStart),
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
  assert.match(runner, /tauri/);
  assert.match(runner, /--features/);
  assert.match(runner, /"target",\s+"release"/);
  assert.match(runner, /ZINNIA_BENCH_SOCKET_PORT/);
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
  const benchmarkJob = workflow.slice(
    workflow.indexOf("  archive-io-benchmark:"),
    workflow.indexOf(
      "\n  rust-check:",
      workflow.indexOf("  archive-io-benchmark:"),
    ),
  );
  assert.match(benchmarkJob, /ZINNIA_BENCH_BASE_RUN:\s*["']?1["']?/);
  assert.match(benchmarkJob, /ZINNIA_BENCH_BASELINE_REF/);
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
