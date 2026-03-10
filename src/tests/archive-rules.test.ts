import assert from "node:assert/strict";

import { ensureArchivePaths, validateExtraArgs } from "../archive-rules.ts";

export async function runArchiveRulesTests() {
  assert.doesNotThrow(() => validateExtraArgs(["-mx=9", "-r", "-bb3"]));

  assert.throws(() => validateExtraArgs(["-psecret"]));
  assert.throws(() => validateExtraArgs(["--totally-unknown"]));

  await assert.rejects(
    ensureArchivePaths(
      ["C:/tmp/notes.txt"],
      "extract",
      async () => [{ path: "C:/tmp/notes.txt", valid: false, reason: "File does not exist." }]
    ),
    /File does not exist/
  );

  await assert.doesNotReject(
    ensureArchivePaths(
      ["C:/tmp/archive.7z", "C:/tmp/data.zip"],
      "extract",
      async () => [
        { path: "C:/tmp/archive.7z", valid: true },
        { path: "C:/tmp/data.zip", valid: true },
      ]
    )
  );

  await assert.doesNotReject(
    ensureArchivePaths(
      ["C:/tmp/extensionless-archive"],
      "extract",
      async () => [{ path: "C:/tmp/extensionless-archive", valid: true }]
    )
  );

  await assert.rejects(
    ensureArchivePaths(
      ["C:/tmp/archive.7z"],
      "extract",
      async () => {
        throw new Error("backend unavailable");
      }
    ),
    /Unable to validate selected inputs/
  );
}
