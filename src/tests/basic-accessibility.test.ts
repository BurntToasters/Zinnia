import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Basic-mode accessibility", () => {
  it("keeps the preset state select out of keyboard and assistive-technology navigation", () => {
    const html = fs.readFileSync(
      path.resolve(process.cwd(), "src", "index.html"),
      "utf8",
    );

    expect(html).toMatch(/<select id="basic-preset" hidden>/);
    expect(html).not.toContain("basic-hidden-select");
  });
});
