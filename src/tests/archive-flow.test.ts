import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  browseArchive,
  cancelAction,
  closeCommandPreviewModal,
  copyCommandPreview,
  clearPickerSelection,
  openSelectiveExtractModal,
  previewCommand,
  runAction,
  runBatchExtract,
  runSelectiveExtractFromModal,
  selectAllVisibleInPicker,
  setSelectiveExtractSearch,
  syncDestinationWhilePickerOpen,
  syncSelectiveDestinationAfterBrowseChoice,
  testArchive,
} from "../archive";
import { state } from "../state";
import type { ArchiveInfo } from "../browse-model";

const invokeMock = vi.mocked(invoke);
const messageMock = vi.mocked(message);
const confirmMock = vi.mocked(confirm);

function uniqueArchivePath(prefix: string): string {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.7z`;
}

function ensureElement<T extends HTMLElement>(id: string, factory: () => T): T {
  const existing = document.getElementById(id) as T | null;
  if (existing) return existing;
  const created = factory();
  created.id = id;
  document.body.appendChild(created);
  return created;
}

function ensureArchiveDom(): void {
  ensureElement("browse-summary", () => document.createElement("div"));
  ensureElement("browse-tbody", () => document.createElement("tbody"));
  ensureElement("basic-browse-tbody", () => document.createElement("tbody"));
  ensureElement("basic-browse-summary", () => document.createElement("div"));
  ensureElement("browse-password", () => document.createElement("input"));
  ensureElement("toggle-browse-password", () =>
    document.createElement("button"),
  );

  const selectiveOverlay = ensureElement("selective-overlay", () =>
    document.createElement("div"),
  );
  selectiveOverlay.hidden = true;
  if (!selectiveOverlay.querySelector(".modal")) {
    const modal = document.createElement("div");
    modal.className = "modal";
    selectiveOverlay.appendChild(modal);
  }

  ensureElement("selective-search", () => document.createElement("input"));
  ensureElement("selective-list", () => document.createElement("div"));
  ensureElement("selective-summary", () => document.createElement("div"));
  ensureElement("selective-dest", () => document.createElement("input"));
}

function archiveInfo(entries: ArchiveInfo["entries"]): ArchiveInfo {
  return {
    type: "7z",
    physicalSize: 2048,
    method: "LZMA2",
    solid: false,
    encrypted: false,
    entries,
  };
}

function sltListing(entries: ArchiveInfo["entries"]): string {
  const lines = [
    "Path = sample.7z",
    "Type = 7z",
    "Physical Size = 2048",
    "Method = LZMA2",
    "Solid = -",
    "Encrypted = -",
    "----------",
  ];

  for (const entry of entries) {
    lines.push(`Path = ${entry.path}`);
    lines.push(`Size = ${entry.size}`);
    lines.push(`Packed Size = ${entry.packedSize}`);
    lines.push(`Modified = ${entry.modified}`);
    lines.push(`Attributes = ${entry.isFolder ? "D" : "A"}`);
    lines.push("----------");
  }

  return lines.join("\n");
}

function setInvokeRouter(
  handler: (command: string, payload?: unknown) => unknown,
): void {
  invokeMock.mockImplementation((command, payload) =>
    Promise.resolve(handler(command, payload)),
  );
}

beforeEach(() => {
  ensureArchiveDom();

  state.inputs = [];
  state.running = false;
  state.cancelRequested = false;
  state.batchCancelled = false;
  state.selectiveActiveArchive = null;
  state.selectiveSearchQuery = "";
  state.selectiveVisiblePaths = [];
  state.browseArchiveInfoByPath.clear();
  state.browseSelectionsByArchive.clear();

  const app = document.getElementById("app") as HTMLElement;
  app.dataset.mode = "extract";

  (document.getElementById("browse-password-field") as HTMLElement).hidden =
    true;
  (document.getElementById("browse-password") as HTMLInputElement).value = "";
  (document.getElementById("extract-password") as HTMLInputElement).value = "";
  (document.getElementById("extract-path") as HTMLInputElement).value = "";
  (document.getElementById("selective-dest") as HTMLInputElement).value = "";

  messageMock.mockReset();
  messageMock.mockResolvedValue("Ok");
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  invokeMock.mockReset();
});

describe("archive test/browse/selective flows", () => {
  it("returns failed when testArchive is called without an archive", async () => {
    const result = await testArchive();

    expect(result).toBe("failed");
    expect(messageMock).toHaveBeenCalledWith("Select an archive to test.", {
      title: "No archive selected",
    });
  });

  it("returns passed_with_warnings when testArchive exits with code 1", async () => {
    state.inputs = ["/tmp/sample.7z"];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        return { stdout: "", stderr: "warning", code: 1 };
      }
      return undefined;
    });

    const result = await testArchive();

    expect(result).toBe("passed_with_warnings");
    expect(invokeMock.mock.calls.some(([name]) => name === "probe_7z")).toBe(
      true,
    );
  });

  it("shows encrypted hint when browseArchive fails with password-required error", async () => {
    state.inputs = ["/tmp/encrypted.7z"];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        return { stdout: "", stderr: "Wrong password", code: 2 };
      }
      return undefined;
    });

    const result = await browseArchive();

    expect(result).toBeNull();
    const browseFailureCall = messageMock.mock.calls.find((call) => {
      const options = call[1];
      return (
        options !== undefined &&
        typeof options === "object" &&
        "title" in options &&
        options.title === "Browse failed"
      );
    });
    expect((browseFailureCall?.[0] as string) ?? "").toContain(
      "appears to be encrypted",
    );
  });

  it("returns parsed info and renders table when browseArchive succeeds", async () => {
    state.inputs = ["/tmp/listing.7z"];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        return {
          code: 0,
          stderr: "",
          stdout: [
            "--",
            "Type = 7z",
            "Physical Size = 100",
            "Method = LZMA2",
            "----------",
            "Path = docs/readme.md",
            "Size = 10",
            "Packed Size = 9",
            "Modified = 2026-04-25 10:00:00",
            "Folder = -",
            "----------",
          ].join("\n"),
        };
      }
      return undefined;
    });

    const result = await browseArchive();

    expect(result?.entries.length).toBe(1);
    expect(
      (document.getElementById("browse-contents") as HTMLElement).hidden,
    ).toBe(false);
    expect(document.getElementById("browse-tbody")?.children.length).toBe(1);
  });

  it("opens selective extract modal using cached archive info", async () => {
    const archive = "/tmp/cached.7z";
    state.inputs = [archive];
    state.browseArchiveInfoByPath.set(
      archive,
      archiveInfo([
        {
          path: "docs/readme.md",
          size: 11,
          packedSize: 8,
          modified: "2026-01-01 00:00:00",
          isFolder: false,
        },
      ]),
    );

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      return undefined;
    });

    await openSelectiveExtractModal();

    expect(
      (document.getElementById("selective-overlay") as HTMLElement).hidden,
    ).toBe(false);
    expect(document.getElementById("selective-list")?.children.length).toBe(1);
  });

  it("shows error when selective extract destination is missing", async () => {
    const archive = "/tmp/selection.7z";
    state.inputs = [archive];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        return {
          stdout: sltListing([
            {
              path: "docs/readme.md",
              size: 11,
              packedSize: 8,
              modified: "2026-01-01 00:00:00",
              isFolder: false,
            },
          ]),
          stderr: "",
          code: 0,
        };
      }
      return undefined;
    });

    await browseArchive();
    await openSelectiveExtractModal();
    (document.getElementById("selective-dest") as HTMLInputElement).value = "";

    await runSelectiveExtractFromModal();

    expect(messageMock).toHaveBeenCalledWith("Choose a destination folder.", {
      title: "Error",
      kind: "error",
    });
  });

  it("runs selective extraction for selected entries", async () => {
    const archive = "/tmp/selected.7z";
    state.inputs = [archive];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        if (args.includes("-slt")) {
          return {
            stdout: sltListing([
              {
                path: "docs/readme.md",
                size: 11,
                packedSize: 8,
                modified: "2026-01-01 00:00:00",
                isFolder: false,
              },
            ]),
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "Everything is Ok", stderr: "", code: 0 };
      }
      return undefined;
    });

    await browseArchive();
    await openSelectiveExtractModal();
    state.browseSelectionsByArchive.set(archive, new Set(["docs/readme.md"]));
    (document.getElementById("selective-dest") as HTMLInputElement).value =
      "/tmp/out";
    (document.getElementById("extract-password") as HTMLInputElement).value =
      "pw";

    await runSelectiveExtractFromModal();

    const runCall = invokeMock.mock.calls.find(([name, payload]) => {
      if (name !== "run_7z") return false;
      const args = (payload as { args?: string[] } | undefined)?.args ?? [];
      return args.includes("-spd");
    });
    const args = (runCall?.[1] as { args?: string[] } | undefined)?.args ?? [];
    expect(args).toContain("-spd");
    expect(args).toContain(archive);
    expect(args).toContain("docs/readme.md");
    expect(
      (document.getElementById("selective-overlay") as HTMLElement).hidden,
    ).toBe(true);
    expect(messageMock).toHaveBeenCalledWith(
      "Selected entries extracted successfully.",
      { title: "Done" },
    );
  });

  it("returns null immediately when browseArchive is invoked while running", async () => {
    state.running = true;
    const result = await browseArchive();
    expect(result).toBeNull();
  });

  it("shows invalid-input error when browseArchive path validation fails", async () => {
    const archive = uniqueArchivePath("invalid");
    state.inputs = [archive];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({
          path,
          valid: false,
          reason: "unsupported extension",
        }));
      }
      return undefined;
    });

    const result = await browseArchive();

    expect(result).toBeNull();
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("Only supported archive files can be used"),
      { title: "Invalid input", kind: "error" },
    );
  });

  it("keeps browse password field visible when listing reports encrypted archive", async () => {
    const archive = uniqueArchivePath("encrypted-info");
    state.inputs = [archive];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        return {
          code: 0,
          stderr: "",
          stdout: [
            "--",
            "Type = 7z",
            "Physical Size = 100",
            "Encrypted = +",
            "----------",
            "----------",
          ].join("\n"),
        };
      }
      return undefined;
    });

    const result = await browseArchive();

    expect(result?.encrypted).toBe(true);
  });

  it("returns passed and uses browse password while in browse mode", async () => {
    const archive = uniqueArchivePath("browse-pass");
    state.inputs = [archive];
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "browse";
    (document.getElementById("browse-password") as HTMLInputElement).value =
      "secret";

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") return { stdout: "", stderr: "", code: 0 };
      return undefined;
    });

    const result = await testArchive();

    expect(result).toBe("passed");
    const runCall = invokeMock.mock.calls.find(([name]) => name === "run_7z");
    const args = (runCall?.[1] as { args?: string[] } | undefined)?.args ?? [];
    expect(args).toContain("-psecret");
  });

  it("returns cancelled from testArchive when already running", async () => {
    state.running = true;
    const result = await testArchive();
    expect(result).toBe("cancelled");
  });

  it("filters picker entries, selects visible matches, and clears selection", () => {
    const archive = uniqueArchivePath("picker");
    state.selectiveActiveArchive = archive;
    state.browseArchiveInfoByPath.set(
      archive,
      archiveInfo([
        {
          path: "docs",
          size: 0,
          packedSize: 0,
          modified: "2026-01-01 00:00:00",
          isFolder: true,
        },
        {
          path: "docs/readme.md",
          size: 11,
          packedSize: 8,
          modified: "2026-01-01 00:00:00",
          isFolder: false,
        },
        {
          path: "img/logo.png",
          size: 12,
          packedSize: 9,
          modified: "2026-01-01 00:00:00",
          isFolder: false,
        },
      ]),
    );

    setSelectiveExtractSearch("readme");

    expect(state.selectiveVisiblePaths).toEqual(["docs/readme.md"]);

    selectAllVisibleInPicker();
    expect(
      state.browseSelectionsByArchive.get(archive)?.has("docs/readme.md"),
    ).toBe(true);

    clearPickerSelection();
    expect(state.browseSelectionsByArchive.get(archive)?.size).toBe(0);
  });

  it("syncs selective destination with extract destination fields", () => {
    const extract = document.getElementById("extract-path") as HTMLInputElement;
    const selective = document.getElementById(
      "selective-dest",
    ) as HTMLInputElement;

    extract.value = "/tmp/from-extract";
    syncSelectiveDestinationAfterBrowseChoice();
    expect(selective.value).toBe("/tmp/from-extract");

    state.lastAutoExtractDestination = "/tmp/auto";
    syncDestinationWhilePickerOpen("/tmp/manual");

    expect(extract.value).toBe("/tmp/manual");
    expect(state.lastAutoExtractDestination).toBeNull();
  });

  it("reports error when selective extraction runs without cached browse info", async () => {
    const archive = uniqueArchivePath("no-cache");
    state.inputs = [archive];
    state.selectiveActiveArchive = archive;
    (document.getElementById("selective-dest") as HTMLInputElement).value =
      "/tmp/out";

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      return undefined;
    });

    await runSelectiveExtractFromModal();

    expect(messageMock).toHaveBeenCalledWith(
      "Browse archive contents first before selective extraction.",
      { title: "Error", kind: "error" },
    );
  });

  it("skips runAction when delete-after confirmation is declined", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    state.inputs = ["/tmp/input.txt"];
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/output.7z";
    (document.getElementById("delete-after") as HTMLInputElement).checked =
      true;
    confirmMock.mockResolvedValueOnce(false);

    setInvokeRouter((command) => {
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        throw new Error("run_7z should not run when confirmation is declined");
      }
      return undefined;
    });

    await runAction();

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(invokeMock.mock.calls.some(([name]) => name === "run_7z")).toBe(
      false,
    );
  });

  it("runs add-mode action and handles warning exit code", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    state.inputs = ["/tmp/input.txt"];
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/output.7z";
    (document.getElementById("delete-after") as HTMLInputElement).checked =
      false;

    setInvokeRouter((command) => {
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        return {
          stdout: "25%\n100%",
          stderr: "warning",
          code: 1,
          stdout_truncated: true,
        };
      }
      return undefined;
    });

    await runAction();

    const runCall = invokeMock.mock.calls.find(([name]) => name === "run_7z");
    const args = (runCall?.[1] as { args?: string[] } | undefined)?.args ?? [];
    expect(args[0]).toBe("a");
    expect(messageMock).toHaveBeenCalledWith("Archive created successfully.", {
      title: "Done",
    });
  });

  it("delegates runAction to batch extraction for multiple archives", async () => {
    const archiveA = uniqueArchivePath("batch-a");
    const archiveB = uniqueArchivePath("batch-b");
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "extract";
    state.inputs = [archiveA, archiveB];
    (document.getElementById("extract-path") as HTMLInputElement).value =
      "/tmp/out";

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") return { stdout: "", stderr: "", code: 0 };
      return undefined;
    });

    await runAction();

    const runCalls = invokeMock.mock.calls.filter(
      ([name]) => name === "run_7z",
    );
    expect(runCalls.length).toBe(2);
    expect(messageMock).toHaveBeenCalledWith(
      "Successfully extracted 2 archives.",
      { title: "Batch extraction complete" },
    );
  });

  it("reports mixed batch extraction outcomes", async () => {
    const archiveA = uniqueArchivePath("mixed-a");
    const archiveB = uniqueArchivePath("mixed-b");
    state.inputs = [archiveA, archiveB];
    (document.getElementById("extract-path") as HTMLInputElement).value =
      "/tmp/out";

    let runCount = 0;
    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths =
          (payload as { paths?: string[] } | undefined)?.paths ?? [];
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        runCount += 1;
        if (runCount === 1) return { stdout: "", stderr: "bad", code: 2 };
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    await runBatchExtract();

    expect(messageMock).toHaveBeenCalledWith("1 succeeded, 1 failed.", {
      title: "Batch extraction complete",
      kind: "warning",
    });
  });

  it("cancels running operations and swallows cancel backend errors", async () => {
    await cancelAction();
    expect(invokeMock.mock.calls.some(([name]) => name === "cancel_7z")).toBe(
      false,
    );

    state.running = true;
    setInvokeRouter((command) => {
      if (command === "cancel_7z") throw new Error("busy");
      return undefined;
    });

    await cancelAction();

    expect(state.cancelRequested).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("cancel_7z");
  });

  it("shows missing-info preview dialog when command args cannot be built", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    state.inputs = [];
    (document.getElementById("output-path") as HTMLInputElement).value = "";

    await previewCommand();

    expect(messageMock).toHaveBeenCalledWith("Choose an output archive path.", {
      title: "Missing info",
    });
  });

  it("opens and closes command preview modal with trigger focus restoration", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    state.inputs = ["/tmp/input.txt"];
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/output.7z";
    const overlay = document.getElementById(
      "command-preview-overlay",
    ) as HTMLElement;
    overlay.hidden = true;
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);

    await previewCommand(trigger);
    expect(overlay.hidden).toBe(false);

    closeCommandPreviewModal();

    expect(overlay.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("shows copy error when clipboard copy fails", async () => {
    const preview = document.getElementById(
      "command-preview-text",
    ) as HTMLElement;
    preview.textContent = "7z a out.7z -- in.txt";

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("copy denied")),
      },
    });

    await copyCommandPreview();

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("Could not copy command."),
      expect.objectContaining({ title: "Copy failed", kind: "error" }),
    );
  });

  it("marks copy button as copied when clipboard write succeeds", async () => {
    const preview = document.getElementById(
      "command-preview-text",
    ) as HTMLElement;
    preview.textContent = "7z a out.7z -- in.txt";

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    await copyCommandPreview();

    expect(
      (document.getElementById("copy-command-preview") as HTMLButtonElement)
        .textContent,
    ).toBe("Copied");
  });
});
