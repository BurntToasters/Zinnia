import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const STARTUP_TIMEOUT_MS = 20_000;

const LAUNCHER_SOURCE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");

const [payloadPath, host, portText, token, startupTimeoutText] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
const socket = net.createConnection({ host, port: Number(portText) });
const startupTimeout = Number(startupTimeoutText);
let command;
let settled = false;
let launched = false;
let input = "";

const finish = (result) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    socket.write(JSON.stringify(result) + "\n", () => socket.end());
  } catch {
    socket.destroy();
  }
  process.exitCode = result.code ?? 1;
};

const fail = (message) => finish({ error: message, code: 1, signal: null });

const timer = setTimeout(() => fail("Windows launch handshake timed out"), startupTimeout);
socket.setEncoding("utf8");
socket.once("connect", () => socket.write(token + "\n"));
socket.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    newline = input.indexOf("\n");
    if (line === "abort") {
      fail("Windows launch was aborted before command start");
      return;
    }
    if (line !== "go" || launched) continue;
    launched = true;
    clearTimeout(timer);
    command = spawn(payload.command, payload.args, {
      cwd: payload.cwd,
      env: process.env,
      stdio: "inherit",
      shell: payload.shell,
      windowsHide: true,
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        if (!command?.pid) return;
        try {
          command.kill(signal);
        } catch {}
      });
    }
    command.once("error", (error) => finish({ error: error.message, code: 1, signal: null }));
    command.once("close", (code, signal) => finish({ code, signal }));
  }
});
socket.once("error", (error) => {
  if (!settled) fail(error.message);
});
socket.once("close", () => {
  if (!settled && !launched) fail("Windows launch handshake closed before command start");
});
`;

const JOB_HELPER_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Management
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ZinniaJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static IntPtr job = IntPtr.Zero;

  public static void Create() {
    job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ExtendedLimit info = new ExtendedLimit();
    info.Basic.LimitFlags = 0x2400; // KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimit)))) {
      throw new Win32Exception();
    }
  }

  public static void Assign(int pid, long expectedCreated) {
    IntPtr process = OpenProcess(0x1101, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception();
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) {
        throw new Win32Exception();
      }
      if (Math.Abs(created - expectedCreated) > 10) {
        throw new InvalidOperationException("wrapper creation time " + created + " does not match its captured identity " + expectedCreated);
      }
      uint exitCode;
      if (!GetExitCodeProcess(process, out exitCode)) throw new Win32Exception();
      if (exitCode != 259) throw new InvalidOperationException("wrapper exited before job assignment");
      if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
    } finally {
      CloseHandle(process);
    }
  }

  public static uint Active() {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) {
      throw new Win32Exception();
    }
    return info.ActiveProcesses;
  }

  public static void Terminate() {
    if (!TerminateJobObject(job, 1)) throw new Win32Exception();
  }
}
'@
[ZinniaJob]::Create()
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $parts = $line.Split(' ')
    switch ($parts[0]) {
      'assign' {
        $expected = [System.Management.ManagementDateTimeConverter]::ToDateTime($parts[2]).ToUniversalTime().ToFileTimeUtc()
        [ZinniaJob]::Assign([int]$parts[1], $expected)
        $reply = 'ok'
      }
      'terminate' {
        [ZinniaJob]::Terminate()
        $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$parts[1])
        while ([ZinniaJob]::Active() -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
          Start-Sleep -Milliseconds 25
        }
        $reply = 'active ' + [ZinniaJob]::Active()
      }
      default { $reply = 'error unknown job helper request' }
    }
  } catch {
    $reply = 'error ' + ($_.Exception.Message -replace '\s+', ' ')
  }
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
`;

const JOB_TERMINATE_TIMEOUT_MS = 10_000;

