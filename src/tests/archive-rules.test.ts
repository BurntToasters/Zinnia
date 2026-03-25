import { describe, it, expect } from "vitest";
import { ensureArchivePaths, validateExtraArgs } from "../archive-rules";

describe("validateExtraArgs", () => {
  it("accepts valid known args", () => {
    expect(() => validateExtraArgs(["-mx=9", "-r", "-bb3"])).not.toThrow();
  });

  it("rejects password args", () => {
    expect(() => validateExtraArgs(["-psecret"])).toThrow();
  });

  it("rejects unknown double-dash args", () => {
    expect(() => validateExtraArgs(["--totally-unknown"])).toThrow();
  });
});

describe("ensureArchivePaths", () => {
  it("rejects invalid paths", async () => {
    await expect(
      ensureArchivePaths(["C:/tmp/notes.txt"], "extract", async () => [
        {
          path: "C:/tmp/notes.txt",
          valid: false,
          reason: "File does not exist.",
        },
      ]),
    ).rejects.toThrow(/File does not exist/);
  });

  it("accepts valid paths", async () => {
    await expect(
      ensureArchivePaths(
        ["C:/tmp/archive.7z", "C:/tmp/data.zip"],
        "extract",
        async () => [
          { path: "C:/tmp/archive.7z", valid: true },
          { path: "C:/tmp/data.zip", valid: true },
        ],
      ),
    ).resolves.not.toThrow();
  });

  it("accepts extensionless archives when backend validates them", async () => {
    await expect(
      ensureArchivePaths(
        ["C:/tmp/extensionless-archive"],
        "extract",
        async () => [{ path: "C:/tmp/extensionless-archive", valid: true }],
      ),
    ).resolves.not.toThrow();
  });

  it("wraps backend errors gracefully", async () => {
    await expect(
      ensureArchivePaths(["C:/tmp/archive.7z"], "extract", async () => {
        throw new Error("backend unavailable");
      }),
    ).rejects.toThrow(/Unable to validate selected inputs/);
  });
});
