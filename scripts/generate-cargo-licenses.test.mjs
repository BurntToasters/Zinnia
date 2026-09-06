import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  findSourceLicenseInCheckout,
  normalizedRepositoryUrl,
} from "./generate-cargo-licenses.js";

test("strict Cargo license recovery walks from a crate to its workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "zinnia-license-test-"));
  try {
    mkdirSync(join(root, "crates", "example"), { recursive: true });
    writeFileSync(
      join(root, "LICENSE"),
      "Permission is hereby granted to use this test license.\n",
    );
    const result = findSourceLicenseInCheckout(
      { license_file: null },
      { revision: "a".repeat(40), pathInRepository: "crates/example" },
      root,
      "https://example.com/repository.git",
    );
    assert.equal(result?.directory, ".");
    assert.match(result?.text || "", /Permission is hereby granted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source recovery accepts only credential-free HTTPS repositories", () => {
  assert.equal(
    normalizedRepositoryUrl("git+https://github.com/example/repo.git#main"),
    "https://github.com/example/repo.git",
  );
  assert.equal(normalizedRepositoryUrl("http://example.com/repo.git"), null);
  assert.equal(normalizedRepositoryUrl("https://user@example.com/repo.git"), null);
});
