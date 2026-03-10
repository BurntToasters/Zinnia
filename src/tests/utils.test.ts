import assert from "node:assert/strict";

import { isArchiveFile, redactSensitiveText, splitArgs } from "../utils.ts";

export function runUtilsTests() {
  const args = splitArgs(`-mx=9 -w "C:/My Folder" 'file one.txt'`);
  assert.deepEqual(args, ["-mx=9", "-w", "C:/My Folder", "file one.txt"]);

  const raw = "run -pmySecret password=abc ghp_1234567890123456789012345";
  const redacted = redactSensitiveText(raw);
  assert.equal(redacted.includes("-p***"), true);
  assert.equal(redacted.includes("password=***"), true);
  assert.equal(redacted.includes("ghp_"), false);

  assert.equal(isArchiveFile("C:/tmp/file.7z"), true);
  assert.equal(isArchiveFile("C:/tmp/file.tar.gz"), true);
  assert.equal(isArchiveFile("C:/tmp/file.txt"), false);
}
