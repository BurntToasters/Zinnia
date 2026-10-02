import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  captureWindowsProcessIdentity,
  createE2eWebdriverPortHandoff,
  reserveE2eWebdriverPort,
  classifyProcessTreeCleanup,
  terminateAndWaitForProcessTree,
  windowsProcessCleanupFailure,
  windowsProcessCleanupFailureKind,
} from "../e2e/helpers/archive-benchmark.js";
import {
  startWindowsFencedCommand,
  waitForWindowsFencedCommand,
} from "../e2e/helpers/windows-fenced-launcher.js";
import {
  REPO_ROOT,
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  updateE2eSettings,
} from "../e2e/helpers/profile.js";
export { reserveE2eWebdriverPort };

import { usesWindowsCmdShell } from "./npm-safe-update.mjs";

const EXTRACT_WINDOW_AUTO_CLOSE_SECONDS = 10;

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function e2eChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Cursor/CI helper envs must not redirect the e2e binary away from
  // src-tauri/target/debug, where the stamp and WDIO launcher look.
  delete env.CARGO_TARGET_DIR;
  return env;
}

const E2E_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const E2E_SUITE_TIMEOUT_MS =
  process.platform === "win32" ? 20 * 60 * 1000 : 15 * 60 * 1000;
const E2E_STAMP_VERSION = "e2e-feature-10";
const E2E_INPUT_PATHS = [
  "src",
  "public",
  "assets",
  "src-tauri",
  "e2e",
  "scripts",
  ".env",
  ".env.local",
  ".env.e2e",
  ".env.e2e.local",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "rust-toolchain.toml",
];
const E2E_BUILD_INPUT_PATHS = E2E_INPUT_PATHS.filter(
  (input) => input !== "e2e" && input !== "scripts",
);
const IGNORED_INPUT_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "coverage",
  "release",
  "build",
  "build-ci",
  "out",
]);
const IGNORED_INPUT_PATHS = new Set(["src-tauri/binaries"]);
// Keep in sync with the E2E proof validators in .github/workflows/ci.yml.
const ACCEPTED_CLEANUP_STATUSES = ["verified", "build-unproven", "capture-gap"];

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function e2eWrapperTimeoutMs(
  env = process.env,
  platform = process.platform,
) {
  const suiteTimeoutFallback =
    platform === "win32" ? 20 * 60 * 1000 : 15 * 60 * 1000;
  return (
    2 * positiveTimeout(env.ZINNIA_E2E_BUILD_TIMEOUT_MS, E2E_BUILD_TIMEOUT_MS) +
    2 * positiveTimeout(env.ZINNIA_E2E_SUITE_TIMEOUT_MS, suiteTimeoutFallback) +
    60_000
  );
}

function fileSha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileSha256OrNull(file) {
  try {
    return fileSha256(file);
  } catch {
    return null;
  }
}

function e2eBuildEnvironmentSha256(env = process.env) {
  const entries = Object.entries(env)
    .filter(([name]) => name !== "CARGO_TARGET_DIR")
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify([process.platform, process.arch, entries]))
    .digest("hex");
}

function e2eSourceRecords(root = REPO_ROOT, inputPaths = E2E_INPUT_PATHS) {
  const records = [];
  const walk = (relativePath) => {
    const absolute = path.join(root, relativePath);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      records.push(["missing", relativePath]);
      return;
    }
    if (stat.isDirectory()) {
      records.push(["directory", relativePath]);
      const entries = fs.readdirSync(absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const childPath = path.join(relativePath, entry.name);
        if (
          entry.isDirectory() &&
          (IGNORED_INPUT_DIRECTORIES.has(entry.name) ||
            IGNORED_INPUT_PATHS.has(childPath))
        ) {
          continue;
        }
        walk(childPath);
      }
    } else if (stat.isSymbolicLink()) {
      records.push(["link", relativePath, fs.readlinkSync(absolute)]);
    } else if (stat.isFile()) {
      const contents = fs.readFileSync(absolute);
      records.push([
        "file",
        relativePath,
        contents.byteLength,
        createHash("sha256").update(contents).digest("hex"),
      ]);
    }
  };
  for (const relativePath of inputPaths) walk(relativePath);
  return records;
}

function digestRecords(records) {
  const hash = createHash("sha256");
  for (const record of records) {
    const encoded = Buffer.from(JSON.stringify(record));
    hash.update(`${encoded.byteLength}:`);
    hash.update(encoded);
  }
  return hash.digest("hex");
}

