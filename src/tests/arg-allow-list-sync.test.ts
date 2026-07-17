import { describe, expect, it } from "vitest";
import { ALLOWED_EXTRA_PREFIXES } from "../archive-rules";

describe("custom argument allow-list", () => {
  it("contains only the intentionally exposed safe switch families", () => {
    expect(ALLOWED_EXTRA_PREFIXES).toEqual([
      "-m",
      "-x",
      "-i",
      "-ao",
      "-bb",
      "-bs",
      "-bt",
      "-scs",
      "-slt",
      "-stl",
      "-slp",
      "-ssp",
      "-ssw",
      "-sse",
      "-y",
      "-r",
    ]);
  });

  it("does not expose filesystem, stream, link, or sfx controls", () => {
    expect(ALLOWED_EXTRA_PREFIXES).not.toEqual(
      expect.arrayContaining(["-w", "-si", "-so", "-snl", "-snh", "-sfx"]),
    );
  });
});
