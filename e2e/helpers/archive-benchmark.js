import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  startWindowsFencedCommand,
  waitForWindowsFencedCommand,
} from "./windows-fenced-launcher.js";
import { createE2eProfile, REPO_ROOT } from "./profile.js";

const E2E_CONFIG = path.join(REPO_ROOT, "src-tauri", "tauri.e2e.conf.json");
const VENDORED_UPDATER_DIR = path.join(
  REPO_ROOT,
  "src-tauri",
  "vendor",
  "tauri-plugin-updater",
);
export const ARCHIVE_BENCHMARK_E2E_STAMP_VERSION = "archive-io-e2e-v2";
const DEFAULT_ARCHIVE_BENCHMARK_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS = 10_000;
const WINDOWS_PROCESS_QUIET_ROUNDS = 3;
const WINDOWS_PROCESS_SCAN_DELAY_MS = 50;
const WINDOWS_PROCESS_CAPTURE_INTERVAL_MS = 50;
const windowsProcessStates = new WeakMap();

function positiveProcessTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function hostBinaryName() {
  return process.platform === "win32" ? "zinnia.exe" : "zinnia";
}

function releaseBinaryPath() {
  return path.join(
    REPO_ROOT,
    "src-tauri",
    "target",
    "release",
    hostBinaryName(),
  );
}

function releaseE2eStampPath() {
  return path.join(
    REPO_ROOT,
    "src-tauri",
    "target",
    "release",
    ".zinnia-archive-io-e2e.json",
  );
}

const E2E_FRESHNESS_PATHS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "public"),
  path.join(REPO_ROOT, "assets"),
  path.join(REPO_ROOT, "vite.config.ts"),
  path.join(REPO_ROOT, "tsconfig.json"),
  path.join(REPO_ROOT, "rust-toolchain.toml"),
  path.join(REPO_ROOT, "src-tauri", "src"),
  path.join(REPO_ROOT, "src-tauri", "build.rs"),
  path.join(REPO_ROOT, "src-tauri", "Cargo.toml"),
  path.join(REPO_ROOT, "src-tauri", "Cargo.lock"),
  path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"),
  E2E_CONFIG,
  path.join(REPO_ROOT, "src-tauri", "tauri.linux.conf.json"),
  path.join(REPO_ROOT, "src-tauri", "tauri.macos.conf.json"),
  path.join(REPO_ROOT, "src-tauri", "tauri.windows.conf.json"),
  path.join(REPO_ROOT, "src-tauri", "capabilities"),
  path.join(REPO_ROOT, "src-tauri", "permissions"),
  path.join(REPO_ROOT, "src-tauri", "icons"),
  path.join(REPO_ROOT, "src-tauri", "binaries"),
  path.join(REPO_ROOT, "src-tauri", "linux"),
  path.join(REPO_ROOT, "src-tauri", "macos"),
  path.join(REPO_ROOT, "src-tauri", "windows"),
  path.join(REPO_ROOT, "src-tauri", "Info.plist"),
  path.join(REPO_ROOT, "src-tauri", "entitlements.plist"),
  VENDORED_UPDATER_DIR,
  path.join(REPO_ROOT, "e2e"),
  path.join(REPO_ROOT, "package.json"),
  path.join(REPO_ROOT, "package-lock.json"),
];

export async function reserveE2eWebdriverPort(
  serverFactory = net.createServer,
) {
  const server = serverFactory();
  server.on?.("connection", (connection) => connection.destroy());
  let port = null;
  let releasePromise;
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener?.("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.port <= 0) {
      throw new Error("Could not reserve an available E2E WebDriver port.");
    }
    port = address.port;
  } catch (error) {
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    throw error;
  }
  return {
    port,
    release() {
      if (!server.listening) return Promise.resolve();
      if (!releasePromise) {
        releasePromise = new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        releasePromise.catch(() => {
          if (server.listening) releasePromise = undefined;
        });
      }
      return releasePromise;
    },
  };
}

