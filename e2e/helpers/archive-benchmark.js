import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createE2eProfile, REPO_ROOT } from "./profile.js";

const E2E_CONFIG = path.join(REPO_ROOT, "src-tauri", "tauri.e2e.conf.json");
export const ARCHIVE_BENCHMARK_E2E_STAMP_VERSION = "archive-io-e2e-v1";

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
  path.join(REPO_ROOT, "src-tauri", "src"),
  path.join(REPO_ROOT, "src-tauri", "Cargo.toml"),
  path.join(REPO_ROOT, "src-tauri", "Cargo.lock"),
  E2E_CONFIG,
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

function run(command, args, cwd = REPO_ROOT, env = {}) {
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

function ensureReleaseE2eBinary() {
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
    run(npmCommand(), ["run", "prepare:7z"]);
    run(npxCommand(), [
      "tauri",
      "build",
      "--no-bundle",
      "--config",
      E2E_CONFIG,
      "--",
      "--features",
      "e2e",
    ]);
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

function waitForChild(child, timeoutMs = 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Archive benchmark WDIO process did not exit in time."));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(`Archive benchmark WDIO exited with ${code ?? signal}.`),
        );
    });
    child.once("error", reject);
  });
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
export async function createArchiveBenchmarkSession() {
  const binary = ensureReleaseE2eBinary();
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
    });
  } catch (error) {
    await closeServer(server);
    cleanupProfile(profile.profileDir);
    throw error;
  }
  const childExit = waitForChild(child);
  childExit.catch(() => {});
  let closePromise;
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
        } else if (!child.killed) {
          child.kill();
        }
        try {
          await childExit;
        } catch (error) {
          childError = error;
        }
      } finally {
        const socketError = new Error("Archive benchmark session closed.");
        for (const request of pending.values()) request.reject(socketError);
        pending.clear();
        if (socket && !socket.destroyed) socket.destroy();
        await closeServer(server);
        cleanupProfile(profile.profileDir);
      }
      if (childError) throw childError;
    })();
    return closePromise;
  };
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
  return { run, runArchiveBenchmarkOperation: run, close };
}
