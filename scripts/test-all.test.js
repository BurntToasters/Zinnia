import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInitialResults, main } from "./test-all.js";
import {
  QUALITY_GATE_RELATIVE_PATH,
  currentReleaseIdentity,
  recordSuccessfulQualityGate,
  verifyQualityGate,
} from "./release-session.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mockedIdentity = {
  version: "0.7.0-beta.1",
  commit: "a".repeat(40),
  platform: "test",
  arch: "test",
  node: "test",
  rustc: "test",
  packageLockSha256: "b".repeat(64),
  cargoLockSha256: "c".repeat(64),
  sourceSha256: "d".repeat(64),
};

function createReleaseFixture({ schema = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-test-all-proof-"));
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "1.2.3-beta.1" }),
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), "package lock\n");
  fs.writeFileSync(path.join(root, "src-tauri", "Cargo.lock"), "cargo lock\n");
  fs.writeFileSync(
    path.join(root, "src", "index.ts"),
    "export const value = 1;\n",
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "/coverage/*\n");
  if (schema) {
    const schemaDir = path.join(root, "src-tauri", "gen", "schemas");
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.writeFileSync(path.join(schemaDir, "linux-schema.json"), "initial\n");
  }
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
  return root;
}

function runController(root, { mutateAt, mutate, failAt } = {}) {
  return main({
    root,
    captureIdentity: currentReleaseIdentity,
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (name, _command, _args, _parser, results) => {
      if (name === mutateAt) mutate(root);
      const passed = name !== failAt;
      results[name].status = passed ? "passed" : "failed";
      if (name === "test") results.coverage.status = "passed";
      return passed;
    },
  });
}

function readPackageJsonScripts() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    .scripts;
}

test("createInitialResults includes cargoSafeUpdate and cargoUpdatePolicy in initial state", () => {
  const results = createInitialResults();
  assert.equal(results.cargoSafeUpdate.status, "pending");
  assert.equal(results.cargoUpdatePolicy.status, "pending");
  assert.equal(results.vendorUpdater.status, "pending");
  assert.equal(results.archives.status, "pending");
  assert.equal(results.e2e.status, "pending");
});

test("package.json scripts define cargo safe update test and policy check", () => {
  const scripts = readPackageJsonScripts();
  assert.equal(
    scripts["test:cargo-safe-update"],
    "node --test scripts/cargo-safe-update.test.mjs scripts/check-cargo-update-policy.test.mjs scripts/test-all.test.js scripts/run-release.test.js scripts/github-cli.test.cjs scripts/release-branch-protection.test.cjs scripts/release-licenses.test.mjs scripts/npm-dev-audit.test.cjs scripts/generate-cargo-licenses.test.mjs scripts/check-rustsec-ignore-policy.test.mjs scripts/deps-majors.test.mjs",
  );
  assert.equal(
    scripts["check:cargo-update-policy"],
    "node scripts/check-cargo-update-policy.mjs",
  );
  assert.equal(scripts["audit:dev-reviewed"], "node scripts/npm-dev-audit.cjs");
  assert.equal(
    scripts["check:rustsec-ignore-policy"],
    "node scripts/check-rustsec-ignore-policy.mjs",
  );
  assert.equal(
    scripts["repo:protect-beta-tags"],
    "node scripts/release-branch-protection.cjs --apply",
  );
  assert.equal(scripts["repo:protect-release-branches"], undefined);
  assert.equal(scripts["test:archives"], "node scripts/test-archives.js");
  assert.equal(scripts["test:e2e"], "node scripts/test-e2e.js");
});

test("main prevents quality-gate proof recording when cargoSafeUpdate fails", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    recordProof: () => {
      calls.push("recordProof");
      return { recorded: true };
    },
    captureIdentity: () => mockedIdentity,
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "cargoSafeUpdate") {
        results[name].status = "failed";
        return false;
      }
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:cargoSafeUpdate"));
  assert.ok(
    !calls.includes("recordProof"),
    "failing cargoSafeUpdate must not record quality gate proof",
  );
  assert.equal(exitCode, 1);
});