export async function createE2eWebdriverPortHandoff({
  binary,
  args = [],
  directory,
  reservation,
}) {
  if (!binary || !directory || !reservation?.port || !reservation.release) {
    throw new Error("E2E WebDriver port handoff inputs are incomplete.");
  }
  const token = randomBytes(32).toString("hex");
  const launcher = path.join(directory, `.zinnia-e2e-launch-${token}.cjs`);
  let handoffConsumed = false;
  const server = net.createServer((connection) => {
    let buffered = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const receivedToken = buffered.slice(0, newline);
      if (receivedToken !== token || handoffConsumed) {
        connection.destroy();
        return;
      }
      handoffConsumed = true;
      buffered = "";
      void releaseReservation()
        .then(() => {
          connection.end("ready\n");
          void closeServer(server);
        })
        .catch(() => {
          connection.end("unavailable\n");
          void closeServer(server);
        });
    });
  });
  let handoffPort;
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener?.("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.port <= 0) {
      throw new Error("Could not open E2E WebDriver handoff channel.");
    }
    handoffPort = address.port;
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      launcher,
      [
        'const net = require("node:net");',
        'const { spawn } = require("node:child_process");',
        "const [binary, ...args] = process.argv.slice(2);",
        "const host = process.env.ZINNIA_E2E_HANDOFF_HOST;",
        "const port = Number(process.env.ZINNIA_E2E_HANDOFF_PORT);",
        "const token = process.env.ZINNIA_E2E_HANDOFF_TOKEN;",
        "let finished = false;",
        "const socket = net.connect({ host, port });",
        "const fail = (error) => {",
        "  if (finished) return;",
        "  finished = true;",
        "  console.error(`E2E app port handoff failed: ${error instanceof Error ? error.message : String(error)}`);",
        "  socket.destroy();",
        "  process.exitCode = 1;",
        "};",
        'let response = "";',
        'socket.setEncoding("utf8");',
        'socket.once("connect", () => socket.write(`${token}\\n`));',
        'socket.on("data", (chunk) => {',
        "  response += chunk;",
        '  if (!response.includes("\\n")) return;',
        '  if (response.split("\\n", 1)[0] !== "ready") return fail("reserved port could not be released");',
        "  socket.destroy();",
        '  const app = spawn(binary, args, { stdio: "inherit", windowsHide: true });',
        '  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {',
        "    process.on(signal, () => { if (app.pid) app.kill(signal); });",
        "  }",
        '  app.once("error", fail);',
        '  app.once("exit", (code, signal) => {',
        "    if (finished) return;",
        "    finished = true;",
        "    process.exitCode = code ?? (signal ? 1 : 0);",
        "  });",
        "});",
        'socket.once("error", fail);',
      ].join("\n") + "\n",
    );
  } catch (error) {
    await closeServer(server);
    fs.rmSync(launcher, { force: true });
    throw error;
  }
  let reservationRelease;
  const releaseReservation = () => {
    reservationRelease ??= Promise.resolve().then(() => reservation.release());
    return reservationRelease;
  };
  let releasePromise;
  return {
    binary: process.execPath,
    args: [launcher, binary, ...args],
    env: {
      ZINNIA_E2E_HANDOFF_HOST: "127.0.0.1",
      ZINNIA_E2E_HANDOFF_PORT: String(handoffPort),
      ZINNIA_E2E_HANDOFF_TOKEN: token,
    },
    release() {
      releasePromise ??= (async () => {
        let releaseError;
        try {
          await releaseReservation();
        } catch (error) {
          releaseError = error;
        }
        try {
          await closeServer(server);
        } catch (error) {
          releaseError ??= error;
        }
        fs.rmSync(launcher, { force: true });
        if (releaseError) throw releaseError;
      })();
      return releasePromise;
    },
  };
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function normalizedPath(pathname) {
  return path.resolve(pathname).replaceAll("\\", "/");
}

