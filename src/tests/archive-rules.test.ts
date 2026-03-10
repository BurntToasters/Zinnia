import assert from "node:assert/strict";

import { ensureArchivePaths, validateExtraArgs } from "../archive-rules.ts";

export function runArchiveRulesTests() {
  assert.doesNotThrow(() => validateExtraArgs(["-mx=9", "-r", "-bb3"]));

  assert.throws(() => validateExtraArgs(["-psecret"]));
  assert.throws(() => validateExtraArgs(["--totally-unknown"]));

  assert.throws(() => ensureArchivePaths(["C:/tmp/notes.txt"], "extract"));
  assert.doesNotThrow(() => ensureArchivePaths(["C:/tmp/archive.7z", "C:/tmp/data.zip"], "extract"));
}
