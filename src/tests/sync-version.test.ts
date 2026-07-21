import { describe, expect, it } from "vitest";

import {
  macBundleVersionFromSemver,
  updateWindowsResourceFlags,
} from "../../scripts/sync-version-helpers.js";

const resource = `#ifdef _DEBUG
 FILEFLAGS VS_FF_DEBUG | VS_FF_PRERELEASE
#else
 FILEFLAGS VS_FF_PRERELEASE
#endif`;

describe("Windows resource version flags", () => {
  it("marks beta builds as prerelease", () => {
    expect(updateWindowsResourceFlags(resource, "0.6.0-beta.4")).toBe(resource);
  });

  it("removes prerelease flags from stable builds", () => {
    expect(updateWindowsResourceFlags(resource, "0.6.0")).toBe(`#ifdef _DEBUG
 FILEFLAGS VS_FF_DEBUG
#else
 FILEFLAGS 0
#endif`);
  });

  it("fails if the expected resource block is missing", () => {
    expect(() => updateWindowsResourceFlags("FILEFLAGS 0", "0.6.0")).toThrow(
      /FILEFLAGS block was not found/,
    );
  });
});

describe("macOS bundle version", () => {
  it("converts prerelease and stable SemVer versions into ordered numeric builds", () => {
    expect(macBundleVersionFromSemver("0.6.0-beta.4")).toBe("0.6.34");
    expect(macBundleVersionFromSemver("0.6.0-rc.1")).toBe("0.6.61");
    expect(macBundleVersionFromSemver("0.6.0")).toBe("0.6.99");
    expect(macBundleVersionFromSemver("0.6.1-beta.1")).toBe("0.6.131");
  });

  it("rejects unsupported prerelease version forms", () => {
    expect(() => macBundleVersionFromSemver("0.6.0-preview.1")).toThrow(
      /cannot be represented/,
    );
    expect(() => macBundleVersionFromSemver("0.6.0-beta.30")).toThrow(/0-29/);
  });
});
