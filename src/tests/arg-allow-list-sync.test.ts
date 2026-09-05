import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_METHOD_PREFIXES, validateExtraArgs } from "../archive-rules";

function rustSource(): string {
  return fs.readFileSync("src-tauri/src/validation.rs", "utf8");
}

function rustMethodPrefixes(src: string): string[] {
  const marker = "const PREFIXES: &[&str] = &[";
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("];", start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start + marker.length, end);
  return [...block.matchAll(/"(-[^"]+)"/g)].map((match) => match[1]);
}

describe("custom argument allow-list", () => {
  it("keeps TypeScript method prefixes equal to validation.rs PREFIXES", () => {
    expect([...ALLOWED_METHOD_PREFIXES].sort()).toEqual(
      rustMethodPrefixes(rustSource()).sort(),
    );
  });

  it("keeps accepted extras a subset of validation.rs per command", () => {
    const rust = rustSource();
    for (const extractArg of ["-bsp1", "-y", "-bt", "-bb1", "-slt"]) {
      expect(() => validateExtraArgs([extractArg], "extract")).not.toThrow();
    }
    for (const compressArg of ["-stl", "-slp", "-ssp", "-sse", "-bt", "-bb1"]) {
      expect(() => validateExtraArgs([compressArg], "compress")).not.toThrow();
    }
    expect(rust).toContain("is_allowed_switch");
    expect(rust).toContain('arg.eq_ignore_ascii_case("-bsp1")');
    expect(() =>
      validateExtraArgs(["-mx=9", "-mmt=on"], "compress"),
    ).not.toThrow();
  });

  it("locks extra-args rejects that are stricter than the old Rust allow-list", () => {
    for (const arg of [
      "-r",
      "-r-",
      "-r0",
      "-scsUTF-8",
      "-sccUTF-8",
      "-mcu=off",
      "-mcl=off",
    ]) {
      expect(() => validateExtraArgs([arg], "extract")).toThrow();
      expect(() => validateExtraArgs([arg], "compress")).toThrow();
    }
  });

  it("rejects caller recursion and charset in Rust too", () => {
    const rust = rustSource();
    expect(rust).not.toMatch(/lower == "-r"/);
    expect(rust).not.toContain('lower.starts_with("-scs")');
    expect(rust).not.toContain('lower.starts_with("-scc")');
  });

  it("does not expose filesystem, stream, sfx, or -ssw controls via extras", () => {
    for (const arg of ["-ssw", "-snl", "-snh", "-sfx7z", "-wtmp", "-o/tmp/x"]) {
      expect(() => validateExtraArgs([arg], "extract")).toThrow();
      expect(() => validateExtraArgs([arg], "compress")).toThrow();
    }
  });
});
