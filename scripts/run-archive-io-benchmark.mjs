import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCHMARK_MODULE = join(
  REPO_ROOT,
  "bench",
  "archive-io",
  "benchmark.mjs",
);

const RUNNER_EXPORTS = [
  "createArchiveBenchmarkSession",
  "createArchiveBenchmarkExecutor",
  "startArchiveBenchmarkSession",
  "startArchiveBenchmarkExecutor",
];

const RUNNER_MODULES = [
  process.env.ZINNIA_BENCH_RUNNER_MODULE,
  join(REPO_ROOT, "e2e", "helpers", "archive-benchmark.js"),
  join(REPO_ROOT, "e2e", "helpers", "benchmark-runner.js"),
].filter(Boolean);

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function gitRevision(ref) {
  if (!ref) return null;
  const result = spawnSync("git", ["rev-parse", ref], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function runCommand(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32" && /^(npm|npx)(\.cmd)?$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] || null;
}

function withoutWrapperOptions(argv) {
  const valueOptions = new Set([
    "--candidate-ref",
    "--baseline-ref",
    "--role",
    "--runner-module",
  ]);
  const flags = new Set(["--no-summary", "--skip-runner"]);
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (flags.has(arg)) continue;
    result.push(arg);
  }
  return result;
}

function reportDirectory(benchmarkOptions) {
  return resolve(
    benchmarkOptions.outputDir ||
      process.env.ZINNIA_BENCH_REPORT_DIR ||
      join(process.cwd(), "archive-io-report"),
  );
}

function reportFiles(outputDir) {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(outputDir, name));
}

function withoutBaselineReport(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--baseline-report") {
      index += 1;
      continue;
    }
    result.push(argv[index]);
  }
  return result;
}

async function runBaselineCheckout({ argv, baselineRef, outputDir }) {
  if (
    !baselineRef ||
    !envFlag("ZINNIA_BENCH_BASE_RUN") ||
    envFlag("ZINNIA_BENCH_SKIP_BASELINE")
  ) {
    return null;
  }
  const worktree = mkdtempSync(join(tmpdir(), "zinnia-archive-io-base-"));
  const baselineOutput = join(worktree, ".archive-io-baseline");
  let added = false;
  try {
    runCommand(
      "git",
      ["worktree", "add", "--detach", worktree, baselineRef],
      REPO_ROOT,
    );
    added = true;
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    runCommand(npm, ["ci", "--ignore-scripts"], worktree);
    runCommand(npm, ["run", "prepare:7z"], worktree);
    const childEnv = {
      ZINNIA_BENCH_REPORT_DIR: baselineOutput,
      ZINNIA_BENCH_CANDIDATE_REF: baselineRef,
      ZINNIA_BENCH_BASE_REF: "",
      ZINNIA_BENCH_BASELINE_REF: "",
      ZINNIA_BENCH_CANDIDATE_REVISION: gitRevision(baselineRef) || baselineRef,
      ZINNIA_BENCH_BASE_REVISION: "",
      ZINNIA_BENCH_ROLE: "baseline",
      ZINNIA_BENCH_BASE_RUN: "0",
      ZINNIA_BENCH_SKIP_BASELINE: "1",
      ZINNIA_BENCH_REQUIRE_BASELINE: "1",
      ZINNIA_BENCH_REQUIRE_CANDIDATE: "0",
      ZINNIA_BENCH_REQUIRE_ZINNIA: "0",
    };
    const childArgs = [
      "scripts/run-archive-io-benchmark.mjs",
      "--role",
      "baseline",
      ...withoutBaselineReport(withoutWrapperOptions(argv)),
    ];
    runCommand(process.execPath, childArgs, worktree, childEnv);
    const baselineJson = reportFiles(baselineOutput)[0];
    if (!baselineJson) return null;
    mkdirSync(outputDir, { recursive: true });
    const destination = join(outputDir, "archive-io-baseline.json");
    copyFileSync(baselineJson, destination);
    const baselineMarkdown = baselineJson.replace(/\.json$/i, ".md");
    if (existsSync(baselineMarkdown)) {
      copyFileSync(baselineMarkdown, join(outputDir, "archive-io-baseline.md"));
    }
    return destination;
  } catch (error) {
    console.warn(
      `Baseline archive benchmark unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    if (added) {
      try {
        runCommand(
          "git",
          ["worktree", "remove", "--force", worktree],
          REPO_ROOT,
        );
      } catch (error) {
        console.warn(
          `Baseline worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (existsSync(worktree))
      rmSync(worktree, { recursive: true, force: true });
  }
}

function addRevisionMetadata(outputDir, metadata) {
  for (const file of reportFiles(outputDir)) {
    let report;
    try {
      report = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    // Harness owns comparison fields. Add only missing top-level metadata so
    // this wrapper remains compatible with both old and new report schemas.
    if (metadata.candidateRevision && !report.candidateRevision) {
      report.candidateRevision = metadata.candidateRevision;
    }
    if (metadata.baselineRevision && !report.baseRevision) {
      report.baseRevision = metadata.baselineRevision;
    }
    if (!report.revisions) {
      report.revisions = {
        candidate: metadata.candidateRevision || null,
        baseline: metadata.baselineRevision || null,
      };
    }
    if (metadata.baselineUnavailable && !report.comparison) {
      report.comparison = {
        baselineStatus: "baseline-unavailable",
        targetStatus: "not-applicable",
        trendStatus: "baseline-unavailable",
      };
    }
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  }
}

function markdownFiles(outputDir) {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(outputDir, name));
}

function writeStepSummary(outputDir, metadata) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const blocks = markdownFiles(outputDir).map((file) =>
    readFileSync(file, "utf8"),
  );
  if (blocks.length === 0) return;
  const heading = [
    "## Archive I/O benchmark",
    "",
    `Candidate: \`${metadata.candidateRef || "working tree"}\``,
    `Baseline: \`${metadata.baselineRef || "unavailable"}\``,
    "",
  ].join("\n");
  appendFileSync(summaryPath, `${heading}${blocks.join("\n\n")}\n`);
}

