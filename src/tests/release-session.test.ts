import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  DEFAULT_MAX_AGE_MS,
  RELEASE_SESSION_RELATIVE_PATH,
  createReleaseSession,
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

      expect(recordSuccessfulQualityGate(root)).toBe(true);
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
  });
});