test("main prevents quality-gate proof recording when cargoUpdatePolicy fails", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    recordProof: () => {
      calls.push("recordProof");
      return { recorded: true };
    },
    captureIdentity: () => mockedIdentity,
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "cargoUpdatePolicy") {
        results[name].status = "failed";
        return false;
      }
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:cargoUpdatePolicy"));
  assert.ok(
    !calls.includes("recordProof"),
    "failing cargoUpdatePolicy must not record quality gate proof",
  );
  assert.equal(exitCode, 1);
});

test("main records quality-gate proof when all checks pass", () => {
  const calls = [];
  let captureCount = 0;
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    recordProof: (_root, options) => {
      assert.deepEqual(options, { e2e: "passed", identity: mockedIdentity });
      calls.push("recordProof");
      return { recorded: true };
    },
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    captureIdentity: () => {
      captureCount += 1;
      calls.push("captureIdentity");
      return mockedIdentity;
    },
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:archives"));
  assert.ok(calls.includes("run:e2e"));
  assert.ok(calls.includes("recordProof"));
  assert.equal(captureCount, 2);
  assert.ok(
    calls.indexOf("captureIdentity") < calls.indexOf("run:typecheck"),
    "the tested identity must be captured before the first gate stage",
  );
  assert.equal(exitCode, 0);
});

test("main records explicitly skipped e2e in release proof mode", () => {
  const calls = [];
  const resultsSeen = [];
  const exitCode = main({
    root: repoRoot,
    skipE2e: true,
    requireCleanProof: true,
    clearProof: () => calls.push("clearProof"),
    recordProof: (_root, options) => {
      assert.deepEqual(options, { e2e: "skipped", identity: mockedIdentity });
      calls.push("recordProof");
      return { recorded: true };
    },
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    captureIdentity: () => mockedIdentity,
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      resultsSeen.push(results);
      return true;
    },
  });

  assert.ok(!calls.includes("run:e2e"));
  assert.equal(resultsSeen.at(-1)?.e2e.status, "skipped");
  assert.ok(calls.includes("recordProof"));
  assert.equal(exitCode, 0);
});

