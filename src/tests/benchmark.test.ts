import { describe, it, expect } from "vitest";
import { parseBenchmarkSummary } from "../main";

describe("parseBenchmarkSummary", () => {
  it("extracts the rating from the Tot: line", () => {
    const stdout = [
      "7-Zip (z) 26.01",
      "Compr   Decompr",
      "Avg:    4012   4099",
      "Tot:             4123   100   4150",
    ].join("\n");
    expect(parseBenchmarkSummary(stdout)).toBe("Rating: 4150");
  });

  it("returns null when there is no Tot line", () => {
    expect(parseBenchmarkSummary("Everything is Ok")).toBeNull();
  });

  it("handles CRLF output", () => {
    expect(parseBenchmarkSummary("Tot:   1   2   3333\r\n")).toBe(
      "Rating: 3333",
    );
  });
});
