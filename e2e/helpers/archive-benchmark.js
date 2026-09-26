import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createE2eProfile, REPO_ROOT } from "./profile.js";

const E2E_CONFIG = path.join(REPO_ROOT, "src-tauri", "tauri.e2e.conf.json");
const VENDORED_UPDATER_DIR = path.join(
  REPO_ROOT,
  "src-tauri",
  "vendor",
  "tauri-plugin-updater",
);
export const ARCHIVE_BENCHMARK_E2E_STAMP_VERSION = "archive-io-e2e-v1";
const DEFAULT_ARCHIVE_BENCHMARK_BUILD_TIMEOUT_MS = 45 * 60 * 1000;

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

function latestMtime(pathname) {
  let metadata;
  try {
    metadata = fs.statSync(pathname);
  } catch {
    return 0;
  }
  if (!metadata.isDirectory()) return metadata.mtimeMs;
  let latest = metadata.mtimeMs;
  for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) {
    latest = Math.max(latest, latestMtime(path.join(pathname, entry.name)));
  }
  return latest;
}

function e2eSourceMtime() {
  return Math.max(
    ...E2E_FRESHNESS_PATHS.map((pathname) => latestMtime(pathname)),
  );
}

function readE2eStamp() {
  try {
    return JSON.parse(fs.readFileSync(releaseE2eStampPath(), "utf8"));
  } catch {
    return null;
  }
}

function releaseE2eBinaryIsFresh(binary) {
  if (!fs.existsSync(binary)) return false;
  const stamp = readE2eStamp();
  if (!stamp || stamp.version !== ARCHIVE_BENCHMARK_E2E_STAMP_VERSION) {
    return false;
  }
  const binaryMtimeMs = fs.statSync(binary).mtimeMs;
  return (
    stamp.binaryPath === binary &&
    stamp.binaryMtimeMs === binaryMtimeMs &&
    stamp.sourceMtimeMs >= e2eSourceMtime()
  );
}

function writeE2eStamp(binary) {
  const binaryMtimeMs = fs.statSync(binary).mtimeMs;
  fs.writeFileSync(
    releaseE2eStampPath(),
    `${JSON.stringify(
      {
        version: ARCHIVE_BENCHMARK_E2E_STAMP_VERSION,
        kind: "release-e2e",
        binaryPath: binary,
        binaryMtimeMs,
        sourceMtimeMs: e2eSourceMtime(),
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
    if (result.status === 0) return true;
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

async function terminateAndWaitForProcessTree(child) {
  if (!child?.pid) {
    terminateProcessTree(child, "SIGTERM");
    return waitForProcessExit(child, 10_000);
  }
  terminateProcessTree(child, "SIGTERM");
  const leaderExited = await waitForProcessExit(child, 1_000);
  if (process.platform === "win32") return leaderExited;
  if (!processGroupIsAlive(child.pid)) return leaderExited;
  terminateProcessTree(child, "SIGKILL");
  const [leaderStopped, groupStopped] = await Promise.all([
    waitForProcessExit(child, 10_000),
    waitForProcessGroupExit(child.pid, 10_000),
  ]);
  return leaderStopped && groupStopped;
}

async function run(command, args, cwd = REPO_ROOT, env = {}, signal) {
  if (signal?.aborted) {
    throw new Error("Archive benchmark build was aborted before starting.");
  }
  const mergedEnv = { ...process.env, ...env };
  const buildTimeoutMs = buildCommandTimeoutMs(mergedEnv);
  const child = spawn(command, args, {
    cwd,
    env: mergedEnv,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32" && /^(npm|npx)(\.cmd)?$/i.test(command),
    detached: process.platform !== "win32",
  });
  const childExit = waitForChild(child);
  childExit.catch(() => {});
  let timeout;
  let timedOut = false;
  let aborted = false;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
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
      aborted = true;
      reject(new Error("Archive benchmark build was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([childExit, deadline, abortSignal]);
  } catch (error) {
    if (!timedOut && !aborted) throw error;
    if (!(await terminateAndWaitForProcessTree(child))) {
      throw new Error(
        `Archive benchmark build process tree did not stop after interruption: ${command}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
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
    releaseE2eBinaryIsFresh(binary)
  ) {
    return binary;
  }
  const buildStartedAt = Date.now();
  const snapshots = snapshotGeneratedSchemas();
  try {
    await run(npmCommand(), ["run", "prepare:7z"], REPO_ROOT, {}, signal);
    await run(
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
  // A production release binary may occupy target/release. The stamp is only
  // written after the feature-enabled build refreshes that exact path, so an
  // un-stamped production binary can never be reused as an E2E executable.
  if (fs.statSync(binary).mtimeMs < buildStartedAt) {
    throw new Error(
      "Release E2E build did not refresh target/release/zinnia; refusing to reuse a production binary.",
    );
  }
  writeE2eStamp(binary);
  return binary;
}

function childEnvironment(profile, binary, port) {
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
  return new Promise((resolve) => server.close(() => resolve()));
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
  try {
    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
  } catch (error) {
    await closeServer(server);
    cleanupProfile(profile.profileDir);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    cleanupProfile(profile.profileDir);
    throw new Error("Benchmark socket did not bind.");
  }
  let child;
  try {
    const command = wdioCommand();
    child = spawn(command.command, command.args, {
      cwd: REPO_ROOT,
      env: childEnvironment(profile, binary, address.port),
      stdio: "inherit",
      windowsHide: true,
      shell: command.shell,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    await closeServer(server);
    cleanupProfile(profile.profileDir);
    throw error;
  }
  const childExit = waitForChild(child);
  childExit.catch(() => {});
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
    closePromise = (async () => {
      let childError = null;
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
        try {
          await waitForChildExit(
            childExit,
            child,
            ARCHIVE_BENCHMARK_CLOSE_TIMEOUT_MS,
          );
        } catch (error) {
          childError = error;
        }
      } finally {
        if (childError) {
          const stopped = await terminateAndWaitForProcessTree(child);
          if (!stopped) {
            childError = new Error(
              "Archive benchmark WDIO process tree did not stop after close failure.",
            );
          }
        }
        await cleanup();
      }
      if (childError) throw childError;
    })();
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
