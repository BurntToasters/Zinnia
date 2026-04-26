import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { state } from "../state";

const uiMocks = vi.hoisted(() => {
  const runtime = {
    workspaceMode: "basic" as "basic" | "power",
    mode: "add" as "add" | "extract" | "browse",
  };

  return {
    runtime,
    log: vi.fn(),
    setMode: vi.fn((next: "add" | "extract" | "browse") => {
      runtime.mode = next;
    }),
    renderInputs: vi.fn(),
    setBrowsePasswordFieldVisible: vi.fn(),
    registerBasicHooks: vi.fn(),
  };
});

const depMocks = vi.hoisted(() => ({
  applyPreset: vi.fn(),
  updateCompressionOptionsForFormat: vi.fn(),
  onCompressionOptionChange: vi.fn(),
  validateArchivePaths: vi.fn().mockResolvedValue([]),
  runAction: vi.fn().mockResolvedValue(undefined),
  cancelAction: vi.fn(),
  browseArchive: vi.fn().mockResolvedValue(null),
  testArchive: vi.fn().mockResolvedValue("passed"),
  chooseOutput: vi.fn().mockResolvedValue(undefined),
  chooseExtract: vi.fn().mockResolvedValue(undefined),
  addFiles: vi.fn().mockResolvedValue(undefined),
  addFolder: vi.fn().mockResolvedValue(undefined),
  deriveOutputArchivePath: vi.fn().mockReturnValue("/tmp/derived.7z"),
  resolveOutputArchiveAutofill: vi.fn().mockReturnValue(null),
  resolveExtractDestinationAutofill: vi.fn().mockReturnValue(null),
}));

vi.mock("../ui", () => ({
  log: uiMocks.log,
  getWorkspaceMode: () => uiMocks.runtime.workspaceMode,
  getMode: () => uiMocks.runtime.mode,
  setMode: uiMocks.setMode,
  renderInputs: uiMocks.renderInputs,
  setBrowsePasswordFieldVisible: uiMocks.setBrowsePasswordFieldVisible,
  registerBasicHooks: uiMocks.registerBasicHooks,
}));

vi.mock("../presets", () => ({
  applyPreset: depMocks.applyPreset,
  updateCompressionOptionsForFormat: depMocks.updateCompressionOptionsForFormat,
  onCompressionOptionChange: depMocks.onCompressionOptionChange,
}));

vi.mock("../archive-rules", () => ({
  validateArchivePaths: depMocks.validateArchivePaths,
}));

vi.mock("../archive", () => ({
  runAction: depMocks.runAction,
  cancelAction: depMocks.cancelAction,
  browseArchive: depMocks.browseArchive,
  testArchive: depMocks.testArchive,
}));

vi.mock("../files", () => ({
  chooseOutput: depMocks.chooseOutput,
  chooseExtract: depMocks.chooseExtract,
  addFiles: depMocks.addFiles,
  addFolder: depMocks.addFolder,
}));

vi.mock("../extract-path", () => ({
  deriveOutputArchivePath: depMocks.deriveOutputArchivePath,
  resolveOutputArchiveAutofill: depMocks.resolveOutputArchiveAutofill,
  resolveExtractDestinationAutofill: depMocks.resolveExtractDestinationAutofill,
}));

import {
  getBasicView,
  handleBasicDragDrop,
  initBasicWorkspace,
  renderBasicBrowseTable,
  renderBasicInputs,
  setBasicBrowseSummary,
  setBasicView,
  syncBasicBeforeRun,
  updateBasicRunningState,
  updateBasicStatus,
} from "../basic-ui";

const openMock = vi.mocked(open);
const invokeMock = vi.mocked(invoke);

function addEl<T extends HTMLElement>(
  root: HTMLElement,
  tag: string,
  id: string,
): T {
  const el = document.createElement(tag) as T;
  el.id = id;
  root.appendChild(el);
  return el;
}

function addSelect(
  root: HTMLElement,
  id: string,
  values: string[],
): HTMLSelectElement {
  const select = addEl<HTMLSelectElement>(root, "select", id);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  return select;
}

