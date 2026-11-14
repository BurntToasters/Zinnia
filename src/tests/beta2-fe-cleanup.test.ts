import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { promptPassword } from "../prompt-modal";
import { sanitizeStatusFileName } from "../extract-window/status-sanitize";
import { runBenchmark, cancelBenchmark } from "../benchmark";
import { state } from "../state";
import {
  renderOsIntegrationStatus,
  setZinniaDefaultArchiver,
} from "../os-integration";
import {
  setDebugEnabled,
  wireDebugConsoleControls,
  clearDebugConsole,
} from "../debug-mode";
import { normalizeUserSettings, SETTING_DEFAULTS } from "../settings-model";
import { runWithPasswordRetry } from "../archive/runtime";
import { renderRecentArchives, saveRecentArchives } from "../basic/recent";
import { renderSelectiveExtractModal } from "../archive/selective-tree-ui";
import { showBasicCompletion } from "../basic/progress";
import type { ArchiveInfo, BrowseEntry } from "../browse-model";

vi.mock("../ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ui")>();
  const { state: sharedState } = await import("../state");
  return {
    ...original,
    setRunning: vi.fn((active: boolean) => {
      sharedState.running = active;
    }),
  };
});

vi.mock("../prompt-modal", async (importOriginal) => {
  const original = await importOriginal<typeof import("../prompt-modal")>();
  return { ...original, promptPassword: vi.fn() };
});

const invokeMock = vi.mocked(invoke);
const promptMock = vi.mocked(promptPassword);
const PASSWORD_LABEL = "This archive is encrypted. Enter password:";
const CLOSED_STDIN_LISTING_REJECTION =
  "Could not list archive members for path safety: Break signaled";
const ARCHIVE = "/tmp/header-locked.7z";
const RUN_ARGS = ["x", "-y", "-o/tmp/out", "--", ARCHIVE];

function rejectionEvent(reason: unknown): Event {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}

describe("V-emoji: status file names keep graphemes whole", () => {
  it("V-emoji-1 drops a leading non-BMP symbol without cutting the name", () => {
    expect(sanitizeStatusFileName("🎉file.txt")).toBe("file.txt");
  });

  it("V-emoji-2 keeps a regional-indicator flag at the cap whole", () => {
    expect(sanitizeStatusFileName(`${"a".repeat(199)}🇩🇪zz`)).toBe(
      `${"a".repeat(199)}🇩🇪`,
    );
  });

  it("V-emoji-3 keeps a base letter with its combining accent at the cap", () => {
    expect(sanitizeStatusFileName(`${"a".repeat(199)}e\u0301x`)).toBe(
      `${"a".repeat(199)}e\u0301`,
    );
  });

  it("V-emoji-4 still caps plain names at 200 characters", () => {
    expect(sanitizeStatusFileName("b".repeat(300))).toBe("b".repeat(200));
  });

  it("V-emoji-5 keeps the existing leading-junk rules", () => {
    expect(sanitizeStatusFileName("*** file.txt")).toBe("file.txt");
    expect(sanitizeStatusFileName("报告.pdf")).toBe("报告.pdf");
  });
});

describe("V-bench: benchmark treats a non-zero exit as a failure", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button id="run-benchmark"></button><button id="cancel-benchmark" hidden></button><p id="benchmark-result"></p>';
    state.running = false;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("");
  });

  it("V-bench-1 reports a plain failure instead of a rating", async () => {
    invokeMock.mockResolvedValueOnce({
      stdout: "Tot: 1 2 3333",
      stderr: "",
      code: 2,
    });
    await runBenchmark();
    expect(document.getElementById("benchmark-result")?.textContent).toBe(
      "Benchmark failed: 7-Zip exited with code 2.",
    );
  });

  it("V-bench-2 keeps the rating for a zero exit", async () => {
    invokeMock.mockResolvedValueOnce({
      stdout: "Tot: 1 2 3333",
      stderr: "",
      code: 0,
    });
    await runBenchmark();
    expect(document.getElementById("benchmark-result")?.textContent).toBe(
      "Rating: 3,333 MIPS",
    );
  });

  it("V-bench-3 reports cancellation over a failed exit", async () => {
    let finish!: (value: unknown) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = runBenchmark();
    await vi.waitFor(() => expect(state.running).toBe(true));
    await cancelBenchmark();
    finish({ stdout: "Tot: 1 2 3333", stderr: "", code: 2 });
    await running;
    expect(document.getElementById("benchmark-result")?.textContent).toBe(
      "Benchmark cancelled.",
    );
  });
});