async function loadRunner(explicitModule) {
  const candidates = [explicitModule, ...RUNNER_MODULES].filter(Boolean);
  for (const candidate of candidates) {
    const modulePath = isAbsolute(candidate)
      ? candidate
      : resolve(REPO_ROOT, candidate);
    if (!existsSync(modulePath)) continue;
    const module = await import(pathToFileURL(modulePath).href);
    const factoryName = RUNNER_EXPORTS.find(
      (name) => typeof module[name] === "function",
    );
    if (factoryName) return { factory: module[factoryName], modulePath };
  }
  return null;
}

function executorFromSession(session) {
  if (typeof session === "function") return session;
  for (const name of [
    "runArchiveBenchmarkOperation",
    "executeArchiveBenchmarkOperation",
    "execute",
    "run",
  ]) {
    if (typeof session?.[name] === "function")
      return session[name].bind(session);
  }
  throw new Error(
    "Archive benchmark runner must return function or session with runArchiveBenchmarkOperation(request).",
  );
}

function batchExecutorFromSession(session) {
  for (const name of ["runArchiveBenchmarkBatch", "executeBatch", "runBatch"])
    if (typeof session?.[name] === "function")
      return session[name].bind(session);
  return null;
}

async function startPersistentRunner(metadata, explicitModule) {
  if (envFlag("ZINNIA_BENCH_SKIP_RUNNER")) return null;
  const runner = await loadRunner(explicitModule);
  if (!runner) return null;
  const session = await runner.factory({
    repoRoot: REPO_ROOT,
    buildProfile: "release",
    candidateRef: metadata.candidateRef,
    baselineRef: metadata.baselineRef,
    persistent: true,
    excludeTransportTime: true,
  });
  const execute = executorFromSession(session);
  const executeBatch = batchExecutorFromSession(session);
  return {
    execute,
    executeBatch,
    async close() {
      for (const name of ["close", "stop", "dispose"]) {
        if (typeof session?.[name] === "function") {
          await session[name]();
          return;
        }
      }
    },
  };
}