function ensureGlobalInput(id: string): HTMLInputElement {
  const existing = document.getElementById(id) as HTMLInputElement | null;
  if (existing) return existing;
  const input = document.createElement("input");
  input.id = id;
  document.body.appendChild(input);
  return input;
}

function mountBasicDom(): void {
  document.getElementById("basic-test-root")?.remove();
  const root = addEl<HTMLDivElement>(document.body, "div", "basic-test-root");

  const workspace = addEl<HTMLDivElement>(root, "div", "basic-workspace");
  for (const view of ["home", "compress", "extract", "browse"] as const) {
    const section = document.createElement("section");
    section.id = `basic-${view}`;
    section.className = "basic-view";
    workspace.appendChild(section);
  }

  addEl(root, "button", "basic-action-compress");
  addEl(root, "button", "basic-action-open");
  addEl(root, "div", "basic-dropzone");

  addEl(root, "div", "basic-input-list");
  addEl(root, "div", "basic-extract-archive-name");
  addEl(root, "div", "basic-extract-archive-meta");
  addEl(root, "div", "basic-browse-archive-name");
  addEl(root, "div", "basic-browse-archive-meta");
  addEl(root, "div", "basic-browse-summary");
  addEl(root, "div", "basic-compress-status");
  addEl(root, "div", "basic-extract-status");

  addEl(root, "button", "basic-compress-back");
  addEl(root, "button", "basic-add-files");
  addEl(root, "button", "basic-add-folder");
  addEl(root, "button", "basic-clear-inputs");
  addEl(root, "button", "basic-choose-output");
  addEl(root, "button", "basic-run-compress");
  addEl(root, "button", "basic-compress-cancel");
  addEl(root, "button", "basic-toggle-password");
  addEl(root, "button", "basic-compress-open-dest");
  addEl(root, "button", "basic-compress-again");

  addEl(root, "button", "basic-extract-back");
  addEl(root, "button", "basic-choose-extract");
  addEl(root, "button", "basic-run-extract");
  addEl(root, "button", "basic-extract-cancel");
  addEl(root, "button", "basic-browse-contents");
  addEl(root, "button", "basic-toggle-extract-password");
  addEl(root, "button", "basic-extract-open-dest");
  addEl(root, "button", "basic-extract-another");

  addEl(root, "button", "basic-browse-back");
  addEl(root, "button", "basic-browse-extract-all");
  addEl(root, "button", "basic-browse-test");

  addSelect(root, "basic-preset", ["balanced", "ultra"]);
  addSelect(root, "basic-format", ["7z", "zip", "tar"]);

  addEl(root, "input", "basic-archive-name");
  addEl(root, "input", "basic-output-path");
  addEl(root, "input", "basic-password");
  addEl(root, "input", "basic-extract-path");
  addEl(root, "input", "basic-extract-password");

  for (const section of ["compress", "extract"] as const) {
    const progress = addEl(root, "div", `basic-${section}-progress`);
    progress.classList.remove("is-active");

    const completion = addEl(root, "div", `basic-${section}-completion`);
    completion.classList.remove("is-active");
    addEl(completion, "div", `basic-${section}-completion-icon`);
    addEl(completion, "div", `basic-${section}-completion-title`);
    addEl(completion, "div", `basic-${section}-completion-msg`);
  }

  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  tbody.id = "basic-browse-tbody";
  table.appendChild(tbody);
  root.appendChild(table);
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mountBasicDom();

  ensureGlobalInput("archive-name");
  ensureGlobalInput("output-path");
  ensureGlobalInput("password");
  ensureGlobalInput("extract-path");
  ensureGlobalInput("extract-password");

  uiMocks.runtime.workspaceMode = "basic";
  uiMocks.runtime.mode = "add";

  state.inputs = [];
  state.running = false;
  state.lastAutoOutputPath = null;
  state.lastAutoExtractDestination = null;

  (document.getElementById("app") as HTMLElement).dataset.mode = "add";

  (document.getElementById("format") as HTMLSelectElement).value = "7z";
  (document.getElementById("preset") as HTMLSelectElement).value = "balanced";
  (document.getElementById("archive-name") as HTMLInputElement).value = "";
  (document.getElementById("output-path") as HTMLInputElement).value = "";
  (document.getElementById("password") as HTMLInputElement).value = "";
  (document.getElementById("extract-path") as HTMLInputElement).value = "";
  (document.getElementById("extract-password") as HTMLInputElement).value = "";

  uiMocks.log.mockReset();
  uiMocks.setMode.mockClear();
  uiMocks.renderInputs.mockClear();
  uiMocks.setBrowsePasswordFieldVisible.mockClear();
  uiMocks.registerBasicHooks.mockClear();

  depMocks.applyPreset.mockReset();
  depMocks.updateCompressionOptionsForFormat.mockReset();
  depMocks.onCompressionOptionChange.mockReset();
  depMocks.validateArchivePaths.mockReset();
  depMocks.validateArchivePaths.mockResolvedValue([]);
  depMocks.runAction.mockReset();
  depMocks.runAction.mockResolvedValue(undefined);
  depMocks.cancelAction.mockReset();
  depMocks.browseArchive.mockReset();
  depMocks.browseArchive.mockResolvedValue(null);
  depMocks.testArchive.mockReset();
  depMocks.testArchive.mockResolvedValue("passed");
  depMocks.chooseOutput.mockReset();
  depMocks.chooseExtract.mockReset();
  depMocks.addFiles.mockReset();
  depMocks.addFolder.mockReset();
  depMocks.deriveOutputArchivePath.mockReset();
  depMocks.deriveOutputArchivePath.mockReturnValue("/tmp/derived.7z");
  depMocks.resolveOutputArchiveAutofill.mockReset();
  depMocks.resolveOutputArchiveAutofill.mockReturnValue(null);
  depMocks.resolveExtractDestinationAutofill.mockReset();
  depMocks.resolveExtractDestinationAutofill.mockReturnValue(null);

  openMock.mockReset();
  openMock.mockResolvedValue(null);
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("basic-ui views and rendering", () => {
  it("switches to compress view and enforces format encryption support", () => {
    (document.getElementById("format") as HTMLSelectElement).value = "tar";
    (document.getElementById("archive-name") as HTMLInputElement).value =
      "bundle";
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/bundle.tar";

    const basicPassword = document.getElementById(
      "basic-password",
    ) as HTMLInputElement;
    basicPassword.value = "secret";

    setBasicView("compress");

    expect(getBasicView()).toBe("compress");
    expect(
      document
        .getElementById("basic-compress")
        ?.classList.contains("is-active"),
    ).toBe(true);
    expect(
      (document.getElementById("basic-format") as HTMLSelectElement).value,
    ).toBe("tar");
    expect(
      (document.getElementById("basic-archive-name") as HTMLInputElement).value,
    ).toBe("bundle");
    expect(
      (document.getElementById("basic-output-path") as HTMLInputElement).value,
    ).toBe("/tmp/bundle.tar");
    expect(basicPassword.disabled).toBe(true);
    expect(basicPassword.value).toBe("");
    expect(basicPassword.placeholder).toContain(
      "TAR does not support encryption",
    );
  });

  it("updates extract and browse metadata from the selected archive", () => {
    state.inputs = ["/tmp/data/photos.7z"];
    depMocks.resolveExtractDestinationAutofill.mockReturnValueOnce(
      "/tmp/data/photos",
    );

    setBasicView("extract");

    expect(
      (document.getElementById("basic-extract-archive-name") as HTMLElement)
        .textContent,
    ).toBe("photos.7z");
    expect(
      (document.getElementById("basic-extract-archive-meta") as HTMLElement)
        .textContent,
    ).toBe("7Z archive");
    expect(depMocks.resolveExtractDestinationAutofill).toHaveBeenCalled();
    expect(state.lastAutoExtractDestination).toBe("/tmp/data/photos");

    setBasicView("browse");

    expect(
      (document.getElementById("basic-browse-archive-name") as HTMLElement)
        .textContent,
    ).toBe("photos.7z");
    expect(
      (document.getElementById("basic-browse-archive-meta") as HTMLElement)
        .textContent,
    ).toBe("7Z archive");
  });

  it("renders empty and populated input list states", () => {
    renderBasicInputs();
    expect(
      (document.getElementById("basic-input-list") as HTMLElement).textContent,
    ).toContain("No files added yet");

    state.inputs = ["/tmp/a.txt", "/tmp/b.txt"];
    state.running = false;
    renderBasicInputs();

    const rows = document.querySelectorAll(".basic-file-item");
    expect(rows.length).toBe(2);

    const removeButtons = document.querySelectorAll(
      ".basic-file-item__remove",
    ) as NodeListOf<HTMLButtonElement>;
    removeButtons[0].click();

    expect(state.inputs).toEqual(["/tmp/b.txt"]);
    expect(uiMocks.renderInputs).toHaveBeenCalled();
  });

  it("renders browse table rows and summary", () => {
    renderBasicBrowseTable([
      {
        path: "docs",
        size: "-",
        packed: "-",
        modified: "2026-04-25",
        isDir: true,
      },
      {
        path: "docs/readme.md",
        size: "10",
        packed: "8",
        modified: "2026-04-25",
        isDir: false,
      },
    ]);

    const rows = document.querySelectorAll("#basic-browse-tbody tr");
    expect(rows.length).toBe(2);
    expect(rows[0].classList.contains("browse-folder")).toBe(true);

    setBasicBrowseSummary("2 entries shown");
    expect(
      (document.getElementById("basic-browse-summary") as HTMLElement)
        .textContent,
    ).toBe("2 entries shown");
  });
});

describe("basic-ui state transitions", () => {
  it("toggles running state across compress and extract sections", () => {
    uiMocks.runtime.mode = "add";

    updateBasicRunningState(true);
    expect(
      document
        .getElementById("basic-compress-progress")
        ?.classList.contains("is-active"),
    ).toBe(true);
    expect(
      (document.getElementById("basic-run-compress") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (document.getElementById("basic-add-files") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    updateBasicRunningState(false);
    expect(
      document
        .getElementById("basic-compress-progress")
        ?.classList.contains("is-active"),
    ).toBe(false);
    expect(
      (document.getElementById("basic-run-compress") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    uiMocks.runtime.mode = "extract";
    updateBasicRunningState(true);
    expect(
      document
        .getElementById("basic-extract-progress")
        ?.classList.contains("is-active"),
    ).toBe(true);
  });

  it("maps status strings to completion UI", () => {
    uiMocks.runtime.mode = "add";
    updateBasicStatus("Done");

    expect(
      document
        .getElementById("basic-compress-completion")
        ?.classList.contains("basic-completion--success"),
    ).toBe(true);
    expect(
      (
        document.getElementById(
          "basic-compress-completion-title",
        ) as HTMLElement
      ).textContent,
    ).toBe("Archive created");

    updateBasicStatus("Error");
    expect(
      document
        .getElementById("basic-compress-completion")
        ?.classList.contains("basic-completion--error"),
    ).toBe(true);

    document
      .getElementById("basic-compress-progress")
      ?.classList.add("is-active");
    updateBasicStatus("Cancelled");
    expect(
      document
        .getElementById("basic-compress-progress")
        ?.classList.contains("is-active"),
    ).toBe(false);

    uiMocks.runtime.mode = "extract";
    updateBasicStatus("Done");
    expect(
      (document.getElementById("basic-extract-completion-title") as HTMLElement)
        .textContent,
    ).toBe("Extraction complete");
  });

  it("syncs basic controls into power controls before running", () => {
    uiMocks.runtime.workspaceMode = "basic";
    uiMocks.runtime.mode = "add";

    (document.getElementById("basic-format") as HTMLSelectElement).value =
      "zip";
    (document.getElementById("basic-preset") as HTMLSelectElement).value =
      "ultra";
    (document.getElementById("basic-archive-name") as HTMLInputElement).value =
      "release";
    (document.getElementById("basic-output-path") as HTMLInputElement).value =
      "/tmp/release.zip";
    (document.getElementById("basic-password") as HTMLInputElement).value =
      "pw";

    syncBasicBeforeRun();

    expect(depMocks.updateCompressionOptionsForFormat).toHaveBeenCalledWith(
      "zip",
    );
    expect(depMocks.applyPreset).toHaveBeenCalledWith("ultra");
    expect(depMocks.onCompressionOptionChange).toHaveBeenCalled();
    expect((document.getElementById("format") as HTMLSelectElement).value).toBe(
      "zip",
    );
    expect((document.getElementById("preset") as HTMLSelectElement).value).toBe(
      "ultra",
    );
    expect(
      (document.getElementById("archive-name") as HTMLInputElement).value,
    ).toBe("release");
    expect(
      (document.getElementById("output-path") as HTMLInputElement).value,
    ).toBe("/tmp/release.zip");
    expect(
      (document.getElementById("password") as HTMLInputElement).value,
    ).toBe("pw");

    uiMocks.runtime.mode = "extract";
    (document.getElementById("basic-extract-path") as HTMLInputElement).value =
      "/tmp/out";
    (
      document.getElementById("basic-extract-password") as HTMLInputElement
    ).value = "secret";

    syncBasicBeforeRun();

    expect(
      (document.getElementById("extract-path") as HTMLInputElement).value,
    ).toBe("/tmp/out");
    expect(
      (document.getElementById("extract-password") as HTMLInputElement).value,
    ).toBe("secret");
  });
});

describe("basic-ui drag and init wiring", () => {
  it("ignores drag state updates outside basic workspace mode", () => {
    uiMocks.runtime.workspaceMode = "power";

    handleBasicDragDrop("enter");

    expect(
      document
        .getElementById("basic-dropzone")
        ?.classList.contains("is-drag-over"),
    ).toBe(false);
  });

  it("handles archive drag-drop and auto-browse for a single archive", async () => {
    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: "/tmp/one.7z", valid: true },
    ]);

    handleBasicDragDrop("drop", ["/tmp/one.7z"]);
    await flushAsync();

    expect(state.inputs).toEqual(["/tmp/one.7z"]);
    expect(uiMocks.setMode).toHaveBeenCalledWith("browse");
    expect(getBasicView()).toBe("browse");
    expect(depMocks.browseArchive).toHaveBeenCalled();
  });

  it("wires card actions and register hooks on init", async () => {
    initBasicWorkspace();

    expect(uiMocks.registerBasicHooks).toHaveBeenCalledOnce();

    state.inputs = ["/tmp/old.txt"];
    state.lastAutoOutputPath = "/tmp/old.7z";

    (
      document.getElementById("basic-action-compress") as HTMLButtonElement
    ).click();
    await flushAsync();

    expect(state.inputs).toEqual([]);
    expect(uiMocks.runtime.mode).toBe("add");
    expect(getBasicView()).toBe("compress");

    openMock.mockResolvedValueOnce("/tmp/archive.7z");
    (document.getElementById("basic-action-open") as HTMLButtonElement).click();
    await flushAsync();

    expect(uiMocks.runtime.mode).toBe("browse");
    expect(getBasicView()).toBe("browse");
    expect(uiMocks.setBrowsePasswordFieldVisible).toHaveBeenCalledWith(false);
    expect(depMocks.browseArchive).toHaveBeenCalled();

    openMock.mockResolvedValueOnce(["/tmp/a.7z", "/tmp/b.zip"]);
    (document.getElementById("basic-action-open") as HTMLButtonElement).click();
    await flushAsync();

    expect(uiMocks.runtime.mode).toBe("extract");
    expect(getBasicView()).toBe("extract");
  });

  it("uses dropzone picker and routes non-archive picks to compress mode", async () => {
    initBasicWorkspace();

    openMock.mockResolvedValueOnce(["/tmp/file.txt"]);
    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: "/tmp/file.txt", valid: false },
    ]);

    (document.getElementById("basic-dropzone") as HTMLButtonElement).click();
    await flushAsync();

    expect(uiMocks.runtime.mode).toBe("add");
    expect(getBasicView()).toBe("compress");
    expect(depMocks.browseArchive).not.toHaveBeenCalled();
  });
});