function startJobHelper() {
  const helper = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(JOB_HELPER_SOURCE, "utf16le").toString("base64"),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const waiters = [];
  let output = "";
  let stderr = "";
  let failure = null;
  const exited = new Promise((resolve) => {
    helper.once("close", resolve);
    helper.once("error", resolve);
  });
  const fail = (error) => {
    failure ??= error;
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  };
  helper.stdout.setEncoding("utf8");
  helper.stderr.setEncoding("utf8");
  helper.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  helper.stdout.on("data", (chunk) => {
    output += chunk;
    let newline = output.indexOf("\n");
    while (newline >= 0) {
      const line = output.slice(0, newline).replace(/\r$/, "");
      output = output.slice(newline + 1);
      newline = output.indexOf("\n");
      waiters.shift()?.resolve(line);
    }
  });
  helper.stdin.on("error", () => {});
  helper.once("error", (error) =>
    fail(new Error(`Windows job helper could not start: ${error.message}`)),
  );
  helper.once("close", (code) =>
    fail(
      new Error(
        `Windows job helper exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      ),
    ),
  );
  const nextLine = (timeoutMs) =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const waiter = {
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        fail(new Error("Windows job helper stopped responding."));
      }, timeoutMs);
      waiters.push(waiter);
    });
  let ready = null;
  return {
    ready(timeoutMs) {
      ready ??= nextLine(timeoutMs).then((line) => {
        if (line !== "ready") {
          throw new Error(`Windows job helper failed to start: ${line}`);
        }
      });
      return ready;
    },
    async request(line, timeoutMs) {
      const reply = nextLine(timeoutMs);
      helper.stdin.write(`${line}\n`);
      const result = await reply;
      if (result.startsWith("error ")) throw new Error(result.slice(6));
      return result;
    },
    async close() {
      helper.stdin.end();
      let timer;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
        }),
      ]);
      clearTimeout(timer);
      if (!stopped) {
        helper.kill();
        await exited;
      }
    },
  };
}

function positiveTimeout(value, fallback = STARTUP_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

export async function startWindowsFencedCommand(command, args, options = {}) {
  if (process.platform !== "win32") {
    throw new Error(
      "The fenced command launcher is only available on Windows.",
    );
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-fenced-command-"),
  );
  const launcherPath = path.join(directory, "launcher.cjs");
  const payloadPath = path.join(directory, "command.json");
  const token = randomBytes(32).toString("hex");
  const startupTimeoutMs = positiveTimeout(options.startupTimeoutMs);
  const payload = {
    command,
    args,
    cwd: options.cwd ?? process.cwd(),
    shell: Boolean(options.shell),
  };
  fs.writeFileSync(launcherPath, LAUNCHER_SOURCE, { mode: 0o600 });
  fs.writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`, {
    mode: 0o600,
  });

  let resolveConnection;
  let rejectConnection;
  const connectionPromise = new Promise((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
  connectionPromise.catch(() => {});
  let resolveCommandResult;
  let rejectCommandResult;
  const commandResult = new Promise((resolve, reject) => {
    resolveCommandResult = resolve;
    rejectCommandResult = reject;
  });
  commandResult.catch(() => {});

  let channel;
  let authenticated = false;
  let input = "";
  let abortRequested = false;
  let controlSent = false;
  let commandResultSettled = false;
  const server = net.createServer((socket) => {
    if (channel) {
      socket.destroy();
      return;
    }
    channel = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      let newline = input.indexOf("\n");
      while (newline >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        newline = input.indexOf("\n");
        if (!authenticated) {
          if (line !== token) {
            socket.destroy();
            rejectConnection(
              new Error("Windows launch handshake token did not match."),
            );
            return;
          }
          authenticated = true;
          resolveConnection(socket);
          if (abortRequested) sendControl("abort");
          continue;
        }
        let result;
        try {
          result = JSON.parse(line);
        } catch {
          rejectResult(
            new Error("Windows launch returned malformed command status."),
          );
          continue;
        }
        if (!result || typeof result !== "object") {
          rejectResult(
            new Error("Windows launch returned malformed command status."),
          );
          continue;
        }
        if (result.error) rejectResult(new Error(String(result.error)));
        else {
          commandResultSettled = true;
          resolveCommandResult({ code: result.code, signal: result.signal });
        }
      }
    });
    socket.once("error", (error) => {
      if (!commandResultSettled) rejectResult(error);
    });
    socket.once("close", () => {
      if (!commandResultSettled) {
        rejectResult(
          new Error("Windows launch channel closed before command status."),
        );
      }
    });
  });

  function rejectResult(error) {
    if (commandResultSettled) return;
    commandResultSettled = true;
    rejectCommandResult(error);
  }

  function sendControl(line) {
    if (controlSent || !channel || !authenticated) return;
    controlSent = true;
    channel.write(`${line}\n`);
  }

  const jobHelper = startJobHelper();
  const jobHelperReady = jobHelper.ready(startupTimeoutMs);
  jobHelperReady.catch(() => {});
  let jobAssigned = false;

  try {
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string" || address.port <= 0) {
      throw new Error("Could not open the Windows launch handshake channel.");
    }
    const child = spawn(
      process.execPath,
      [
        launcherPath,
        payloadPath,
        "127.0.0.1",
        String(address.port),
        token,
        String(startupTimeoutMs),
      ],
      {
        cwd: payload.cwd,
        env: options.env ?? process.env,
        stdio: options.stdio ?? "inherit",
        windowsHide: true,
        detached: false,
      },
    );
    let releasePromise;
    let disposePromise;
    return {
      child,
      commandResult,
      get jobAssigned() {
        return jobAssigned;
      },
      release(identity) {
        releasePromise ??= (async () => {
          if (!authenticated) {
            let timeout;
            try {
              await Promise.race([
                connectionPromise,
                new Promise((_, reject) => {
                  timeout = setTimeout(
                    () =>
                      reject(
                        new Error(
                          `Windows launch handshake did not start within ${startupTimeoutMs}ms.`,
                        ),
                      ),
                    startupTimeoutMs,
                  );
                }),
              ]);
            } catch (error) {
              abortRequested = true;
              if (channel && authenticated) sendControl("abort");
              throw error;
            } finally {
              clearTimeout(timeout);
            }
          }
          if (abortRequested) {
            throw new Error("Windows launch was aborted before command start.");
          }
          try {
            if (!identity || identity.pid !== child.pid || !identity.created) {
              throw new Error("wrapper identity was not captured");
            }
            await jobHelperReady;
            await jobHelper.request(
              `assign ${identity.pid} ${identity.created}`,
              startupTimeoutMs,
            );
          } catch (error) {
            abortRequested = true;
            sendControl("abort");
            throw new Error(
              `Windows launch could not confine the command in a job: ${error.message}`,
              { cause: error },
            );
          }
          jobAssigned = true;
          sendControl("go");
        })();
        return releasePromise;
      },
      abort() {
        abortRequested = true;
        if (channel && authenticated) sendControl("abort");
        return Promise.resolve();
      },
      async terminateJob(timeoutMs = JOB_TERMINATE_TIMEOUT_MS) {
        if (!jobAssigned) return null;
        try {
          const reply = await jobHelper.request(
            `terminate ${timeoutMs}`,
            timeoutMs + 5_000,
          );
          const active = Number(reply.match(/^active (\d+)$/)?.[1] ?? NaN);
          if (active === 0) return { stopped: true, reason: null };
          return {
            stopped: false,
            reason: Number.isNaN(active)
              ? `Windows job helper returned ${reply}`
              : `${active} process(es) remain in the Windows job after termination`,
          };
        } catch (error) {
          return {
            stopped: false,
            reason: `Windows job termination failed: ${error.message}`,
          };
        }
      },
      dispose() {
        disposePromise ??= (async () => {
          await jobHelper.close();
          channel?.destroy();
          await closeServer(server);
          fs.rmSync(directory, { recursive: true, force: true });
        })();
        return disposePromise;
      },
    };
  } catch (error) {
    await jobHelper.close();
    await closeServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function waitForWindowsFencedCommand(launch, description) {
  return new Promise((resolve, reject) => {
    launch.commandResult.then(({ code, signal }) => {
      if (code === 0) resolve();
      else reject(new Error(`${description} exited with ${code ?? signal}`));
    }, reject);
    launch.child.once("error", reject);
  });
}