function archiveBenchmarkInputRecords(inputPaths) {
  const records = new Map();
  const activeDirectories = new Set();
  const addRecord = (pathname, record) => {
    records.set(normalizedPath(pathname), sha256(JSON.stringify(record)));
  };
  const visit = (pathname) => {
    let metadata;
    try {
      metadata = fs.lstatSync(pathname);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      addRecord(pathname, ["missing"]);
      return;
    }
    if (metadata.isSymbolicLink()) {
      const target = fs.readlinkSync(pathname);
      let targetMetadata;
      try {
        targetMetadata = fs.statSync(pathname);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        addRecord(pathname, ["symlink", target, "missing-target"]);
        return;
      }
      addRecord(pathname, ["symlink", target]);
      if (targetMetadata.isDirectory()) {
        visitDirectory(pathname);
      } else if (targetMetadata.isFile()) {
        addRecord(`${pathname}#target`, [
          "file-target",
          targetMetadata.mode & 0o777,
          targetMetadata.size,
          sha256(fs.readFileSync(pathname)),
        ]);
      }
      return;
    }
    if (metadata.isDirectory()) {
      visitDirectory(pathname);
      return;
    }
    if (metadata.isFile()) {
      addRecord(pathname, [
        "file",
        metadata.mode & 0o777,
        metadata.size,
        sha256(fs.readFileSync(pathname)),
      ]);
      return;
    }
    addRecord(pathname, ["special", metadata.mode & 0o777]);
  };
  const visitDirectory = (pathname) => {
    let realpath;
    try {
      realpath = fs.realpathSync(pathname);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      addRecord(pathname, ["missing"]);
      return;
    }
    if (activeDirectories.has(realpath)) {
      addRecord(pathname, ["directory-cycle", realpath]);
      return;
    }
    activeDirectories.add(realpath);
    const metadata = fs.statSync(pathname);
    addRecord(pathname, ["directory", metadata.mode & 0o777]);
    for (const entry of fs
      .readdirSync(pathname, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      visit(path.join(pathname, entry.name));
    }
    activeDirectories.delete(realpath);
  };
  for (const inputPath of inputPaths) visit(inputPath);
  return Object.fromEntries(
    [...records.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function archiveBenchmarkBuildInputSnapshot(
  inputPaths = E2E_FRESHNESS_PATHS,
) {
  return archiveBenchmarkInputRecords(inputPaths);
}

export function archiveBenchmarkBuildInputSha256(
  inputPaths = E2E_FRESHNESS_PATHS,
) {
  return sha256(JSON.stringify(archiveBenchmarkBuildInputSnapshot(inputPaths)));
}

export function assertArchiveBenchmarkBuildInputsUnchanged(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...paths]
    .filter((pathname) => before[pathname] !== after[pathname])
    .sort();
  if (changed.length > 0) {
    throw new Error(
      `Archive benchmark build inputs changed during build (${changed.join(", ")}); refusing to stamp binary.`,
    );
  }
}

function readE2eStamp(stampPath = releaseE2eStampPath()) {
  try {
    return JSON.parse(fs.readFileSync(stampPath, "utf8"));
  } catch {
    return null;
  }
}

export function isArchiveBenchmarkE2eBinaryFresh({
  binary = releaseBinaryPath(),
  stamp = releaseE2eStampPath(),
  inputPaths = E2E_FRESHNESS_PATHS,
} = {}) {
  if (!fs.existsSync(binary)) return false;
  const proof = readE2eStamp(stamp);
  if (!proof || proof.version !== ARCHIVE_BENCHMARK_E2E_STAMP_VERSION) {
    return false;
  }
  try {
    return (
      proof.binaryPath === binary &&
      proof.binarySha256 === sha256(fs.readFileSync(binary)) &&
      proof.buildInputSha256 === archiveBenchmarkBuildInputSha256(inputPaths)
    );
  } catch {
    return false;
  }
}

export function writeArchiveBenchmarkE2eStamp({
  binary,
  stamp = releaseE2eStampPath(),
  inputPaths = E2E_FRESHNESS_PATHS,
  inputSnapshot = archiveBenchmarkBuildInputSnapshot(inputPaths),
}) {
  if (!binary || !fs.existsSync(binary)) {
    throw new Error("Cannot stamp missing release E2E binary.");
  }
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(
    stamp,
    `${JSON.stringify(
      {
        version: ARCHIVE_BENCHMARK_E2E_STAMP_VERSION,
        kind: "release-e2e",
        binaryPath: binary,
        binarySha256: sha256(fs.readFileSync(binary)),
        buildInputSha256: sha256(JSON.stringify(inputSnapshot)),
      },
      null,
      2,
    )}\n`,
  );
}

function buildCommandTimeoutMs(env = process.env) {
  const parsed = Number(env.ZINNIA_BENCH_BUILD_TIMEOUT_MS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ARCHIVE_BENCHMARK_BUILD_TIMEOUT_MS;
}

export function terminateProcessTree(child, signal = "SIGTERM") {
  if (!child) return false;
  if (!child.pid) {
    try {
      return child.kill(signal) !== false;
    } catch {
      return false;
    }
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 10_000 },
    );
    return !result.error && result.status === 0;
  } else {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") {
        try {
          child.kill(signal);
          return true;
        } catch {}
      }
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(child, timeoutMs) {
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

function processGroupIsAlive(pid) {
  if (!pid || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function waitForProcessGroupExit(pid, timeoutMs) {
  if (!processGroupIsAlive(pid)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!processGroupIsAlive(pid)) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(check, 25);
      }
    };
    check();
  });
}

function runWindowsPowerShell(command, env = process.env, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    let output = "";
    let settled = false;
    let timeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (status) => finish({ status, output }));
    timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function readWindowsProcessTable(timeoutMs = 5_000) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {",
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; created = [string]$_.CreationDate }",
    "})",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("\n");
  const result = await runWindowsPowerShell(command, process.env, timeoutMs);
  if (!result || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.output.trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map(({ pid, parentPid, created }) => ({
      pid: Number(pid),
      parentPid: Number(parentPid),
      created: String(created),
    }));
  } catch {
    return null;
  }
}

function windowsProcessIdentity(processInfo) {
  if (
    !Number.isSafeInteger(processInfo?.pid) ||
    processInfo.pid <= 0 ||
    typeof processInfo.created !== "string" ||
    !processInfo.created ||
    processInfo.created === "undefined"
  ) {
    return null;
  }
  return { pid: processInfo.pid, created: processInfo.created };
}

function windowsProcessIdentityKey(processInfo) {
  return `${processInfo.pid}:${processInfo.created}`;
}

function sameWindowsProcess(left, right) {
  return left?.pid === right?.pid && left?.created === right?.created;
}

function windowsCreationTimeMs(value) {
  if (typeof value !== "string") return null;
  const cim = value.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,6})([+-])(\d{3})$/,
  );
  if (cim) {
    const [, year, month, day, hour, minute, second, fraction, sign, offset] =
      cim;
    const localMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(fraction.padEnd(3, "0").slice(0, 3)),
    );
    const signedOffset = Number(offset) * (sign === "+" ? 1 : -1);
    return localMs - signedOffset * 60_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowsChildCreatedAfterParent(processInfo, parentIdentity) {
  const childCreatedAt = windowsCreationTimeMs(processInfo?.created);
  const parentCreatedAt = windowsCreationTimeMs(parentIdentity?.created);
  return (
    childCreatedAt !== null &&
    parentCreatedAt !== null &&
    childCreatedAt >= parentCreatedAt
  );
}

