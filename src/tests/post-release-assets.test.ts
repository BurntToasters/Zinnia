import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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

  it("detects direct execution by basename so Windows path identity cannot no-op", () => {
    expect(
      isDirectExecution(
        ["node", "C:\\Users\\Main\\Zinnia\\scripts\\post-release-assets.js"],
        "win32",
      ),
    ).toBe(true);
    expect(
      isDirectExecution(
        [
          "node",
          "C:\\Users\\Main\\Zinnia\\scripts\\finalize-release-assets.js",
        ],
        "win32",
      ),
    ).toBe(false);
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

  it("dedicated runner executes finalization without an argv guard", () => {
    const root = makeTemporaryDirectory();
    const scriptsDir = path.join(root, "scripts");
    const releaseDir = path.join(root, "release");
    const destination = path.join(root, "mirror");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(releaseDir);
    fs.copyFileSync(
      path.resolve(process.cwd(), "scripts", "post-release-assets.js"),
      path.join(scriptsDir, "post-release-assets.js"),
    );
    fs.copyFileSync(
      path.resolve(process.cwd(), "scripts", "finalize-release-assets.js"),
      path.join(scriptsDir, "finalize-release-assets.js"),
    );
    fs.writeFileSync(
      path.join(releaseDir, "Zinnia-Windows-x64.exe"),
      "installer",
    );

    const ran = spawnSync(
      process.execPath,
      [path.join(scriptsDir, "finalize-release-assets.js")],
      {
        encoding: "utf8",
        env: { ...process.env, AFTER_PACK_LOC: destination },
      },
    );
    const combined = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;

    expect(ran.status).toBe(0);
    expect(combined).toContain(
      "Mirrored and verified 1 cleaned release entries",
    );
    expect(combined).toContain("[release:mirror] starting");
    expect(combined).toContain(`AFTER_PACK_LOC=${JSON.stringify(destination)}`);
    expect(
      fs.readFileSync(path.join(destination, "Zinnia-Windows-x64.exe"), "utf8"),
    ).toBe("installer");
  });

  it("release finalization runs the observable mirror command first", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    );
    expect(packageJson.scripts["release:mirror"]).toContain(
      "scripts/finalize-release-assets.js",
    );
    expect(packageJson.scripts["release:finalize"]).toMatch(
      /^npm run release:mirror &&/,
    );
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
