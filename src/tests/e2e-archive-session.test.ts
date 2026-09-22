import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The E2E helper is JavaScript and intentionally has no TS declaration.
import * as archiveBenchmark from "../../e2e/helpers/archive-benchmark.js";
const { ARCHIVE_BENCHMARK_CLOSE_TIMEOUT_MS, waitForChild, waitForChildExit } =
  archiveBenchmark;

class FakeChild extends EventEmitter {
  killed = false;
  killCalls = 0;

  kill(): boolean {
    this.killed = true;
    this.killCalls += 1;
    return true;
  }
}

describe("persistent archive benchmark child lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not force-kill an active session after one hour", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const childExit = waitForChild(child);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(child.killCalls).toBe(0);
    child.emit("exit", 0, null);
    await expect(childExit).resolves.toBeUndefined();
  });

  it("bounds close while preserving the child exit result", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const childExit = waitForChild(child);
    const closeExit = waitForChildExit(childExit, child);
    const closeFailure = expect(closeExit).rejects.toThrow(
      "did not exit after close request",
    );

    await vi.advanceTimersByTimeAsync(ARCHIVE_BENCHMARK_CLOSE_TIMEOUT_MS - 1);
    expect(child.killCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await closeFailure;
    expect(child.killCalls).toBe(1);

    child.emit("exit", 0, null);
    await expect(childExit).resolves.toBeUndefined();
  });
});
