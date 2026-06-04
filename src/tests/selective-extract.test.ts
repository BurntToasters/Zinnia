import { describe, it, expect } from "vitest";
import type { BrowseEntry } from "../browse-model";
import {
  buildSelectiveExtractArgs,
  buildEntryTree,
  computeNodeCheckState,
  clearPathSelection,
  filterBrowseEntriesByQuery,
  isPathWithinFolder,
  normalizeSelectiveSearchQuery,
  selectEntries,
  selectPaths,
  toggleEntrySelection,
  togglePathSelection,
} from "../selective-extract";
import type { TreeNode } from "../selective-extract";

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

describe("buildEntryTree", () => {
  function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
    for (const node of nodes) {
      if (node.path === path) return node;
      const found = findNode(node.children, path);
      if (found) return found;
    }
    return undefined;
  }

  it("nests files under their folders", () => {
    const tree = buildEntryTree(SAMPLE_ENTRIES);
    const docs = findNode(tree, "docs");
    expect(docs?.isFolder).toBe(true);
    expect(findNode(tree, "docs/readme.md")?.isFolder).toBe(false);
    expect(findNode(tree, "docs/guide/install.md")).toBeDefined();
  });

  it("synthesizes intermediate folders absent from the entry list", () => {
    const tree = buildEntryTree([
      {
        path: "a/b/c.txt",
        size: 1,
        packedSize: 1,
        modified: "",
        isFolder: false,
      },
    ]);
    const a = findNode(tree, "a");
    expect(a?.isFolder).toBe(true);
    expect(findNode(tree, "a/b")?.isFolder).toBe(true);
  });

  it("sorts folders before files alphabetically", () => {
    const tree = buildEntryTree(SAMPLE_ENTRIES);
    const topNames = tree.map((n) => n.name);
    const docsIdx = topNames.indexOf("docs");
    const fileIdx = topNames.indexOf("-leading-switch-name.txt");
    expect(docsIdx).toBeLessThan(fileIdx);
  });
});

describe("computeNodeCheckState", () => {
  it("returns checked when all descendant files are selected", () => {
    const tree = buildEntryTree(SAMPLE_ENTRIES);
    const docs = tree.find((n) => n.path === "docs")!;
    const selected = new Set(["docs/readme.md", "docs/guide/install.md"]);
    expect(computeNodeCheckState(docs, selected)).toBe("checked");
  });

  it("returns indeterminate when some descendants are selected", () => {
    const tree = buildEntryTree(SAMPLE_ENTRIES);
    const docs = tree.find((n) => n.path === "docs")!;
    const selected = new Set(["docs/readme.md"]);
    expect(computeNodeCheckState(docs, selected)).toBe("indeterminate");
  });

  it("returns unchecked when nothing is selected", () => {
    const tree = buildEntryTree(SAMPLE_ENTRIES);
    const docs = tree.find((n) => n.path === "docs")!;
    expect(computeNodeCheckState(docs, new Set())).toBe("unchecked");
  });

  it("reflects a single file's own state", () => {
    const tree = buildEntryTree(SAMPLE_ENTRIES);
    const src = tree.find((n) => n.path === "src")!;
    const file = src.children[0];
    expect(computeNodeCheckState(file, new Set([file.path]))).toBe("checked");
    expect(computeNodeCheckState(file, new Set())).toBe("unchecked");
  });
});
