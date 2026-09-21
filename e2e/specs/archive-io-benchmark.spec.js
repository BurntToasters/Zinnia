import net from "node:net";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";

function socketAddress() {
  const host = process.env.ZINNIA_BENCH_SOCKET_HOST;
  const port = Number(process.env.ZINNIA_BENCH_SOCKET_PORT);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      "ZINNIA_BENCH_SOCKET_HOST and ZINNIA_BENCH_SOCKET_PORT are required for the archive benchmark runner",
    );
  }
  return { host, port };
}

async function waitForBenchmarkHook() {
  await $("#app").waitForExist({ timeout: 30_000 });
  await $("#basic-workspace").waitForDisplayed({ timeout: 30_000 });
  await browser.setTimeout({ script: 300_000 });
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Boolean(window.__ZINNIA_E2E__?.runArchiveBenchmarkOperation),
      ),
    {
      timeout: 30_000,
      timeoutMsg: "window.__ZINNIA_E2E__ benchmark hook was not installed",
    },
  );
}

async function executeRequest(request) {
  const response = await browser.executeAsync((nextRequest, done) => {
    const hook = window.__ZINNIA_E2E__;
    if (!hook?.runArchiveBenchmarkOperation) {
      done({ ok: false, error: "Archive benchmark hook is unavailable" });
      return;
    }
    hook
      .runArchiveBenchmarkOperation(nextRequest)
      .then((result) => done({ ok: true, result }))
      .catch((error) =>
        done({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }, request);
  if (!response?.ok) {
    throw new Error(String(response?.error || "Archive benchmark failed"));
  }
  const result = response.result;
  assert.ok(
    result && Number.isFinite(result.durationMs),
    "benchmark result must contain in-webview durationMs",
  );
  assert.equal(
    typeof result.code,
    "number",
    "benchmark result must contain numeric code",
  );
  if (result.code !== 0) {
    throw new Error(
      `${request.operation} benchmark returned code ${result.code}${result.stdout ? `: ${result.stdout.slice(0, 1000)}` : ""}`,
    );
  }
  return result;
}

function connectBenchmarkSocket() {
  const address = socketAddress();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.setEncoding("utf8");
    const onError = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Keep the browser process alive while the parent benchmark harness submits
 * requests. The parent owns the persistent session; this spec is only a
 * newline-delimited socket adapter around the browser hook.
 */
async function runSocketSession() {
  const socket = await connectBenchmarkSocket();
  let input = "";
  let processing = Promise.resolve();
  let finished = false;
  let settled = false;
  let finish;
  let fail;
  const finishedPromise = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const finishSession = () => {
    if (settled) return;
    settled = true;
    finish();
  };
  const failSession = (error) => {
    if (settled) return;
    settled = true;
    fail(error);
  };

  const reply = (id, payload) => {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify({ id, ...payload })}\n`);
  };

  const processMessage = async (message) => {
    if (message.close === true) {
      finished = true;
      socket.end(finishSession);
      return;
    }
    if (message.ready === true) {
      reply(undefined, { ready: true });
      return;
    }
    if (message.id == null || !message.request) {
      throw new Error(
        "Archive benchmark socket message requires id and request",
      );
    }
    try {
      reply(message.id, {
        ok: true,
        result: await executeRequest(message.request),
      });
    } catch (error) {
      reply(message.id, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  socket.on("data", (chunk) => {
    input += chunk;
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line.trim() || finished) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        failSession(
          new Error(
            `Invalid archive benchmark socket message: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        socket.destroy();
        return;
      }
      // Chain every request so browser.executeAsync calls cannot overlap even
      // if a future harness sends more than one line in one write.
      if (message.close === true) {
        processing = processing
          .then(() => processMessage(message))
          .catch((error) => {
            failSession(error);
            socket.destroy();
          });
      } else {
        processing = processing
          .then(() => processMessage(message))
          .catch((error) => {
            failSession(error);
            socket.destroy();
          });
      }
    }
  });
  socket.once("error", (error) => {
    if (!finished) failSession(error);
  });
  socket.once("close", () => {
    if (finished) finishSession();
    else
      failSession(
        new Error("Archive benchmark socket closed before close request"),
      );
  });

  // The helper waits on this readiness response before submitting work.
  reply(undefined, { ready: true });
  await finishedPromise;
}

const benchmarkConfigured = Boolean(
  process.env.ZINNIA_BENCH_SOCKET_HOST && process.env.ZINNIA_BENCH_SOCKET_PORT,
);

describe("Zinnia archive I/O benchmark runner", () => {
  if (!benchmarkConfigured) {
    it.skip("requires the archive benchmark socket", () => {});
    return;
  }

  it("runs all supplied operations in one persistent app", async () => {
    await waitForBenchmarkHook();
    await runSocketSession();
    console.log("Archive benchmark socket session completed.");
  });
});