export function e2eSourceSha256(
  root = REPO_ROOT,
  inputPaths = E2E_INPUT_PATHS,
) {
  return digestRecords(e2eSourceRecords(root, inputPaths));
}

export function e2eBuildInputSnapshot(root = REPO_ROOT) {
  const records = e2eSourceRecords(root, E2E_BUILD_INPUT_PATHS);
  return Object.fromEntries(
    records.map((record) => [
      record[1],
      createHash("sha256").update(JSON.stringify(record)).digest("hex"),
    ]),
  );
}

function e2eBuildInputSha256(snapshot) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
}

export function writeE2eStamp({
  root = REPO_ROOT,
  binary = e2eBinaryPath(root),
  stamp = e2eStampPath(root),
  env = process.env,
  buildInputSnapshot = e2eBuildInputSnapshot(root),
} = {}) {
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(
    stamp,
    `${JSON.stringify({
      version: E2E_STAMP_VERSION,
      binarySha256: fileSha256(binary),
      sourceSha256: e2eSourceSha256(root),
      buildInputSha256: e2eBuildInputSha256(buildInputSnapshot),
      buildEnvironmentSha256: e2eBuildEnvironmentSha256(env),
      externalBinaries: e2eExternalBinaryHashes(root),
    })}\n`,
  );
}

export function isE2eBinaryFresh({
  root = REPO_ROOT,
  binary = e2eBinaryPath(root),
  stamp = e2eStampPath(root),
  env = process.env,
} = {}) {
  if (!fs.existsSync(binary) || !fs.existsSync(stamp)) return false;
  try {
    const proof = JSON.parse(fs.readFileSync(stamp, "utf8"));
    return (
      proof.version === E2E_STAMP_VERSION &&
      proof.binarySha256 === fileSha256(binary) &&
      proof.sourceSha256 === e2eSourceSha256(root) &&
      proof.buildInputSha256 ===
        e2eBuildInputSha256(e2eBuildInputSnapshot(root)) &&
      proof.buildEnvironmentSha256 === e2eBuildEnvironmentSha256(env) &&
      JSON.stringify(proof.externalBinaries) ===
        JSON.stringify(e2eExternalBinaryHashes(root))
    );
  } catch {
    return false;
  }
}

