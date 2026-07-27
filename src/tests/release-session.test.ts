import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  DEFAULT_MAX_AGE_MS,
  RELEASE_SESSION_RELATIVE_PATH,
  createReleaseSession,
  porcelainPaths,
  recordSuccessfulQualityGate,
  validateQualityGate,
  validateReleaseSession,
  verifyReleaseSession,
} from "../../scripts/release-session.js";

const identity = {
  version: "0.6.0-beta.13",
  commit: "a".repeat(40),
  platform: "darwin",
  arch: "arm64",
  node: "v24.0.0",
  rustc: "rustc 1.90.0",
  packageLockSha256: "b".repeat(64),
  cargoLockSha256: "c".repeat(64),
};

describe("release build session", () => {
  it("parses porcelain paths without eating the first path character", () => {
    // Regression: trim() on " M src-tauri/gen/schemas/x" became "M path",
    // slice(3) => "c-tauri/..." and the schema ignore filter missed it.
    expect(
      porcelainPaths(" M src-tauri/gen/schemas/linux-schema.json"),
    ).toEqual(["src-tauri/gen/schemas/linux-schema.json"]);
    expect(
      porcelainPaths("M  src-tauri/gen/schemas/linux-schema.json"),
    ).toEqual(["src-tauri/gen/schemas/linux-schema.json"]);
    expect(
      porcelainPaths("?? src-tauri/gen/schemas/linux-schema.json"),
    ).toEqual(["src-tauri/gen/schemas/linux-schema.json"]);
  });

  it("accepts a recent session for the exact source and environment", () => {
    const now = 1_000_000;
    const session = {
      ...identity,
      qualityGateCompletedAt: now - 2_000,
      startedAt: now - 1_000,
    };
    expect(validateReleaseSession(session, identity, { now })).toBe(session);
  });

  it.each([
    ["commit", "d".repeat(40)],
    ["version", "0.6.0-beta.14"],
    ["platform", "win32"],
    ["arch", "x64"],
    ["node", "v22.0.0"],
    ["rustc", "rustc 1.89.0"],
    ["packageLockSha256", "e".repeat(64)],
    ["cargoLockSha256", "f".repeat(64)],
  ])("rejects a mismatched %s", (key, value) => {
    const session = {
      ...identity,
      [key]: value,
      qualityGateCompletedAt: 500,
      startedAt: 1_000,
    };
    expect(() =>
      validateReleaseSession(session, identity, { now: 2_000 }),
    ).toThrow(new RegExp(String(key)));
  });

  it("rejects expired and future-dated sessions", () => {
    const now = DEFAULT_MAX_AGE_MS + 10_000;
    expect(() =>
      validateReleaseSession(
        {
          ...identity,
          qualityGateCompletedAt: now - DEFAULT_MAX_AGE_MS - 2,
          startedAt: now - DEFAULT_MAX_AGE_MS - 1,
        },
        identity,
        { now },
      ),
    ).toThrow(/expired/);
    expect(() =>
      validateReleaseSession(
        {
          ...identity,
          qualityGateCompletedAt: now,
          startedAt: now + 1,
        },
        identity,
        { now },
      ),
    ).toThrow(/expired/);
  });

  it("requires a successful, recent quality gate before session creation", () => {
    const now = 10_000;
    const proof = { ...identity, completedAt: now - 1_000 };
    expect(validateQualityGate(proof, identity, { now })).toBe(proof);
    expect(() =>
      validateQualityGate(
        { ...proof, completedAt: now - DEFAULT_MAX_AGE_MS - 1 },
        identity,
        { now },
      ),
    ).toThrow(/expired/);
  });

  it("rejects sessions without a quality-gate proof", () => {
    expect(() =>
      validateReleaseSession(
        {
          ...identity,
          qualityGateCompletedAt: Number.NaN,
          startedAt: 9_000,
        },
        identity,
        { now: 10_000 },
      ),
    ).toThrow(/quality-gate proof/);
  });

  it("rejects sessions where the quality gate did not run before session start", () => {
    // qualityGateCompletedAt equal to startedAt — gate and session created
    // in the same millisecond, which cannot happen via createReleaseSession.
    expect(() =>
      validateReleaseSession(
        { ...identity, qualityGateCompletedAt: 9_000, startedAt: 9_000 },
        identity,
        { now: 10_000 },
      ),
    ).toThrow(/quality-gate proof/);

    // qualityGateCompletedAt strictly after startedAt — clearly invalid.
    expect(() =>
      validateReleaseSession(
        { ...identity, qualityGateCompletedAt: 9_001, startedAt: 9_000 },
        identity,
        { now: 10_000 },
      ),
    ).toThrow(/quality-gate proof/);
  });

  // Six synchronous `execFileSync("git", ...)` calls are fast in isolation,
  // but this is one of the few tests in the suite that shells out to real
  // subprocesses rather than doing only in-process work, so it can
  // occasionally exceed vitest's 5s default under the full suite's ~55
  // concurrent jsdom worker load (same class of flake fixed for the macOS
  // 7-Zip compatibility test).
  it("binds a recorded clean-tree quality gate to the release session", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "zinnia-release-session-"),
    );
    try {
      fs.mkdirSync(path.join(root, "src-tauri"));
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ version: "1.2.3-beta.1" }),
      );
      fs.writeFileSync(path.join(root, "package-lock.json"), "lock\n");
      fs.writeFileSync(path.join(root, "src-tauri", "Cargo.lock"), "cargo\n");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Zinnia Test",
          "-c",
          "user.email=zinnia@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: root },
      );

      // Add .gitignore to fixture so proof path coverage/.release-quality.json is ignored
      fs.writeFileSync(path.join(root, ".gitignore"), "/coverage/*\n");
      execFileSync("git", ["add", ".gitignore"], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Zinnia Test",
          "-c",
          "user.email=zinnia@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "add gitignore",
        ],
        { cwd: root },
      );

      expect(recordSuccessfulQualityGate(root).recorded).toBe(true);

      // Generated ACL schemas rewritten by tauri build must not block the quality
      // gate — including when they are tracked and show porcelain " M path".
      const schemaDir = path.join(root, "src-tauri", "gen", "schemas");
      fs.mkdirSync(schemaDir, { recursive: true });
      fs.writeFileSync(path.join(schemaDir, "linux-schema.json"), "clean\n");
      execFileSync("git", ["add", "src-tauri/gen/schemas/linux-schema.json"], {
        cwd: root,
      });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Zinnia Test",
          "-c",
          "user.email=zinnia@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "add schema",
        ],
        { cwd: root },
      );
      fs.writeFileSync(path.join(schemaDir, "linux-schema.json"), "dirty\n");
      expect(recordSuccessfulQualityGate(root).recorded).toBe(true);

      const session = createReleaseSession(root);
      const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify(session));
      expect(verifyReleaseSession(root).commit).toBe(session.commit);

      fs.writeFileSync(path.join(root, "package-lock.json"), "changed\n");
      expect(() => verifyReleaseSession(root)).toThrow(/packageLockSha256/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