describe("V-osint: default-archiver button keeps its status-derived state", () => {
  function statusWith(
    available: boolean,
    help: string,
  ): Parameters<typeof renderOsIntegrationStatus>[0] {
    return {
      platform: "linux",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: available,
      defaultArchiverActionAvailable: available,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: help,
      archiveDefaults: [],
    };
  }

  beforeEach(() => {
    document.body.innerHTML =
      '<button id="open-os-integration-settings">Make Zinnia Default</button>';
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("");
  });

  it("V-osint-1 stays disabled with its help title after a failed action", async () => {
    const button = document.getElementById(
      "open-os-integration-settings",
    ) as HTMLButtonElement;
    renderOsIntegrationStatus(
      statusWith(false, "Zinnia cannot change archive defaults here."),
    );
    expect(button.disabled).toBe(true);
    invokeMock.mockRejectedValueOnce(new Error("set failed"));

    await setZinniaDefaultArchiver(button);

    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Zinnia cannot change archive defaults here.");
  });

  it("V-osint-2 re-enables the button after a failed action when the status allows it", async () => {
    const button = document.getElementById(
      "open-os-integration-settings",
    ) as HTMLButtonElement;
    renderOsIntegrationStatus(statusWith(true, "Zinnia can set defaults."));
    invokeMock.mockRejectedValueOnce(new Error("set failed"));

    await setZinniaDefaultArchiver(button);

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Make Zinnia Default");
  });
});

describe("V-dbg: unhandled rejections reach the debug console", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="debug-console"><pre id="debug-console-log"></pre></div>';
    clearDebugConsole();
  });

  function logText(): string {
    return document.getElementById("debug-console-log")?.textContent ?? "";
  }

  it("V-dbg-1 shows one line per rejection while debug mode is on", () => {
    setDebugEnabled(true, { banner: false });
    wireDebugConsoleControls();
    clearDebugConsole();
    const event = rejectionEvent(new Error("kaboom"));
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(logText()).toContain("Unhandled promise rejection: kaboom");
    expect(logText().split("Unhandled promise rejection").length - 1).toBe(1);
    setDebugEnabled(false);
  });

  it("V-dbg-2 leaves the rejection alone while debug mode is off", () => {
    setDebugEnabled(false);
    const event = rejectionEvent(new Error("quiet"));
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(logText()).toBe("");
  });

  it("V-dbg-3 accepts non-Error reasons without throwing", () => {
    setDebugEnabled(true, { banner: false });
    clearDebugConsole();
    expect(() => {
      window.dispatchEvent(rejectionEvent("plain text reason"));
      window.dispatchEvent(rejectionEvent(undefined));
    }).not.toThrow();
    expect(logText()).toContain(
      "Unhandled promise rejection: plain text reason",
    );
    expect(logText()).toContain("Unhandled promise rejection: undefined");
    setDebugEnabled(false);
  });

  it("V-dbg-4 redacts secrets in the logged reason", () => {
    setDebugEnabled(true, { banner: false });
    clearDebugConsole();
    window.dispatchEvent(
      rejectionEvent(new Error("failed, password=swordfish")),
    );
    expect(logText()).toContain("Unhandled promise rejection");
    expect(logText()).not.toContain("swordfish");
    setDebugEnabled(false);
  });
});

describe("V-method: retired compression methods load as the default", () => {
  it.each(["ppmd", "bzip2", "zstd"])(
    "V-method-1 keeps a custom preset with %s and uses the default method",
    (method) => {
      const settings = normalizeUserSettings({
        customPresets: [
          {
            name: "legacy",
            format: "7z",
            level: "5",
            method,
            dict: "64m",
            wordSize: "64",
            solid: "4g",
          },
        ],
      });
      expect(settings.customPresets).toEqual([
        {
          name: "legacy",
          format: "7z",
          level: "5",
          method: SETTING_DEFAULTS.method,
          dict: "64m",
          wordSize: "64",
          solid: "4g",
        },
      ]);
    },
  );

  it.each(["ppmd", "bzip2", "zstd"])(
    "V-method-2 loads a saved global %s method as the default for 7z and zip",
    (method) => {
      expect(normalizeUserSettings({ format: "7z", method }).method).toBe(
        "lzma2",
      );
      expect(normalizeUserSettings({ format: "zip", method }).method).toBe(
        "deflate",
      );
    },
  );

  it("V-method-3 still drops a custom preset with an unknown method", () => {
    const settings = normalizeUserSettings({
      customPresets: [
        {
          name: "garbage",
          format: "7z",
          level: "5",
          method: "not-a-method",
          dict: "",
          wordSize: "",
          solid: "off",
        },
      ],
    });
    expect(settings.customPresets).toEqual([]);
  });
});

