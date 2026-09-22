import { describe, expect, it } from "vitest";
import {
  assertArchiveBenchmarkOutputComplete,
  collectArchiveBenchmarkStdout,
  MAX_RESULT_STDOUT_CHARS,
} from "../e2e-archive-benchmark";

describe("E2E archive benchmark output bounds", () => {
  it("preserves a release-sized listing above the old 512 KiB cap", () => {
    const listing = Array.from(
      { length: 2_048 },
      (_, index) =>
        `Path = payload/${String(index).padStart(4, "0")}-${"x".repeat(280)}.txt`,
    ).join("\n");

    expect(listing.length).toBeGreaterThan(512 * 1024);
    expect(listing.length).toBeLessThan(MAX_RESULT_STDOUT_CHARS);
    expect(collectArchiveBenchmarkStdout([listing])).toBe(listing);
  });

  it("rejects aggregate output over the bounded E2E result limit", () => {
    const overLimit = "x".repeat(MAX_RESULT_STDOUT_CHARS + 1);

    expect(() => collectArchiveBenchmarkStdout([overLimit])).toThrow(
      "refusing to return a partial result",
    );
  });

  it.each([
    ["stdout", { stdout_truncated: true }],
    ["stderr", { stderr_truncated: true }],
    ["both streams", { stdout_truncated: true, stderr_truncated: true }],
  ])("rejects backend-truncated %s output", (_label, run) => {
    expect(() => assertArchiveBenchmarkOutputComplete(run, "browse")).toThrow(
      /browse output was truncated by the backend/,
    );
  });
});
