import { describe, it, expect } from "vitest";
import type { BrowseEntry } from "../browse-model";
import {
  buildSelectiveExtractArgs,
  clearPathSelection,
  filterBrowseEntriesByQuery,
  isPathWithinFolder,
  normalizeSelectiveSearchQuery,
  selectEntries,
  selectPaths,
  toggleEntrySelection,
  togglePathSelection,
} from "../selective-extract";

const SAMPLE_ENTRIES: BrowseEntry[] = [
  {
    path: "docs",
    size: 0,
    packedSize: 0,
    modified: "2025-01-01 12:00:00",
    isFolder: true,
  },
  {
    path: "docs/readme.md",
    size: 1024,
    packedSize: 600,
    modified: "2025-01-01 12:00:00",
    isFolder: false,
  },
  {
    path: "docs/guide/install.md",
    size: 1536,
    packedSize: 900,
    modified: "2025-01-01 12:00:30",
    isFolder: false,
  },
  {
    path: "docs/guides",
    size: 0,
    packedSize: 0,
    modified: "2025-01-01 12:01:00",
    isFolder: true,
  },
  {
    path: "src/main.ts",
    size: 2048,
    packedSize: 900,
    modified: "2025-01-01 12:02:00",
    isFolder: false,
  },
  {
    path: "-leading-switch-name.txt",
    size: 200,
    packedSize: 100,
    modified: "2025-01-01 12:03:00",
    isFolder: false,
  },
];

describe("filterBrowseEntriesByQuery", () => {
  it("filters entries case-insensitively", () => {
    const filtered = filterBrowseEntriesByQuery(SAMPLE_ENTRIES, "DOCS");
    expect(filtered.length).toBe(4);
    expect(filtered[0].path).toBe("docs");
  });

  it("returns all entries for empty query", () => {
    expect(filterBrowseEntriesByQuery(SAMPLE_ENTRIES, "").length).toBe(
      SAMPLE_ENTRIES.length,
    );
  });
});

describe("isPathWithinFolder", () => {
  it("detects paths within folder (forward slash)", () => {
    expect(isPathWithinFolder("docs/guide/install.md", "docs")).toBe(true);
  });

  it("detects paths within folder (backslash)", () => {
    expect(isPathWithinFolder("docs\\guide\\install.md", "docs")).toBe(true);
  });

  it("rejects paths outside folder", () => {
    expect(isPathWithinFolder("src/main.ts", "docs")).toBe(false);
  });
});

describe("togglePathSelection", () => {
  it("adds path when not selected", () => {
    const selected = togglePathSelection(new Set<string>(), "docs/readme.md");
    expect(selected.has("docs/readme.md")).toBe(true);
  });

  it("removes path when already selected", () => {
    const initial = new Set(["docs/readme.md"]);
    const selected = togglePathSelection(initial, "docs/readme.md");
    expect(selected.has("docs/readme.md")).toBe(false);
  });
});

describe("selectPaths", () => {
  it("adds multiple paths", () => {
    const selected = selectPaths(new Set<string>(), [
      "docs/readme.md",
      "src/main.ts",
    ]);
    expect(selected.size).toBe(2);
  });
});

describe("toggleEntrySelection", () => {
  it("selects folder and all its children", () => {
    const selected = toggleEntrySelection(
      new Set<string>(),
      SAMPLE_ENTRIES[0],
      SAMPLE_ENTRIES,
    );
    expect(selected.has("docs")).toBe(true);
    expect(selected.has("docs/readme.md")).toBe(true);
    expect(selected.has("docs/guide/install.md")).toBe(true);
  });

  it("deselects folder and all its children", () => {
    const initial = new Set([
      "docs",
      "docs/readme.md",
      "docs/guide/install.md",
      "docs/guides",
      "src/main.ts",
    ]);
    const selected = toggleEntrySelection(
      initial,
      SAMPLE_ENTRIES[0],
      SAMPLE_ENTRIES,
    );
    expect(selected.has("docs")).toBe(false);
    expect(selected.has("docs/readme.md")).toBe(false);
    expect(selected.has("docs/guide/install.md")).toBe(false);
    expect(selected.has("src/main.ts")).toBe(true);
  });
});

describe("selectEntries", () => {
  it("selects given entries and their children", () => {
    const selected = selectEntries(
      new Set<string>(),
      [SAMPLE_ENTRIES[3]],
      SAMPLE_ENTRIES,
    );
    expect(selected.has("docs/guides")).toBe(true);
  });
});

describe("clearPathSelection", () => {
  it("returns empty set", () => {
    expect(clearPathSelection().size).toBe(0);
  });
});

describe("buildSelectiveExtractArgs", () => {
  it("builds correct args with selected paths", () => {
    expect(
      buildSelectiveExtractArgs(
        "/tmp/archive.7z",
        "/tmp/output",
        "secret",
        ["-aos"],
        ["docs/readme.md", "src/main.ts"],
      ),
    ).toEqual([
      "x",
      "-o/tmp/output",
      "-y",
      "-psecret",
      "-aos",
      "-spd",
      "--",
      "/tmp/archive.7z",
      "docs/readme.md",
      "src/main.ts",
    ]);
  });

  it("uses -- separator to prevent switch-like path injection", () => {
    expect(
      buildSelectiveExtractArgs(
        "/tmp/archive.7z",
        "/tmp/output",
        "",
        [],
        ["-leading-switch-name.txt"],
      ),
    ).toEqual([
      "x",
      "-o/tmp/output",
      "-y",
      "-spd",
      "--",
      "/tmp/archive.7z",
      "-leading-switch-name.txt",
    ]);
  });

  it("extracts everything when no paths selected", () => {
    expect(
      buildSelectiveExtractArgs("/tmp/archive.7z", "/tmp/output", "", [], []),
    ).toEqual(["x", "-o/tmp/output", "-y", "--", "/tmp/archive.7z"]);
  });
});

describe("normalizeSelectiveSearchQuery", () => {
  it("trims whitespace and lowercases", () => {
    expect(normalizeSelectiveSearchQuery("  MyQuery  ")).toBe("myquery");
  });

  it("converts uppercase to lowercase", () => {
    expect(normalizeSelectiveSearchQuery("README")).toBe("readme");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeSelectiveSearchQuery("   ")).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeSelectiveSearchQuery("")).toBe("");
  });

  it("handles mixed case and whitespace", () => {
    expect(normalizeSelectiveSearchQuery("\tDocs/Guide\n")).toBe("docs/guide");
  });
});