describe("V-pw: a closed-stdin listing rejection opens the password prompt", () => {
  beforeEach(() => {
    state.cancelRequested = false;
    state.batchCancelled = false;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("");
    promptMock.mockReset();
  });

  it("V-pw-1 prompts with the first-attempt label and returns cancelled on Cancel", async () => {
    invokeMock.mockRejectedValueOnce(CLOSED_STDIN_LISTING_REJECTION);
    promptMock.mockResolvedValueOnce({ kind: "cancel" });

    const result = await runWithPasswordRetry(RUN_ARGS, true, "Extract");

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(promptMock.mock.calls[0][0].label).toBe(PASSWORD_LABEL);
    expect(result.code).toBe(-1);
  });

  it("V-pw-2 keeps an ordinary listing rejection as an error", async () => {
    invokeMock.mockRejectedValueOnce(
      "Could not list archive members for path safety: Headers Error",
    );

    await expect(
      runWithPasswordRetry(RUN_ARGS, true, "Extract"),
    ).rejects.toBeDefined();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("V-pw-3 extracts with the typed password after the prompt", async () => {
    invokeMock
      .mockRejectedValueOnce(CLOSED_STDIN_LISTING_REJECTION)
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });
    promptMock.mockResolvedValueOnce({ kind: "submit", value: "right-pass" });

    const result = await runWithPasswordRetry(RUN_ARGS, true, "Extract");

    expect(result.code).toBe(0);
    expect(promptMock).toHaveBeenCalledTimes(1);
    const retryPayload = invokeMock.mock.calls[1][1] as { requestJson: string };
    const retryRequest = JSON.parse(retryPayload.requestJson) as {
      args: string[];
    };
    expect(retryRequest.args).toContain("-pright-pass");
  });
});

describe("V-recent: same-named recents show their folders", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="header-recent" hidden><button id="header-recent-btn"></button><div id="header-recent-menu" hidden></div></div>';
    sessionStorage.clear();
    localStorage.clear();
  });

  it("V-recent-folder-1 shows the parent folder of each entry and keeps the full path as title", () => {
    saveRecentArchives([
      "C:\\Users\\a\\same.7z",
      "/srv/b/same.7z",
      "/top.7z",
      "C:\\top.7z",
    ]);
    renderRecentArchives();
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "#header-recent-menu .header-recent__item",
      ),
    );
    expect(
      items.map(
        (item) => item.querySelector(".header-recent__name")?.textContent,
      ),
    ).toEqual(["same.7z", "same.7z", "top.7z", "top.7z"]);
    expect(
      items.map(
        (item) => item.querySelector(".header-recent__folder")?.textContent,
      ),
    ).toEqual(["C:\\Users\\a", "/srv/b", "/", "C:\\"]);
    expect(items.map((item) => item.title)).toEqual([
      "C:\\Users\\a\\same.7z",
      "/srv/b/same.7z",
      "/top.7z",
      "C:\\top.7z",
    ]);
  });
});

