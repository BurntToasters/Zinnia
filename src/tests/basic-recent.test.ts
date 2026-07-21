import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../archive-rules", () => ({
  validateArchivePaths: vi.fn(),
}));

import { validateArchivePaths } from "../archive-rules";
import {
  loadRecentArchives,
  pruneMissingRecentArchives,
  saveRecentArchives,
} from "../basic/recent";

const KEY = "zinnia.basic.recentArchives";

describe("pruneMissingRecentArchives", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(validateArchivePaths).mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("removes paths that no longer exist and keeps the rest", async () => {
    saveRecentArchives(["/tmp/gone.7z", "/tmp/alive.7z"]);
    vi.mocked(validateArchivePaths).mockResolvedValue([
      {
        path: "/tmp/gone.7z",
        valid: false,
        reason: "File does not exist.",
      },
      { path: "/tmp/alive.7z", valid: true },
    ]);

    const kept = await pruneMissingRecentArchives();
    expect(kept).toEqual(["/tmp/alive.7z"]);
    expect(loadRecentArchives()).toEqual(["/tmp/alive.7z"]);
  });

  it("does not drop paths that fail for non-missing reasons", async () => {
    saveRecentArchives(["/tmp/not-archive.bin"]);
    vi.mocked(validateArchivePaths).mockResolvedValue([
      {
        path: "/tmp/not-archive.bin",
        valid: false,
        reason: "File is not a recognized archive.",
      },
    ]);

    const kept = await pruneMissingRecentArchives();
    expect(kept).toEqual(["/tmp/not-archive.bin"]);
    expect(localStorage.getItem(KEY)).toContain("not-archive.bin");
  });

  it("leaves the list alone when probing fails", async () => {
    saveRecentArchives(["/tmp/a.7z"]);
    vi.mocked(validateArchivePaths).mockRejectedValue(new Error("offline"));

    const kept = await pruneMissingRecentArchives();
    expect(kept).toEqual(["/tmp/a.7z"]);
  });

  it("does not clobber a newer list when prune is superseded", async () => {
    saveRecentArchives(["/tmp/old.7z"]);
    let release!: (
      value: Awaited<ReturnType<typeof validateArchivePaths>>,
    ) => void;
    vi.mocked(validateArchivePaths).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = pruneMissingRecentArchives();
    saveRecentArchives(["/tmp/new.7z"]);
    release([
      { path: "/tmp/old.7z", valid: false, reason: "File does not exist." },
    ]);

    const kept = await pending;
    expect(kept).toEqual(["/tmp/new.7z"]);
    expect(loadRecentArchives()).toEqual(["/tmp/new.7z"]);
  });
});