function processTreeFromTable(
  table,
  leaderIdentity,
  state,
  allowNewDescendants = false,
) {
  if (!Array.isArray(table)) return null;
  const currentByPid = new Map(table.map((item) => [item.pid, item]));
  const currentLeader = currentByPid.get(leaderIdentity.pid);
  if (currentLeader && !sameWindowsProcess(currentLeader, leaderIdentity)) {
    return { reusedLeaderPid: true, processes: [] };
  }

  const processesByIdentity = new Map();
  const ownedParentsByPid = new Map();
  const addOwned = (processInfo, observe = false) => {
    const identity = windowsProcessIdentity(processInfo);
    if (!identity) return false;
    const current = currentByPid.get(identity.pid);
    if (!sameWindowsProcess(current, identity)) return false;
    processesByIdentity.set(windowsProcessIdentityKey(identity), processInfo);
    ownedParentsByPid.set(identity.pid, identity);
    if (observe) {
      state.observed.set(windowsProcessIdentityKey(identity), processInfo);
    }
    return true;
  };

  // Keep only exact process identities observed while their parents were live.
  for (const observed of state.observed.values()) addOwned(observed);

  // New ownership requires a live, identity-matched parent in this snapshot.
  if (allowNewDescendants && currentLeader) {
    addOwned(currentLeader, true);
    let changed = true;
    while (changed) {
      changed = false;
      for (const processInfo of table) {
        const identity = windowsProcessIdentity(processInfo);
        const parentIdentity = ownedParentsByPid.get(processInfo.parentPid);
        const currentParent = currentByPid.get(processInfo.parentPid);
        if (
          !identity ||
          !parentIdentity ||
          !sameWindowsProcess(currentParent, parentIdentity) ||
          !windowsChildCreatedAfterParent(processInfo, parentIdentity) ||
          processesByIdentity.has(windowsProcessIdentityKey(identity))
        ) {
          continue;
        }
        if (addOwned(processInfo, true)) changed = true;
      }
    }
  }

  const processes = [...processesByIdentity.values()].sort(
    (left, right) => left.pid - right.pid,
  );
  const knownParentPids = new Set([
    leaderIdentity.pid,
    ...[...state.observed.values()].map((processInfo) => processInfo.pid),
  ]);
  const unresolvedParentPids = new Set();
  const unresolvedDescendants = [];
  let hasUnresolved = true;
  while (hasUnresolved) {
    hasUnresolved = false;
    for (const processInfo of table) {
      const identity = windowsProcessIdentity(processInfo);
      const identityKey = identity && windowsProcessIdentityKey(identity);
      if (identityKey && processesByIdentity.has(identityKey)) continue;
      if (
        !knownParentPids.has(processInfo.parentPid) &&
        !unresolvedParentPids.has(processInfo.parentPid)
      ) {
        continue;
      }
      unresolvedDescendants.push(processInfo);
      if (!unresolvedParentPids.has(processInfo.pid)) {
        unresolvedParentPids.add(processInfo.pid);
        hasUnresolved = true;
      }
    }
  }
  return { reusedLeaderPid: false, processes, unresolvedDescendants };
}

async function snapshotWindowsProcessTree(
  leaderIdentity,
  state,
  readProcessTable = readWindowsProcessTable,
  allowNewDescendants = false,
) {
  const table = await readProcessTable();
  return processTreeFromTable(
    table,
    leaderIdentity,
    state,
    allowNewDescendants,
  );
}