export async function runBoundedCommand(command, args, options = {}) {
  const timeoutMs = positiveTimeout(options.timeoutMs, E2E_SUITE_TIMEOUT_MS);
  const logFile = options.logFile;
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = logFile ? fs.openSync(logFile, "w") : null;
  const commandCwd = options.cwd ?? REPO_ROOT;
  const commandEnv = e2eChildEnv(options.env);
  const commandStdio = logFd === null ? "inherit" : ["ignore", "pipe", "pipe"];
  let fencedLaunch = null;
  let child;
  try {
    if (process.platform === "win32") {
      fencedLaunch = await startWindowsFencedCommand(command, args, {
        cwd: commandCwd,
        env: commandEnv,
        stdio: commandStdio,
        shell: usesWindowsCmdShell(command),
        startupTimeoutMs: Math.min(timeoutMs, 20_000),
      });
      child = fencedLaunch.child;
    } else {
      child = spawn(command, args, {
        cwd: commandCwd,
        env: commandEnv,
        stdio: commandStdio,
        windowsHide: true,
        shell: usesWindowsCmdShell(command),
        detached: true,
      });
    }
  } catch (error) {
    if (logFd !== null) fs.closeSync(logFd);
    throw error;
  }
  const processPlatform = options.processPlatform ?? process.platform;
  const windowsProcessOptions = options.windowsProcessOptions ?? {};
  const identityCapture = captureWindowsProcessIdentity(child, {
    ...windowsProcessOptions,
    platform: processPlatform,
    waitForSpawn: true,
  });
  if (logFd !== null) {
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        output.write(chunk);
        fs.writeSync(logFd, chunk);
      });
    }
  }
  const childExit = fencedLaunch
    ? waitForWindowsFencedCommand(fencedLaunch, `${command} ${args.join(" ")}`)
    : new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        child.once("error", finish);
        child.once("close", (code, signal) =>
          finish(
            code === 0
              ? null
              : new Error(
                  `${command} ${args.join(" ")} exited with ${code ?? signal}`,
                ),
          ),
        );
      });
  childExit.catch(() => {});
  let timer;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  let commandError = null;
  let launchReleased = false;
  try {
    if (fencedLaunch) {
      const identity = await Promise.race([identityCapture, deadline]);
      if (!identity || identity.pid !== child.pid) {
        throw new Error(
          `${command} Windows launch fence could not capture its exact leader identity.`,
        );
      }
      await fencedLaunch.release();
      launchReleased = true;
    }
    await Promise.race([childExit, deadline]);
  } catch (error) {
    commandError = error;
  } finally {
    clearTimeout(timer);
  }

  if (fencedLaunch && !launchReleased) {
    await fencedLaunch.abort().catch(() => {});
  }
  let processTreeCleanup = { status: "verified" };
  let cleanupVerified = true;
  if (child.pid) {
    const stopped = await terminateAndWaitForProcessTree(child, {
      ...windowsProcessOptions,
      ...options.processTreeCleanupOptions,
      platform: processPlatform,
    });
    if (!stopped) {
      cleanupVerified = false;
      const detail = windowsProcessCleanupFailure(child);
      const reason =
        detail ??
        "leader identity or descendant ownership could not be proven safely";
      // A successful command whose seen processes all exited may still have
      // had a short-lived helper slip between scans (capture-gap). Build steps
      // may also leave toolchain helpers (build-unproven). Both are recorded
      // and warned. Failed commands and surviving session processes stay strict.
      const status = classifyProcessTreeCleanup({
        stopped: false,
        kind: windowsProcessCleanupFailureKind(child),
        commandFailed: Boolean(commandError),
        allowBuildCleanupWarning: options.allowBuildCleanupWarning,
      });
      processTreeCleanup = { status, reason };
      if (status !== "unproven") {
        console.warn(
          `Warning: ${command} succeeded but its process tree cleanup could not be verified (${reason}). Continuing.`,
        );
      }
    }
    if (processTreeCleanup.status === "unproven") {
      const cleanupFailure = new Error(
        `${command} process tree cleanup could not be verified: ${processTreeCleanup.reason}`,
        { cause: commandError },
      );
      commandError = commandError
        ? new AggregateError(
            [commandError, cleanupFailure],
            cleanupFailure.message,
          )
        : cleanupFailure;
    }
    options.onProcessTreeCleanup?.({
      command: path.basename(command),
      ...processTreeCleanup,
    });
  }
  if (timedOut) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    let settleTimer;
    if (cleanupVerified) {
      try {
        await Promise.race([
          childExit.catch(() => {}),
          new Promise((resolve) => {
            settleTimer = setTimeout(resolve, 10_000);
          }),
        ]);
      } finally {
        clearTimeout(settleTimer);
      }
    }
  }
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch (error) {
      commandError ??= error;
    }
  }
  if (fencedLaunch) {
    try {
      await fencedLaunch.dispose();
    } catch (error) {
      commandError ??= error;
    }
  }
  if (commandError) throw commandError;
  return { processTreeCleanup };
}

function which(bin) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [bin],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0;
}

function needsXvfb() {
  return (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  );
}

async function reexecUnderXvfb() {
  if (process.env.ZINNIA_E2E_XVFB === "1") return false;
  if (!needsXvfb()) return false;
  if (!which("xvfb-run")) {
    throw new Error(
      "Linux E2E needs a display. Install xvfb with `sudo apt install -y xvfb` (also in npm run setup:deb), or set DISPLAY.",
    );
  }
  await runBoundedCommand(
    "xvfb-run",
    [
      "-a",
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ZINNIA_E2E_XVFB: "1" },
      timeoutMs: e2eWrapperTimeoutMs(),
    },
  );
  return true;
}

function snapshotGeneratedSchemas() {
  const schemaDir = path.join(REPO_ROOT, "src-tauri", "gen", "schemas");
  return fs
    .readdirSync(schemaDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(schemaDir, entry.name);
      return [file, fs.readFileSync(file)];
    });
}

function restoreGeneratedSchemas(snapshots) {
  for (const [file, contents] of snapshots) {
    fs.writeFileSync(file, contents);
  }
}

