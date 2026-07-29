import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import {
  addFilesToArchive,
  browseArchive,
  cancelAction,
  closeCommandPreviewModal,
  convertArchive,
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
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import { MAX_ARCHIVE_TREE_DEPTH } from "../selective-extract";

const invokeMock = vi.mocked(invoke);
const messageMock = vi.mocked(message);
const confirmMock = vi.mocked(confirm);
const openMock = vi.mocked(open);
const saveMock = vi.mocked(save);

function uniqueArchivePath(prefix: string): string {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.7z`;
}

function pathsFromValidationPayload(payload: unknown): string[] {
  const pathsJson = (payload as { pathsJson?: unknown } | undefined)?.pathsJson;
  if (typeof pathsJson !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(pathsJson);
    return Array.isArray(parsed) &&
      parsed.every((path) => typeof path === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
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
  document.getElementById("toast-region")?.remove();

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
  app.dataset.workspaceMode = "power";

  (document.getElementById("browse-password-field") as HTMLElement).hidden =
    true;
  (document.getElementById("browse-password") as HTMLInputElement).value = "";
  (document.getElementById("extract-password") as HTMLInputElement).value = "";
  (document.getElementById("password") as HTMLInputElement).value = "";
  (document.getElementById("encrypt-headers") as HTMLInputElement).checked =
    false;
  (document.getElementById("store-timestamps") as HTMLInputElement).checked =
    false;
  (document.getElementById("split-size") as HTMLSelectElement).value = "";
  (document.getElementById("extract-path") as HTMLInputElement).value = "";
  (document.getElementById("selective-dest") as HTMLInputElement).value = "";
  (document.getElementById("format") as HTMLSelectElement).value = "7z";

  messageMock.mockReset();
  messageMock.mockResolvedValue("Ok");
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  openMock.mockReset();
  openMock.mockResolvedValue(null);
  saveMock.mockReset();
  saveMock.mockResolvedValue(null);
  invokeMock.mockReset();
});

describe("addFilesToArchive", () => {
  it("updates the archive and refreshes its listing", async () => {
    const archive = uniqueArchivePath("add-files");
    state.inputs = [archive];
    openMock.mockResolvedValue(["/tmp/one.txt", "/tmp/two.txt"]);

    const runArgs: string[][] = [];
    setInvokeRouter((command, payload) => {
      if (command === "probe_7z") return undefined;
      if (command === "validate_archive_paths") {
        return pathsFromValidationPayload(payload).map((path) => ({
          path,
          valid: true,
        }));
      }
      if (command === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        runArgs.push(args);
        if (args[0] === "l") {
          return {
            stdout: sltListing([
              {
                path: "one.txt",
                size: 3,
                packedSize: 3,
                modified: "2026-07-22",
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

    await addFilesToArchive();

    expect(openMock).toHaveBeenCalledWith({ multiple: true, directory: false });
    expect(runArgs[0]).toEqual(
      expect.arrayContaining([
        "u",
        "-sse",
        "-snl",
        "-snh",
        "-spd",
        archive,
        "--",
        "/tmp/one.txt",
        "/tmp/two.txt",
      ]),
    );
    expect(runArgs.some(([operation]) => operation === "l")).toBe(true);
    expect(document.getElementById("browse-summary")?.textContent).toContain(
      "1 file",
    );
  });

  it("handles a rejected mutation file dialog", async () => {
    state.inputs = [uniqueArchivePath("add-files-dialog-error")];
    openMock.mockRejectedValueOnce(new Error("portal unavailable"));

    await expect(addFilesToArchive()).resolves.toBeUndefined();

    expect(invokeMock.mock.calls.some(([name]) => name === "run_7z")).toBe(
      false,
    );
    expect(document.getElementById("status")?.textContent).toContain(
      "Could not open the file dialog",
    );
  });
});

describe("archive test/browse/selective flows", () => {
  it("returns failed when testArchive is called without an archive", async () => {
    const result = await testArchive();

    expect(result).toBe("failed");
    expect(messageMock).toHaveBeenCalledWith("Select an archive to test.", {
      title: "No archive selected",
    });
  });

  it("clears the Basic browse password after an archive test", async () => {
    const basicBrowsePassword = document.createElement("input");
    basicBrowsePassword.id = "basic-browse-password";
    basicBrowsePassword.value = "must-clear";
    document.body.appendChild(basicBrowsePassword);

    await testArchive();

    expect(basicBrowsePassword.value).toBe("");
    basicBrowsePassword.remove();
  });

  it("returns passed_with_warnings when testArchive exits with code 1", async () => {
    state.inputs = ["/tmp/sample.7z"];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
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
    expect(invokeMock).toHaveBeenCalledWith(
      "run_7z",
      expect.objectContaining({
        args: expect.arrayContaining(["t", "/tmp/sample.7z"]),
      }),
    );
  });

  it("shows encrypted hint when browseArchive fails with password-required error", async () => {
    state.inputs = ["/tmp/encrypted.7z"];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
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
        const paths = pathsFromValidationPayload(payload);
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
        const paths = pathsFromValidationPayload(payload);
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

  it("reports hostile member depth without opening a broken selective modal", async () => {
    const archive = "/tmp/hostile-depth.7z";
    const hostilePath = Array.from(
      { length: MAX_ARCHIVE_TREE_DEPTH + 1 },
      (_, index) => `d${index}`,
    ).join("/");
    state.inputs = [archive];
    state.browseArchiveInfoByPath.set(
      archive,
      archiveInfo([
        {
          path: hostilePath,
          size: 1,
          packedSize: 1,
          modified: "",
          isFolder: false,
        },
      ]),
    );

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
        return paths.map((path) => ({ path, valid: true }));
      }
      return undefined;
    });

    await openSelectiveExtractModal();

    expect(
      (document.getElementById("selective-overlay") as HTMLElement).hidden,
    ).toBe(true);
    expect(state.selectiveActiveArchive).toBeNull();
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("256-level browsing limit"),
      { title: "Archive browsing unavailable", kind: "error" },
    );
  });

  it("shows error when selective extract destination is missing", async () => {
    const archive = "/tmp/selection.7z";
    state.inputs = [archive];

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
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
        const paths = pathsFromValidationPayload(payload);
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
      return args[0] === "x" && args.includes("-spd");
    });
    const args = (runCall?.[1] as { args?: string[] } | undefined)?.args ?? [];
    expect(args).toContain("-spd");
    expect(args).toContain(archive);
    expect(args).toContain("docs/readme.md");
    expect(
      (document.getElementById("selective-overlay") as HTMLElement).hidden,
    ).toBe(true);
    const toast = document.querySelector("#toast-region .toast--success");
    expect(toast?.textContent).toBe("Selected entries extracted.");
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
        const paths = pathsFromValidationPayload(payload);
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
        const paths = pathsFromValidationPayload(payload);
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
        const paths = pathsFromValidationPayload(payload);
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
        const paths = pathsFromValidationPayload(payload);
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

  it("rejects runAction when delete-after is checked", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    app.dataset.workspaceMode = "power";
    state.inputs = ["/tmp/input.txt"];
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/output.7z";
    (document.getElementById("delete-after") as HTMLInputElement).checked =
      true;

    setInvokeRouter((command) => {
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        throw new Error("run_7z should not run when delete-after is checked");
      }
      return undefined;
    });

    await runAction();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([name]) => name === "run_7z")).toBe(
      false,
    );
    expect(messageMock).toHaveBeenCalled();
  });

  it("rolls back add-mode output on warning exit code", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    app.dataset.workspaceMode = "power";
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
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("exit code 1"),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("delegates runAction to batch extraction for multiple archives", async () => {
    const archiveA = uniqueArchivePath("batch-a");
    const archiveB = uniqueArchivePath("batch-b");
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "extract";
    app.dataset.workspaceMode = "power";
    state.inputs = [archiveA, archiveB];
    (document.getElementById("extract-path") as HTMLInputElement).value =
      "/tmp/out";

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
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
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.workspaceMode = "power";
    state.inputs = [archiveA, archiveB];
    (document.getElementById("extract-path") as HTMLInputElement).value =
      "/tmp/out";

    let runCount = 0;
    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
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

  it("skips native dialogs for basic-mode batch extract outcomes", async () => {
    const archiveA = uniqueArchivePath("basic-batch-a");
    const archiveB = uniqueArchivePath("basic-batch-b");
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.workspaceMode = "basic";
    state.inputs = [archiveA, archiveB];
    (document.getElementById("extract-path") as HTMLInputElement).value =
      "/tmp/out";

    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") return { stdout: "", stderr: "", code: 0 };
      return undefined;
    });

    await runBatchExtract();

    expect(messageMock).not.toHaveBeenCalled();
  });

  it("skips native dialogs for basic-mode batch extract failures and cancel", async () => {
    const archiveA = uniqueArchivePath("basic-fail-a");
    const archiveB = uniqueArchivePath("basic-fail-b");
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.workspaceMode = "basic";
    state.inputs = [archiveA, archiveB];
    (document.getElementById("extract-path") as HTMLInputElement).value =
      "/tmp/out";

    let runCount = 0;
    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
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
    expect(messageMock).not.toHaveBeenCalled();

    messageMock.mockClear();
    runCount = 0;
    state.inputs = [archiveA, archiveB];
    setInvokeRouter((command, payload) => {
      if (command === "validate_archive_paths") {
        const paths = pathsFromValidationPayload(payload);
        return paths.map((path) => ({ path, valid: true }));
      }
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        state.batchCancelled = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    await runBatchExtract();
    expect(messageMock).not.toHaveBeenCalled();
  });

  it("skips native dialogs for basic-mode operation and batch errors", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    app.dataset.workspaceMode = "basic";
    state.inputs = ["/tmp/input.txt"];
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/output.7z";
    (document.getElementById("delete-after") as HTMLInputElement).checked =
      false;

    setInvokeRouter((command) => {
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") {
        return { stdout: "", stderr: "fail", code: 2 };
      }
      return undefined;
    });

    await runAction();
    expect(messageMock).not.toHaveBeenCalled();

    messageMock.mockClear();
    setInvokeRouter((command) => {
      if (command === "probe_7z") return undefined;
      if (command === "run_7z") throw new Error("backend down");
      return undefined;
    });
    await runAction();
    expect(messageMock).not.toHaveBeenCalled();

    messageMock.mockClear();
    app.dataset.mode = "extract";
    state.inputs = [uniqueArchivePath("basic-err")];
    (document.getElementById("extract-path") as HTMLInputElement).value = "";
    await runBatchExtract();
    expect(messageMock).not.toHaveBeenCalled();
  });

  it("resets cancellation state and reports backend errors", async () => {
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

    expect(state.cancelRequested).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("cancel_7z");
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("busy"),
      expect.objectContaining({ title: "Cancel failed" }),
    );
  });

  it("does not stick cancelRequested when cancel_7z reports idle", async () => {
    state.running = true;
    state.batchCancelled = false;
    state.cancelRequested = false;
    setInvokeRouter((command) => {
      if (command === "cancel_7z") return false;
      return undefined;
    });

    await cancelAction();

    expect(state.cancelRequested).toBe(false);
    expect(state.batchCancelled).toBe(false);
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

describe("convertArchive", () => {
  it("requires an open archive before converting", async () => {
    state.inputs = [];
    await convertArchive();
    expect(messageMock).toHaveBeenCalledWith(
      "Open an archive first to convert it.",
      expect.objectContaining({ title: "No archive", kind: "warning" }),
    );
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("extracts with the safe overwrite policy then recompresses", async () => {
    const archive = uniqueArchivePath("convert-src");
    state.inputs = [archive];
    saveMock.mockResolvedValueOnce("/tmp/converted.7z");

    const runArgs: string[][] = [];
    setInvokeRouter((command, payload) => {
      if (command === "probe_7z") return undefined;
      if (command === "create_temp_extract_dir")
        return "/tmp/zinnia-convert-tmp";
      if (command === "list_managed_temp_children")
        return ["/tmp/zinnia-convert-tmp/document.txt"];
      if (command === "remove_managed_temp_dir") return undefined;
      if (command === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        runArgs.push(args);
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    await convertArchive();

    expect(runArgs).toHaveLength(2);
    expect(runArgs[0][0]).toBe("x");
    expect(runArgs[0]).toContain("-o/tmp/zinnia-convert-tmp");
    expect(runArgs[0]).toContain(SAFE_EXTRACT_OVERWRITE_MODE);
    expect(runArgs[0]).not.toContain("-y");
    expect(runArgs[1][0]).toBe("a");
    expect(runArgs[1]).toContain("/tmp/converted.7z");
    expect(invokeMock).toHaveBeenCalledWith("remove_managed_temp_dir", {
      path: "/tmp/zinnia-convert-tmp",
    });
  });

  it("fails conversion safely when extraction produces no children", async () => {
    state.inputs = [uniqueArchivePath("convert-empty")];
    saveMock.mockResolvedValueOnce("/tmp/converted.7z");

    const runArgs: string[][] = [];
    setInvokeRouter((command, payload) => {
      if (command === "probe_7z") return undefined;
      if (command === "create_temp_extract_dir")
        return "/tmp/zinnia-convert-empty";
      if (command === "list_managed_temp_children") return [];
      if (command === "remove_managed_temp_dir") return undefined;
      if (command === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        runArgs.push(args);
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    await convertArchive();

    expect(runArgs).toHaveLength(1);
    expect(messageMock).toHaveBeenCalledWith(
      "Conversion extract produced no files to recompress.",
      { title: "Conversion error", kind: "error" },
    );
    expect(invokeMock).toHaveBeenCalledWith("remove_managed_temp_dir", {
      path: "/tmp/zinnia-convert-empty",
    });
  });

  it("cancels ZIP conversion when extracted links may not round-trip", async () => {
    state.inputs = [uniqueArchivePath("convert-zip-risk")];
    (document.getElementById("format") as HTMLSelectElement).value = "zip";
    saveMock.mockResolvedValueOnce("/tmp/converted.zip");
    confirmMock.mockResolvedValueOnce(false);

    const runArgs: string[][] = [];
    setInvokeRouter((command, payload) => {
      if (command === "probe_7z") return undefined;
      if (command === "create_temp_extract_dir")
        return "/tmp/zinnia-convert-zip";
      if (command === "list_managed_temp_children") {
        return ["/tmp/zinnia-convert-zip/Demo.app"];
      }
      if (command === "probe_compress_inputs") {
        return {
          nestedSymlinks: 1,
          appBundles: 1,
          nestedReparsePoints: 0,
          examples: ["/tmp/zinnia-convert-zip/Demo.app"],
        };
      }
      if (command === "remove_managed_temp_dir") return undefined;
      if (command === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        runArgs.push(args);
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    await convertArchive();

    expect(runArgs).toHaveLength(1);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("ZIP often fails to preserve"),
      expect.objectContaining({ title: "ZIP may break app bundles" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("remove_managed_temp_dir", {
      path: "/tmp/zinnia-convert-zip",
    });
  });

  it("preserves conversion passwords, timestamps, and split settings", async () => {
    state.inputs = [uniqueArchivePath("convert-options")];
    (document.getElementById("format") as HTMLSelectElement).value = "zip";
    (document.getElementById("extract-password") as HTMLInputElement).value =
      "source-secret";
    (document.getElementById("password") as HTMLInputElement).value =
      "dest-secret";
    (document.getElementById("encrypt-headers") as HTMLInputElement).checked =
      true;
    (document.getElementById("store-timestamps") as HTMLInputElement).checked =
      true;
    (document.getElementById("split-size") as HTMLSelectElement).value = "100m";
    saveMock.mockResolvedValueOnce("/tmp/converted.zip");

    const runArgs: string[][] = [];
    setInvokeRouter((command, payload) => {
      if (command === "probe_7z") return undefined;
      if (command === "create_temp_extract_dir")
        return "/tmp/zinnia-convert-options";
      if (command === "list_managed_temp_children") {
        return ["/tmp/zinnia-convert-options/document.txt"];
      }
      if (command === "probe_compress_inputs") {
        return {
          nestedSymlinks: 0,
          appBundles: 0,
          nestedReparsePoints: 0,
          examples: [],
        };
      }
      if (command === "remove_managed_temp_dir") return undefined;
      if (command === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        runArgs.push(args);
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    await convertArchive();

    expect(runArgs).toHaveLength(2);
    expect(runArgs[0]).toContain("-psource-secret");
    expect(runArgs[1]).toEqual(
      expect.arrayContaining([
        "-pdest-secret",
        "-mem=AES256",
        "-mtc=on",
        "-mta=on",
        "-v100m",
      ]),
    );
  });

  it("aborts cleanly when the save dialog is cancelled", async () => {
    state.inputs = [uniqueArchivePath("convert-cancel")];
    saveMock.mockResolvedValueOnce(null);

    await convertArchive();

    expect(invokeMock.mock.calls.some(([name]) => name === "run_7z")).toBe(
      false,
    );
  });
});
