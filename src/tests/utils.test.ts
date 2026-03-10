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

  const bearerRaw = "Authorization: Bearer abc.def.ghi";
  const bearerRedacted = redactSensitiveText(bearerRaw);
  assert.equal(bearerRedacted.includes("Bearer ***"), true);

  const jwtRaw = "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sgntrData";
  const jwtRedacted = redactSensitiveText(jwtRaw);
  assert.equal(jwtRedacted.includes("eyJ"), false);

  const skRaw = "OPENAI_KEY=sk-1234567890abcdefghijklmnopqr";
  const skRedacted = redactSensitiveText(skRaw);
  assert.equal(skRedacted.includes("sk-123456"), false);

  assert.equal(isArchiveFile("C:/tmp/file.7z"), true);
  assert.equal(isArchiveFile("C:/tmp/file.tar.gz"), true);
  assert.equal(isArchiveFile("C:/tmp/file.txt"), false);
}
