import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTRA_PREFIXES,
  ALLOWED_METHOD_PREFIXES,
  validateExtraArgs,
} from "../archive-rules";

describe("custom argument allow-list", () => {
  it("exposes narrowed method prefixes plus safe switch families", () => {
    expect(ALLOWED_METHOD_PREFIXES).toContain("-mx");
    expect(ALLOWED_METHOD_PREFIXES).toContain("-mhe=");
    expect(ALLOWED_EXTRA_PREFIXES).toEqual([
      ...ALLOWED_METHOD_PREFIXES,
      "-x",
      "-i",
      "-ao",
      "-bb",
      "-bt",
      "-scs",
      "-slt",
      "-stl",
      "-slp",
      "-ssp",
      "-sse",
      "-y",
      "-r",
    ]);
  });

  it("does not expose filesystem, stream, sfx, or -ssw controls via extras", () => {
    expect(ALLOWED_EXTRA_PREFIXES).not.toEqual(
      expect.arrayContaining([
        "-w",
        "-si",
        "-so",
        "-snl",
        "-snh",
        "-sfx",
        "-ssw",
        "-m",
      ]),
    );
    expect(() => validateExtraArgs(["-ssw"])).toThrow();
    expect(() => validateExtraArgs(["-snl"])).toThrow();
    expect(() => validateExtraArgs(["-mfoo=1"])).toThrow();
    expect(() => validateExtraArgs(["-mxyz"])).toThrow();
    expect(() => validateExtraArgs(["-mx=9", "-mmt=on"])).not.toThrow();
  });
});
