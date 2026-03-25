import { describe, it, expect } from "vitest";
import { formatCommandOutputForLogs } from "../output-logging";

describe("formatCommandOutputForLogs", () => {
  it("formats info-level output with preview and line count", () => {
    const entries = formatCommandOutputForLogs(
      "line 1\nline 2\nline 3\nline 4",
      "warn 1\nwarn 2",
      "info",
    );
    expect(entries.length).toBe(2);
    expect(entries[0].text).toContain("stdout:");
    expect(entries[0].text).toContain("line(s)");
    expect(entries[0].text).toContain("Preview:");
    expect(entries[1].level).toBe("error");
  });

  it("truncates very large output in debug mode", () => {
    const big = "x".repeat(25_000);
    const entries = formatCommandOutputForLogs(big, "", "debug");
    expect(entries.length).toBe(1);
    expect(entries[0].text).toMatch(/^stdout:\n/);
    expect(entries[0].text).toContain("[truncated ");
  });

  it("handles empty stdout and stderr", () => {
    const entries = formatCommandOutputForLogs("", "", "info");
    expect(entries.length).toBe(0);
  });

  it("handles stderr-only output", () => {
    const entries = formatCommandOutputForLogs("", "error line", "info");
    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe("error");
  });
});
