import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { state } from "../state";
import { decodeRun7zInvokePayload } from "./backend-ipc-test-utils";

const uiMocks = vi.hoisted(() => {
  const runtime = {
    workspaceMode: "basic" as "basic" | "power",
    mode: "add" as "add" | "extract" | "browse",
  };

  const clearBrowsePasswordFields = vi.fn(() => {
    for (const id of ["basic-browse-password", "browse-password"] as const) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) continue;
      input.value = "";
      input.type = "password";
    }
    for (const id of [
      "basic-toggle-browse-password",
      "toggle-browse-password",
    ] as const) {
      const toggle = document.getElementById(id) as HTMLButtonElement | null;
      if (!toggle) continue;
      const isIconOnly = toggle.classList.contains(
        "basic-password-toggle--icon",
      );
      if (isIconOnly) {
        const icon = toggle.querySelector<HTMLElement>("[data-lucide]");
        icon?.setAttribute("data-lucide", "eye");
        toggle.setAttribute("aria-label", "Show password");
      } else {
        toggle.textContent = "Show";
      }
      toggle.setAttribute("aria-pressed", "false");
    }
  });

  return {
    runtime,
    log: vi.fn(),
    setStatus: vi.fn(),
    setMode: vi.fn((next: "add" | "extract" | "browse") => {
      runtime.mode = next;
    }),
    renderInputs: vi.fn(),
    clearBrowsePasswordFields,
    resetPasswordFieldControl: (inputId: string, toggleId: string) => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      const toggle = document.getElementById(
        toggleId,
      ) as HTMLButtonElement | null;
      if (input) {
        input.value = "";
        input.type = "password";
      }
      if (!toggle) return;
      toggle.textContent = "Show";
      toggle.setAttribute("aria-pressed", "false");
    },
    setBrowsePasswordFieldVisible: vi.fn((visible: boolean) => {
      const field = document.getElementById("browse-password-field");
      if (field) field.hidden = !visible;
      if (!visible) {
        clearBrowsePasswordFields();
        const basicField = document.getElementById(
          "basic-browse-password-field",
        );
        if (basicField) basicField.hidden = true;
      }
    }),
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
  looksLikePasswordRequiredError: vi.fn().mockReturnValue(false),
  parseArchiveListing: vi.fn().mockReturnValue({
    type: "7z",
    physicalSize: 10,
    method: "LZMA2",
    solid: false,
    encrypted: false,
    entries: [],
  }),
  chooseOutput: vi.fn().mockResolvedValue(undefined),
  chooseOutputIfCurrent: vi.fn().mockResolvedValue(undefined),
  chooseExtract: vi.fn().mockResolvedValue(undefined),
  chooseExtractIfCurrent: vi.fn().mockResolvedValue(undefined),
  addFiles: vi.fn().mockResolvedValue(undefined),
  addFilesIfCurrent: vi.fn().mockResolvedValue(undefined),
  addFolder: vi.fn().mockResolvedValue(undefined),
  addFolderIfCurrent: vi.fn().mockResolvedValue(undefined),
  deriveOutputArchivePath: vi.fn().mockReturnValue("/tmp/derived.7z"),
  resolveOutputArchiveAutofill: vi.fn().mockReturnValue(null),
  resolveExtractDestinationAutofill: vi.fn().mockReturnValue(null),
  promptInput: vi.fn().mockResolvedValue("secret"),
}));

vi.mock("../ui", () => ({
  log: uiMocks.log,
  setStatus: uiMocks.setStatus,
  getWorkspaceMode: () => uiMocks.runtime.workspaceMode,
  getMode: () => uiMocks.runtime.mode,
  setMode: uiMocks.setMode,
  renderInputs: uiMocks.renderInputs,
  clearBrowsePasswordFields: uiMocks.clearBrowsePasswordFields,
  resetPasswordFieldControl: uiMocks.resetPasswordFieldControl,
  setBrowsePasswordFieldVisible: uiMocks.setBrowsePasswordFieldVisible,
  registerBasicHooks: uiMocks.registerBasicHooks,
  triggerIconRefresh: vi.fn(),
  registerIconRefreshHook: vi.fn(),
}));

vi.mock("../presets", () => ({
  applyPreset: depMocks.applyPreset,
  updateCompressionOptionsForFormat: depMocks.updateCompressionOptionsForFormat,
  onCompressionOptionChange: depMocks.onCompressionOptionChange,
}));

vi.mock("../archive-rules", () => ({
  MAX_ARCHIVE_PATHS: 4096,
  validateArchivePaths: depMocks.validateArchivePaths,
}));

vi.mock("../archive", () => ({
  runAction: depMocks.runAction,
  cancelAction: depMocks.cancelAction,
  browseArchive: depMocks.browseArchive,
  testArchive: depMocks.testArchive,
  looksLikePasswordRequiredError: depMocks.looksLikePasswordRequiredError,
  parseArchiveListing: depMocks.parseArchiveListing,
}));

vi.mock("../prompt-modal", () => ({
  promptInput: depMocks.promptInput,
}));

vi.mock("../files", () => ({
  chooseOutput: depMocks.chooseOutput,
  chooseOutputIfCurrent: depMocks.chooseOutputIfCurrent,
  chooseExtract: depMocks.chooseExtract,
  chooseExtractIfCurrent: depMocks.chooseExtractIfCurrent,
  addFiles: depMocks.addFiles,
  addFilesIfCurrent: depMocks.addFilesIfCurrent,
  addFolder: depMocks.addFolder,
  addFolderIfCurrent: depMocks.addFolderIfCurrent,
}));