async function buildE2eBinary(reportDir, processCleanup) {
  await runBoundedCommand(npmCommand(), ["run", "prepare:7z"], {
    timeoutMs: positiveTimeout(
      process.env.ZINNIA_E2E_BUILD_TIMEOUT_MS,
      E2E_BUILD_TIMEOUT_MS,
    ),
    logFile: path.join(reportDir, "prepare-7z.log"),
    onProcessTreeCleanup: (record) => processCleanup.push(record),
    allowBuildCleanupWarning: true,
  });
  const schemaSnapshots = snapshotGeneratedSchemas();
  const binary = e2eBinaryPath();
  fs.rmSync(binary, { force: true });
  fs.rmSync(e2eStampPath(), { force: true });
  const sourceAtBuildStart = e2eBuildInputSnapshot();
  try {
    await runBoundedCommand(
      npxCommand(),
      [
        "tauri",
        "build",
        "--debug",
        "--no-bundle",
        "--config",
        path.join(REPO_ROOT, "src-tauri", "tauri.e2e.conf.json"),
        "--",
        "--features",
        "e2e",
      ],
      {
        timeoutMs: positiveTimeout(
          process.env.ZINNIA_E2E_BUILD_TIMEOUT_MS,
          E2E_BUILD_TIMEOUT_MS,
        ),
        logFile: path.join(reportDir, "build.log"),
        onProcessTreeCleanup: (record) => processCleanup.push(record),
        allowBuildCleanupWarning: true,
      },
    );
  } finally {
    // Tauri writes feature-dependent ACL schemas into this tracked directory.
    // An E2E build must not dirty a clean release checkout with test-only ACLs.
    restoreGeneratedSchemas(schemaSnapshots);
  }
  if (!fs.existsSync(binary)) {
    throw new Error(`E2E binary missing after build: ${binary}`);
  }
  const sourceAfterBuild = e2eBuildInputSnapshot();
  const changedInputs = [
    ...new Set([
      ...Object.keys(sourceAtBuildStart),
      ...Object.keys(sourceAfterBuild),
    ]),
  ].filter((input) => sourceAtBuildStart[input] !== sourceAfterBuild[input]);
  if (changedInputs.length > 0) {
    throw new Error(
      `E2E app inputs changed during build (${changedInputs.join(", ")}); rerun the suite.`,
    );
  }
  writeE2eStamp({ buildInputSnapshot: sourceAfterBuild });
}

async function runWdio(
  profile,
  spec,
  appArgs,
  reportDir,
  envOverrides = {},
  webdriverReservation,
  processCleanup,
) {
  const env = {
    ...process.env,
    ...profile.env,
    ZINNIA_E2E: "1",
    ZINNIA_E2E_BINARY: e2eBinaryPath(),
    ZINNIA_E2E_APP_ARGS: JSON.stringify(appArgs),
    ZINNIA_E2E_SPECS: spec,
    ZINNIA_E2E_WORK: profile.work,
    ZINNIA_E2E_HELLO_TXT: profile.copies["hello.txt"],
    ZINNIA_E2E_HELLO_7Z: profile.copies["hello.7z"],
    ZINNIA_E2E_HELLO_ZIP: profile.copies["hello.zip"],
    ZINNIA_E2E_NESTED_ZIP: profile.copies["nested.zip"],
    ZINNIA_E2E_ENCRYPTED_7Z: profile.copies["encrypted.7z"],
    ZINNIA_E2E_EXTRACT_OUT: profile.copies.extractOut,
    ZINNIA_E2E_EXTRACT_OUT_ZIP: profile.copies.extractOutZip,
    ZINNIA_E2E_EXTRACT_OUT_NESTED: profile.copies.extractOutNested,
    ZINNIA_E2E_EXTRACT_OUT_ENCRYPTED: profile.copies.extractOutEncrypted,
    ZINNIA_E2E_COMPRESS_OUT: profile.copies.compressOut,
    ZINNIA_E2E_PAYLOAD: profile.manifest.payloadText,
    ZINNIA_E2E_PASSWORD: profile.manifest.password,
    ...envOverrides,
  };
  if (spec.includes("extract-window")) {
    env.ZINNIA_E2E_WINDOW_LABEL = "extract-0";
  }
  const logFile = path.join(
    reportDir,
    spec.includes("extract-window") ? "extract-window.log" : "main.log",
  );
  let handoff;
  try {
    handoff = await createE2eWebdriverPortHandoff({
      binary: e2eBinaryPath(),
      args: appArgs,
      directory: profile.work,
      reservation: webdriverReservation,
    });
    env.ZINNIA_E2E_BINARY = handoff.binary;
    env.ZINNIA_E2E_APP_ARGS = JSON.stringify(handoff.args);
    Object.assign(env, handoff.env);
    await runBoundedCommand(npxCommand(), ["wdio", "run", "e2e/wdio.conf.js"], {
      env,
      timeoutMs: positiveTimeout(
        process.env.ZINNIA_E2E_SUITE_TIMEOUT_MS,
        E2E_SUITE_TIMEOUT_MS,
      ),
      logFile,
      onProcessTreeCleanup: (record) => processCleanup.push(record),
    });
    const log = fs.readFileSync(logFile, "utf8");
    if (
      /Failed to bind WebDriver server to .*port may already be in use/i.test(
        log,
      )
    ) {
      throw new Error(
        "E2E WebDriver port was claimed before the app bound it; refusing a session on an unrelated driver.",
      );
    }
  } finally {
    if (handoff) await handoff.release();
    else await webdriverReservation?.release();
  }
  return logFile;
}

