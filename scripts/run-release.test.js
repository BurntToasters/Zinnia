import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseArgs } from "./run-release.js";

test("parseReleaseArgs accepts platform and optional --skip-e2e", () => {
  assert.deepEqual(parseReleaseArgs(["win"]), {
    platform: "win",
    skipE2e: false,
    continueScript: "release:win:continue",
  });
  assert.deepEqual(parseReleaseArgs(["mac", "--skip-e2e"]), {
    platform: "mac",
    skipE2e: true,
    continueScript: "release:mac:continue",
  });
  assert.deepEqual(parseReleaseArgs(["--skip-e2e", "linux:x64"]), {
    platform: "linux:x64",
    skipE2e: true,
    continueScript: "release:linux:x64:continue",
  });
  assert.deepEqual(parseReleaseArgs(["linux"]), {
    platform: "linux",
    skipE2e: false,
    continueScript: "release:linux:continue",
  });
  assert.deepEqual(parseReleaseArgs(["linux:arm64", "--skip-e2e"]), {
    platform: "linux:arm64",
    skipE2e: true,
    continueScript: "release:linux:arm64:continue",
  });
});

test("parseReleaseArgs rejects unknown flags and platforms", () => {
  assert.throws(() => parseReleaseArgs(["win", "--skip-tests"]), /Unknown/);
  assert.throws(() => parseReleaseArgs([]), /Usage/);
  assert.throws(() => parseReleaseArgs(["bsd"]), /Usage/);
  assert.throws(() => parseReleaseArgs(["win", "mac"]), /Usage/);
});