vi.mock("../extract-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extract-path")>()),
  deriveOutputArchivePath: depMocks.deriveOutputArchivePath,
  resolveOutputArchiveAutofill: depMocks.resolveOutputArchiveAutofill,
  resolveExtractDestinationAutofill: depMocks.resolveExtractDestinationAutofill,
}));

import {
  getBasicView,
  handleBasicCompressAction,
  handleBasicExtractAction,
  handleBasicDragDrop,
  handleBasicDrop,
  initBasicWorkspace,
  renderBasicInputs,
  setBasicBrowsePasswordVisible,
  setBasicView,
  syncBasicBeforeRun,
  syncBasicWorkspaceFromPower,
  togglePasswordVisibility,
  updateBasicPreparingState,
  updateBasicRunningState,
  updateBasicStatus,
} from "../basic";
import { isArchiveEncrypted } from "../basic/actions";
import { setBasicBarDeterminate, resetBasicBar } from "../basic/progress";
import { setSevenZipRunInFlight } from "../archive/runtime";

const openMock = vi.mocked(open);
const confirmMock = vi.mocked(confirm);
const saveMock = vi.mocked(save);
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

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
  const toolbar = addEl(workspace, "div", "basic-toolbar");
  addEl(toolbar, "button", "basic-tab-home");
  const tablist = addEl(toolbar, "div", "basic-tablist");
  tablist.setAttribute("role", "tablist");
  for (const view of ["compress", "extract", "browse"] as const) {
    const tab = addEl(tablist, "button", `basic-tab-${view}`);
    tab.className = "basic-toolbar__tab";
    tab.dataset.basicTab = view;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.tabIndex = -1;
  }

  addEl(root, "div", "basic-input-list");
  addEl(root, "div", "basic-extract-archive-name");
  addEl(root, "div", "basic-extract-archive-meta");
  const extractArchiveInfo = addEl(root, "div", "basic-extract-archive-info");
  extractArchiveInfo.setAttribute("role", "button");
  extractArchiveInfo.tabIndex = 0;
  addEl(root, "div", "basic-browse-archive-name");
  addEl(root, "div", "basic-browse-archive-meta");
  addEl(root, "div", "basic-browse-summary");
  addEl(root, "div", "basic-compress-status");
  addEl(root, "div", "basic-extract-status");

  addEl(root, "button", "basic-add-files");
  addEl(root, "button", "basic-add-folder");
  addEl(root, "button", "basic-clear-inputs");
  addEl(root, "button", "basic-choose-output");
  addEl(root, "button", "basic-run-compress");
  addEl(root, "button", "basic-compress-cancel");
  addEl(root, "button", "basic-toggle-password");
  addEl(root, "button", "basic-compress-open-dest");
  addEl(root, "button", "basic-compress-again");

  addEl(root, "button", "basic-choose-extract");
  addEl(root, "button", "basic-run-extract");
  addEl(root, "button", "basic-extract-cancel");
  addEl(root, "button", "basic-browse-contents");
  addEl(root, "button", "basic-toggle-extract-password");
  addEl(root, "button", "basic-extract-open-dest");
  addEl(root, "button", "basic-extract-another");

  addEl(root, "button", "basic-browse-extract-all");
  addEl(root, "button", "basic-browse-test");

  addSelect(root, "basic-preset", ["balanced", "ultra"]);
  addSelect(root, "basic-format", ["7z", "zip", "tar", "gzip", "bzip2", "xz"]);
  addSelect(root, "basic-split-size", [
    "",
    "100m",
    "700m",
    "1g",
    "4g",
    "custom",
  ]);
  const splitCustomField = addEl(root, "div", "basic-split-custom-field");
  splitCustomField.hidden = true;
  addEl(root, "input", "basic-split-custom");

  addEl(root, "input", "basic-archive-name");
  addEl(root, "input", "basic-output-path");
  addEl(root, "input", "basic-password");
  const encryptHeaders = addEl(
    root,
    "input",
    "basic-encrypt-headers",
  ) as HTMLInputElement;
  encryptHeaders.type = "checkbox";
  addEl(root, "label", "basic-encrypt-headers-row");
  addEl(root, "input", "basic-extract-path");
  addEl(root, "input", "basic-extract-password");
  const browseArchiveInfo = addEl(root, "div", "basic-browse-archive-info");
  browseArchiveInfo.setAttribute("role", "button");
  browseArchiveInfo.tabIndex = 0;
  const browsePasswordField = addEl<HTMLDivElement>(
    root,
    "div",
    "basic-browse-password-field",
  );
  browsePasswordField.hidden = true;
  const browsePassword = addEl<HTMLInputElement>(
    root,
    "input",
    "basic-browse-password",
  );
  browsePassword.type = "password";
  const browseToggle = addEl<HTMLButtonElement>(
    root,
    "button",
    "basic-toggle-browse-password",
  );
  browseToggle.className = "basic-password-toggle basic-password-toggle--icon";
  browseToggle.setAttribute("aria-label", "Show password");
  const browseIcon = document.createElement("i");
  browseIcon.dataset.lucide = "eye";
  browseToggle.appendChild(browseIcon);

  for (const section of ["compress", "extract"] as const) {
    const progress = addEl(root, "div", `basic-${section}-progress`);
    progress.classList.remove("is-active");

    const completion = addEl(root, "div", `basic-${section}-completion`);
    completion.classList.remove("is-active");
    addEl(completion, "div", `basic-${section}-completion-icon`);
    addEl(completion, "div", `basic-${section}-completion-title`);
    addEl(completion, "div", `basic-${section}-completion-msg`);
    addEl(completion, "div", `basic-${section}-completion-path`);
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
  ensureGlobalInput("browse-password");
  if (!document.getElementById("browse-password-field")) {
    const powerBrowseField = document.createElement("div");
    powerBrowseField.id = "browse-password-field";
    powerBrowseField.hidden = true;
    document.body.appendChild(powerBrowseField);
  }
  if (!document.getElementById("toggle-browse-password")) {
    const powerToggle = document.createElement("button");
    powerToggle.id = "toggle-browse-password";
    powerToggle.textContent = "Show";
    document.body.appendChild(powerToggle);
  }

  uiMocks.runtime.workspaceMode = "basic";
  uiMocks.runtime.mode = "add";

  state.inputs = [];
  state.running = false;
  state.operationPreparing = false;
  state.incomingPathsApplying = false;
  state.platformName = "";
  state.lastAutoOutputPath = null;
  state.lastAutoExtractDestination = null;
  state.browseArchiveInfoByPath.clear();
  state.browseArchiveIdentityByPath.clear();

  (document.getElementById("app") as HTMLElement).dataset.mode = "add";

  (document.getElementById("format") as HTMLSelectElement).value = "7z";
  (document.getElementById("preset") as HTMLSelectElement).value = "balanced";
  (document.getElementById("archive-name") as HTMLInputElement).value = "";
  (document.getElementById("output-path") as HTMLInputElement).value = "";
  (document.getElementById("password") as HTMLInputElement).value = "";
  (document.getElementById("extract-path") as HTMLInputElement).value = "";
  (document.getElementById("extract-password") as HTMLInputElement).value = "";

  uiMocks.log.mockReset();
  uiMocks.setStatus.mockReset();
  uiMocks.setMode.mockClear();
  uiMocks.renderInputs.mockClear();
  uiMocks.clearBrowsePasswordFields.mockClear();
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
  depMocks.looksLikePasswordRequiredError.mockReset();
  depMocks.looksLikePasswordRequiredError.mockReturnValue(false);
  depMocks.parseArchiveListing.mockReset();
  depMocks.parseArchiveListing.mockReturnValue({
    type: "7z",
    physicalSize: 10,
    method: "LZMA2",
    solid: false,
    encrypted: false,
    entries: [],
  });
  depMocks.chooseOutput.mockReset();
  depMocks.chooseOutputIfCurrent.mockReset();
  depMocks.chooseOutputIfCurrent.mockResolvedValue(undefined);
  depMocks.chooseExtract.mockReset();
  depMocks.chooseExtractIfCurrent.mockReset();
  depMocks.chooseExtractIfCurrent.mockResolvedValue(undefined);
  depMocks.addFiles.mockReset();
  depMocks.addFilesIfCurrent.mockReset();
  depMocks.addFilesIfCurrent.mockResolvedValue(undefined);
  depMocks.addFolder.mockReset();
  depMocks.addFolderIfCurrent.mockReset();
  depMocks.addFolderIfCurrent.mockResolvedValue(undefined);
  depMocks.deriveOutputArchivePath.mockReset();
  depMocks.deriveOutputArchivePath.mockReturnValue("/tmp/derived.7z");
  depMocks.resolveOutputArchiveAutofill.mockReset();
  depMocks.resolveOutputArchiveAutofill.mockReturnValue(null);
  depMocks.resolveExtractDestinationAutofill.mockReset();
  depMocks.resolveExtractDestinationAutofill.mockReturnValue(null);
  depMocks.promptInput.mockReset();
  depMocks.promptInput.mockResolvedValue("secret");

  openMock.mockReset();
  openMock.mockResolvedValue(null);
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(false);
  saveMock.mockReset();
  saveMock.mockResolvedValue(null);
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
});