function currentCommit(root) {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256Files(files) {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, file]) => [name, fileSha256OrNull(file)]),
  );
}

function e2eExternalBinaryHashes(root = REPO_ROOT) {
  const directory = path.join(root, "src-tauri", "binaries");
  if (!fs.existsSync(directory)) return {};
  const files = Object.fromEntries(
    fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => [entry.name, path.join(directory, entry.name)]),
  );
  return sha256Files(files);
}

function defaultFixtureFiles(fixtureManifest) {
  const fixtureDir = path.dirname(fixtureManifest);
  if (!fs.existsSync(fixtureDir)) return {};
  return Object.fromEntries(
    fs
      .readdirSync(fixtureDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          path.resolve(fixtureDir, entry.name) !==
            path.resolve(fixtureManifest),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => [entry.name, path.join(fixtureDir, entry.name)]),
  );
}

export function captureE2eEvidence({
  root = REPO_ROOT,
  binary = e2eBinaryPath(root),
  fixtureManifest = path.join(root, "zips", "manifest.json"),
  fixtureFiles = defaultFixtureFiles(fixtureManifest),
  commit = currentCommit(root),
  env = process.env,
} = {}) {
  return {
    commit,
    sourceSha256: e2eSourceSha256(root),
    buildEnvironmentSha256: e2eBuildEnvironmentSha256(env),
    binarySha256: fileSha256OrNull(binary),
    externalBinaries: e2eExternalBinaryHashes(root),
    fixtureManifestSha256: fileSha256OrNull(fixtureManifest),
    fixtureFiles: sha256Files(fixtureFiles),
  };
}

