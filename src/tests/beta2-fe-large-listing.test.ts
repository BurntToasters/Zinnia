import { describe, it, expect } from "vitest";
import { parseArchiveListing } from "../archive";
import type { BrowseEntry } from "../browse-model";
import {
  buildEntryTree,
  computeNodeCheckState,
  computeNodeCheckStates,
  getRecursiveSelectionPaths,
  selectEntries,
} from "../selective-extract";
import type { TreeNode } from "../selective-extract";

function sltListing(records: string[][]): string {
  const header = [
    "--",
    "Path = fixture.zip",
    "Type = zip",
    "Physical Size = 100",
    "Method = Deflate",
    "Solid = -",
    "",
    "----------",
  ];
  const body = records.flatMap((record) => [...record, "----------"]);
  return [...header, ...body].join("\n");
}

function entry(path: string, isFolder = false, size = 1): BrowseEntry {
  return { path, size, packedSize: 0, modified: "", isFolder };
}

function allNodes(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop()!;
    out.push(node);
    pending.push(...node.children);
  }
  return out;
}

function selectionsFor(paths: string[]): Set<string>[] {
  return [
    new Set<string>(),
    new Set(paths),
    new Set(paths.filter((_, index) => index % 3 === 0)),
    new Set(["empty"]),
    new Set(["docs/guide/install.md"]),
  ];
}

describe("parseArchiveListing folder flag precedence", () => {
  it("keeps Folder = + a folder when a later Attributes line lacks D", () => {
    const info = parseArchiveListing(
      sltListing([
        [
          "Path = docs",
          "Size = 0",
          "Packed Size = 0",
          "Folder = +",
          "Attributes = A -rw-r--r--",
        ],
      ]),
    );
    expect(info.entries).toEqual([
      { path: "docs", size: 0, packedSize: 0, modified: "", isFolder: true },
    ]);
  });

  it("lets Folder = - win over an Attributes line that has D", () => {
    const info = parseArchiveListing(
      sltListing([
        [
          "Path = notes.txt",
          "Size = 4",
          "Folder = -",
          "Attributes = D drwxr-xr-x",
        ],
      ]),
    );
    expect(info.entries[0].isFolder).toBe(false);
  });

  it("does not depend on whether Attributes comes before or after Folder", () => {
    const info = parseArchiveListing(
      sltListing([
        ["Path = after", "Attributes = A", "Folder = +"],
        ["Path = before", "Folder = -", "Attributes = D"],
      ]),
    );
    expect(info.entries.map((item) => [item.path, item.isFolder])).toEqual([
      ["after", true],
      ["before", false],
    ]);
  });

  it("falls back to Attributes only when no Folder line exists", () => {
    const info = parseArchiveListing(
      sltListing([
        ["Path = dir", "Attributes = D drwxr-xr-x"],
        ["Path = file.txt", "Attributes = A -rw-r--r--"],
      ]),
    );
    expect(info.entries.map((item) => [item.path, item.isFolder])).toEqual([
      ["dir", true],
      ["file.txt", false],
    ]);
  });
});

const CHECK_TREE_ENTRIES: BrowseEntry[] = [
  entry("docs", true),
  entry("docs/guide", true),
  entry("docs/guide/install.md"),
  entry("docs/guide/faq.md"),
  entry("docs/readme.md"),
  entry("empty", true),
  entry("src", true),
  entry("src/main.ts"),
  entry("src/lib/util.ts"),
  entry("root.txt"),
];

const WINDOWS_CHECK_ENTRIES: BrowseEntry[] = [
  entry("win\\dir", true),
  entry("win\\dir\\a.txt"),
  entry("win\\dir\\sub\\b.txt"),
  entry("win\\empty", true),
];

describe("computeNodeCheckStates", () => {
  it("matches computeNodeCheckState for every node and selection", () => {
    for (const [entries, windowsPaths] of [
      [CHECK_TREE_ENTRIES, false],
      [WINDOWS_CHECK_ENTRIES, true],
    ] as const) {
      const tree = buildEntryTree(entries, windowsPaths);
      const nodes = allNodes(tree);
      expect(nodes.length).toBeGreaterThan(0);
      for (const selected of selectionsFor(nodes.map((node) => node.path))) {
        const states = computeNodeCheckStates(tree, selected);
        for (const node of nodes) {
          expect(states.get(node)).toBe(computeNodeCheckState(node, selected));
        }
      }
    }
  });

  it("gives an empty folder its own selection and never indeterminate", () => {
    const tree = buildEntryTree(CHECK_TREE_ENTRIES);
    const empty = tree.find((node) => node.name === "empty");
    expect(empty).toBeDefined();
    expect(computeNodeCheckStates(tree, new Set(["empty"])).get(empty!)).toBe(
      "checked",
    );
    expect(computeNodeCheckStates(tree, new Set()).get(empty!)).toBe(
      "unchecked",
    );
  });
});

describe("selectEntries matches the per-target recursion", () => {
  const SCOPE: BrowseEntry[] = [
    entry("docs", true),
    entry("docs/guide/", true),
    entry("docs/guide/install.md"),
    entry("docs/readme.md"),
    entry("docs2/a.txt"),
    entry("docs2", true),
    entry("empty", true),
    entry("top.txt"),
  ];

  const WINDOWS_SCOPE: BrowseEntry[] = [
    entry("win\\dir", true),
    entry("win\\dir\\a.txt"),
    entry("win\\dir2\\b.txt"),
    entry("win\\empty", true),
  ];

  function oracle(
    scope: BrowseEntry[],
    targets: BrowseEntry[],
    windowsPaths: boolean,
  ): string[] {
    const out = new Set<string>();
    for (const target of targets) {
      for (const path of getRecursiveSelectionPaths(
        scope,
        target.path,
        target.isFolder,
        windowsPaths,
      )) {
        out.add(path);
      }
    }
    return [...out].sort();
  }

  function actual(
    scope: BrowseEntry[],
    targets: BrowseEntry[],
    windowsPaths: boolean,
  ): string[] {
    return [...selectEntries(new Set(), targets, scope, windowsPaths)].sort();
  }

  it("selects every scope member under each folder target", () => {
    expect(actual(SCOPE, SCOPE, false)).toEqual(oracle(SCOPE, SCOPE, false));
  });

  it("uses the full scope for collapsed folder targets", () => {
    const targets = SCOPE.filter(
      (item) => item.path === "docs" || item.path === "empty",
    );
    expect(actual(SCOPE, targets, false)).toEqual(
      oracle(SCOPE, targets, false),
    );
  });

  it("stays inside a visible-only search scope", () => {
    const visible = SCOPE.filter((item) => item.path.includes("docs2"));
    expect(actual(visible, visible, false)).toEqual(
      oracle(visible, visible, false),
    );
  });

  it("matches the oracle for Windows separators", () => {
    expect(actual(WINDOWS_SCOPE, WINDOWS_SCOPE, true)).toEqual(
      oracle(WINDOWS_SCOPE, WINDOWS_SCOPE, true),
    );
  });

  it("keeps the existing selection when adding targets", () => {
    const next = selectEntries(
      new Set(["keep.txt"]),
      [entry("top.txt")],
      SCOPE,
      false,
    );
    expect(next.has("keep.txt")).toBe(true);
    expect(next.has("top.txt")).toBe(true);
  });
});