describe("basic-ui views and rendering", () => {
  it("invalidates cached encryption state when the archive identity changes", async () => {
    const archive = "/tmp/replaced.7z";
    state.browseArchiveInfoByPath.set(archive, {
      type: "7z",
      physicalSize: 10,
      method: "LZMA2",
      solid: false,
      encrypted: true,
      entries: [],
    });
    state.browseArchiveIdentityByPath.set(archive, "old-identity");
    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: archive, valid: true, identity: "new-identity" },
    ]);
    invokeMock.mockImplementation((command) => {
      if (command === "probe_7z") return Promise.resolve("26.02");
      if (command === "run_7z") {
        return Promise.resolve({ code: 0, stdout: "listing", stderr: "" });
      }
      return Promise.resolve(undefined);
    });

    await expect(isArchiveEncrypted(archive)).resolves.toBe(false);

    expect(depMocks.validateArchivePaths).toHaveBeenCalledWith([archive], true);
    expect(state.browseArchiveInfoByPath.has(archive)).toBe(false);
    expect(state.browseArchiveIdentityByPath.has(archive)).toBe(false);
    const runCall = invokeMock.mock.calls.find(
      ([command]) => command === "run_7z",
    );
    expect(decodeRun7zInvokePayload(runCall?.[1])).toEqual({
      args: ["l", "-slt", "-spd", "--", archive],
    });
  });

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
      document
        .getElementById("basic-tab-compress")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      document
        .getElementById("basic-tab-extract")
        ?.getAttribute("aria-selected"),
    ).toBe("false");
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
    const emptyPicker = document.getElementById(
      "basic-empty-input-picker",
    ) as HTMLButtonElement;
    expect(emptyPicker).toBeInstanceOf(HTMLButtonElement);
    expect(emptyPicker.type).toBe("button");
    expect(emptyPicker.dataset.basicInputPicker).toBe("");
    expect(emptyPicker.tabIndex).toBe(0);
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
    expect(removeButtons[0].getAttribute("aria-label")).toBe("Remove a.txt");
    removeButtons[0].click();

    expect(state.inputs).toEqual(["/tmp/b.txt"]);
    expect(uiMocks.renderInputs).toHaveBeenCalled();
  });

  it("opens archive pickers from keyboard-accessible archive cards", async () => {
    initBasicWorkspace();
    openMock.mockResolvedValueOnce("/tmp/keyboard.7z");

    document
      .getElementById("basic-browse-archive-info")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    await flushAsync();

    expect(state.inputs).toEqual(["/tmp/keyboard.7z"]);
    expect(depMocks.browseArchive).toHaveBeenCalled();
  });

  it("disables remove buttons while preparing and ignores clicks", () => {
    state.inputs = ["/tmp/a.txt", "/tmp/b.txt"];
    state.running = false;
    state.operationPreparing = true;
    renderBasicInputs();

    const removeButtons = document.querySelectorAll(
      ".basic-file-item__remove",
    ) as NodeListOf<HTMLButtonElement>;
    expect(removeButtons[0].disabled).toBe(true);
    removeButtons[0].disabled = false;
    removeButtons[0].click();

    expect(state.inputs).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
  });
});