function mergeExecutorOptions(options, runner) {
  if (!runner) return options;
  // New harnesses consume one of these names. Keeping both makes wrapper
  // usable during staged rollout while old harnesses ignore unknown options.
  return {
    ...options,
    zinniaExecutor: runner.execute,
    zinniaPersistentExecutor: runner.execute,
    persistentExecutor: runner.execute,
    ...(runner.executeBatch
      ? {
          zinniaBatchExecutor: runner.executeBatch,
          persistentBatchExecutor: runner.executeBatch,
        }
      : {}),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const candidateRef =
    optionValue(argv, "--candidate-ref") ||
    process.env.ZINNIA_BENCH_CANDIDATE_REF ||
    process.env.GITHUB_SHA ||
    null;
  const baselineRef =
    optionValue(argv, "--baseline-ref") ||
    process.env.ZINNIA_BENCH_BASELINE_REF ||
    process.env.ZINNIA_BENCH_BASE_REF ||
    null;
  const candidateRevision =
    process.env.ZINNIA_BENCH_CANDIDATE_REVISION ||
    gitRevision("HEAD") ||
    candidateRef;
  const baselineRevision =
    process.env.ZINNIA_BENCH_BASE_REVISION ||
    gitRevision(baselineRef) ||
    baselineRef;
  const role =
    optionValue(argv, "--role") || process.env.ZINNIA_BENCH_ROLE || "candidate";
  const explicitRunnerModule =
    optionValue(argv, "--runner-module") ||
    process.env.ZINNIA_BENCH_RUNNER_MODULE;
  const benchmark = await import(pathToFileURL(BENCHMARK_MODULE).href);
  const benchmarkArgs = withoutWrapperOptions(argv);
  const options = benchmark.parseArgs(benchmarkArgs);
  if (options.help) {
    console.log("Usage: npm run benchmark:archive-io -- [benchmark options]");
    console.log(
      "Wrapper options: --candidate-ref, --baseline-ref, --role, --baseline-report",
    );
    return;
  }
  const outputDir = reportDirectory(options);
  options.outputDir = outputDir;

  const metadata = {
    candidateRef,
    baselineRef,
    candidateRevision,
    baselineRevision,
    baselineUnavailable: Boolean(
      baselineRef && role === "candidate" && !envFlag("ZINNIA_BENCH_BASE_RUN"),
    ),
  };
  process.env.ZINNIA_BENCH_CANDIDATE_REF = candidateRef || "";
  process.env.ZINNIA_BENCH_BASELINE_REF = baselineRef || "";
  process.env.ZINNIA_BENCH_BASE_REF = baselineRef || "";
  process.env.ZINNIA_BENCH_CANDIDATE_REVISION = candidateRevision || "";
  process.env.ZINNIA_BENCH_BASE_REVISION = baselineRevision || "";
  process.env.ZINNIA_BENCH_ROLE = role;
  process.env.ZINNIA_BENCH_RUN_BASELINE = envFlag("ZINNIA_BENCH_BASE_RUN")
    ? "1"
    : "0";
  process.env.ZINNIA_BENCH_REQUIRE_CANDIDATE = role === "candidate" ? "1" : "0";
  if (role === "candidate") process.env.ZINNIA_BENCH_REQUIRE_ZINNIA = "1";
  if (argv.includes("--skip-runner"))
    process.env.ZINNIA_BENCH_SKIP_RUNNER = "1";

  const baselineReport =
    role === "candidate"
      ? await runBaselineCheckout({ argv, baselineRef, outputDir })
      : null;
  if (role === "candidate" && baselineRef && !baselineReport) {
    metadata.baselineUnavailable = true;
  }
  const runArgs = baselineReport
    ? [
        ...withoutBaselineReport(benchmarkArgs),
        "--baseline-report",
        baselineReport,
      ]
    : benchmarkArgs;
  const runOptions = benchmark.parseArgs(runArgs);
  runOptions.outputDir = outputDir;

  let runner = null;
  let failure = null;
  let report = null;
  try {
    const runnerRequired =
      role === "candidate" || envFlag("ZINNIA_BENCH_REQUIRE_BASELINE");
    if (runnerRequired && !envFlag("ZINNIA_BENCH_SKIP_RUNNER")) {
      runner = await startPersistentRunner(metadata, explicitRunnerModule);
      const runnerRequirement =
        role === "baseline"
          ? envFlag("ZINNIA_BENCH_REQUIRE_BASELINE")
          : envFlag("ZINNIA_BENCH_REQUIRE_CANDIDATE", role === "candidate");
      if (!runner && runnerRequirement) {
        if (role === "baseline") {
          throw new Error(
            "Baseline archive benchmark requires persistent release E2E runner; runner module not found.",
          );
        }
        throw new Error(
          "Candidate archive benchmark requires persistent release E2E runner; runner module not found.",
        );
      }
      if (runner) process.env.ZINNIA_BENCH_RUNNER_ACTIVE = "1";
    }
    report = await benchmark.runBenchmark(
      mergeExecutorOptions(runOptions, runner),
    );
  } catch (error) {
    failure = error;
  } finally {
    addRevisionMetadata(outputDir, metadata);
    writeStepSummary(outputDir, metadata);
    try {
      await runner?.close?.();
    } catch (error) {
      // Keep child/socket shutdown failures deterministic. If the benchmark
      // already failed, retain that primary error while still observing the
      // close rejection so Node cannot report an unhandled promise.
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return report;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
