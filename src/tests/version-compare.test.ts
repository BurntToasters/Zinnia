import { describe, expect, it } from "vitest";
import { compareVersions } from "../version-compare";

// Failure modes, written before the implementation:
// 1. Numeric prerelease identifiers compared as strings ("beta.10" < "beta.9").
//    This made the updater skip beta.10+ when beta.9 was installed.
// 2. A release compared as older than its own prerelease.
// 3. Core parts compared as strings ("0.6.10" < "0.6.9").
// 4. Build metadata ("+build") treated as precedence.
// 5. Semver precedence chain broken (numeric vs alphanumeric, shorter prefix).
// 6. Equal versions not reported as 0.
// 7. Malformed input throws instead of returning a number.

describe("compareVersions", () => {
  it("orders numeric prerelease identifiers numerically (beta.10 > beta.9)", () => {
    expect(compareVersions("0.6.3-beta.10", "0.6.3-beta.9")).toBe(1);
    expect(compareVersions("0.6.3-beta.9", "0.6.3-beta.10")).toBe(-1);
    expect(compareVersions("0.6.3-beta.19", "0.6.3-beta.4")).toBe(1);
  });

  it("orders consecutive prereleases", () => {
    expect(compareVersions("0.6.3-beta.5", "0.6.3-beta.4")).toBe(1);
    expect(compareVersions("0.6.3-beta.4", "0.6.3-beta.5")).toBe(-1);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareVersions("0.6.3", "0.6.3-beta.12")).toBe(1);
    expect(compareVersions("0.6.3-beta.12", "0.6.3")).toBe(-1);
  });

  it("compares core parts numerically", () => {
    expect(compareVersions("0.6.10", "0.6.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.6", "0.6.0")).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("0.6.3+build7", "0.6.3")).toBe(0);
    expect(compareVersions("0.6.3-beta.1+sha.abc", "0.6.3-beta.1")).toBe(0);
  });

  it("follows the semver prerelease precedence chain", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareVersions(chain[i], chain[i + 1])).toBe(-1);
      expect(compareVersions(chain[i + 1], chain[i])).toBe(1);
    }
  });

  it("ranks numeric identifiers below alphanumeric ones", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBe(1);
  });

  it("ranks a shorter prerelease below a longer one with the same prefix", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });

  it("returns 0 for equal versions", () => {
    expect(compareVersions("0.6.3-beta.4", "0.6.3-beta.4")).toBe(0);
    expect(compareVersions("0.6.3", "0.6.3")).toBe(0);
  });

  it("does not throw on malformed input", () => {
    expect(() => compareVersions("", "0.6.3")).not.toThrow();
    expect(() => compareVersions("abc", "0.6.3-beta.1")).not.toThrow();
    expect(typeof compareVersions("abc", "0.6.3")).toBe("number");
  });
});