describe("V-picker: selected picker rows carry is-selected", () => {
  const ARCHIVE = "/tmp/picker-c1.7z";

  function member(path: string, isFolder = false): BrowseEntry {
    return { path, isFolder, size: 1, packedSize: 0, modified: "" };
  }

  function mountPicker(
    entries: BrowseEntry[],
    selected: string[],
    query = "",
  ): void {
    document.body.innerHTML =
      '<div id="selective-list"></div><div id="selective-summary"></div>';
    state.browseArchiveInfoByPath.set(ARCHIVE, {
      entries,
    } as unknown as ArchiveInfo);
    state.browseSelectionsByArchive.set(ARCHIVE, new Set(selected));
    state.selectiveActiveArchive = ARCHIVE;
    state.selectiveSearchQuery = query;
    state.selectiveExpandedFolders.clear();
    renderSelectiveExtractModal();
  }

  function rowFor(path: string): HTMLElement | undefined {
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-member-path]"),
    ).find((row) => row.dataset.memberPath === path);
  }

  it("V-picker-1 marks a selected tree row and mirrors aria-selected", () => {
    mountPicker([member("a.txt"), member("b.txt")], ["a.txt"]);
    expect(rowFor("a.txt")?.classList.contains("is-selected")).toBe(true);
    expect(rowFor("a.txt")?.getAttribute("aria-selected")).toBe("true");
    expect(rowFor("b.txt")?.classList.contains("is-selected")).toBe(false);
    expect(rowFor("b.txt")?.getAttribute("aria-selected")).toBe("false");
  });

  it("V-picker-2 leaves a mixed folder unmarked and marks it once fully selected", () => {
    const entries = [
      member("dir", true),
      member("dir/x.txt"),
      member("dir/y.txt"),
    ];
    mountPicker(entries, ["dir/x.txt"]);
    expect(rowFor("dir")?.getAttribute("aria-checked")).toBe("mixed");
    expect(rowFor("dir")?.classList.contains("is-selected")).toBe(false);
    mountPicker(entries, ["dir/x.txt", "dir/y.txt"]);
    expect(rowFor("dir")?.getAttribute("aria-selected")).toBe("true");
    expect(rowFor("dir")?.classList.contains("is-selected")).toBe(true);
  });

  it("V-picker-3 updates the class when a toggle refreshes the rows", () => {
    mountPicker([member("a.txt"), member("b.txt")], ["a.txt"]);
    rowFor("b.txt")?.querySelector("input")?.dispatchEvent(new Event("change"));
    expect(rowFor("b.txt")?.classList.contains("is-selected")).toBe(true);
    expect(rowFor("b.txt")?.getAttribute("aria-selected")).toBe("true");
    expect(rowFor("a.txt")?.classList.contains("is-selected")).toBe(true);
  });

  it("V-picker-4 marks a selected search result row", () => {
    mountPicker([member("a.txt"), member("b.txt")], ["b.txt"], "txt");
    expect(rowFor("b.txt")?.classList.contains("is-selected")).toBe(true);
    expect(rowFor("a.txt")?.classList.contains("is-selected")).toBe(false);
  });
});

describe("V-completion: the Basic completion path keeps the full path for screen readers", () => {
  const OUTPUT =
    "C:\\Users\\Burnt\\AppData\\Local\\Temp\\zinnia-e2e-run\\nested-folder-for-the-completion-panel\\basic-locked.7z";

  function completionPath(): HTMLElement {
    return document.getElementById(
      "basic-compress-completion-path",
    ) as HTMLElement;
  }

  beforeEach(() => {
    document.body.innerHTML =
      '<div id="basic-compress-completion" class="basic-completion"><span id="basic-compress-completion-icon"></span><h3 id="basic-compress-completion-title"></h3><p id="basic-compress-completion-msg"></p><p class="basic-completion__path" id="basic-compress-completion-path" hidden></p><button id="basic-compress-open-dest"></button><button id="basic-compress-again"></button><button id="basic-run-compress"></button></div>';
  });

  it("V-completion-1 shows the file name and gives the path a full-path title", () => {
    showBasicCompletion("compress", true, "Archive created", "Done.", OUTPUT);
    expect(completionPath().title).toBe(OUTPUT);
    expect(completionPath().textContent?.endsWith("basic-locked.7z")).toBe(
      true,
    );
    expect(completionPath().textContent).not.toBe(OUTPUT);
  });

  it("V-completion-2 gives screen readers the full path as its accessible name", () => {
    showBasicCompletion("compress", true, "Archive created", "Done.", OUTPUT);
    expect(completionPath().getAttribute("aria-label")).toBe(OUTPUT);
    expect(completionPath().getAttribute("role")).toBe("group");
  });

  it("V-completion-3 clears the name and role when the panel has no path", () => {
    showBasicCompletion("compress", true, "Archive created", "Done.", OUTPUT);
    showBasicCompletion("compress", true, "Archive created", "Done.");
    expect(completionPath().hidden).toBe(true);
    expect(completionPath().hasAttribute("aria-label")).toBe(false);
    expect(completionPath().hasAttribute("role")).toBe(false);
    expect(completionPath().title).toBe("");
  });

  it("V-completion-4 keeps a short path whole for the name and text", () => {
    showBasicCompletion(
      "compress",
      true,
      "Archive created",
      "Done.",
      "/tmp/out.7z",
    );
    expect(completionPath().textContent).toBe("/tmp/out.7z");
    expect(completionPath().getAttribute("aria-label")).toBe("/tmp/out.7z");
  });
});