export function captureWindowsProcessIdentity(child, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !child?.pid) return Promise.resolve(null);
  if (options.waitForSpawn) {
    if (child.pid) {
      return captureWindowsProcessIdentity(child, {
        ...options,
        waitForSpawn: false,
        spawnObservedAt: Date.now(),
      });
    }
    return new Promise((resolve) => {
      const cleanup = () => {
        child.removeListener?.("spawn", onSpawn);
        child.removeListener?.("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        const spawnObservedAt = Date.now();
        void captureWindowsProcessIdentity(child, {
          ...options,
          waitForSpawn: false,
          spawnObservedAt,
        }).then(resolve);
      };
      const onError = () => {
        cleanup();
        resolve(null);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }
  const existing = windowsProcessStates.get(child);
  if (existing) return existing.identityPromise;

  const readProcessTable =
    options.readWindowsProcessTable ?? (() => readWindowsProcessTable());
  const state = {
    identity: null,
    identityPromise: null,
    observed: new Map(),
    leaderExited: false,
    captureStopped: false,
    captureIncomplete: false,
    readProcessTable,
  };
  windowsProcessStates.set(child, state);
  let resolveIdentity;
  let identitySettled = false;
  state.identityPromise = new Promise((resolve) => {
    resolveIdentity = resolve;
  });
  const settleIdentity = (identity) => {
    if (identitySettled) return;
    identitySettled = true;
    resolveIdentity(identity);
  };
  const markLeaderExited = () => {
    state.leaderExited = true;
    state.captureStopped = true;
    settleIdentity(state.identity);
  };
  child.once?.("exit", markLeaderExited);
  const captureIntervalMs = positiveProcessTimeout(
    options.captureIntervalMs,
    WINDOWS_PROCESS_CAPTURE_INTERVAL_MS,
  );
  state.captureTask = (async () => {
    while (!state.leaderExited && !state.captureStopped) {
      if (child.exitCode !== null || child.signalCode !== null) {
        markLeaderExited();
        break;
      }
      let table;
      try {
        table = await readProcessTable();
      } catch {
        table = null;
      }
      if (state.captureStopped) break;
      if (
        state.leaderExited ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        markLeaderExited();
        break;
      }
      if (!Array.isArray(table)) {
        state.captureIncomplete = true;
      } else {
        const leader = table.find(
          (processInfo) => processInfo.pid === child.pid,
        );
        if (!leader) {
          if (state.identity) state.captureIncomplete = true;
        } else {
          const identity = windowsProcessIdentity(leader);
          const createdAtMs = windowsCreationTimeMs(identity?.created);
          const identityMatchesSpawn =
            options.spawnObservedAt === undefined ||
            (createdAtMs !== null && createdAtMs <= options.spawnObservedAt);
          if (!identity || !identityMatchesSpawn) {
            state.captureIncomplete = true;
          } else if (
            state.identity &&
            !sameWindowsProcess(state.identity, identity)
          ) {
            state.captureIncomplete = true;
          } else {
            state.identity = identity;
            state.observed.set(windowsProcessIdentityKey(identity), leader);
            settleIdentity(identity);
            const ownership = processTreeFromTable(
              table,
              identity,
              state,
              true,
            );
            if (!ownership || ownership.unresolvedDescendants.length > 0) {
              state.captureIncomplete = true;
            }
          }
        }
      }
      await new Promise((resolve) => {
        const wait = setTimeout(resolve, captureIntervalMs);
        wait.unref?.();
      });
    }
    settleIdentity(state.identity);
  })().catch(() => {
    state.captureIncomplete = true;
    settleIdentity(state.identity);
  });
  return state.identityPromise;
}

export function hasCapturedWindowsProcessIdentity(child) {
  return Boolean(windowsProcessStates.get(child)?.identity);
}

async function killWindowsProcessSnapshot(processInfo, timeoutMs = 10_000) {
  if (
    !Number.isSafeInteger(processInfo?.pid) ||
    processInfo.pid <= 0 ||
    !processInfo.created ||
    processInfo.created === "undefined"
  ) {
    return false;
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$targetPid = [int]$env:ZINNIA_PROCESS_PID",
    "$expectedCreated = [string]$env:ZINNIA_PROCESS_CREATED",
    "Add-Type -AssemblyName System.Management",
    "$process = $null",
    "try { $process = [System.Diagnostics.Process]::GetProcessById($targetPid) } catch [System.ArgumentException] { exit 0 }",
    "try {",
    "  $expected = [System.Management.ManagementDateTimeConverter]::ToDateTime($expectedCreated).ToUniversalTime().Ticks",
    "  $actual = $process.StartTime.ToUniversalTime().Ticks",
    "  if ([Math]::Abs([long]$actual - [long]$expected) -gt 9) { exit 3 }",
    "  $process.Kill()",
    "  if (-not $process.WaitForExit(10000)) { exit 4 }",
    "} finally { $process.Dispose() }",
  ].join("\n");
  const result = await runWindowsPowerShell(
    command,
    {
      ...process.env,
      ZINNIA_PROCESS_PID: String(processInfo.pid),
      ZINNIA_PROCESS_CREATED: processInfo.created,
    },
    Math.max(1, Math.min(10_000, timeoutMs)),
  );
  return result !== null && result.status === 0;
}

function windowsProcessDepth(processInfo, byPid) {
  const seen = new Set([processInfo.pid]);
  let depth = 0;
  let parentPid = processInfo.parentPid;
  while (byPid.has(parentPid) && !seen.has(parentPid)) {
    seen.add(parentPid);
    depth += 1;
    parentPid = byPid.get(parentPid).parentPid;
  }
  return depth;
}

export async function terminateAndWaitForProcessTree(child, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!child?.pid) {
    terminateProcessTree(child, "SIGTERM");
    return platform !== "win32" && waitForProcessExit(child, 10_000);
  }
  if (platform === "win32") {
    const timeoutMs = positiveProcessTimeout(
      options.processTreeCleanupTimeoutMs,
      WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS,
    );
    const deadline = Date.now() + timeoutMs;
    const readProcessTable =
      options.readWindowsProcessTable ??
      (() =>
        readWindowsProcessTable(
          Math.max(1, Math.min(5_000, deadline - Date.now())),
        ));
    const state = windowsProcessStates.get(child);
    if (!state) return false;
    const failCleanup = () => {
      state.captureStopped = true;
      return false;
    };
    let identityTimer;
    const identityDeadline = new Promise((resolve) => {
      identityTimer = setTimeout(
        () => resolve(null),
        Math.max(1, deadline - Date.now()),
      );
      identityTimer.unref?.();
    });
    const leaderIdentity = await Promise.race([
      state.identityPromise,
      identityDeadline,
    ]);
    clearTimeout(identityTimer);
    if (!leaderIdentity || leaderIdentity.pid !== child.pid) {
      return failCleanup();
    }
    const snapshotTree = async () =>
      snapshotWindowsProcessTree(
        leaderIdentity,
        state,
        readProcessTable,
        !state.leaderExited &&
          child.exitCode === null &&
          child.signalCode === null,
      );
    const terminateTree =
      options.killWindowsProcessTree ??
      ((_processChild, identity) =>
        killWindowsProcessSnapshot(
          identity,
          Math.max(1, deadline - Date.now()),
        ));
    const terminateProcess =
      options.killWindowsProcess ??
      ((identity) =>
        killWindowsProcessSnapshot(
          identity,
          Math.max(1, deadline - Date.now()),
        ));
    const scanDelayMs = positiveProcessTimeout(
      options.processTreeScanDelayMs,
      WINDOWS_PROCESS_SCAN_DELAY_MS,
    );
    let treeKillAttempted = false;
    let quietRounds = 0;

    while (Date.now() < deadline) {
      let snapshot;
      try {
        snapshot = await snapshotTree();
      } catch {
        return failCleanup();
      }
      if (!snapshot || !Array.isArray(snapshot.processes)) return failCleanup();
      if (snapshot.reusedLeaderPid) return failCleanup();
      const unresolvedDescendants = snapshot.unresolvedDescendants ?? [];

      const leaderFromSnapshot = snapshot.processes.find(
        (processInfo) => processInfo.pid === child.pid,
      );
      if (
        leaderFromSnapshot &&
        !sameWindowsProcess(leaderFromSnapshot, leaderIdentity)
      ) {
        return failCleanup();
      }
      const processes = snapshot.processes.filter((processInfo) =>
        windowsProcessIdentity(processInfo),
      );
      for (const processInfo of processes) {
        state.observed.set(windowsProcessIdentityKey(processInfo), processInfo);
      }

      const leaderStopped =
        child.exitCode !== null || child.signalCode !== null;
      const leaderPresent = Boolean(leaderFromSnapshot);
      if (!leaderStopped && leaderPresent && !treeKillAttempted) {
        treeKillAttempted = true;
        try {
          await terminateTree(child, leaderIdentity);
        } catch {
          // The individual identity-checked fallback below is still attempted.
        }
      }
      if (!leaderStopped && !leaderPresent) {
        // The process inventory may lag spawn/exit notifications. Target only
        // the captured PID+creation-time identity; never issue PID-only treekill.
        treeKillAttempted = true;
        try {
          await terminateProcess(leaderIdentity);
        } catch {
          // Continue scanning and require identity-based exit proof.
        }
      }

      const processesByPid = new Map(
        processes.map((processInfo) => [processInfo.pid, processInfo]),
      );
      const descendants = processes
        .filter((processInfo) => processInfo.pid !== child.pid)
        .sort(
          (left, right) =>
            windowsProcessDepth(right, processesByPid) -
              windowsProcessDepth(left, processesByPid) || right.pid - left.pid,
        );
      for (const processInfo of descendants) {
        try {
          await terminateProcess(processInfo);
        } catch {
          // Keep scanning: later rounds prove whether the exact identity left.
        }
      }
      if (!leaderStopped && leaderPresent && treeKillAttempted) {
        try {
          await terminateProcess(leaderIdentity);
        } catch {
          // Keep scanning for exit and late descendants.
        }
      }

      const currentDescendants = processes.filter(
        (processInfo) => processInfo.pid !== child.pid,
      );
      const leaderStoppedNow =
        child.exitCode !== null || child.signalCode !== null;
      if (
        leaderStoppedNow &&
        !leaderPresent &&
        currentDescendants.length === 0
      ) {
        if (unresolvedDescendants.length === 0) {
          if (state.captureIncomplete) return failCleanup();
          quietRounds += 1;
          if (quietRounds >= WINDOWS_PROCESS_QUIET_ROUNDS) {
            state.captureStopped = true;
            return true;
          }
        } else {
          quietRounds = 0;
        }
      } else {
        quietRounds = 0;
      }

      if (!leaderStopped) {
        await waitForProcessExit(
          child,
          Math.min(scanDelayMs, Math.max(1, deadline - Date.now())),
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, scanDelayMs));
      }
    }
    return failCleanup();
  }
  terminateProcessTree(child, "SIGTERM");
  const leaderExited = await waitForProcessExit(child, 1_000);
  if (!processGroupIsAlive(child.pid)) return leaderExited;
  terminateProcessTree(child, "SIGKILL");
  const [leaderStopped, groupStopped] = await Promise.all([
    waitForProcessExit(child, 10_000),
    waitForProcessGroupExit(child.pid, 10_000),
  ]);
  return leaderStopped && groupStopped;
}

export async function runArchiveBenchmarkBuildCommand(
  command,
  args,
  cwd = REPO_ROOT,
  env = {},
  signal,
  options = {},
) {
  if (signal?.aborted) {
    throw new Error("Archive benchmark build was aborted before starting.");
  }
  const mergedEnv = { ...process.env, ...env };
  const buildTimeoutMs = buildCommandTimeoutMs(mergedEnv);
  const shell =
    process.platform === "win32" && /^(npm|npx)(\.cmd)?$/i.test(command);
  let fencedLaunch = null;
  let child;
  if (process.platform === "win32") {
    fencedLaunch = await startWindowsFencedCommand(command, args, {
      cwd,
      env: mergedEnv,
      stdio: "inherit",
      shell,
      startupTimeoutMs: Math.min(buildTimeoutMs, 20_000),
    });
    child = fencedLaunch.child;
  } else {
    child = spawn(command, args, {
      cwd,
      env: mergedEnv,
      stdio: "inherit",
      windowsHide: true,
      shell,
      detached: true,
    });
  }
  const processPlatform = options.processPlatform ?? process.platform;
  const windowsProcessOptions = options.windowsProcessOptions ?? {};
  const identityCapture = captureWindowsProcessIdentity(child, {
    ...windowsProcessOptions,
    platform: processPlatform,
    waitForSpawn: true,
  });
  const childExit = fencedLaunch
    ? waitForWindowsFencedCommand(
        fencedLaunch,
        `Archive benchmark build command ${command} ${args.join(" ")}`,
      )
    : waitForChild(child);
  childExit.catch(() => {});
  let timeout;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `Archive benchmark build command ${command} ${args.join(" ")} timed out after ${buildTimeoutMs}ms`,
        ),
      );
    }, buildTimeoutMs);
  });
  const abortSignal = new Promise((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      reject(new Error("Archive benchmark build was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let commandError = null;
  let launchReleased = false;
  try {
    if (fencedLaunch) {
      const identity = await Promise.race([
        identityCapture,
        deadline,
        abortSignal,
      ]);
      if (!identity || identity.pid !== child.pid) {
        throw new Error(
          `Archive benchmark build launch fence could not capture its exact leader identity: ${command}`,
        );
      }
      await Promise.race([fencedLaunch.release(), deadline, abortSignal]);
      launchReleased = true;
    }
    await Promise.race([childExit, deadline, abortSignal]);
  } catch (error) {
    commandError = error;
  } finally {
    clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (fencedLaunch && !launchReleased) {
    await fencedLaunch.abort().catch(() => {});
  }
  let processTreeCleanup = { status: "verified" };
  if (child.pid) {
    if (
      !(await terminateAndWaitForProcessTree(child, {
        ...windowsProcessOptions,
        ...options.processTreeCleanupOptions,
        platform: processPlatform,
      }))
    ) {
      const cleanupError = new Error(
        `Archive benchmark build process tree cleanup could not be verified: ${command}`,
        { cause: commandError },
      );
      processTreeCleanup = {
        status: "unproven",
        reason:
          "leader identity or descendant ownership could not be proven safely",
      };
      commandError = commandError
        ? new AggregateError([commandError, cleanupError], cleanupError.message)
        : cleanupError;
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
  if (processTreeCleanup.status !== "verified") {
    throw new Error(
      `Archive benchmark build process tree cleanup was not verified: ${command}`,
    );
  }
  return { processTreeCleanup };
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
  for (const [file, contents] of snapshots) fs.writeFileSync(file, contents);
}

async function ensureReleaseE2eBinary(signal) {
  if (signal?.aborted) {
    throw new Error("Archive benchmark build was aborted before starting.");
  }
  const binary = releaseBinaryPath();
  if (
    process.env.ZINNIA_E2E_REBUILD !== "1" &&
    isArchiveBenchmarkE2eBinaryFresh({ binary })
  ) {
    return binary;
  }
  const snapshots = snapshotGeneratedSchemas();
  let buildInputSnapshot;
  try {
    await runArchiveBenchmarkBuildCommand(
      npmCommand(),
      ["run", "prepare:7z"],
      REPO_ROOT,
      {},
      signal,
    );
    buildInputSnapshot = archiveBenchmarkBuildInputSnapshot();
    // Never stamp an older release binary if Cargo reports success without
    // replacing the feature-enabled E2E artifact.
    fs.rmSync(binary, { force: true });
    await runArchiveBenchmarkBuildCommand(
      npxCommand(),
      [
        "tauri",
        "build",
        "--no-bundle",
        "--config",
        E2E_CONFIG,
        "--",
        "--features",
        "e2e",
      ],
      REPO_ROOT,
      {},
      signal,
    );
  } finally {
    restoreGeneratedSchemas(snapshots);
  }
  if (!fs.existsSync(binary)) {
    throw new Error(`Release E2E binary missing after build: ${binary}`);
  }
  const buildInputSnapshotAfter = archiveBenchmarkBuildInputSnapshot();
  assertArchiveBenchmarkBuildInputsUnchanged(
    buildInputSnapshot,
    buildInputSnapshotAfter,
  );
  writeArchiveBenchmarkE2eStamp({ binary, inputSnapshot: buildInputSnapshot });
  return binary;
}

function childEnvironment(profile, binary, port, webdriverPort) {
  return {
    ...process.env,
    ...profile.env,
    ZINNIA_E2E: "1",
    ZINNIA_E2E_BINARY: binary,
    ZINNIA_E2E_APP_ARGS: "[]",
    ZINNIA_E2E_SPECS: "./specs/archive-io-benchmark.spec.js",
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
    ZINNIA_BENCH_SOCKET_HOST: "127.0.0.1",
    ZINNIA_BENCH_SOCKET_PORT: String(port),
    TAURI_WEBDRIVER_PORT: String(webdriverPort),
  };
}

function wdioCommand() {
  const args = ["wdio", "run", "e2e/wdio.conf.js"];
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    const probe = spawnSync("xvfb-run", ["--help"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (probe.error?.code === "ENOENT") {
      throw new Error(
        "Archive benchmark on headless Linux requires xvfb-run; install Xvfb (for example: sudo apt-get install xvfb).",
      );
    }
    if (probe.error) throw probe.error;
    return {
      command: "xvfb-run",
      args: ["-a", npxCommand(), ...args],
      shell: false,
    };
  }
  return {
    command: npxCommand(),
    args,
    shell: process.platform === "win32",
  };
}

export const ARCHIVE_BENCHMARK_CLOSE_TIMEOUT_MS = 30_000;

export function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onExit = (code, signal) => {
      settle(() => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`Archive benchmark WDIO exited with ${code ?? signal}.`),
          );
      });
    };
    const onError = (error) => {
      settle(() => reject(error));
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export function waitForChildExit(
  childExit,
  child,
  timeoutMs = ARCHIVE_BENCHMARK_CLOSE_TIMEOUT_MS,
) {
  let timeout;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error("Archive benchmark WDIO close deadline expired."));
    }, timeoutMs);
  });
  return Promise.race([childExit, deadline])
    .catch(async (error) => {
      if (!timedOut) throw error;
      if (!(await terminateAndWaitForProcessTree(child))) {
        throw new Error(
          "Archive benchmark WDIO process tree did not stop after timeout.",
        );
      }
      throw new Error(
        "Archive benchmark WDIO process did not exit after close request.",
      );
    })
    .finally(() => clearTimeout(timeout));
}

