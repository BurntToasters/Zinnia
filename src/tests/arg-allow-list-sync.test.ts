import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_METHOD_PREFIXES, validateExtraArgs } from "../archive-rules";

describe("custom argument allow-list", () => {
  it("exposes narrowed method prefixes", () => {
    expect(ALLOWED_METHOD_PREFIXES).toContain("-mx");
    expect(ALLOWED_METHOD_PREFIXES).toContain("-mhe=");
  });

  it("keeps the UI list a subset of validation.rs is_allowed_switch", () => {
    const rust = fs.readFileSync(
      "src-tauri/src/validation.rs",
      "utf8",
    ) as string;
    for (const literal of [
      '"-bsp1"',
      '"-y"',
      '"-stl"',
      '"-slp"',
      '"-ssp"',
      '"-sse"',
      '"-slt"',
      '"-bt"',
    ]) {
      expect(rust, `validation.rs must still recognize ${literal}`).toContain(
        literal,
      );
    }
    expect(rust).toContain('arg.eq_ignore_ascii_case("-bsp1")');
  });

  it("does not expose filesystem, stream, sfx, or -ssw controls via extras", () => {
    for (const arg of ["-ssw", "-snl", "-snh", "-sfx7z", "-wtmp", "-o/tmp/x"]) {
      expect(() => validateExtraArgs([arg], "extract")).toThrow();
      expect(() => validateExtraArgs([arg], "compress")).toThrow();
    }
    expect(() =>
      validateExtraArgs(["-mx=9", "-mmt=on"], "compress"),
    ).not.toThrow();
  });
});