export function writeE2eArtifact({
  reportDir,
  root = REPO_ROOT,
  binary = e2eBinaryPath(root),
  fixtureManifest = path.join(root, "zips", "manifest.json"),
  commit = currentCommit(root),
  fixtureFiles = defaultFixtureFiles(fixtureManifest),
  env = process.env,
  evidence = captureE2eEvidence({
    root,
    binary,
    fixtureManifest,
    fixtureFiles,
    commit,
    env,
  }),
  status,
  suites = [],
  failure = null,
  processCleanup = [],
  platform = process.platform,
}) {
  fs.mkdirSync(reportDir, { recursive: true });
  const current = captureE2eEvidence({
    root,
    binary,
    fixtureManifest,
    fixtureFiles,
    env,
  });
  const observedCommit = currentCommit(root);
  const commitUnchanged =
    observedCommit !== null && observedCommit === evidence.commit;
  const inputsUnchanged =
    commitUnchanged &&
    evidence.commit === commit &&
    evidence.sourceSha256 === current.sourceSha256 &&
    evidence.buildEnvironmentSha256 === current.buildEnvironmentSha256 &&
    evidence.binarySha256 !== null &&
    evidence.binarySha256 === current.binarySha256 &&
    JSON.stringify(evidence.externalBinaries) ===
      JSON.stringify(current.externalBinaries) &&
    evidence.fixtureManifestSha256 !== null &&
    evidence.fixtureManifestSha256 === current.fixtureManifestSha256 &&
    Object.keys(evidence.fixtureFiles ?? {}).length > 0 &&
    JSON.stringify(evidence.fixtureFiles) ===
      JSON.stringify(current.fixtureFiles);
  const missingRequiredEvidence =
    !/^[0-9a-f]{40}$/i.test(evidence.commit ?? "") ||
    !/^[0-9a-f]{64}$/.test(evidence.sourceSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(evidence.buildEnvironmentSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(evidence.binarySha256 ?? "") ||
    Object.keys(evidence.externalBinaries ?? {}).length === 0 ||
    Object.values(evidence.externalBinaries ?? {}).some(
      (digest) => !/^[0-9a-f]{64}$/.test(digest ?? ""),
    ) ||
    !/^[0-9a-f]{64}$/.test(evidence.fixtureManifestSha256 ?? "") ||
    Object.keys(evidence.fixtureFiles ?? {}).length === 0 ||
    Object.values(evidence.fixtureFiles ?? {}).some(
      (digest) => !/^[0-9a-f]{64}$/.test(digest ?? ""),
    );
  const recordedSuites = suites.map((suite) => {
    const relativeLog = path.relative(reportDir, suite.logFile);
    if (relativeLog.startsWith("..") || path.isAbsolute(relativeLog)) {
      throw new Error("E2E suite log must be inside report directory.");
    }
    const logSha256 = fileSha256OrNull(suite.logFile);
    return {
      spec: suite.spec,
      status: suite.status,
      logFile: relativeLog.replaceAll("\\", "/"),
      logSha256,
    };
  });
  const suiteProofComplete =
    recordedSuites.length > 0 &&
    recordedSuites.every(
      (suite) =>
        suite.status === "passed" &&
        /^[0-9a-f]{64}$/.test(suite.logSha256 ?? ""),
    );
  const processCleanupStatus =
    processCleanup.length === 0
      ? "not-recorded"
      : processCleanup.every((record) => record.status === "verified")
        ? "verified"
        : processCleanup.every((record) =>
              ACCEPTED_CLEANUP_STATUSES.includes(record.status),
            )
          ? processCleanup.some((record) => record.status === "capture-gap")
            ? "capture-gap"
            : "build-unproven"
          : "unproven";
  const windowsCleanupUnproven =
    platform === "win32" &&
    !ACCEPTED_CLEANUP_STATUSES.includes(processCleanupStatus);
  const finalStatus =
    status === "passed" &&
    (!inputsUnchanged ||
      missingRequiredEvidence ||
      !suiteProofComplete ||
      windowsCleanupUnproven)
      ? "failed"
      : status;
  const finalFailure =
    finalStatus === "failed" && status === "passed"
      ? windowsCleanupUnproven
        ? "Windows E2E process cleanup was not verified."
        : `E2E evidence ${missingRequiredEvidence || !suiteProofComplete ? "is incomplete" : "changed during run"}.`
      : failure;
  const artifact = {
    schemaVersion: 1,
    status: finalStatus,
    commit: evidence.commit,
    sourceSha256: evidence.sourceSha256,
    buildEnvironmentSha256: evidence.buildEnvironmentSha256,
    binary: { sha256: evidence.binarySha256 },
    externalBinaries: evidence.externalBinaries,
    fixtures: {
      manifestSha256: evidence.fixtureManifestSha256,
      files: evidence.fixtureFiles,
    },
    verification: { inputsUnchanged },
    processCleanup: {
      status: processCleanupStatus,
      commands: processCleanup,
    },
    platform,
    arch: process.arch,
    nodeVersion: process.version,
    suites: recordedSuites,
    replay: { command: "npm run test:e2e" },
    ...(finalFailure ? { failure: finalFailure } : {}),
  };
  fs.writeFileSync(
    path.join(reportDir, "result.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return artifact;
}

function cleanupE2eProfile(profileDir) {
  try {
    fs.rmSync(profileDir, {
      recursive: true,
      force: true,
      // WebView2 can retain file handles briefly after a clean application
      // exit. Its retries use linear backoff, giving Windows up to 21 seconds.
      maxRetries: process.platform === "win32" ? 20 : 8,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(
      `WARNING: Could not remove temporary E2E profile ${profileDir}; leaving it for OS cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main() {
  if (process.env.SKIP_E2E === "1") {
    throw new Error(
      "SKIP_E2E=1 is not allowed. Unset it and run the unpackaged WebdriverIO suite.",
    );
  }
  if (await reexecUnderXvfb()) return;
  const reportDir = path.resolve(
    process.env.ZINNIA_E2E_REPORT_DIR ||
      path.join(REPO_ROOT, "coverage", "e2e"),
  );
  fs.mkdirSync(reportDir, { recursive: true });
  for (const name of [
    "result.json",
    "main.log",
    "extract-window.log",
    "build.log",
    "prepare-7z.log",
  ]) {
    fs.rmSync(path.join(reportDir, name), { force: true });
  }
  const suites = [];
  const processCleanup = [];
  let profile = null;
  let fixtureFiles = null;
  let evidence = null;
  const fixtureManifest = path.join(REPO_ROOT, "zips", "manifest.json");
  let status = "failed";
  let failure = null;
  let runError = null;
  try {
    if (!isE2eBinaryFresh() || process.env.ZINNIA_E2E_REBUILD === "1") {
      await buildE2eBinary(reportDir, processCleanup);
    }
    const manifestAtProfileStart = fileSha256(fixtureManifest);
    profile = createE2eProfile();
    if (fileSha256OrNull(fixtureManifest) !== manifestAtProfileStart) {
      throw new Error(
        "E2E fixture manifest changed while creating the profile.",
      );
    }
    if (!isE2eBinaryFresh()) {
      throw new Error("E2E app source or binary changed before suite startup.");
    }
    const extractWindowDir = path.join(profile.work, "extract-window-case");
    fs.mkdirSync(extractWindowDir, { recursive: true });
    const extractWindowArchive = path.join(extractWindowDir, "hello.7z");
    fs.copyFileSync(profile.copies["hello.7z"], extractWindowArchive);
    const fixtureNames = [
      profile.manifest.payloadFile,
      "hello.7z",
      "hello.zip",
      "nested.zip",
      "encrypted.7z",
    ];
    fixtureFiles = Object.fromEntries(
      fixtureNames.map((name) => [name, profile.copies[name]]),
    );
    fixtureFiles["extract-window/hello.7z"] = extractWindowArchive;
    evidence = captureE2eEvidence({
      fixtureFiles,
    });
    if (evidence.fixtureManifestSha256 !== manifestAtProfileStart) {
      throw new Error("E2E fixture manifest changed before suite startup.");
    }
    const mainWebdriver = await reserveE2eWebdriverPort();
    const mainSuite = {
      spec: "./specs/main.spec.js",
      status: "failed",
      logFile: path.join(reportDir, "main.log"),
    };
    suites.push(mainSuite);
    await runWdio(
      profile,
      mainSuite.spec,
      [],
      reportDir,
      {
        TAURI_WEBDRIVER_PORT: String(mainWebdriver.port),
      },
      mainWebdriver,
      processCleanup,
    );
    mainSuite.status = "passed";
    updateE2eSettings(profile.profileDir, {
      extractAutoCloseSeconds: EXTRACT_WINDOW_AUTO_CLOSE_SECONDS,
    });
    const extractWebdriver = await reserveE2eWebdriverPort();
    const extractSuite = {
      spec: "./specs/extract-window.spec.js",
      status: "failed",
      logFile: path.join(reportDir, "extract-window.log"),
    };
    suites.push(extractSuite);
    await runWdio(
      profile,
      extractSuite.spec,
      ["--extract", extractWindowArchive],
      reportDir,
      {
        ZINNIA_E2E_HELLO_7Z: extractWindowArchive,
        ZINNIA_E2E_AUTO_CLOSE_SECONDS: String(
          EXTRACT_WINDOW_AUTO_CLOSE_SECONDS,
        ),
        TAURI_WEBDRIVER_PORT: String(extractWebdriver.port),
      },
      extractWebdriver,
      processCleanup,
    );
    extractSuite.status = "passed";
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    runError = error;
  } finally {
    let artifact = null;
    try {
      artifact = writeE2eArtifact({
        reportDir,
        fixtureManifest,
        ...(fixtureFiles ? { fixtureFiles } : {}),
        ...(evidence ? { evidence } : {}),
        status,
        suites,
        failure,
        processCleanup,
      });
      console.log(
        `E2E result artifact: ${path.join(reportDir, "result.json")} (${artifact.status})`,
      );
      if (status === "passed" && artifact.status !== "passed") {
        runError = new Error(
          `E2E suites passed, but ${artifact.failure ?? "evidence verification failed"}`,
        );
      }
    } catch (error) {
      runError = runError
        ? new AggregateError(
            [runError, error],
            "E2E execution and proof artifact generation both failed.",
          )
        : error;
    } finally {
      if (profile) cleanupE2eProfile(profile.profileDir);
    }
  }
  if (runError) throw runError;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
