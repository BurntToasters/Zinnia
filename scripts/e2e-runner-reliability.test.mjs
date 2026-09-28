import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as e2eRunner from "./test-e2e.js";
import * as archiveBenchmark from "../e2e/helpers/archive-benchmark.js";
import * as testAll from "./test-all.js";

// Failure scenarios and regressions covered here: scripts/e2e-runner-failure-modes.md.

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), "zinnia-e2e-runner-test-"));
}

function initializeGit(root) {
  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const commit = spawnSync(
    "git",
    [
      "-c",
      "user.name=E2E test",
      "-c",
      "user.email=e2e@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
}

function addSidecarFixture(root) {
  const directory = join(root, "src-tauri", "binaries");
  mkdirSync(directory, { recursive: true });
  const sidecar = join(directory, "7z-host");
  writeFileSync(sidecar, "generated sidecar\n");
  return sidecar;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function assertStopped(pid) {
  for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt += 1) {
    await delay(25);
  }
  assert.equal(processIsAlive(pid), false, `process ${pid} should stop`);
}

function windowsProcess(pid, parentPid, second) {
  return {
    pid,
    parentPid,
    created: new Date(Date.UTC(2020, 0, 1, 0, 0, second)).toISOString(),
  };
}

function windowsChild(pid) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill() {
      this.exitCode = 1;
      return true;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
}

test("test:all outer timeout leaves time for E2E cleanup", () => {
  assert.equal(typeof e2eRunner.e2eWrapperTimeoutMs, "function");
  assert.equal(typeof testAll.e2eAggregateTimeoutMs, "function");
  for (const platform of ["linux", "win32"]) {
    const innerTimeout = e2eRunner.e2eWrapperTimeoutMs({}, platform);
    const aggregateTimeout = testAll.e2eAggregateTimeoutMs({}, platform);
    assert.ok(
      aggregateTimeout > innerTimeout + 10_000,
      `${platform} aggregate timeout must allow bounded child cleanup`,
    );
  }
});

test("E2E holds embedded WebDriver port reservation until runner spawn", async () => {
  let closeCount = 0;
  const server = {
    listening: false,
    once(event) {
      assert.equal(event, "error");
      return this;
    },
    listen(port, host, callback) {
      assert.equal(port, 0);
      assert.equal(host, "127.0.0.1");
      this.listening = true;
      callback();
    },
    address() {
      return { port: 50_123 };
    },
    close(callback) {
      closeCount += 1;
      this.listening = false;
      callback();
    },
  };

  assert.equal(typeof e2eRunner.reserveE2eWebdriverPort, "function");
  const reservation = await e2eRunner.reserveE2eWebdriverPort(() => server);
  assert.equal(reservation.port, 50_123);
  assert.equal(server.listening, true, "port stays bound after selection");
  assert.equal(closeCount, 0, "reservation stays active until handoff");
  await reservation.release();
  assert.equal(closeCount, 1, "runner handoff releases the reserved port");
});

test("E2E refuses an invalid reserved port and still releases its listener", async () => {
  let closeCount = 0;
  const server = {
    listening: false,
    once() {
      return this;
    },
    listen(_port, _host, callback) {
      this.listening = true;
      callback();
    },
    address() {
      return { port: 0 };
    },
    close(callback) {
      closeCount += 1;
      this.listening = false;
      callback();
    },
  };

  await assert.rejects(
    e2eRunner.reserveE2eWebdriverPort(() => server),
    /Could not reserve an available E2E WebDriver port/,
  );
  assert.equal(closeCount, 1);
});

test("E2E hands reserved WebDriver port to the app at launch", async () => {
  const root = temporaryRoot();
  let releaseCount = 0;
  try {
    const handoff = await archiveBenchmark.createE2eWebdriverPortHandoff({
      binary: process.execPath,
      args: ["-e", "process.exit(23)"],
      directory: root,
      reservation: {
        port: 50_124,
        async release() {
          releaseCount += 1;
        },
      },
    });
    assert.equal(releaseCount, 0, "reservation remains held before app spawn");
    const child = spawn(handoff.binary, handoff.args, {
      cwd: root,
      env: { ...process.env, ...handoff.env },
      stdio: "ignore",
      windowsHide: true,
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 23, "launcher preserves the app exit code");
    assert.equal(releaseCount, 1, "app launch performs one port handoff");
    await handoff.release();
    assert.equal(releaseCount, 1, "cleanup release is idempotent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive benchmark keeps WebDriver reservation through WDIO spawn", () => {
  const source = readFileSync(
    new URL("../e2e/helpers/archive-benchmark.js", import.meta.url),
    "utf8",
  );
  const runnerStart = source.slice(
    source.indexOf("export async function createArchiveBenchmarkSession"),
  );
  const spawnStart = runnerStart.indexOf('child.once("spawn", resolve)');
  const spawnCatch = runnerStart.indexOf("} catch (error)", spawnStart);
  const spawnWait = runnerStart.slice(spawnStart, spawnCatch);
  assert.ok(spawnWait.includes('child.once("spawn", resolve)'));
  assert.doesNotMatch(
    spawnWait,
    /webdriverReservation\.release\(\)/,
    "WDIO spawn must not release the socket; only the one-use app launcher does",
  );
});

test("release benchmark freshness uses content hashes when mtimes stay fixed", () => {
  const root = temporaryRoot();
  try {
    const source = join(root, "src", "main.rs");
    const binary = join(root, "zinnia");
    const stamp = join(root, "stamp.json");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(source, 'fn main() { println!("v1"); }\n');
    writeFileSync(binary, "feature-enabled binary v1\n");
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(source, fixedTime, fixedTime);
    utimesSync(binary, fixedTime, fixedTime);
    const sourceDigest = archiveBenchmark.archiveBenchmarkBuildInputSha256([
      source,
    ]);
    archiveBenchmark.writeArchiveBenchmarkE2eStamp({
      binary,
      stamp,
      inputPaths: [source],
    });
    assert.equal(
      archiveBenchmark.isArchiveBenchmarkE2eBinaryFresh({
        binary,
        stamp,
        inputPaths: [source],
      }),
      true,
    );

    writeFileSync(source, 'fn main() { println!("v2"); }\n');
    utimesSync(source, fixedTime, fixedTime);
    assert.notEqual(
      archiveBenchmark.archiveBenchmarkBuildInputSha256([source]),
      sourceDigest,
      "same-mtime source content change must alter build-input digest",
    );
    assert.equal(
      archiveBenchmark.isArchiveBenchmarkE2eBinaryFresh({
        binary,
        stamp,
        inputPaths: [source],
      }),
      false,
      "same-mtime source edit must stale prior benchmark binary",
    );

    archiveBenchmark.writeArchiveBenchmarkE2eStamp({
      binary,
      stamp,
      inputPaths: [source],
    });
    writeFileSync(binary, "feature-enabled binary v2\n");
    utimesSync(binary, fixedTime, fixedTime);
    assert.equal(
      archiveBenchmark.isArchiveBenchmarkE2eBinaryFresh({
        binary,
        stamp,
        inputPaths: [source],
      }),
      false,
      "same-mtime binary replacement must invalidate benchmark stamp",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release benchmark rejects build-input changes during compilation", () => {
  const root = temporaryRoot();
  try {
    const source = join(root, "src", "main.rs");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(source, 'fn main() { println!("v1"); }\n');
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(source, fixedTime, fixedTime);
    const before = archiveBenchmark.archiveBenchmarkBuildInputSnapshot([
      source,
    ]);
    writeFileSync(source, 'fn main() { println!("v2"); }\n');
    utimesSync(source, fixedTime, fixedTime);
    const after = archiveBenchmark.archiveBenchmarkBuildInputSnapshot([source]);
    assert.throws(
      () =>
        archiveBenchmark.assertArchiveBenchmarkBuildInputsUnchanged(
          before,
          after,
        ),
      /changed during build.*main\.rs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E stamp uses the exact build-input snapshot that passed validation", () => {
  const root = temporaryRoot();
  try {
    const source = join(root, "src", "main.ts");
    const binary = join(root, "zinnia");
    const stamp = join(root, "stamp.json");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(source, "export const version = 1;\n");
    writeFileSync(binary, "binary built from version 1\n");
    const validatedSnapshot = e2eRunner.e2eBuildInputSnapshot(root);

    // Reproduce an edit in the gap between the final validation read and stamp write.
    writeFileSync(source, "export const version = 2;\n");
    e2eRunner.writeE2eStamp({
      root,
      binary,
      stamp,
      buildInputSnapshot: validatedSnapshot,
    });

    assert.equal(
      e2eRunner.isE2eBinaryFresh({ root, binary, stamp }),
      false,
      "a post-validation source edit must leave the just-built binary stale",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows cleanup fails closed when captured descendants survive", async () => {
  const child = windowsChild(51_234);
  const descendant = windowsProcess(51_235, child.pid, 1);
  const leader = windowsProcess(child.pid, 1, 0);
  await archiveBenchmark.captureWindowsProcessIdentity(child, {
    platform: "win32",
    readWindowsProcessTable: async () => [leader, descendant],
    captureIntervalMs: 2,
  });
  child.exitCode = 1;
  assert.equal(
    await archiveBenchmark.terminateAndWaitForProcessTree(child, {
      platform: "win32",
      processTreeCleanupTimeoutMs: 60,
      processTreeScanDelayMs: 2,
      readWindowsProcessTable: async () => [descendant],
      killWindowsProcess: async () => false,
    }),
    false,
    "a live identity captured before leader exit must still be proven stopped",
  );
});

test("Windows cleanup kills only descendants captured while their ancestry is live", async () => {
  const child = windowsChild(51_234);
  const leader = windowsProcess(child.pid, 1, 0);
  const descendant = windowsProcess(51_235, child.pid, 1);
  const grandchild = windowsProcess(51_236, descendant.pid, 2);
  const killed = new Set();
  let reads = 0;
  const readWindowsProcessTable = async () => {
    reads += 1;
    if (child.exitCode !== null) {
      return [descendant, grandchild].filter((item) => !killed.has(item.pid));
    }
    if (reads === 1) return [leader];
    if (reads === 2) return [leader, descendant];
    return [leader, descendant, grandchild];
  };
  await archiveBenchmark.captureWindowsProcessIdentity(child, {
    platform: "win32",
    readWindowsProcessTable,
    captureIntervalMs: 2,
  });
  for (let attempt = 0; attempt < 100 && reads < 3; attempt += 1) {
    await delay(2);
  }
  assert.ok(reads >= 3, "tracker observes later descendants before root exit");
  child.exitCode = 0;
  const stopped = await archiveBenchmark.terminateAndWaitForProcessTree(child, {
    platform: "win32",
    readWindowsProcessTable,
    processTreeScanDelayMs: 2,
    killWindowsProcess: async (processInfo) => {
      killed.add(processInfo.pid);
      return true;
    },
  });
  assert.equal(stopped, true);
  assert.deepEqual([...killed], [grandchild.pid, descendant.pid]);
});

test("Windows cleanup terminates an active leader with an empty process snapshot", async () => {
  let identityKillCount = 0;
  const child = {
    pid: 51_234,
    exitCode: null,
    signalCode: null,
    kill() {
      this.exitCode = 1;
      return true;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
  await archiveBenchmark.captureWindowsProcessIdentity(child, {
    platform: "win32",
    readWindowsProcessTable: async () => [
      { pid: child.pid, parentPid: 1, created: "leader" },
    ],
  });
  assert.equal(
    await archiveBenchmark.terminateAndWaitForProcessTree(child, {
      platform: "win32",
      readWindowsProcessTable: async () => [],
      killWindowsProcess: async (processInfo) => {
        assert.equal(processInfo.created, "leader");
        identityKillCount += 1;
        child.exitCode = 1;
        return true;
      },
    }),
    true,
  );
  assert.equal(identityKillCount, 1);
});

test("Windows cleanup refuses descendants first observed after leader exit", async () => {
  const child = windowsChild(51_234);
  const leader = windowsProcess(child.pid, 1, 0);
  await archiveBenchmark.captureWindowsProcessIdentity(child, {
    platform: "win32",
    readWindowsProcessTable: async () => [leader],
    captureIntervalMs: 2,
  });
  child.exitCode = 0;
  const descendant = windowsProcess(51_235, child.pid, 1);
  const grandchild = windowsProcess(51_236, descendant.pid, 2);
  let killCount = 0;
  assert.equal(
    await archiveBenchmark.terminateAndWaitForProcessTree(child, {
      platform: "win32",
      processTreeCleanupTimeoutMs: 40,
      processTreeScanDelayMs: 2,
      readWindowsProcessTable: async () => [descendant, grandchild],
      killWindowsProcess: async () => {
        killCount += 1;
        return true;
      },
    }),
    false,
  );
  assert.equal(
    killCount,
    0,
    "exit-time PPID ancestry must not authorize kills",
  );
});

test("Windows cleanup rejects a reused leader identity without killing its tree", async () => {
  const child = windowsChild(51_234);
  const originalLeader = windowsProcess(child.pid, 1, 0);
  const reusedLeader = windowsProcess(child.pid, 1, 1);
  const unrelatedChild = windowsProcess(51_235, child.pid, 2);
  const identity = await archiveBenchmark.captureWindowsProcessIdentity(child, {
    platform: "win32",
    readWindowsProcessTable: async () => [originalLeader],
    captureIntervalMs: 2,
  });
  assert.deepEqual(identity, {
    pid: child.pid,
    created: originalLeader.created,
  });
  child.exitCode = 1;
  let killCount = 0;
  assert.equal(
    await archiveBenchmark.terminateAndWaitForProcessTree(child, {
      platform: "win32",
      readWindowsProcessTable: async () => [reusedLeader, unrelatedChild],
      killWindowsProcess: async () => {
        killCount += 1;
        return true;
      },
    }),
    false,
  );
  assert.equal(killCount, 0, "creation-time mismatch must be fail-closed");
});

test("Windows cleanup fails closed when a new subchild appears after leader exit", async () => {
  const child = windowsChild(51_234);
  const leader = windowsProcess(child.pid, 1, 0);
  const descendant = windowsProcess(51_235, child.pid, 1);
  await archiveBenchmark.captureWindowsProcessIdentity(child, {
    platform: "win32",
    readWindowsProcessTable: async () => [leader, descendant],
    captureIntervalMs: 2,
  });
  child.exitCode = 0;
  const lateGrandchild = windowsProcess(51_236, descendant.pid, 2);
  const killedPids = [];
  assert.equal(
    await archiveBenchmark.terminateAndWaitForProcessTree(child, {
      platform: "win32",
      processTreeCleanupTimeoutMs: 40,
      processTreeScanDelayMs: 2,
      readWindowsProcessTable: async () => [descendant, lateGrandchild],
      killWindowsProcess: async (processInfo) => {
        killedPids.push(processInfo.pid);
        return true;
      },
    }),
    false,
  );
  assert.equal(
    killedPids.includes(lateGrandchild.pid),
    false,
    "unseen post-exit subchild stays untouched",
  );
});

test("bounded command reports unproven Windows cleanup after delayed capture", async () => {
  const root = temporaryRoot();
  const leader = windowsProcess(51_234, 1, 0);
  const descendant = windowsProcess(51_235, leader.pid, 1);
  const grandchild = windowsProcess(51_236, descendant.pid, 2);
  let killCount = 0;
  const cleanupRecords = [];
  try {
    await assert.rejects(
      e2eRunner.runBoundedCommand(process.execPath, ["-e", "process.exit(0)"], {
        cwd: root,
        timeoutMs: 5_000,
        processPlatform: "win32",
        windowsProcessOptions: {
          captureIntervalMs: 2,
          readWindowsProcessTable: async () => {
            await delay(100);
            return [leader, descendant, grandchild];
          },
        },
        processTreeCleanupOptions: {
          processTreeCleanupTimeoutMs: 20,
          killWindowsProcess: async () => {
            killCount += 1;
            return true;
          },
        },
        onProcessTreeCleanup: (record) => cleanupRecords.push(record),
      }),
      /cleanup could not be verified/,
    );
    assert.equal(cleanupRecords[0]?.status, "unproven");
    assert.match(cleanupRecords[0]?.reason, /leader identity/);
    assert.equal(
      killCount,
      0,
      "exit-time child and subchild are never adopted",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "archive benchmark build rejects successful commands with unproven Windows cleanup",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryRoot();
    try {
      await assert.rejects(
        archiveBenchmark.runArchiveBenchmarkBuildCommand(
          process.execPath,
          ["-e", "process.exit(0)"],
          root,
          {},
          undefined,
          {
            processPlatform: "win32",
            windowsProcessOptions: {
              captureIntervalMs: 2,
              readWindowsProcessTable: async () => {
                await delay(100);
                return [];
              },
            },
            processTreeCleanupOptions: {
              processTreeCleanupTimeoutMs: 40,
            },
          },
        ),
        /cleanup could not be verified/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("timed-out Windows command bounds cleanup when identity capture is delayed", async () => {
  const root = temporaryRoot();
  const pidFile = join(root, "leader.pid");
  let leaderPid = null;
  try {
    const code = [
      "const fs=require('node:fs');",
      "fs.writeFileSync(process.argv[1],String(process.pid));",
      "setInterval(()=>{},1000);",
    ].join("");
    const startedAt = Date.now();
    await assert.rejects(
      e2eRunner.runBoundedCommand(process.execPath, ["-e", code, pidFile], {
        cwd: root,
        timeoutMs: 100,
        processPlatform: "win32",
        windowsProcessOptions: {
          captureIntervalMs: 2,
          readWindowsProcessTable: async () => {
            await delay(250);
            return [];
          },
        },
        processTreeCleanupOptions: { processTreeCleanupTimeoutMs: 60 },
      }),
      /cleanup could not be verified/,
    );
    assert.ok(Date.now() - startedAt < 1_000, "cleanup observes its deadline");
    leaderPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(processIsAlive(leaderPid), "unknown PID was not killed");
  } finally {
    if (!leaderPid && existsSync(pidFile)) {
      leaderPid = Number(readFileSync(pidFile, "utf8"));
    }
    if (leaderPid && processIsAlive(leaderPid)) {
      process.kill(leaderPid, "SIGKILL");
      await assertStopped(leaderPid);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive benchmark workflow writes diagnostics after preparation failures", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/archive-io-benchmark.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /name: Write archive benchmark setup diagnostics/);
  const diagnostics = workflow.slice(
    workflow.indexOf("name: Write archive benchmark setup diagnostics"),
    workflow.indexOf("name: Upload archive I/O release report"),
  );
  assert.match(diagnostics, /if: always\(\)/);
  assert.match(diagnostics, /archive-io-setup-diagnostics\.json/);
  assert.match(diagnostics, /archive-io-setup-diagnostics\.log/);
  assert.match(
    workflow,
    /ZINNIA_BENCH_EXPECTED_CANDIDATE_REVISION:\s*\$\{\{\s*steps\.checkout\.outputs\.commit\s*\}\}/,
  );
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(
    workflow,
    /hard cancellation|hard runner loss/i,
    "workflow must document when its always-run diagnostic cannot execute",
  );
});

test(
  "Windows live process-tree cleanup leaves no child or grandchild",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const root = temporaryRoot();
    const pidFile = join(root, "descendant.pid");
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
      "fs.writeFileSync(process.argv[1], String(grandchild.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const leader = spawn(process.execPath, ["-e", childSource, pidFile], {
      stdio: "ignore",
      windowsHide: true,
    });
    let descendantPid = null;
    try {
      for (
        let attempt = 0;
        attempt < 200 && !existsSync(pidFile);
        attempt += 1
      ) {
        await delay(25);
      }
      assert.equal(existsSync(pidFile), true, "descendant PID was written");
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(descendantPid > 0);
      const leaderIdentity =
        await archiveBenchmark.captureWindowsProcessIdentity(leader);
      assert.equal(
        leaderIdentity?.pid,
        leader.pid,
        "capture original leader PID and creation time while it is alive",
      );
      assert.equal(
        await archiveBenchmark.terminateAndWaitForProcessTree(leader, {
          platform: "win32",
        }),
        true,
      );
      await assertStopped(leader.pid);
      await assertStopped(descendantPid);
    } finally {
      for (const pid of new Set([leader.pid, descendantPid])) {
        if (!pid || !processIsAlive(pid)) continue;
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 10_000,
        });
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows fenced launch preserves command behavior and removes fast detached descendants",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const root = temporaryRoot();
    const profile = join(root, "profile");
    mkdirSync(profile);
    const lockedFile = join(profile, "session.lock");
    const pidFile = join(root, "grandchild.pid");
    const reportFile = join(root, "command.json");
    const logFile = join(root, "command.log");
    writeFileSync(lockedFile, "profile held by the child\n");
    const grandchildSource =
      'const fs=require("node:fs");fs.openSync(process.argv[1],"r");setInterval(()=>{},1000);';
    const commandSource = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      "const [pidFile,reportFile,profileFile,...args]=process.argv.slice(1);",
      `const grandchild=spawn(process.execPath,["-e",${JSON.stringify(grandchildSource)},profileFile],{stdio:"ignore",windowsHide:true,detached:true});`,
      "grandchild.unref();",
      "fs.writeFileSync(pidFile,String(grandchild.pid));",
      "fs.writeFileSync(reportFile,JSON.stringify({args,cwd:process.cwd(),marker:process.env.ZINNIA_FENCE_MARKER}));",
      'process.stdout.write("fence stdout\\n");',
      'process.stderr.write("fence stderr\\n");',
      "setTimeout(()=>process.exit(23),400);",
    ].join(" ");
    const cleanupRecords = [];
    let grandchildPid = null;
    try {
      await assert.rejects(
        e2eRunner.runBoundedCommand(
          process.execPath,
          [
            "-e",
            commandSource,
            pidFile,
            reportFile,
            lockedFile,
            "argument with spaces",
            'quoted "value"',
          ],
          {
            cwd: root,
            env: { ZINNIA_FENCE_MARKER: "preserved-environment" },
            timeoutMs: 10_000,
            logFile,
            onProcessTreeCleanup: (record) => cleanupRecords.push(record),
          },
        ),
        /exited with 23/,
      );
      assert.equal(cleanupRecords[0]?.status, "verified");
      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      assert.deepEqual(report.args, ["argument with spaces", 'quoted "value"']);
      assert.equal(report.cwd, root);
      assert.equal(report.marker, "preserved-environment");
      const log = readFileSync(logFile, "utf8");
      assert.match(log, /fence stdout/);
      assert.match(log, /fence stderr/);
      grandchildPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(grandchildPid > 0);
      await assertStopped(grandchildPid);
      rmSync(profile, { recursive: true, force: true });
      assert.equal(
        existsSync(profile),
        false,
        "profile can be removed after cleanup",
      );
    } finally {
      if (grandchildPid && processIsAlive(grandchildPid)) {
        spawnSync("taskkill", ["/PID", String(grandchildPid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 10_000,
        });
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows cleanup catches a resistant descendant created after its first snapshot",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const root = temporaryRoot();
    const triggerFile = join(root, "spawn-late-descendant");
    const workerPidFile = join(root, "worker.pid");
    const latePidFile = join(root, "late-descendant.pid");
    const workerSource = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      "const [triggerFile, latePidFile] = process.argv.slice(1);",
      "let spawned = false;",
      'process.on("SIGTERM", () => {});',
      'const timer = setInterval(() => { if (!spawned && fs.existsSync(triggerFile)) { spawned = true; const late = spawn(process.execPath, ["-e", "process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true }); fs.writeFileSync(latePidFile, String(late.pid)); } }, 10);',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const leaderSource = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => {});',
      `const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerSource)}, ${JSON.stringify(triggerFile)}, ${JSON.stringify(latePidFile)}], { stdio: "ignore", windowsHide: true });`,
      "fs.writeFileSync(process.argv[1], String(worker.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const leader = spawn(
      process.execPath,
      ["-e", leaderSource, workerPidFile],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    let workerPid = null;
    let latePid = null;
    let lateDescendantAppeared = false;
    try {
      for (
        let attempt = 0;
        attempt < 200 && !existsSync(workerPidFile);
        attempt += 1
      ) {
        await delay(25);
      }
      assert.equal(existsSync(workerPidFile), true, "worker PID was written");
      workerPid = Number(readFileSync(workerPidFile, "utf8"));
      assert.ok(workerPid > 0);
      assert.ok(
        await archiveBenchmark.captureWindowsProcessIdentity(leader),
        "capture leader identity before starting cleanup",
      );
      const stopped = await archiveBenchmark.terminateAndWaitForProcessTree(
        leader,
        {
          platform: "win32",
          killWindowsProcessTree: async (processChild) => {
            assert.equal(processChild.pid, leader.pid);
            writeFileSync(triggerFile, "spawn now\n");
            for (
              let attempt = 0;
              attempt < 200 && !existsSync(latePidFile);
              attempt += 1
            ) {
              await delay(10);
            }
            lateDescendantAppeared = existsSync(latePidFile);
            if (!lateDescendantAppeared) return false;
            const result = spawnSync(
              "taskkill",
              ["/PID", String(processChild.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true, timeout: 10_000 },
            );
            return !result.error && result.status === 0;
          },
        },
      );
      assert.equal(
        lateDescendantAppeared,
        true,
        "late child started after first scan",
      );
      assert.equal(stopped, true, "cleanup proves the full tree stopped");
      latePid = Number(readFileSync(latePidFile, "utf8"));
      assert.ok(latePid > 0);
      await assertStopped(leader.pid);
      await assertStopped(workerPid);
      await assertStopped(latePid);
    } finally {
      for (const pid of new Set([leader.pid, workerPid, latePid])) {
        if (!pid || !processIsAlive(pid)) continue;
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 10_000,
        });
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("E2E stamp follows source and binary content", () => {
  const root = temporaryRoot();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src-tauri", "target", "debug"), {
      recursive: true,
    });
    mkdirSync(join(root, "src-tauri", "binaries"), { recursive: true });
    const source = join(root, "src", "main.ts");
    const binary = join(root, "src-tauri", "target", "debug", "zinnia");
    const stamp = join(
      root,
      "src-tauri",
      "target",
      "debug",
      ".zinnia-e2e-stamp",
    );
    const sidecar = join(root, "src-tauri", "binaries", "7z-host");
    writeFileSync(source, "export const version = 1;\n");
    writeFileSync(binary, "E2E binary v1\n");
    writeFileSync(sidecar, "generated sidecar v1\n");
    const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const add = spawnSync("git", ["add", "src/main.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(add.status, 0, add.stderr);

    e2eRunner.writeE2eStamp({ root, binary, stamp });
    assert.equal(e2eRunner.isE2eBinaryFresh({ root, binary, stamp }), true);
    const stampProof = JSON.parse(readFileSync(stamp, "utf8"));
    const sourceSha256 = e2eRunner.e2eSourceSha256(root);
    assert.equal(
      stampProof.externalBinaries["7z-host"],
      createHash("sha256").update(readFileSync(sidecar)).digest("hex"),
    );
    writeFileSync(sidecar, "generated sidecar v2\n");
    assert.equal(e2eRunner.e2eSourceSha256(root), sourceSha256);
    assert.equal(e2eRunner.isE2eBinaryFresh({ root, binary, stamp }), false);
    e2eRunner.writeE2eStamp({ root, binary, stamp });
    writeFileSync(source, "export const version = 2;\n");
    assert.equal(e2eRunner.isE2eBinaryFresh({ root, binary, stamp }), false);
    e2eRunner.writeE2eStamp({ root, binary, stamp });
    writeFileSync(binary, "E2E binary v2\n");
    assert.equal(e2eRunner.isE2eBinaryFresh({ root, binary, stamp }), false);
    const envA = { ...process.env, APPLE_TEAM_ID: "TEAM-A" };
    const envB = { ...process.env, APPLE_TEAM_ID: "TEAM-B" };
    e2eRunner.writeE2eStamp({ root, binary, stamp, env: envA });
    assert.equal(
      e2eRunner.isE2eBinaryFresh({ root, binary, stamp, env: envA }),
      true,
    );
    assert.equal(
      e2eRunner.isE2eBinaryFresh({ root, binary, stamp, env: envB }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "bounded command stops a resistant descendant",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryRoot();
    const pidFile = join(root, "descendant.pid");
    const logFile = join(root, "command.log");
    try {
      const code = [
        "const {spawn}=require('node:child_process');",
        "const fs=require('node:fs');",
        "process.on('SIGTERM',()=>{});",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
        "fs.writeFileSync(process.argv[1],String(child.pid));",
        "setInterval(()=>{},1000);",
      ].join("");
      await assert.rejects(
        e2eRunner.runBoundedCommand(process.execPath, ["-e", code, pidFile], {
          cwd: root,
          timeoutMs: 300,
          logFile,
        }),
        /timed out/,
      );
      assert.equal(existsSync(logFile), true);
      const descendantPid = Number(readFileSync(pidFile, "utf8"));
      await assertStopped(descendantPid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "successful bounded command stops detached descendants",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryRoot();
    const pidFile = join(root, "descendant.pid");
    try {
      const code = [
        "const {spawn}=require('node:child_process');",
        "const fs=require('node:fs');",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
        "fs.writeFileSync(process.argv[1],String(child.pid));",
        "process.exit(0);",
      ].join("");
      await e2eRunner.runBoundedCommand(
        process.execPath,
        ["-e", code, pidFile],
        { cwd: root, timeoutMs: 5_000 },
      );
      const descendantPid = Number(readFileSync(pidFile, "utf8"));
      await assertStopped(descendantPid);
    } finally {
      if (existsSync(pidFile)) {
        const descendantPid = Number(readFileSync(pidFile, "utf8"));
        if (processIsAlive(descendantPid))
          process.kill(descendantPid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "nonzero archive build stops detached descendants",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryRoot();
    const pidFile = join(root, "descendant.pid");
    try {
      const code = [
        "const {spawn}=require('node:child_process');",
        "const fs=require('node:fs');",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
        "fs.writeFileSync(process.argv[1],String(child.pid));",
        "process.exit(17);",
      ].join("");
      await assert.rejects(
        archiveBenchmark.runArchiveBenchmarkBuildCommand(
          process.execPath,
          ["-e", code, pidFile],
          root,
        ),
        /exited with 17/,
      );
      const descendantPid = Number(readFileSync(pidFile, "utf8"));
      await assertStopped(descendantPid);
    } finally {
      if (existsSync(pidFile)) {
        const descendantPid = Number(readFileSync(pidFile, "utf8"));
        if (processIsAlive(descendantPid))
          process.kill(descendantPid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("benchmark close write error terminates WDIO child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  const identityCapture = archiveBenchmark.captureWindowsProcessIdentity(
    child,
    { waitForSpawn: true },
  );
  const childExit = archiveBenchmark.waitForChild(child);
  childExit.catch(() => {});
  let cleaned = false;
  const socket = {
    destroyed: false,
    write(_payload, callback) {
      callback(new Error("close socket write failed"));
    },
  };
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await identityCapture;
    await assert.rejects(
      archiveBenchmark.closeArchiveBenchmarkSession({
        socket,
        child,
        childExit,
        cleanup: async () => {
          cleaned = true;
        },
      }),
      /close socket write failed/,
    );
    assert.equal(cleaned, true);
    await assertStopped(child.pid);
  } finally {
    if (processIsAlive(child.pid)) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
      await childExit.catch(() => {});
    }
  }
});

test("E2E artifact records suite outcomes and verifiable hashes", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const reportDir = join(root, "report");
    mkdirSync(reportDir, { recursive: true });
    const logFile = join(reportDir, "main.log");
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(logFile, "1 passing\n");
    const sidecar = addSidecarFixture(root);
    initializeGit(root);
    const evidence = e2eRunner.captureE2eEvidence({
      root,
      binary,
      fixtureManifest: manifest,
    });
    e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      commit: evidence.commit,
      evidence,
      status: "passed",
      suites: [{ spec: "./specs/main.spec.js", status: "passed", logFile }],
    });
    const report = JSON.parse(
      readFileSync(join(reportDir, "result.json"), "utf8"),
    );
    const digest = (file) =>
      createHash("sha256").update(readFileSync(file)).digest("hex");
    assert.equal(report.status, "passed");
    assert.match(report.commit, /^[0-9a-f]{40}$/i);
    assert.equal(report.binary.sha256, digest(binary));
    assert.equal(report.fixtures.manifestSha256, digest(manifest));
    assert.equal(report.externalBinaries["7z-host"], digest(sidecar));
    assert.equal(report.verification.inputsUnchanged, true);
    assert.equal(report.processCleanup.status, "not-recorded");
    assert.equal(report.suites[0].logSha256, digest(logFile));
    assert.equal(report.replay.command, "npm run test:e2e");

    const unprovenWindowsArtifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      commit: evidence.commit,
      evidence,
      platform: "win32",
      status: "passed",
      suites: [{ spec: "./specs/main.spec.js", status: "passed", logFile }],
      processCleanup: [{ command: "wdio", status: "unproven" }],
    });
    assert.equal(
      unprovenWindowsArtifact.status,
      "failed",
      "Windows cannot record a successful E2E proof without verified cleanup",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI E2E proof validators require verified process cleanup", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const cleanupChecks = workflow.match(
    /!\["verified","build-unproven","capture-gap"\]\.includes\(r\.processCleanup\?\.status\)/g,
  );
  assert.equal(
    cleanupChecks?.length,
    2,
    "quality-gate and matrix E2E proof validators accept only verified cleanup or a warned build step",
  );
});

test("E2E artifact records when Windows process cleanup is unproven", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const reportDir = join(root, "report");
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    const artifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      status: "failed",
      failure: "test evidence",
      processCleanup: [
        {
          command: "node",
          status: "unproven",
          reason: "leader identity was not captured before exit",
        },
      ],
    });
    assert.deepEqual(artifact.processCleanup, {
      status: "unproven",
      commands: [
        {
          command: "node",
          status: "unproven",
          reason: "leader identity was not captured before exit",
        },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E artifact cannot pass if the tested binary changes mid-run", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const fixture = join(root, "hello.7z");
    const source = join(root, "src", "app.ts");
    const reportDir = join(root, "report");
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    const logFile = join(reportDir, "main.log");
    writeFileSync(binary, "feature-enabled binary v1\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(fixture, "archive fixture v1\n");
    writeFileSync(source, "export const version = 1;\n");
    writeFileSync(logFile, "1 passing\n");
    addSidecarFixture(root);
    initializeGit(root);
    const evidence = e2eRunner.captureE2eEvidence({
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
    });
    writeFileSync(binary, "feature-enabled binary v2\n");
    writeFileSync(fixture, "archive fixture v2\n");
    writeFileSync(source, "export const version = 2;\n");
    const artifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
      commit: evidence.commit,
      evidence,
      status: "passed",
      suites: [{ spec: "./specs/main.spec.js", status: "passed", logFile }],
    });
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.verification.inputsUnchanged, false);
    assert.match(artifact.failure, /changed during run/);
    assert.equal(
      artifact.fixtures.files["hello.7z"],
      createHash("sha256").update("archive fixture v1\n").digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E artifact persists a failed run when fixture evidence disappears", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const fixture = join(root, "hello.7z");
    const reportDir = join(root, "report");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(fixture, "archive fixture\n");
    addSidecarFixture(root);
    initializeGit(root);
    const evidence = e2eRunner.captureE2eEvidence({
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
    });
    rmSync(fixture);
    const artifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
      commit: evidence.commit,
      evidence,
      status: "failed",
      failure: "fixture vanished",
    });
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.verification.inputsUnchanged, false);
    assert.equal(existsSync(join(reportDir, "result.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E artifact persists but cannot pass without a hashable suite log", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const fixture = join(root, "hello.7z");
    const reportDir = join(root, "report");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(fixture, "archive fixture\n");
    addSidecarFixture(root);
    initializeGit(root);
    const evidence = e2eRunner.captureE2eEvidence({
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
    });
    const artifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
      commit: evidence.commit,
      evidence,
      status: "passed",
      suites: [
        {
          spec: "./specs/main.spec.js",
          status: "passed",
          logFile: reportDir,
        },
      ],
    });
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.suites[0].logSha256, null);
    assert.equal(existsSync(join(reportDir, "result.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E artifact cannot pass without a verifiable current HEAD", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const fixture = join(root, "hello.7z");
    const reportDir = join(root, "report");
    mkdirSync(reportDir, { recursive: true });
    const logFile = join(reportDir, "main.log");
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(fixture, "archive fixture\n");
    addSidecarFixture(root);
    writeFileSync(logFile, "1 passing\n");
    const evidence = e2eRunner.captureE2eEvidence({
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
      commit: "e".repeat(40),
    });
    const artifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
      commit: evidence.commit,
      evidence,
      status: "passed",
      suites: [{ spec: "./specs/main.spec.js", status: "passed", logFile }],
    });
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.verification.inputsUnchanged, false);
    assert.equal(existsSync(join(reportDir, "result.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E artifact cannot pass if HEAD changes during the suites", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const fixture = join(root, "hello.7z");
    const reportDir = join(root, "report");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(fixture, "archive fixture\n");
    addSidecarFixture(root);
    const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const firstCommit = spawnSync(
      "git",
      [
        "-c",
        "user.name=E2E test",
        "-c",
        "user.email=e2e@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "first",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(firstCommit.status, 0, firstCommit.stderr);
    const evidence = e2eRunner.captureE2eEvidence({
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
    });
    const secondCommit = spawnSync(
      "git",
      [
        "-c",
        "user.name=E2E test",
        "-c",
        "user.email=e2e@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "second",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(secondCommit.status, 0, secondCommit.stderr);
    const logFile = join(reportDir, "main.log");
    writeFileSync(logFile, "1 passing\n");
    const artifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      fixtureFiles: { "hello.7z": fixture },
      commit: evidence.commit,
      evidence,
      status: "passed",
      suites: [{ spec: "./specs/main.spec.js", status: "passed", logFile }],
    });
    assert.equal(artifact.commit, evidence.commit);
    assert.notEqual(
      artifact.commit,
      e2eRunner.captureE2eEvidence({ root }).commit,
    );
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.verification.inputsUnchanged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI validates and uploads the E2E proof directory", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /r\.commit!==process\.env\.GITHUB_SHA/);
  assert.match(workflow, /r\.verification\?\.inputsUnchanged!==true/);
  assert.match(workflow, /r\.binary\?\.sha256/);
  assert.match(workflow, /r\.buildEnvironmentSha256/);
  assert.match(workflow, /r\.fixtures\?\.manifestSha256/);
  assert.match(workflow, /name: e2e-proof-\$\{\{ matrix\.os \}\}/);
  assert.match(workflow, /path: coverage\/e2e/);
  const qualityGate = workflow.slice(
    workflow.indexOf("  quality-gate:"),
    workflow.indexOf("  archive-io-benchmark:"),
  );
  assert.match(
    qualityGate,
    /name: Upload quality-gate E2E proof[\s\S]*?if: always\(\)/,
  );
  assert.match(qualityGate, /name: e2e-proof-quality-gate/);
  assert.match(qualityGate, /path: coverage\/e2e/);
});

test("CI preserves benchmark setup diagnostics and always uploads E2E proof", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  for (const [jobName, nextJobName] of [
    ["archive-io-benchmark:", "  archive-io-promotion-benchmark:"],
    ["archive-io-promotion-benchmark:", "  rust-check:"],
  ]) {
    const start = workflow.indexOf(`  ${jobName}`);
    const nextJob = workflow.indexOf(nextJobName, start + jobName.length + 2);
    const job = workflow.slice(start, nextJob);
    assert.match(job, /name: Capture archive benchmark setup diagnostics/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /workflow-diagnostics\.txt/);
    assert.match(job, /name: Upload archive I\/O .*report/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /path: \$\{\{ runner\.temp \}\}\/zinnia-archive-io/);
  }
  assert.match(
    workflow,
    /hard job cancellation can terminate the runner before this diagnostic step runs/i,
  );
});

test("WDIO captures app startup logs in the E2E proof", () => {
  const wdioConfig = readFileSync(
    new URL("../e2e/wdio.conf.js", import.meta.url),
    "utf8",
  );
  assert.match(wdioConfig, /logLevel:\s*"warn"/);
  assert.match(wdioConfig, /captureBackendLogs:\s*true/);
  assert.match(wdioConfig, /backendLogLevel:\s*"debug"/);
});

test("Flatpak npm version matches packageManager pin", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const flatpak = readFileSync(
    new URL("../run.rosie.zinnia.yml", import.meta.url),
    "utf8",
  );
  const npmVersion = packageJson.packageManager.replace(/^npm@/, "");
  assert.match(
    flatpak,
    new RegExp(`npm@${npmVersion.replaceAll(".", "\\.")}\\b`),
  );
  assert.doesNotMatch(flatpak, /npm@12\s+--/);
});

// Windows build steps (npm/npx/cargo) can leave toolchain helpers whose
// ownership the PID+creation-time scan cannot prove. A successful build step
// records "build-unproven" and continues; failures and non-build commands
// stay fail-closed.
const unprovableWindowsCleanup = {
  processPlatform: "win32",
  windowsProcessOptions: {
    captureIntervalMs: 2,
    readWindowsProcessTable: async () => {
      await delay(100);
      return [];
    },
  },
  processTreeCleanupOptions: { processTreeCleanupTimeoutMs: 40 },
};

test("successful Windows build step with unproven cleanup warns and continues", async () => {
  const root = temporaryRoot();
  const cleanupRecords = [];
  try {
    const result = await e2eRunner.runBoundedCommand(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        cwd: root,
        timeoutMs: 5_000,
        allowBuildCleanupWarning: true,
        ...unprovableWindowsCleanup,
        onProcessTreeCleanup: (record) => cleanupRecords.push(record),
      },
    );
    assert.equal(result.processTreeCleanup.status, "build-unproven");
    assert.equal(cleanupRecords[0]?.status, "build-unproven");
    assert.match(cleanupRecords[0]?.reason, /leader identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed Windows build step with unproven cleanup still fails", async () => {
  const root = temporaryRoot();
  try {
    await assert.rejects(
      e2eRunner.runBoundedCommand(process.execPath, ["-e", "process.exit(3)"], {
        cwd: root,
        timeoutMs: 5_000,
        allowBuildCleanupWarning: true,
        ...unprovableWindowsCleanup,
      }),
      /exited with 3|cleanup could not be verified/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "archive benchmark build step with unproven cleanup warns when allowed",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryRoot();
    try {
      const result = await archiveBenchmark.runArchiveBenchmarkBuildCommand(
        process.execPath,
        ["-e", "process.exit(0)"],
        root,
        {},
        undefined,
        { allowBuildCleanupWarning: true, ...unprovableWindowsCleanup },
      );
      assert.equal(result.processTreeCleanup.status, "build-unproven");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Windows E2E artifact passes with warned build steps but not unproven sessions", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const reportDir = join(root, "report");
    const logFile = join(reportDir, "main.log");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(logFile, "passing\n");
    const common = {
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      platform: "win32",
      status: "passed",
      suites: [{ spec: "./specs/main.spec.js", status: "passed", logFile }],
    };
    const warned = e2eRunner.writeE2eArtifact({
      ...common,
      processCleanup: [
        { command: "npx.cmd", status: "build-unproven", reason: "x" },
        { command: "wdio", status: "verified" },
      ],
    });
    assert.equal(warned.processCleanup.status, "build-unproven");
    assert.notEqual(
      warned.failure,
      "Windows E2E process cleanup was not verified.",
    );
    const unproven = e2eRunner.writeE2eArtifact({
      ...common,
      processCleanup: [
        { command: "npx.cmd", status: "build-unproven", reason: "x" },
        { command: "wdio", status: "unproven" },
      ],
    });
    assert.equal(unproven.status, "failed");
    assert.equal(unproven.processCleanup.status, "unproven");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows cleanup classifies a capture gap separately from survivors", async () => {
  const child = windowsChild(52_000);
  const leader = windowsProcess(child.pid, 1, 5);
  // Parent PID matches the leader but it predates the leader, so ownership
  // cannot be proven: the capture records a gap.
  const unowned = windowsProcess(52_001, child.pid, 1);
  await archiveBenchmark.captureWindowsProcessIdentity(child, {
    platform: "win32",
    readWindowsProcessTable: async () => [leader, unowned],
    captureIntervalMs: 2,
  });
  await delay(20);
  child.exitCode = 0;
  assert.equal(
    await archiveBenchmark.terminateAndWaitForProcessTree(child, {
      platform: "win32",
      processTreeCleanupTimeoutMs: 200,
      processTreeScanDelayMs: 2,
      readWindowsProcessTable: async () => [],
    }),
    false,
  );
  assert.equal(
    archiveBenchmark.windowsProcessCleanupFailureKind(child),
    "capture-gap",
  );

  const survivorChild = windowsChild(52_100);
  const survivorLeader = windowsProcess(survivorChild.pid, 1, 0);
  const survivor = windowsProcess(52_101, survivorChild.pid, 1);
  await archiveBenchmark.captureWindowsProcessIdentity(survivorChild, {
    platform: "win32",
    readWindowsProcessTable: async () => [survivorLeader, survivor],
    captureIntervalMs: 2,
  });
  await delay(20);
  survivorChild.exitCode = 0;
  assert.equal(
    await archiveBenchmark.terminateAndWaitForProcessTree(survivorChild, {
      platform: "win32",
      processTreeCleanupTimeoutMs: 40,
      processTreeScanDelayMs: 2,
      readWindowsProcessTable: async () => [survivor],
      killWindowsProcess: async () => true,
    }),
    false,
  );
  assert.equal(
    archiveBenchmark.windowsProcessCleanupFailureKind(survivorChild),
    "survivors",
  );
});

test("cleanup status policy warns only for proven-safe Windows gaps", () => {
  const classify = archiveBenchmark.classifyProcessTreeCleanup;
  assert.equal(classify({ stopped: true }), "verified");
  assert.equal(
    classify({ stopped: false, kind: "capture-gap", commandFailed: false }),
    "capture-gap",
  );
  assert.equal(
    classify({ stopped: false, kind: "capture-gap", commandFailed: true }),
    "unproven",
  );
  assert.equal(
    classify({
      stopped: false,
      kind: "survivors",
      commandFailed: false,
      allowBuildCleanupWarning: true,
    }),
    "build-unproven",
  );
  assert.equal(
    classify({ stopped: false, kind: "survivors", commandFailed: false }),
    "unproven",
  );
  assert.equal(
    classify({ stopped: false, kind: "identity", commandFailed: false }),
    "unproven",
  );
});

test("Windows E2E artifact accepts a session capture gap", () => {
  const root = temporaryRoot();
  try {
    const binary = join(root, "zinnia");
    const manifest = join(root, "manifest.json");
    const reportDir = join(root, "report");
    const logFile = join(reportDir, "main.log");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(binary, "feature-enabled binary\n");
    writeFileSync(manifest, '{"payloadFile":"hello.txt"}\n');
    writeFileSync(logFile, "passing\n");
    const artifact = e2eRunner.writeE2eArtifact({
      reportDir,
      root,
      binary,
      fixtureManifest: manifest,
      platform: "win32",
      status: "passed",
      suites: [{ spec: "./specs/main.spec.js", status: "passed", logFile }],
      processCleanup: [
        { command: "npx.cmd", status: "build-unproven", reason: "x" },
        { command: "npx.cmd", status: "capture-gap", reason: "y" },
      ],
    });
    assert.equal(artifact.processCleanup.status, "capture-gap");
    assert.notEqual(
      artifact.failure,
      "Windows E2E process cleanup was not verified.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
