import { describe, expect, it } from "vitest";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";

describe("extract overwrite policy", () => {
  it("auto-renames colliding extract members", () => {
    expect(SAFE_EXTRACT_OVERWRITE_MODE).toBe("-aou");
  });
});
