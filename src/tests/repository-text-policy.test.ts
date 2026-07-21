import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repository text policy", () => {
  it("keeps scripts and configuration LF-only on Windows checkouts", () => {
    const attributes = fs.readFileSync(
      path.resolve(process.cwd(), ".gitattributes"),
      "utf8",
    );

    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
  });
});
