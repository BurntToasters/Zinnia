import { describe, it, expect } from "vitest";
import { parseArchiveListing } from "../archive";

describe("parseArchiveListing", () => {
  it("parses a standard 7z listing", () => {
    const stdout = [
      "Listing archive: test.7z",
      "",
      "--",
      "Path = test.7z",
      "Type = 7z",
      "Physical Size = 1234",
      "Method = LZMA2:24",
      "Solid = +",
      "Blocks = 1",
      "",
      "----------",
      "Path = docs",
      "Size = 0",
      "Packed Size = 0",
      "Modified = 2025-01-15 10:30:00",
      "Folder = +",
      "----------",
      "Path = docs/readme.md",
      "Size = 1024",
      "Packed Size = 512",
      "Modified = 2025-01-15 10:31:00",
      "Folder = -",
      "----------",
      "Path = src/main.ts",
      "Size = 2048",
      "Packed Size = 800",
      "Modified = 2025-01-15 10:32:00",
      "Folder = -",
      "----------",
    ].join("\n");

    const info = parseArchiveListing(stdout);
    expect(info.type).toBe("7z");
    expect(info.physicalSize).toBe(1234);
    expect(info.method).toBe("LZMA2:24");
    expect(info.solid).toBe(true);
    expect(info.entries.length).toBe(3);
    expect(info.entries[0]).toEqual({
      path: "docs",
      size: 0,
      packedSize: 0,
      modified: "2025-01-15 10:30:00",
      isFolder: true,
    });
    expect(info.entries[1].path).toBe("docs/readme.md");
    expect(info.entries[1].size).toBe(1024);
    expect(info.entries[1].isFolder).toBe(false);
    expect(info.entries[2].path).toBe("src/main.ts");
  });

  it("detects encryption from Encrypted flag", () => {
    const stdout = [
      "--",
      "Type = 7z",
      "Physical Size = 500",
      "Encrypted = +",
      "",
      "----------",
      "Path = secret.txt",
      "Size = 100",
      "Packed Size = 50",
      "Modified = 2025-01-01 00:00:00",
      "Folder = -",
      "----------",
    ].join("\n");

    const info = parseArchiveListing(stdout);
    expect(info.encrypted).toBe(true);
  });

  it("detects encryption from Method containing AES", () => {
    const stdout = [
      "--",
      "Type = zip",
      "Physical Size = 500",
      "Method = AES-256 Deflate",
      "",
      "----------",
      "Path = data.bin",
      "Size = 200",
      "Packed Size = 150",
      "Modified = 2025-01-01 00:00:00",
      "Folder = -",
      "----------",
    ].join("\n");

    const info = parseArchiveListing(stdout);
    expect(info.encrypted).toBe(true);
  });

  it("detects per-file encryption from entry Method", () => {
    const stdout = [
      "--",
      "Type = zip",
      "Physical Size = 900",
      "",
      "----------",
      "Path = encrypted.txt",
      "Size = 300",
      "Packed Size = 250",
      "Modified = 2025-01-01 00:00:00",
      "Folder = -",
      "Method = 7zAES:19",
      "----------",
    ].join("\n");

    const info = parseArchiveListing(stdout);
    expect(info.encrypted).toBe(true);
  });

  it("returns empty entries for empty archive listing", () => {
    const stdout = [
      "--",
      "Type = 7z",
      "Physical Size = 100",
      "",
      "----------",
      "----------",
    ].join("\n");

    const info = parseArchiveListing(stdout);
    expect(info.type).toBe("7z");
    expect(info.entries.length).toBe(0);
  });

  it("handles listing with no closing separator", () => {
    const stdout = [
      "--",
      "Type = tar",
      "Physical Size = 2000",
      "",
      "----------",
      "Path = file.txt",
      "Size = 500",
      "Packed Size = 500",
      "Modified = 2025-06-01 00:00:00",
      "Folder = -",
    ].join("\n");

    const info = parseArchiveListing(stdout);
    expect(info.entries.length).toBe(1);
    expect(info.entries[0].path).toBe("file.txt");
  });

  it("defaults missing fields to reasonable values", () => {
    const stdout = [
      "--",
      "Type = zip",
      "",
      "----------",
      "Path = minimal.txt",
      "----------",
    ].join("\n");

    const info = parseArchiveListing(stdout);
    expect(info.entries.length).toBe(1);
    expect(info.entries[0]).toEqual({
      path: "minimal.txt",
      size: 0,
      packedSize: 0,
      modified: "",
      isFolder: false,
    });
  });
});
