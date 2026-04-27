import { beforeEach, describe, expect, it } from "vitest";
import { cacheBrowseInfo, cacheSelection, state } from "../state";
import type { ArchiveInfo } from "../browse-model";

function makeArchiveInfo(seed: number): ArchiveInfo {
  return {
    type: "7z",
    physicalSize: seed,
    method: "LZMA2",
    solid: false,
    encrypted: false,
    entries: [],
  };
}

beforeEach(() => {
  state.browseArchiveInfoByPath.clear();
  state.browseSelectionsByArchive.clear();
});

describe("cacheBrowseInfo", () => {
  it("stores archive metadata for a path", () => {
    cacheBrowseInfo("/tmp/archive.7z", makeArchiveInfo(1));

    expect(
      state.browseArchiveInfoByPath.get("/tmp/archive.7z")?.physicalSize,
    ).toBe(1);
  });

  it("evicts oldest archive metadata after cache limit", () => {
    for (let i = 0; i < 10; i += 1) {
      cacheBrowseInfo(`/tmp/archive-${i}.7z`, makeArchiveInfo(i));
    }

    cacheBrowseInfo("/tmp/archive-10.7z", makeArchiveInfo(10));

    expect(state.browseArchiveInfoByPath.size).toBe(10);
    expect(state.browseArchiveInfoByPath.has("/tmp/archive-0.7z")).toBe(false);
    expect(state.browseArchiveInfoByPath.has("/tmp/archive-10.7z")).toBe(true);
  });
});

describe("cacheSelection", () => {
  it("stores selection set for archive", () => {
    cacheSelection("/tmp/archive.7z", new Set(["a.txt", "b.txt"]));

    expect(state.browseSelectionsByArchive.get("/tmp/archive.7z")?.size).toBe(
      2,
    );
  });

  it("evicts oldest selection set after cache limit", () => {
    for (let i = 0; i < 10; i += 1) {
      cacheSelection(`/tmp/archive-${i}.7z`, new Set([`entry-${i}`]));
    }

    cacheSelection("/tmp/archive-10.7z", new Set(["latest"]));

    expect(state.browseSelectionsByArchive.size).toBe(10);
    expect(state.browseSelectionsByArchive.has("/tmp/archive-0.7z")).toBe(
      false,
    );
    expect(state.browseSelectionsByArchive.has("/tmp/archive-10.7z")).toBe(
      true,
    );
  });
});
