import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../archive-rules", () => ({
  validateArchivePaths: vi.fn(),
}));

import { validateArchivePaths } from "../archive-rules";
import {
  loadRecentArchives,
  pruneMissingRecentArchives,
  saveRecentArchives,
  renderRecentArchives,
  refreshRecentArchives,
  rememberRecentArchive,
  setRecentArchiveHandler,
} from "../basic/recent";

const KEY = "zinnia.basic.recentArchives";

describe("pruneMissingRecentArchives", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(validateArchivePaths).mockReset();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
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
    expect(sessionStorage.getItem(KEY)).toContain("not-archive.bin");
    expect(localStorage.getItem(KEY)).toBeNull();
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

describe("Recent menu interaction", () => {
  let wrap: HTMLElement;
  const handler = vi.fn();
  const items = () =>
    Array.from(
      wrap.querySelectorAll<HTMLButtonElement>(".header-recent__item"),
    );
  const trigger = () =>
    wrap.querySelector<HTMLButtonElement>("#header-recent-btn")!;
  const key = (value: string) =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );

  beforeAll(() => {
    wrap = document.createElement("div");
    wrap.id = "header-recent";
    wrap.innerHTML =
      '<button id="header-recent-btn"></button><div id="header-recent-menu" hidden></div>';
    document.body.append(wrap);
    setRecentArchiveHandler(handler);
  });

  beforeEach(() => {
    document.body.click();
    sessionStorage.clear();
    localStorage.clear();
    handler.mockClear();
    vi.mocked(validateArchivePaths).mockResolvedValue([]);
  });

  afterAll(() => {
    document.body.click();
    wrap.remove();
    sessionStorage.clear();
  });

  it("renders session recents and supports keyboard navigation and Escape", async () => {
    saveRecentArchives(["/tmp/first.7z", "/tmp/second.zip"]);
    renderRecentArchives();
    renderRecentArchives();
    expect(items().map((item) => item.textContent)).toEqual([
      "first.7z",
      "second.zip",
    ]);
    expect(items()[0].title).toBe("/tmp/first.7z");
    trigger().click();
    await vi.waitFor(() =>
      expect(trigger().getAttribute("aria-expanded")).toBe("true"),
    );
    expect(document.activeElement).toBe(items()[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(items()[1]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    key("End");
    expect(document.activeElement).toBe(items()[1]);
    key("Home");
    expect(document.activeElement).toBe(items()[0]);
    key("Escape");
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(wrap.querySelector<HTMLElement>("#header-recent-menu")!.hidden).toBe(
      true,
    );
  });

  it("opens an existing selection but prunes a selection deleted since rendering", async () => {
    saveRecentArchives(["/tmp/alive.7z", "/tmp/gone.zip"]);
    renderRecentArchives();
    items()[0].click();
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledWith("/tmp/alive.7z"),
    );
    handler.mockClear();
    vi.mocked(validateArchivePaths).mockResolvedValue([
      { path: "/tmp/gone.zip", valid: false, reason: "File does not exist." },
    ]);
    items()[1].click();
    await vi.waitFor(() => expect(items()).toHaveLength(1));
    expect(handler).not.toHaveBeenCalled();
    expect(loadRecentArchives()).toEqual(["/tmp/alive.7z"]);
  });

  it("does not reopen after an outside click supersedes a pending open", async () => {
    saveRecentArchives(["/tmp/first.7z"]);
    renderRecentArchives();
    let resolveProbe!: (
      value: Awaited<ReturnType<typeof validateArchivePaths>>,
    ) => void;
    vi.mocked(validateArchivePaths).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    trigger().click();
    document.body.click();
    resolveProbe([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("deduplicates recents, limits the list, and hides the empty menu", async () => {
    saveRecentArchives([
      "/tmp/a.7z",
      "/tmp/b.7z",
      "/tmp/c.7z",
      "/tmp/d.7z",
      "/tmp/e.7z",
    ]);
    rememberRecentArchive("/tmp/c.7z");
    await vi.waitFor(() => expect(items()[0]?.textContent).toBe("c.7z"));
    expect(loadRecentArchives()).toEqual([
      "/tmp/c.7z",
      "/tmp/a.7z",
      "/tmp/b.7z",
      "/tmp/d.7z",
      "/tmp/e.7z",
    ]);
    rememberRecentArchive("/tmp/new.7z");
    await vi.waitFor(() => expect(items()[0]?.textContent).toBe("new.7z"));
    expect(loadRecentArchives()).toHaveLength(5);
    expect(loadRecentArchives()).not.toContain("/tmp/e.7z");
    saveRecentArchives([]);
    await refreshRecentArchives();
    expect(wrap.hidden).toBe(true);
    expect(items()).toHaveLength(0);
  });
});