describe("basic-ui state transitions", () => {
  it("locks Back, tabs, and workspace controls while preparing", () => {
    updateBasicPreparingState(true);

    expect(state.operationPreparing).toBe(true);
    expect(state.running).toBe(false);
    expect(
      (document.getElementById("basic-tab-home") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (document.getElementById("basic-tab-extract") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (document.getElementById("workspace-mode-power") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    updateBasicPreparingState(false);

    expect(state.operationPreparing).toBe(false);
    expect(
      (document.getElementById("basic-tab-home") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (document.getElementById("basic-tab-extract") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("clears progress busy semantics when an operation ends", () => {
    uiMocks.runtime.mode = "add";
    const progress = document.getElementById("basic-compress-progress")!;

    updateBasicRunningState(true);
    expect(progress.getAttribute("aria-busy")).toBe("true");

    updateBasicRunningState(false);
    expect(progress.hasAttribute("aria-busy")).toBe(false);
  });

  it("shows only the browse cancel control during a browse operation", () => {
    uiMocks.runtime.mode = "browse";

    updateBasicRunningState(true);

    expect(
      (document.getElementById("basic-browse-cancel") as HTMLButtonElement)
        .hidden,
    ).toBe(false);
    expect(
      (document.getElementById("basic-browse-test") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    updateBasicRunningState(false);
    expect(
      (document.getElementById("basic-browse-cancel") as HTMLButtonElement)
        .hidden,
    ).toBe(true);
  });

  it("ignores Finalizing while run_7z is not in flight", async () => {
    uiMocks.runtime.mode = "extract";
    let handler:
      | ((event: {
          payload?: { percent?: number; currentFile?: string };
        }) => void)
      | undefined;
    listenMock.mockImplementation(async (_eventName, callback) => {
      handler = callback as typeof handler;
      return () => {};
    });

    updateBasicRunningState(true);
    await vi.waitFor(() => {
      expect(handler).toBeDefined();
    });

    const cancel = document.getElementById(
      "basic-extract-cancel",
    ) as HTMLButtonElement;
    cancel.disabled = false;
    const status = document.getElementById("basic-extract-status")!;
    status.textContent = "Extracting";
    setSevenZipRunInFlight(false);
    handler?.({
      payload: { currentFile: "Finalizing…", percent: 100 },
    });
    handler?.({
      payload: { currentFile: "secret.txt", percent: 40 },
    });
    expect(cancel.disabled).toBe(false);
    expect(status.textContent).toBe("Extracting");

    setSevenZipRunInFlight(true);
    handler?.({
      payload: { currentFile: "Finalizing…", percent: 100 },
    });
    expect(cancel.disabled).toBe(true);
    expect(status.textContent).toBe("Finalizing…");
    setSevenZipRunInFlight(false);
    updateBasicRunningState(false);
  });

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
    expect(
      (document.getElementById("basic-tab-home") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (document.getElementById("basic-tab-browse") as HTMLButtonElement)
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
    expect(
      (document.getElementById("basic-tab-home") as HTMLButtonElement).disabled,
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

    updateBasicStatus("Error", "disk full");
    expect(
      document
        .getElementById("basic-compress-completion")
        ?.classList.contains("basic-completion--error"),
    ).toBe(true);
    expect(
      (document.getElementById("basic-compress-completion-msg") as HTMLElement)
        .textContent,
    ).toBe("disk full");

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

  it("shows the chosen extract destination instead of stale autofill", () => {
    uiMocks.runtime.mode = "extract";
    state.lastAutoExtractDestination = "/tmp/stale-auto";
    (document.getElementById("basic-extract-path") as HTMLInputElement).value =
      "/tmp/chosen";

    updateBasicStatus("Done");

    expect(
      document.getElementById("basic-extract-completion-path")?.textContent,
    ).toBe("/tmp/chosen");
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
    (document.getElementById("basic-split-size") as HTMLSelectElement).value =
      "100m";
    (
      document.getElementById("basic-encrypt-headers") as HTMLInputElement
    ).checked = true;

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
    expect(
      (document.getElementById("split-size") as HTMLSelectElement).value,
    ).toBe("100m");
    expect(
      (document.getElementById("encrypt-headers") as HTMLInputElement).checked,
    ).toBe(true);

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

  it("forces relative path-mode and disables update-mode for basic compress runs", () => {
    uiMocks.runtime.workspaceMode = "basic";
    uiMocks.runtime.mode = "add";
    (document.getElementById("update-mode") as HTMLInputElement).checked = true;
    (document.getElementById("path-mode") as HTMLSelectElement).value =
      "absolute";
    (document.getElementById("extra-args") as HTMLInputElement).value = "-bb3";
    (document.getElementById("extract-extra-args") as HTMLInputElement).value =
      "-bsp1";

    syncBasicBeforeRun();

    expect(
      (document.getElementById("update-mode") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (document.getElementById("path-mode") as HTMLSelectElement).value,
    ).toBe("relative");
    expect(
      (document.getElementById("extra-args") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (document.getElementById("extract-extra-args") as HTMLInputElement).value,
    ).toBe("");
  });

  it("syncs power extract/browse passwords and custom split into basic", () => {
    (document.getElementById("extract-password") as HTMLInputElement).value =
      "power-extract";
    (document.getElementById("browse-password") as HTMLInputElement).value =
      "power-browse";
    (document.getElementById("split-size") as HTMLSelectElement).value =
      "custom";
    (document.getElementById("split-custom") as HTMLInputElement).value =
      "250m";
    (document.getElementById("encrypt-headers") as HTMLInputElement).checked =
      true;

    syncBasicWorkspaceFromPower();

    expect(
      (document.getElementById("basic-extract-password") as HTMLInputElement)
        .value,
    ).toBe("power-extract");
    expect(
      (document.getElementById("basic-browse-password") as HTMLInputElement)
        .value,
    ).toBe("power-browse");
    expect(
      (document.getElementById("basic-split-size") as HTMLSelectElement).value,
    ).toBe("custom");
    expect(
      (document.getElementById("basic-split-custom") as HTMLInputElement).value,
    ).toBe("250m");
    expect(
      (document.getElementById("basic-split-custom-field") as HTMLElement)
        .hidden,
    ).toBe(false);
    expect(
      (document.getElementById("basic-encrypt-headers") as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("hides browse password and clears both Basic and Power fields", () => {
    const basicField = document.getElementById(
      "basic-browse-password-field",
    ) as HTMLElement;
    const basic = document.getElementById(
      "basic-browse-password",
    ) as HTMLInputElement;
    const basicToggle = document.getElementById(
      "basic-toggle-browse-password",
    ) as HTMLButtonElement;
    const powerField = document.getElementById(
      "browse-password-field",
    ) as HTMLElement;
    const power = document.getElementById(
      "browse-password",
    ) as HTMLInputElement;
    const powerToggle = document.getElementById(
      "toggle-browse-password",
    ) as HTMLButtonElement;

    basicField.hidden = false;
    powerField.hidden = false;
    basic.value = "basic-secret";
    basic.type = "text";
    basicToggle.setAttribute("aria-label", "Hide password");
    basicToggle
      .querySelector("[data-lucide]")
      ?.setAttribute("data-lucide", "eye-off");
    power.value = "power-secret";
    power.type = "text";
    powerToggle.textContent = "Hide";

    setBasicBrowsePasswordVisible(false);

    expect(basicField.hidden).toBe(true);
    expect(powerField.hidden).toBe(true);
    expect(basic.value).toBe("");
    expect(basic.type).toBe("password");
    expect(basicToggle.getAttribute("aria-label")).toBe("Show password");
    expect(
      basicToggle.querySelector("[data-lucide]")?.getAttribute("data-lucide"),
    ).toBe("eye");
    expect(power.value).toBe("");
    expect(power.type).toBe("password");
    expect(powerToggle.textContent).toBe("Show");
    expect(uiMocks.clearBrowsePasswordFields).toHaveBeenCalled();
  });

  it("clears browse passwords before re-browsing a newly picked archive", async () => {
    initBasicWorkspace();

    const basic = document.getElementById(
      "basic-browse-password",
    ) as HTMLInputElement;
    const power = document.getElementById(
      "browse-password",
    ) as HTMLInputElement;
    basic.value = "old-secret";
    power.value = "old-secret";
    uiMocks.runtime.mode = "browse";

    depMocks.browseArchive.mockImplementation(async () => {
      expect(basic.value).toBe("");
      expect(power.value).toBe("");
      return null;
    });
    openMock.mockResolvedValueOnce("/tmp/replacement.7z");

    (
      document.getElementById("basic-browse-archive-info") as HTMLButtonElement
    ).click();
    await flushAsync();

    expect(state.inputs).toEqual(["/tmp/replacement.7z"]);
    expect(uiMocks.clearBrowsePasswordFields).toHaveBeenCalled();
    expect(depMocks.browseArchive).toHaveBeenCalled();
    expect(basic.value).toBe("");
    expect(power.value).toBe("");
  });

  it("preserves and rerenders the browse password icon", () => {
    const input = document.getElementById(
      "basic-browse-password",
    ) as HTMLInputElement;
    const button = document.getElementById(
      "basic-toggle-browse-password",
    ) as HTMLButtonElement;
    const icon = button.querySelector("[data-lucide]")!;

    togglePasswordVisibility(
      "basic-browse-password",
      "basic-toggle-browse-password",
    );

    expect(input.type).toBe("text");
    expect(button.querySelector("[data-lucide]")).toBe(icon);
    expect(icon.getAttribute("data-lucide")).toBe("eye-off");
    expect(button.getAttribute("aria-label")).toBe("Hide password");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("");

    togglePasswordVisibility(
      "basic-browse-password",
      "basic-toggle-browse-password",
    );

    expect(input.type).toBe("password");
    expect(icon.getAttribute("data-lucide")).toBe("eye");
    expect(button.getAttribute("aria-label")).toBe("Show password");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("retains text labels for non-icon password toggles", () => {
    const input = document.getElementById("basic-password") as HTMLInputElement;
    const button = document.getElementById(
      "basic-toggle-password",
    ) as HTMLButtonElement;
    input.type = "password";

    togglePasswordVisibility("basic-password", "basic-toggle-password");

    expect(button.textContent).toBe("Hide");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("basic-ui drag and init wiring", () => {
  it("delegates empty-input activation once across rerenders", async () => {
    initBasicWorkspace();
    setBasicView("compress");
    renderBasicInputs();
    renderBasicInputs();

    const emptyPicker = document.getElementById(
      "basic-empty-input-picker",
    ) as HTMLButtonElement;
    emptyPicker.focus();
    expect(document.activeElement).toBe(emptyPicker);
    emptyPicker.click();
    await flushAsync();

    expect(depMocks.addFilesIfCurrent).toHaveBeenCalledOnce();
    expect(depMocks.addFilesIfCurrent).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ underBasicPreparation: true }),
    );
    expect(state.operationPreparing).toBe(false);
  });

  it("ignores an empty-input picker result after its inputs become stale", async () => {
    let resolveSelection!: (path: string) => void;
    let markHandled!: () => void;
    const selection = new Promise<string>((resolve) => {
      resolveSelection = resolve;
    });
    const handled = new Promise<void>((resolve) => {
      markHandled = resolve;
    });
    depMocks.addFilesIfCurrent.mockImplementationOnce(async (isCurrent) => {
      const path = await selection;
      if (isCurrent()) state.inputs = [path];
      markHandled();
    });

    initBasicWorkspace();
    setBasicView("compress");
    const emptyPicker = document.getElementById(
      "basic-empty-input-picker",
    ) as HTMLButtonElement;
    emptyPicker.click();
    await flushAsync();

    expect(state.operationPreparing).toBe(true);
    renderBasicInputs();
    expect(
      (document.getElementById("basic-empty-input-picker") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    state.inputs = ["/tmp/competing.txt"];
    resolveSelection("/tmp/stale.txt");
    await handled;
    await flushAsync();

    expect(state.inputs).toEqual(["/tmp/competing.txt"]);
    expect(state.operationPreparing).toBe(false);
  });

  it("supports standard keyboard navigation for Basic tabs", () => {
    initBasicWorkspace();
    setBasicView("compress");
    const compress = document.getElementById(
      "basic-tab-compress",
    ) as HTMLButtonElement;
    const extract = document.getElementById(
      "basic-tab-extract",
    ) as HTMLButtonElement;
    const browse = document.getElementById(
      "basic-tab-browse",
    ) as HTMLButtonElement;

    expect(compress.getAttribute("role")).toBe("tab");
    expect(compress.dataset.basicTab).toBe("compress");
    expect(compress.getAttribute("aria-selected")).toBe("true");
    expect(compress.tabIndex).toBe(0);
    expect(extract.tabIndex).toBe(-1);

    compress.focus();
    compress.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(extract);
    expect(extract.getAttribute("aria-selected")).toBe("true");
    expect(extract.tabIndex).toBe(0);
    expect(compress.tabIndex).toBe(-1);

    extract.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    expect(document.activeElement).toBe(browse);
    expect(browse.getAttribute("aria-selected")).toBe("true");

    browse.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(document.activeElement).toBe(compress);
    expect(compress.getAttribute("aria-selected")).toBe("true");
  });

  it("ignores drag state updates outside basic workspace mode", () => {
    uiMocks.runtime.workspaceMode = "power";

    handleBasicDragDrop("enter");

    expect(
      document
        .getElementById("basic-dropzone")
        ?.classList.contains("is-drag-over"),
    ).toBe(false);
  });

  it("toggles drag-over styling on enter/leave in basic mode", () => {
    uiMocks.runtime.workspaceMode = "basic";
    setBasicView("home");

    handleBasicDragDrop("enter");
    expect(
      document
        .getElementById("basic-dropzone")
        ?.classList.contains("is-drag-over"),
    ).toBe(true);

    handleBasicDragDrop("leave");
    expect(
      document
        .getElementById("basic-dropzone")
        ?.classList.contains("is-drag-over"),
    ).toBe(false);
  });

  it("forces relative path-mode for basic compress and syncs extract/browse passwords", () => {
    uiMocks.runtime.workspaceMode = "basic";
    uiMocks.runtime.mode = "extract";
    (
      document.getElementById("basic-extract-password") as HTMLInputElement
    ).value = "extract-secret";
    (document.getElementById("extract-password") as HTMLInputElement).value =
      "";

    syncBasicBeforeRun();
    expect(
      (document.getElementById("extract-password") as HTMLInputElement).value,
    ).toBe("extract-secret");

    uiMocks.runtime.mode = "browse";
    (
      document.getElementById("basic-browse-password") as HTMLInputElement
    ).value = "browse-secret";
    (document.getElementById("browse-password") as HTMLInputElement).value = "";
    syncBasicBeforeRun();
    expect(
      (document.getElementById("browse-password") as HTMLInputElement).value,
    ).toBe("browse-secret");
  });

  it("handles archive drag-drop and auto-browse for a single archive", async () => {
    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: "/tmp/one.7z", valid: true },
    ]);

    await handleBasicDrop(["/tmp/one.7z"]);

    expect(state.inputs).toEqual(["/tmp/one.7z"]);
    expect(uiMocks.setMode).toHaveBeenCalledWith("browse");
    expect(getBasicView()).toBe("browse");
    expect(depMocks.browseArchive).toHaveBeenCalled();
  });

  it("caps an oversized archive drop before probing and routes it to extraction", async () => {
    const paths = Array.from(
      { length: 4_097 },
      (_, index) => `/tmp/archive-${index}.7z`,
    );
    depMocks.validateArchivePaths.mockImplementationOnce(async (candidate) =>
      (candidate as string[]).map((path) => ({ path, valid: true })),
    );

    await handleBasicDrop(paths);

    expect(depMocks.validateArchivePaths).toHaveBeenCalledWith(
      paths.slice(0, 4_096),
    );
    expect(state.inputs).toHaveLength(4_096);
    expect(uiMocks.setMode).toHaveBeenCalledWith("extract");
    expect(getBasicView()).toBe("extract");
    expect(document.querySelector(".toast")?.textContent).toContain(
      "1 more were not added",
    );
  });

  it("does not default a dismissed mixed drop to compression", async () => {
    state.inputs = ["/tmp/original.txt"];
    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: "/tmp/archive.7z", valid: true },
      { path: "/tmp/file.txt", valid: false },
    ]);
    confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await handleBasicDrop(["/tmp/archive.7z", "/tmp/file.txt"]);

    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(state.inputs).toEqual(["/tmp/original.txt"]);
    expect(uiMocks.setMode).not.toHaveBeenCalled();
  });

  it.each([
    ["first", [new Error("portal unavailable")]],
    ["second", [false, new Error("portal unavailable")]],
  ])(
    "contains a rejected %s mixed-drop confirmation",
    async (_which, replies) => {
      state.inputs = ["/tmp/original.txt"];
      depMocks.validateArchivePaths.mockResolvedValueOnce([
        { path: "/tmp/archive.7z", valid: true },
        { path: "/tmp/file.txt", valid: false },
      ]);
      for (const reply of replies) {
        if (reply instanceof Error) confirmMock.mockRejectedValueOnce(reply);
        else confirmMock.mockResolvedValueOnce(reply);
      }

      await expect(
        handleBasicDrop(["/tmp/archive.7z", "/tmp/file.txt"]),
      ).resolves.toBeUndefined();

      expect(uiMocks.log).toHaveBeenCalledWith(
        expect.stringContaining("Could not open Basic confirmation dialog"),
        "error",
      );
      expect(uiMocks.setStatus).toHaveBeenCalledWith(
        "Could not open confirmation dialog",
        3000,
      );
      expect(state.inputs).toEqual(["/tmp/original.txt"]);
    },
  );

  it.each([
    ["gzip", ".gz"],
    ["bzip2", ".bz2"],
  ])(
    "uses the mapped %s extension in the Basic save default",
    async (format, extension) => {
      state.inputs = ["/tmp/input.txt"];
      (document.getElementById("basic-format") as HTMLSelectElement).value =
        format;
      saveMock.mockResolvedValueOnce(`/tmp/output${extension}`);

      await handleBasicCompressAction();

      expect(saveMock).toHaveBeenCalledWith({
        title: "Choose output archive",
        defaultPath: `/tmp/Archive${extension}`,
      });
    },
  );

  it("keeps preparation separate from running until the save resolves", async () => {
    state.inputs = ["/tmp/input.txt"];
    uiMocks.runtime.mode = "add";
    setBasicView("compress");
    let resolveSave!: (path: string) => void;
    saveMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const pending = handleBasicCompressAction();
    await flushAsync();

    expect(state.operationPreparing).toBe(true);
    expect(state.running).toBe(false);
    expect(depMocks.runAction).not.toHaveBeenCalled();
    expect(
      (document.getElementById("basic-tab-extract") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    resolveSave("/tmp/output.7z");
    await pending;

    expect(state.operationPreparing).toBe(false);
    expect(depMocks.runAction).toHaveBeenCalledOnce();
  });

  it("aborts a prepared compression when captured inputs change", async () => {
    state.inputs = ["/tmp/original.txt"];
    uiMocks.runtime.mode = "add";
    setBasicView("compress");
    let resolveSave!: (path: string) => void;
    saveMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const pending = handleBasicCompressAction();
    await flushAsync();
    await handleBasicDrop(["/tmp/competing.7z"]);
    expect(depMocks.validateArchivePaths).not.toHaveBeenCalled();

    state.inputs = ["/tmp/replaced.txt"];
    resolveSave("/tmp/output.7z");
    await pending;

    expect(depMocks.runAction).not.toHaveBeenCalled();
    expect(state.operationPreparing).toBe(false);
    expect(
      (document.getElementById("basic-tab-extract") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("unlocks and clears extraction passwords on picker cancellation", async () => {
    state.inputs = ["/tmp/archive.7z"];
    uiMocks.runtime.mode = "extract";
    setBasicView("extract");
    invokeMock.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });
    openMock.mockResolvedValueOnce(null);
    (
      document.getElementById("basic-extract-password") as HTMLInputElement
    ).value = "basic-secret";
    (
      document.getElementById("basic-extract-password") as HTMLInputElement
    ).type = "text";
    (
      document.getElementById(
        "basic-toggle-extract-password",
      ) as HTMLButtonElement
    ).textContent = "Hide";
    (document.getElementById("extract-password") as HTMLInputElement).value =
      "power-secret";

    await handleBasicExtractAction();

    expect(state.operationPreparing).toBe(false);
    expect(
      (document.getElementById("basic-extract-password") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (document.getElementById("extract-password") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (document.getElementById("basic-extract-password") as HTMLInputElement)
        .type,
    ).toBe("password");
    expect(
      document.getElementById("basic-toggle-extract-password")?.textContent,
    ).toBe("Show");
  });

  it("shows Basic extraction failure when folder dialog rejects", async () => {
    const archive = "/tmp/archive.7z";
    state.inputs = [archive];
    state.browseArchiveInfoByPath.set(archive, {
      type: "7z",
      physicalSize: 10,
      method: "LZMA2",
      solid: false,
      encrypted: false,
      entries: [],
    });
    state.browseArchiveIdentityByPath.set(archive, "identity:archive");
    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: archive, valid: true, identity: "identity:archive" },
    ]);
    uiMocks.runtime.mode = "extract";
    setBasicView("extract");
    openMock.mockRejectedValueOnce(new Error("portal unavailable"));

    await expect(handleBasicExtractAction()).resolves.toBeUndefined();

    expect(uiMocks.log).toHaveBeenCalledWith(
      expect.stringContaining("Could not open the destination-folder dialog"),
      "error",
    );
    expect(
      document
        .getElementById("basic-extract-completion")
        ?.classList.contains("is-active"),
    ).toBe(true);
    expect(state.operationPreparing).toBe(false);
  });

  it("handles rejected Basic archive dialogs without an unhandled event error", async () => {
    initBasicWorkspace();
    openMock.mockRejectedValueOnce(new Error("portal unavailable"));

    (document.getElementById("basic-action-open") as HTMLButtonElement).click();
    await flushAsync();

    expect(uiMocks.log).toHaveBeenCalledWith(
      expect.stringContaining("Could not open Basic file dialog"),
      "error",
    );
    expect(state.operationPreparing).toBe(false);
  });

  it("clears copied extraction passwords when runAction rejects", async () => {
    const archive = "/tmp/encrypted.7z";
    state.inputs = [archive];
    state.browseArchiveInfoByPath.set(archive, {
      type: "7z",
      physicalSize: 10,
      method: "LZMA2",
      solid: false,
      encrypted: true,
      entries: [],
    });
    state.browseArchiveIdentityByPath.set(archive, "identity:encrypted");
    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: archive, valid: true, identity: "identity:encrypted" },
    ]);
    uiMocks.runtime.mode = "extract";
    setBasicView("extract");
    invokeMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    openMock.mockResolvedValueOnce("/tmp/output");
    depMocks.runAction.mockRejectedValueOnce(new Error("run failed"));

    await expect(handleBasicExtractAction()).rejects.toThrow("run failed");

    expect(state.operationPreparing).toBe(false);
    expect(
      (document.getElementById("basic-extract-password") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (document.getElementById("extract-password") as HTMLInputElement).value,
    ).toBe("");
  });

  it("ignores drops and disables basic launch controls while running", async () => {
    state.inputs = ["/tmp/original.txt"];
    state.running = true;

    updateBasicRunningState(true);
    handleBasicDragDrop("drop", ["/tmp/replacement.7z"]);
    await flushAsync();

    expect(state.inputs).toEqual(["/tmp/original.txt"]);
    expect(depMocks.validateArchivePaths).not.toHaveBeenCalled();
    expect(
      (document.getElementById("basic-action-open") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      document.getElementById("basic-dropzone")?.getAttribute("aria-disabled"),
    ).toBe("true");
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

  it("includes RAR files in Windows Basic archive pickers", async () => {
    state.platformName = "windows";
    initBasicWorkspace();
    openMock.mockResolvedValueOnce(null);

    (document.getElementById("basic-action-open") as HTMLButtonElement).click();
    await flushAsync();

    const options = openMock.mock.calls[0]?.[0];
    const extensions = options?.filters?.[0]?.extensions ?? [];
    expect(extensions).toContain("rar");
    expect(extensions).toContain("zip");
  });

  it("caps Basic archive-picker selections before batch extraction", async () => {
    initBasicWorkspace();
    const paths = Array.from(
      { length: 4_097 },
      (_, index) => `/tmp/archive-${index}.7z`,
    );
    openMock.mockResolvedValueOnce(paths);

    (document.getElementById("basic-action-open") as HTMLButtonElement).click();
    await flushAsync();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    expect(state.inputs).toHaveLength(4_096);
    expect(state.inputs.at(-1)).toBe("/tmp/archive-4095.7z");
    expect(document.querySelector(".toast")?.textContent).toContain(
      "1 more were not added",
    );
  });

  it("uses dropzone picker and routes non-archive picks to compress mode", async () => {
    initBasicWorkspace();
    setBasicView("home");

    depMocks.validateArchivePaths.mockResolvedValueOnce([
      { path: "/tmp/file.txt", valid: false },
    ]);

    await handleBasicDrop(["/tmp/file.txt"]);

    expect(uiMocks.runtime.mode).toBe("add");
    expect(getBasicView()).toBe("compress");
    expect(depMocks.browseArchive).not.toHaveBeenCalled();
  });

  it("Escape returns home when no modal overlay is open", async () => {
    initBasicWorkspace();
    setBasicView("compress");
    const overlay = document.getElementById("settings-overlay") as HTMLElement;
    overlay.classList.add("modal-overlay");
    overlay.hidden = true;

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flushAsync();
    expect(getBasicView()).toBe("home");

    setBasicView("compress");
    overlay.hidden = false;
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flushAsync();
    expect(getBasicView()).toBe("compress");
    overlay.hidden = true;
  });

  it("blocks Basic tabs and Escape while an operation is running", async () => {
    initBasicWorkspace();
    setBasicView("compress");
    uiMocks.runtime.mode = "add";
    state.running = true;

    (document.getElementById("basic-tab-extract") as HTMLButtonElement).click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flushAsync();

    expect(getBasicView()).toBe("compress");
    expect(uiMocks.runtime.mode).toBe("add");
  });

  it("writes aria-valuenow on the Basic progressbar track", () => {
    const track = document.createElement("div");
    track.setAttribute("role", "progressbar");
    const fill = document.createElement("div");
    fill.id = "basic-extract-bar";
    track.appendChild(fill);
    document.body.appendChild(track);

    setBasicBarDeterminate("extract", 42);
    expect(track.getAttribute("aria-valuenow")).toBe("42");
    resetBasicBar("extract");
    expect(track.getAttribute("aria-valuenow")).toBe("0");
  });
});
