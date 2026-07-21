import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeUpdaterSignature } from "../../scripts/updater-signature-verifier.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeSignature(contents: string): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-signature-test-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, "artifact.sig");
  fs.writeFileSync(file, contents);
  return file;
}

describe("updater signature normalization", () => {
  const envelope =
    "untrusted comment: test\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\ntrusted comment: test\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n";

  it("wraps a raw Minisign envelope for Tauri manifests", () => {
    expect(normalizeUpdaterSignature(writeSignature(envelope))).toBe(
      Buffer.from(envelope.trim(), "utf8").toString("base64"),
    );
  });

  it("preserves an already wrapped Minisign envelope", () => {
    const wrapped = Buffer.from(envelope, "utf8").toString("base64");
    expect(normalizeUpdaterSignature(writeSignature(wrapped))).toBe(wrapped);
  });
});
