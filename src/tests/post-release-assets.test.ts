import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLI_FLAG,
  REPOSITORY_ROOT,
  copyReleaseAssets,
  copyReleaseEntryToMirror,
  isBetaReleaseVersion,
  isDirectExecution,
  pathsEqual,
  run,
  shouldSkipBetaMirror,
  verifyCopiedPath,
} from "../../scripts/post-release-assets.js";

const STABLE_VERSION = "0.6.1";
const BETA_VERSION = "0.6.1-beta.3";

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
    fs.writeFileSync(
      path.join(releaseDir, ".build-session.json"),
      '{"version":"0.0.0"}\n',
    );

    const result = run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
      version: STABLE_VERSION,
    });

    expect(result).toEqual({
      mirrored: true,
      destination,
      copiedEntries: 2,
      skippedBetaMirror: false,
    });
    expect(fs.existsSync(path.join(releaseDir, "nsis"))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, ".build-session.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(destination, ".build-session.json"))).toBe(
      false,
    );
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

  it("copies over an existing mirror entry without deleting it first", () => {
    const root = makeTemporaryDirectory();
    const source = path.join(root, "Zinnia-Windows-x64.exe");
    const destination = path.join(root, "mirror", "Zinnia-Windows-x64.exe");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(source, "new-installer");
    fs.writeFileSync(destination, "old-installer");

    copyReleaseEntryToMirror(source, destination);

    expect(fs.readFileSync(destination, "utf8")).toBe("new-installer");
    expect(
      fs
        .readdirSync(path.dirname(destination))
        .filter((name) => name.startsWith(".zinnia-mirror-")),
    ).toEqual([]);
  });

  it("cleans build-only files but skips the mirror when AFTER_PACK_LOC is unset", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    fs.mkdirSync(path.join(releaseDir, "nsis"), { recursive: true });
    const buildOnly = path.join(releaseDir, "nsis", "build-only.exe");
    fs.writeFileSync(buildOnly, "build");
    fs.writeFileSync(
      path.join(releaseDir, "Zinnia-Windows-x64.exe"),
      "installer",
    );

    const result = run({
      releaseDir,
      env: {},
      version: STABLE_VERSION,
    });

    expect(result).toEqual({
      mirrored: false,
      destination: "",
      copiedEntries: 0,
      skippedBetaMirror: false,
    });
    expect(fs.existsSync(buildOnly)).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, "Zinnia-Windows-x64.exe"))).toBe(
      true,
    );
  });

  it("skips AFTER_PACK_LOC mirroring for beta versions unless overridden", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    const destination = path.join(root, "mirror");
    fs.mkdirSync(path.join(releaseDir, "nsis"), { recursive: true });
    const buildOnly = path.join(releaseDir, "nsis", "build-only.exe");
    fs.writeFileSync(buildOnly, "build");
    fs.writeFileSync(
      path.join(releaseDir, "Zinnia-Windows-x64.exe"),
      "installer",
    );

    expect(isBetaReleaseVersion(BETA_VERSION)).toBe(true);
    expect(shouldSkipBetaMirror({}, BETA_VERSION)).toBe(true);
    expect(
      shouldSkipBetaMirror({ OVERRIDE_BETA_MIRROR_SKIP: "1" }, BETA_VERSION),
    ).toBe(false);
    expect(shouldSkipBetaMirror({}, STABLE_VERSION)).toBe(false);

    const skipped = run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
      version: BETA_VERSION,
    });
    expect(skipped).toEqual({
      mirrored: false,
      destination: "",
      copiedEntries: 0,
      skippedBetaMirror: true,
    });
    expect(fs.existsSync(buildOnly)).toBe(false);
    expect(
      fs.existsSync(path.join(destination, "Zinnia-Windows-x64.exe")),
    ).toBe(false);

    fs.mkdirSync(path.join(releaseDir, "nsis"), { recursive: true });
    fs.writeFileSync(path.join(releaseDir, "nsis", "build-only.exe"), "build");
    fs.writeFileSync(
      path.join(releaseDir, "Zinnia-Windows-x64.exe"),
      "installer",
    );
    const forced = run({
      releaseDir,
      env: {
        AFTER_PACK_LOC: destination,
        OVERRIDE_BETA_MIRROR_SKIP: "1",
      },
      version: BETA_VERSION,
    });
    expect(forced).toEqual({
      mirrored: true,
      destination,
      copiedEntries: 1,
      skippedBetaMirror: false,
    });
    expect(
      fs.readFileSync(path.join(destination, "Zinnia-Windows-x64.exe"), "utf8"),
    ).toBe("installer");
  });

  it("rejects a platform-relative mirror before cleaning release files", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    fs.mkdirSync(path.join(releaseDir, "nsis"), { recursive: true });
    const buildOnly = path.join(releaseDir, "nsis", "build-only.exe");
    fs.writeFileSync(buildOnly, "build");

    const relativeDestination =
      process.platform === "win32" ? "relative\\mirror" : "Z:/ZINNIA";
    expect(() =>
      run({
        releaseDir,
        env: { AFTER_PACK_LOC: relativeDestination },
        version: STABLE_VERSION,
      }),
    ).toThrow(/must be an absolute path/);
    expect(fs.existsSync(buildOnly)).toBe(true);
  });

  it("rejects a repository-local mirror before cleaning release files", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    fs.mkdirSync(path.join(releaseDir, "nsis"), { recursive: true });
    const buildOnly = path.join(releaseDir, "nsis", "build-only.exe");
    fs.writeFileSync(buildOnly, "build");

    expect(() =>
      run({
        releaseDir,
        env: { AFTER_PACK_LOC: path.join(REPOSITORY_ROOT, "mirror") },
        version: STABLE_VERSION,
      }),
    ).toThrow(/must be outside the repository/);
    expect(fs.existsSync(buildOnly)).toBe(true);
  });

  it("detects same-size mirror corruption by hash", () => {
    const root = makeTemporaryDirectory();
    const source = path.join(root, "source.bin");
    const destination = path.join(root, "destination.bin");
    fs.writeFileSync(source, "good");
    fs.writeFileSync(destination, "evil");

    expect(() => verifyCopiedPath(source, destination)).toThrow(/hash differs/);
  });

  it("dedicated runner executes finalization without an argv guard", () => {
    const root = makeTemporaryDirectory();
    const scriptsDir = path.join(root, "scripts");
    const releaseDir = path.join(root, "release");
    const destination = path.join(makeTemporaryDirectory(), "mirror");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(releaseDir);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "zinnia", version: STABLE_VERSION }),
    );
    fs.copyFileSync(
      path.resolve(process.cwd(), "scripts", "post-release-assets.js"),
      path.join(scriptsDir, "post-release-assets.js"),
    );
    fs.copyFileSync(
      path.resolve(process.cwd(), "scripts", "finalize-release-assets.js"),
      path.join(scriptsDir, "finalize-release-assets.js"),
    );
    fs.copyFileSync(
      path.resolve(process.cwd(), "scripts", "release-policy.cjs"),
      path.join(scriptsDir, "release-policy.cjs"),
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
        env: {
          ...process.env,
          AFTER_PACK_LOC: destination,
          SKIP_RELEASE_MIRROR: "",
          FORCE_UPLOAD: "",
          SKIP_WIN_CODESIGN: "",
          ALLOW_ASSET_REPLACE: "",
        },
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

  it("merges into a shared mirror without removing other platform artifacts", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    const destination = path.join(root, "mirror");
    fs.mkdirSync(releaseDir);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(releaseDir, "current.exe"), "current");
    fs.writeFileSync(
      path.join(destination, "SHA256SUMS-linux-x86_64.txt"),
      "linux",
    );
    fs.writeFileSync(path.join(destination, "stale.exe"), "stale");

    copyReleaseAssets(releaseDir, destination);

    expect(fs.readdirSync(destination).sort()).toEqual(
      ["SHA256SUMS-linux-x86_64.txt", "current.exe", "stale.exe"].sort(),
    );
    expect(fs.readFileSync(path.join(destination, "current.exe"), "utf8")).toBe(
      "current",
    );
  });

  it("overwrites same-name artifacts when re-mirroring this platform", () => {
    const root = makeTemporaryDirectory();
    const releaseDir = path.join(root, "release");
    const destination = path.join(root, "mirror");
    fs.mkdirSync(releaseDir);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(releaseDir, "current.exe"), "new");
    fs.writeFileSync(path.join(destination, "current.exe"), "old");

    copyReleaseAssets(releaseDir, destination);

    expect(fs.readdirSync(destination)).toEqual(["current.exe"]);
    expect(fs.readFileSync(path.join(destination, "current.exe"), "utf8")).toBe(
      "new",
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlink mirror destination",
    () => {
      const root = makeTemporaryDirectory();
      const releaseDir = path.join(root, "release");
      const actualDestination = path.join(root, "actual");
      const destination = path.join(root, "mirror");
      fs.mkdirSync(releaseDir);
      fs.mkdirSync(actualDestination);
      fs.writeFileSync(path.join(releaseDir, "current.exe"), "current");
      fs.symlinkSync(actualDestination, destination);

      expect(() => copyReleaseAssets(releaseDir, destination)).toThrow(
        /must not be a symbolic link/,
      );
    },
  );
});