export async function closeArchiveBenchmarkSession({
  socket,
  child,
  childExit,
  cleanup,
}) {
  let closeError = null;
  try {
    if (socket && !socket.destroyed) {
      await new Promise((resolve, reject) => {
        socket.write(`${JSON.stringify({ close: true })}\n`, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } else if (child.exitCode === null && child.signalCode === null) {
      if (!(await terminateAndWaitForProcessTree(child))) {
        throw new Error(
          "Archive benchmark WDIO process tree did not stop after close.",
        );
      }
    }
    await waitForChildExit(
      childExit,
      child,
      ARCHIVE_BENCHMARK_CLOSE_TIMEOUT_MS,
    );
  } catch (error) {
    closeError = error;
  } finally {
    const stopped = await terminateAndWaitForProcessTree(child);
    if (!stopped) {
      closeError = new Error(
        "Archive benchmark WDIO process tree did not stop after close.",
        { cause: closeError },
      );
    }
    await cleanup();
  }
  if (closeError) throw closeError;
}

function cleanupProfile(profileDir) {
  try {
    fs.rmSync(profileDir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 20 : 8,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(`Could not remove archive benchmark profile: ${error}`);
  }
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Start one release E2E app and expose request/response transport to harness.
 * archive-io-benchmark.spec.js must keep socket open until close request.
 */
export async function createArchiveBenchmarkSession({ signal } = {}) {
  const binary = await ensureReleaseE2eBinary(signal);
  if (signal?.aborted) {
    throw new Error("Archive benchmark runner was aborted before startup.");
  }
  const profile = createE2eProfile(REPO_ROOT);
  const pending = new Map();
  let requestId = 0;
  let socket = null;
  let socketBuffer = "";
  let socketReadyResolve;
  let socketReadyReject;
  let socketReadySettled = false;
  const socketReady = new Promise((resolve, reject) => {
    socketReadyResolve = () => {
      if (socketReadySettled) return;
      socketReadySettled = true;
      resolve();
    };
    socketReadyReject = (error) => {
      if (socketReadySettled) return;
      socketReadySettled = true;
      reject(error);
    };
  });
  // A child can fail before the first harness request. Keep the rejection
  // observed so close() remains deterministic instead of causing an unhandled
  // promise rejection while the caller is already reporting the child error.
  socketReady.catch(() => {});
  const server = net.createServer((connection) => {
    if (socket && !socket.destroyed) {
      connection.destroy();
      return;
    }
    socket = connection;
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      socketBuffer += chunk;
      while (socketBuffer.includes("\n")) {
        const newline = socketBuffer.indexOf("\n");
        const line = socketBuffer.slice(0, newline);
        socketBuffer = socketBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          socketReadyReject(error);
          for (const request of pending.values()) request.reject(error);
          pending.clear();
          connection.destroy();
          continue;
        }
        if (response.ready) socketReadyResolve();
        const pendingRequest = pending.get(response.id);
        if (!pendingRequest) continue;
        pending.delete(response.id);
        if (response.ok) pendingRequest.resolve(response.result);
        else
          pendingRequest.reject(
            new Error(response.error || "Archive benchmark request failed."),
          );
      }
    });
    connection.on("error", (error) => {
      socketReadyReject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
    connection.on("close", () => {
      const error = new Error("Archive benchmark socket closed.");
      socketReadyReject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
  });
  let webdriverReservation;
  try {
    webdriverReservation = await reserveE2eWebdriverPort();
  } catch (error) {
    cleanupProfile(profile.profileDir);
    throw error;
  }
  try {
    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
  } catch (error) {
    await closeServer(server);
    await webdriverReservation.release();
    cleanupProfile(profile.profileDir);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    await webdriverReservation.release();
    cleanupProfile(profile.profileDir);
    throw new Error("Benchmark socket did not bind.");
  }
  let child;
  let webdriverHandoff;
  try {
    const command = wdioCommand();
    webdriverHandoff = await createE2eWebdriverPortHandoff({
      binary,
      directory: profile.work,
      reservation: webdriverReservation,
    });
    const env = childEnvironment(
      profile,
      binary,
      address.port,
      webdriverReservation.port,
    );
    env.ZINNIA_E2E_BINARY = webdriverHandoff.binary;
    env.ZINNIA_E2E_APP_ARGS = JSON.stringify(webdriverHandoff.args);
    Object.assign(env, webdriverHandoff.env);
    child = spawn(command.command, command.args, {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: command.shell,
      detached: process.platform !== "win32",
    });
    void captureWindowsProcessIdentity(child, { waitForSpawn: true });
  } catch (error) {
    await closeServer(server);
    if (webdriverHandoff) await webdriverHandoff.release();
    else await webdriverReservation.release();
    cleanupProfile(profile.profileDir);
    throw error;
  }
  const childExit = waitForChild(child);
  childExit.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    const stopped = await terminateAndWaitForProcessTree(child);
    await closeServer(server);
    if (webdriverHandoff) await webdriverHandoff.release();
    else await webdriverReservation.release();
    cleanupProfile(profile.profileDir);
    if (!stopped) {
      throw new AggregateError(
        [
          error,
          new Error(
            "Archive benchmark WDIO process tree did not stop after port handoff.",
          ),
        ],
        "Archive benchmark startup and process cleanup both failed.",
      );
    }
    throw error;
  }
  let closePromise;
  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onAbort = () => {
    void abort().catch(() => {});
  };
  const cleanup = async () => {
    rejectPending(new Error("Archive benchmark session closed."));
    if (socket && !socket.destroyed) socket.destroy();
    await closeServer(server);
    await webdriverHandoff.release();
    cleanupProfile(profile.profileDir);
    signal?.removeEventListener("abort", onAbort);
  };
  const abort = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        if (!(await terminateAndWaitForProcessTree(child))) {
          throw new Error(
            "Archive benchmark WDIO process tree did not stop after abort.",
          );
        }
      } finally {
        await cleanup();
      }
    })();
    return closePromise;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = closeArchiveBenchmarkSession({
      socket,
      child,
      childExit,
      cleanup,
    });
    return closePromise;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const run = async (request) => {
    await Promise.race([
      socketReady,
      childExit.then(() => {
        throw new Error(
          "Archive benchmark WDIO exited before socket became ready.",
        );
      }),
    ]);
    const id = String(++requestId);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        socket.write(`${JSON.stringify({ id, request })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
  return { run, runArchiveBenchmarkOperation: run, close, abort };
}
