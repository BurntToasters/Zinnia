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
import { spawn, spawnSync } from "node:child_process";
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

const DEFAULT_BENCH_RUN_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_BENCH_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_BENCH_ABORT_SETTLE_TIMEOUT_MS = 30 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function benchmarkRunTimeoutMs(env = process.env) {
  return positiveInteger(
    env.ZINNIA_BENCH_RUN_TIMEOUT_MS,
    DEFAULT_BENCH_RUN_TIMEOUT_MS,
  );
}

function benchmarkCommandTimeoutMs(env = process.env) {
  return positiveInteger(
    env.ZINNIA_BENCH_COMMAND_TIMEOUT_MS,
    DEFAULT_BENCH_COMMAND_TIMEOUT_MS,
  );
}

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

function waitForCommandExit(child, command, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onError = (error) => settle(() => reject(error));
    const onExit = (code, signal) =>
      settle(() => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `${command} ${args.join(" ")} exited with ${code ?? signal}`,
            ),
          );
      });
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForCommandProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateCommandProcessTree(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 10_000 },
    );
    if (result.status !== 0) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    return waitForCommandProcessExit(child, 10_000);
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
  await waitForCommandProcessExit(child, 1_000);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  return waitForCommandProcessExit(child, 10_000);
}

async function runCommand(command, args, cwd, env = {}, timeoutMs) {
  const mergedEnv = { ...process.env, ...env };
  const commandTimeoutMs = timeoutMs ?? benchmarkCommandTimeoutMs(mergedEnv);
  const child = spawn(command, args, {
    cwd,
    env: mergedEnv,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32" && /^(npm|npx)(\.cmd)?$/i.test(command),
    detached: process.platform !== "win32",
  });
  const childExit = waitForCommandExit(child, command, args);
  childExit.catch(() => {});
  let timeout;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `${command} ${args.join(" ")} timed out after ${commandTimeoutMs}ms`,
        ),
      );
    }, commandTimeoutMs);
  });
  try {
    await Promise.race([childExit, deadline]);
  } catch (error) {
    if (!timedOut) throw error;
    if (!(await terminateCommandProcessTree(child))) {
      throw new Error(`${command} process tree did not stop after timeout.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
    await runCommand(
      "git",
      ["worktree", "add", "--detach", worktree, baselineRef],
      REPO_ROOT,
    );
    added = true;
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await runCommand(npm, ["ci", "--ignore-scripts"], worktree);
    if (process.platform === "win32") {
      await runCommand(npm, ["run", "prepare:win-shell-stubs"], worktree);
    }
    await runCommand(npm, ["run", "prepare:7z"], worktree);
    const baselineRunTimeoutMs = Math.floor(benchmarkRunTimeoutMs() / 2);
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
      ZINNIA_BENCH_RUN_TIMEOUT_MS: String(baselineRunTimeoutMs),
      RUSTUP_TOOLCHAIN: process.env.RUST_VERSION || "1.98.1",
    };
    const childArgs = [
      "scripts/run-archive-io-benchmark.mjs",
      "--role",
      "baseline",
      ...withoutBaselineReport(withoutWrapperOptions(argv)),
    ];
    await runCommand(
      process.execPath,
      childArgs,
      worktree,
      childEnv,
      baselineRunTimeoutMs + 60_000,
    );
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
        await runCommand(
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

function withTimeout(
  promise,
  timeoutMs,
  onTimeout,
  settleTimeoutMs = DEFAULT_BENCH_ABORT_SETTLE_TIMEOUT_MS,
) {
  const operation = Promise.resolve(promise);
  operation.catch(() => {});
  let timeout;
  let settleTimeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(async () => {
      const error = new Error(
        `Archive benchmark exceeded its ${timeoutMs}ms run timeout.`,
      );
      let cleanupError;
      try {
        await onTimeout?.(error);
      } catch (failure) {
        cleanupError = failure;
      }
      const operationSettled = await Promise.race([
        operation.then(
          () => true,
          () => true,
        ),
        new Promise((resolve) => {
          settleTimeout = setTimeout(() => resolve(false), settleTimeoutMs);
        }),
      ]);
      clearTimeout(settleTimeout);
      if (!operationSettled) {
        reject(
          new Error(
            `${error.message} Cancellation did not settle underlying benchmark within ${settleTimeoutMs}ms.`,
            { cause: error },
          ),
        );
      } else if (cleanupError) {
        reject(
          new Error(
            `${error.message} Runner cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            { cause: cleanupError },
          ),
        );
      } else {
        reject(error);
      }
    }, timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    clearTimeout(timeout);
    clearTimeout(settleTimeout);
  });
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

async function startPersistentRunner(metadata, explicitModule, signal) {
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
    signal,
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
    abort: session?.abort?.bind(session),
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
  if (
    role === "candidate" &&
    envFlag("ZINNIA_BENCH_REQUIRE_BASELINE_REPORT") &&
    !baselineReport
  ) {
    throw new Error(
      "Required baseline archive benchmark report is unavailable.",
    );
  }
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
  const abortController = new AbortController();
  try {
    const timeoutMs = benchmarkRunTimeoutMs();
    const benchmarkExecution = (async () => {
      const runnerRequired =
        role === "candidate" || envFlag("ZINNIA_BENCH_REQUIRE_BASELINE");
      if (runnerRequired && !envFlag("ZINNIA_BENCH_SKIP_RUNNER")) {
        runner = await startPersistentRunner(
          metadata,
          explicitRunnerModule,
          abortController.signal,
        );
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
      return benchmark.runBenchmark(mergeExecutorOptions(runOptions, runner));
    })();
    report = await withTimeout(benchmarkExecution, timeoutMs, async () => {
      abortController.abort();
      await runner?.abort?.();
    });
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
