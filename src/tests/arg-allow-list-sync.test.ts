/**
 * Sync test: verifies the TS extra-arg allow-list (archive-rules.ts) is a valid
 * subset of the Rust allow-list (validation.rs). The Rust list is authoritative;
 * the TS list is a client-side UX pre-check. If they drift, users see confusing
 * late rejections from the backend. This test keeps them aligned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the TS allow-list from source
function readTsAllowedPrefixes(): string[] {
  const source = readFileSync(
    resolve(__dirname, "../archive-rules.ts"),
    "utf8",
  );
  const match = source.match(/ALLOWED_EXTRA_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
  if (!match)
    throw new Error(
      "Could not parse ALLOWED_EXTRA_PREFIXES from archive-rules.ts",
    );
  const items = match[1].match(/"([^"]+)"/g);
  return (items ?? []).map((s: string) => s.replace(/"/g, ""));
}

// Read the Rust allow-list from source
function readRustAllowedPrefixes(): string[] {
  const source = readFileSync(
    resolve(__dirname, "../../src-tauri/src/validation.rs"),
    "utf8",
  );
  const match = source.match(
    /ALLOWED_7Z_SWITCH_PREFIXES:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/,
  );
  if (!match)
    throw new Error(
      "Could not parse ALLOWED_7Z_SWITCH_PREFIXES from validation.rs",
    );
  const items = match[1].match(/"([^"]+)"/g);
  return (items ?? []).map((s: string) => s.replace(/"/g, ""));
}

describe("arg allow-list sync", () => {
  it("TS ALLOWED_EXTRA_PREFIXES is a subset of Rust ALLOWED_7Z_SWITCH_PREFIXES", () => {
    const tsPrefixes = readTsAllowedPrefixes();
    const rustPrefixes = new Set(readRustAllowedPrefixes());

    const notInRust = tsPrefixes.filter((p) => !rustPrefixes.has(p));
    expect(notInRust).toEqual([]);
  });

  it("Rust allow-list is non-empty", () => {
    const rustPrefixes = readRustAllowedPrefixes();
    expect(rustPrefixes.length).toBeGreaterThan(10);
  });

  it("TS allow-list is non-empty", () => {
    const tsPrefixes = readTsAllowedPrefixes();
    expect(tsPrefixes.length).toBeGreaterThan(5);
  });
});
