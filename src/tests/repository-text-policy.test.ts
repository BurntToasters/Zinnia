import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repository text policy", () => {
  it("writes LF checkouts while tolerating an existing Windows worktree", () => {
    const attributes = fs.readFileSync(
      path.resolve(process.cwd(), ".gitattributes"),
      "utf8",
    );
    const prettier = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), ".prettierrc.json"), "utf8"),
    ) as { endOfLine?: string };

    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
    expect(prettier.endOfLine).toBe("auto");
  });
});
