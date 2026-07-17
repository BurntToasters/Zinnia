import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLI_FLAG,
  copyReleaseAssets,
  isDirectExecution,
  pathsEqual,
  run,
} from "../../scripts/post-release-assets.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-finalize-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("post-release assets", () => {
  it("recognizes Windows paths without case sensitivity", () => {
    expect(
      pathsEqual(
        "C:/Users/Main/Zinnia/release",
        "c:/users/main/zinnia/release",
        "win32",
      ),
    ).toBe(true);
  });

  it("uses the explicit finalizer flag without relying on path identity", () => {
    expect(isDirectExecution(["node", "unrelated.js", CLI_FLAG], "win32")).toBe(
      true,
    );
  });

  it("cleans, mirrors, and verifies release entries", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    const destination = path.join(root, "mirror");
    fs.mkdirSync(path.join(releaseDir, "nsis"), { recursive: true });
    fs.writeFileSync(path.join(releaseDir, "nsis", "build-only.exe"), "build");
    fs.writeFileSync(
      path.join(releaseDir, "Zinnia-Windows-x64.exe"),
      "installer",
    );
    fs.writeFileSync(
      path.join(releaseDir, "SHA256SUMS-windows-x86_64.txt"),
      "hash",
    );

    const result = run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
    });

    expect(result).toEqual({
      mirrored: true,
      destination,
      copiedEntries: 2,
    });
    expect(fs.existsSync(path.join(releaseDir, "nsis"))).toBe(false);
    expect(
      fs.readFileSync(path.join(destination, "Zinnia-Windows-x64.exe"), "utf8"),
    ).toBe("installer");
    expect(
      fs.readFileSync(
        path.join(destination, "SHA256SUMS-windows-x86_64.txt"),
        "utf8",
      ),
    ).toBe("hash");
  });

  it("fails instead of claiming success when the release directory is missing", () => {
    const root = makeTemporaryDirectory();
    expect(() =>
      copyReleaseAssets(path.join(root, "missing"), path.join(root, "mirror")),
    ).toThrow(/release directory does not exist/);
  });

  it("rejects a mirror inside the release directory", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    fs.mkdirSync(releaseDir);
    fs.writeFileSync(path.join(releaseDir, "artifact.exe"), "artifact");

    expect(() =>
      copyReleaseAssets(releaseDir, path.join(releaseDir, "mirror")),
    ).toThrow(/cannot be inside the release directory/);
  });
});
