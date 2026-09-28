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
  let releaseRequested = false;
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
          else if (releaseRequested) sendControl("go");
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
      release() {
        releasePromise ??= (async () => {
          releaseRequested = true;
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
          sendControl("go");
        })();
        return releasePromise;
      },
      abort() {
        abortRequested = true;
        if (channel && authenticated) sendControl("abort");
        return Promise.resolve();
      },
      dispose() {
        disposePromise ??= (async () => {
          channel?.destroy();
          await closeServer(server);
          fs.rmSync(directory, { recursive: true, force: true });
        })();
        return disposePromise;
      },
    };
  } catch (error) {
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