test("standalone e2e skip does not record release proof", () => {
  let recorded = false;
  const exitCode = main({
    skipE2e: true,
    clearProof: () => {},
    recordProof: () => {
      recorded = true;
      return { recorded: true };
    },
    captureIdentity: () => mockedIdentity,
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (name, _cmd, _args, _parser, results) => {
      assert.notEqual(name, "e2e");
      results[name].status = "passed";
      return true;
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(recorded, false);
});

test("release e2e skip preserves failures and dirty-tree proof refusal", () => {
  for (const failedCheck of ["cargoSafeUpdate", "rust", null]) {
    let recorded = false;
    const exitCode = main({
      skipE2e: true,
      requireCleanProof: true,
      clearProof: () => {},
      recordProof: () => {
        recorded = true;
        return { recorded: false, dirtyFiles: " M source.ts" };
      },
      captureIdentity: () => mockedIdentity,
      parseCoverage: (results) => {
        results.coverage.status = "passed";
      },
      runner: (name, _cmd, _args, _parser, results) => {
        results[name].status = name === failedCheck ? "failed" : "passed";
        return name !== failedCheck;
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(recorded, failedCheck === null);
  }
});

test("main keeps generic test:all green when proof cannot be recorded", () => {
  const exitCode = main({
    root: repoRoot,
    clearProof: () => {},
    recordProof: () => ({ recorded: false, dirtyFiles: " M source.ts" }),
    captureIdentity: () => mockedIdentity,
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (_name, _cmd, _args, _parser, results) => {
      results[_name].status = "passed";
      if (_name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.equal(exitCode, 0);
});

test("main fails release proof mode when proof cannot be recorded", () => {
  const exitCode = main({
    root: repoRoot,
    clearProof: () => {},
    recordProof: () => ({ recorded: false, dirtyFiles: " M source.ts" }),
    captureIdentity: () => mockedIdentity,
    requireCleanProof: true,
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (_name, _cmd, _args, _parser, results) => {
      results[_name].status = "passed";
      if (_name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.equal(exitCode, 1);
});

test("main rejects tracked source drift between gate stages without writing proof", () => {
  const root = createReleaseFixture();
  try {
    const exitCode = runController(root, {
      mutateAt: "lint",
      mutate: (fixtureRoot) =>
        fs.writeFileSync(
          path.join(fixtureRoot, "src", "index.ts"),
          "export const value = 2;\n",
        ),
    });
    assert.equal(exitCode, 1);
    assert.equal(
      fs.existsSync(path.join(root, QUALITY_GATE_RELATIVE_PATH)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main rejects untracked source added during the gate without writing proof", () => {
  const root = createReleaseFixture();
  try {
    const exitCode = runController(root, {
      mutateAt: "lint",
      mutate: (fixtureRoot) =>
        fs.writeFileSync(
          path.join(fixtureRoot, "src", "new.ts"),
          "export {};\n",
        ),
    });
    assert.equal(exitCode, 1);
    assert.equal(
      fs.existsSync(path.join(root, QUALITY_GATE_RELATIVE_PATH)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main rejects a tracked source deletion during the gate without writing proof", () => {
  const root = createReleaseFixture();
  try {
    const exitCode = runController(root, {
      mutateAt: "lint",
      mutate: (fixtureRoot) =>
        fs.rmSync(path.join(fixtureRoot, "src", "index.ts")),
    });
    assert.equal(exitCode, 1);
    assert.equal(
      fs.existsSync(path.join(root, QUALITY_GATE_RELATIVE_PATH)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main rejects lockfile drift during the gate without writing proof", () => {
  for (const lockfile of ["package-lock.json", "src-tauri/Cargo.lock"]) {
    const root = createReleaseFixture();
    try {
      const exitCode = runController(root, {
        mutateAt: "lint",
        mutate: (fixtureRoot) =>
          fs.appendFileSync(path.join(fixtureRoot, lockfile), "changed\n"),
      });
      assert.equal(exitCode, 1, `${lockfile} drift must fail the gate`);
      assert.equal(
        fs.existsSync(path.join(root, QUALITY_GATE_RELATIVE_PATH)),
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("main records the exact pre-gate dirty source when it stays unchanged", () => {
  const root = createReleaseFixture();
  try {
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      "export const value = 9;\n",
    );
    const exitCode = runController(root);
    assert.equal(exitCode, 0);
    const proof = verifyQualityGate(root);
    assert.equal(proof.sourceSha256, currentReleaseIdentity(root).sourceSha256);
    assert.equal(proof.e2e, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main allows only the generated schema change during the gate", () => {
  const root = createReleaseFixture({ schema: true });
  try {
    const exitCode = runController(root, {
      mutateAt: "lint",
      mutate: (fixtureRoot) =>
        fs.writeFileSync(
          path.join(
            fixtureRoot,
            "src-tauri",
            "gen",
            "schemas",
            "linux-schema.json",
          ),
          "regenerated\n",
        ),
    });
    assert.equal(exitCode, 0);
    assert.equal(verifyQualityGate(root).e2e, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed gate clears an older quality-gate proof", () => {
  const root = createReleaseFixture();
  try {
    assert.equal(recordSuccessfulQualityGate(root).recorded, true);
    assert.equal(
      fs.existsSync(path.join(root, QUALITY_GATE_RELATIVE_PATH)),
      true,
    );
    const exitCode = runController(root, { failAt: "typecheck" });
    assert.equal(exitCode, 1);
    assert.equal(
      fs.existsSync(path.join(root, QUALITY_GATE_RELATIVE_PATH)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
