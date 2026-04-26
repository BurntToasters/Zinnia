import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SETTING_DEFAULTS } from "../settings-model";

const mocks = vi.hoisted(() => {
  const runtime = {
    mode: "add" as "add" | "extract" | "browse",
    workspaceMode: "basic" as "basic" | "power",
  };

  return {
    runtime,
    settings: {
      applyTheme: vi.fn(),
      loadSettingsWithMetadata: vi.fn(),
      readSettingsModal: vi.fn(),
      applySettingsToForm: vi.fn(),
      openSettingsModal: vi.fn(),
      closeSettingsModal: vi.fn(),
      populateSettingsModal: vi.fn(),
      syncSettingsSecurityControlsForFormat: vi.fn(),
    },
    ui: {
      log: vi.fn(),
      devLog: vi.fn(),
      toggleActivity: vi.fn(),
      renderInputs: vi.fn(),
      setMode: vi.fn((next: "add" | "extract" | "browse") => {
        runtime.mode = next;
      }),
      setActivityPanelVisible: vi.fn(),
      setWorkspaceMode: vi.fn((next: "basic" | "power") => {
        runtime.workspaceMode = next;
      }),
      getWorkspaceMode: vi.fn(() => runtime.workspaceMode),
      setUiDensity: vi.fn(),
      getMode: vi.fn(() => runtime.mode),
      setBrowsePasswordFieldVisible: vi.fn(),
      persistSettingsImmediately: vi.fn().mockResolvedValue(undefined),
    },
    archive: {
      runAction: vi.fn().mockResolvedValue(undefined),
      cancelAction: vi.fn(),
      testArchive: vi.fn().mockResolvedValue("passed"),
      browseArchive: vi.fn().mockResolvedValue(null),
      previewCommand: vi.fn().mockResolvedValue(undefined),
      copyCommandPreview: vi.fn().mockResolvedValue(undefined),
      closeCommandPreviewModal: vi.fn(),
      openSelectiveExtractModal: vi.fn().mockResolvedValue(undefined),
      closeSelectiveExtractModal: vi.fn(),
      setSelectiveExtractSearch: vi.fn(),
      selectAllVisibleInPicker: vi.fn(),
      clearPickerSelection: vi.fn(),
      runSelectiveExtractFromModal: vi.fn().mockResolvedValue(undefined),
      syncSelectiveDestinationAfterBrowseChoice: vi.fn(),
      syncDestinationWhilePickerOpen: vi.fn(),
    },
    archiveRules: {
      validateArchivePaths: vi.fn().mockResolvedValue([]),
    },
    presets: {
      updateCompressionOptionsForFormat: vi.fn(),
      applyPreset: vi.fn(),
      onCompressionOptionChange: vi.fn(),
    },
    updater: {
      checkUpdates: vi.fn().mockResolvedValue(undefined),
      autoCheckUpdates: vi.fn().mockResolvedValue(undefined),
    },
    licenses: {
      openLicensesModal: vi.fn(),
      closeLicensesModal: vi.fn(),
    },
    files: {
      chooseOutput: vi.fn().mockResolvedValue(undefined),
      chooseExtract: vi.fn().mockResolvedValue(undefined),
      addFiles: vi.fn().mockResolvedValue(undefined),
      addFolder: vi.fn().mockResolvedValue(undefined),
    },
    quickActions: {
      wireQuickActionEvents: vi.fn(),
      refreshQuickActionRepeatState: vi.fn(),
    },
    setupWizard: {
      shouldShowSetupWizard: vi.fn().mockReturnValue(false),
      showSetupWizard: vi.fn().mockResolvedValue(null),
      markSetupComplete: vi.fn().mockResolvedValue(undefined),
    },
    extractPath: {
      deriveOutputArchivePath: vi.fn().mockReturnValue("/tmp/out.7z"),
      resolveOutputArchiveAutofill: vi.fn().mockReturnValue(null),
    },
    basicUi: {
      initBasicWorkspace: vi.fn(),
      setBasicView: vi.fn(),
      handleBasicDragDrop: vi.fn(),
      syncBasicBeforeRun: vi.fn(),
    },
  };
});

vi.mock("../settings", () => ({
  applyTheme: mocks.settings.applyTheme,
  loadSettingsWithMetadata: mocks.settings.loadSettingsWithMetadata,
  readSettingsModal: mocks.settings.readSettingsModal,
  applySettingsToForm: mocks.settings.applySettingsToForm,
  openSettingsModal: mocks.settings.openSettingsModal,
  closeSettingsModal: mocks.settings.closeSettingsModal,
  populateSettingsModal: mocks.settings.populateSettingsModal,
  syncSettingsSecurityControlsForFormat:
    mocks.settings.syncSettingsSecurityControlsForFormat,
}));

vi.mock("../ui", () => ({
  log: mocks.ui.log,
  devLog: mocks.ui.devLog,
  toggleActivity: mocks.ui.toggleActivity,
  renderInputs: mocks.ui.renderInputs,
  setMode: mocks.ui.setMode,
  setActivityPanelVisible: mocks.ui.setActivityPanelVisible,
  setWorkspaceMode: mocks.ui.setWorkspaceMode,
  getWorkspaceMode: mocks.ui.getWorkspaceMode,
  setUiDensity: mocks.ui.setUiDensity,
  getMode: mocks.ui.getMode,
  setBrowsePasswordFieldVisible: mocks.ui.setBrowsePasswordFieldVisible,
  persistSettingsImmediately: mocks.ui.persistSettingsImmediately,
}));

vi.mock("../archive", () => ({
  runAction: mocks.archive.runAction,
  cancelAction: mocks.archive.cancelAction,
  testArchive: mocks.archive.testArchive,
  browseArchive: mocks.archive.browseArchive,
  previewCommand: mocks.archive.previewCommand,
  copyCommandPreview: mocks.archive.copyCommandPreview,
  closeCommandPreviewModal: mocks.archive.closeCommandPreviewModal,
  openSelectiveExtractModal: mocks.archive.openSelectiveExtractModal,
  closeSelectiveExtractModal: mocks.archive.closeSelectiveExtractModal,
  setSelectiveExtractSearch: mocks.archive.setSelectiveExtractSearch,
  selectAllVisibleInPicker: mocks.archive.selectAllVisibleInPicker,
  clearPickerSelection: mocks.archive.clearPickerSelection,
  runSelectiveExtractFromModal: mocks.archive.runSelectiveExtractFromModal,
  syncSelectiveDestinationAfterBrowseChoice:
    mocks.archive.syncSelectiveDestinationAfterBrowseChoice,
  syncDestinationWhilePickerOpen: mocks.archive.syncDestinationWhilePickerOpen,
}));

vi.mock("../archive-rules", () => ({
  validateArchivePaths: mocks.archiveRules.validateArchivePaths,
}));

vi.mock("../presets", () => ({
  updateCompressionOptionsForFormat:
    mocks.presets.updateCompressionOptionsForFormat,
  applyPreset: mocks.presets.applyPreset,
  onCompressionOptionChange: mocks.presets.onCompressionOptionChange,
}));

vi.mock("../updater", () => ({
  checkUpdates: mocks.updater.checkUpdates,
  autoCheckUpdates: mocks.updater.autoCheckUpdates,
}));

vi.mock("../licenses", () => ({
  openLicensesModal: mocks.licenses.openLicensesModal,
  closeLicensesModal: mocks.licenses.closeLicensesModal,
}));

vi.mock("../files", () => ({
  chooseOutput: mocks.files.chooseOutput,
  chooseExtract: mocks.files.chooseExtract,
  addFiles: mocks.files.addFiles,
  addFolder: mocks.files.addFolder,
}));

vi.mock("../quick-actions", () => ({
  wireQuickActionEvents: mocks.quickActions.wireQuickActionEvents,
  refreshQuickActionRepeatState:
    mocks.quickActions.refreshQuickActionRepeatState,
}));

vi.mock("../setup-wizard", () => ({
  shouldShowSetupWizard: mocks.setupWizard.shouldShowSetupWizard,
  showSetupWizard: mocks.setupWizard.showSetupWizard,
  markSetupComplete: mocks.setupWizard.markSetupComplete,
}));

vi.mock("../extract-path", () => ({
  deriveOutputArchivePath: mocks.extractPath.deriveOutputArchivePath,
  resolveOutputArchiveAutofill: mocks.extractPath.resolveOutputArchiveAutofill,
}));

vi.mock("../basic-ui", () => ({
  initBasicWorkspace: mocks.basicUi.initBasicWorkspace,
  setBasicView: mocks.basicUi.setBasicView,
  handleBasicDragDrop: mocks.basicUi.handleBasicDragDrop,
  syncBasicBeforeRun: mocks.basicUi.syncBasicBeforeRun,
}));

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);
const messageMock = vi.mocked(message);
const listenMock = vi.mocked(listen);
const getVersionMock = vi.mocked(getVersion);
const getCurrentWebviewWindowMock = vi.mocked(getCurrentWebviewWindow);

let dragDropHandler:
  | ((event: { payload: { type: string; paths: string[] } }) => Promise<void>)
  | null = null;

function ensureElement(id: string, tag = "div"): HTMLElement {
  const existing = document.getElementById(id);
  if (existing) return existing;
  const el = document.createElement(tag);
  el.id = id;
  document.body.appendChild(el);
  return el;
}

function ensureSelect(id: string, options: string[] = []): HTMLSelectElement {
  const existing = document.getElementById(id) as HTMLSelectElement | null;
  if (existing) return existing;
  const select = document.createElement("select");
  select.id = id;
  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  document.body.appendChild(select);
  return select;
}

function ensureMainDomElements(): void {
  const app = ensureElement("app", "div");
  app.setAttribute("data-mode", app.getAttribute("data-mode") ?? "add");
  ensureElement("input-list", "div");
  ensureElement("log", "div");
  ensureElement("status", "div");
  ensureElement("progress", "div");
  ensureElement("version-label", "div");
  ensureElement("platform-label", "div");

  if (!document.querySelector(".grid")) {
    const grid = document.createElement("div");
    grid.className = "grid";
    document.body.appendChild(grid);
  }

  for (const id of [
    "run-action",
    "cancel-action",
    "extract-run",
    "extract-cancel",
    "show-command",
    "extract-preview",
    "test-integrity",
    "clear-log",
    "toggle-activity",
    "toggle-density",
    "add-files",
    "add-folder",
    "clear-inputs",
    "choose-output",
    "choose-extract",
    "open-settings",
    "browse-list",
    "browse-test",
    "browse-extract",
    "browse-selective",
    "selective-select-all",
    "selective-clear",
    "selective-cancel",
    "selective-confirm",
    "selective-browse-dest",
    "close-selective",
    "toggle-browse-password",
    "toggle-password",
    "toggle-extract-password",
    "copy-command-preview",
    "close-command-preview",
    "close-command-preview-footer",
    "close-settings",
    "cancel-settings",
    "save-settings",
    "check-updates",
    "export-logs",
    "open-logs-folder",
    "clear-logs",
    "show-licenses",
    "about-show-licenses",
    "close-licenses",
    "rerun-setup-wizard",
  ]) {
    ensureElement(id, "button");
  }

  const workspaceBasic = ensureElement("workspace-mode-basic", "button");
  workspaceBasic.setAttribute("data-workspace-mode-btn", "basic");
  const workspacePower = ensureElement("workspace-mode-power", "button");
  workspacePower.setAttribute("data-workspace-mode-btn", "power");

  for (const [id, mode] of [
    ["mode-add", "add"],
    ["mode-extract", "extract"],
    ["mode-browse", "browse"],
  ] as const) {
    const btn = ensureElement(id, "button");
    btn.setAttribute("data-mode-btn", mode);
  }

  for (const id of [
    "output-path",
    "archive-name",
    "password",
    "extract-path",
    "extract-password",
    "browse-password",
    "selective-search",
    "selective-dest",
  ]) {
    ensureElement(id, "input");
  }

  ensureSelect("format", ["7z", "zip", "tar"]);
  ensureSelect("preset", ["balanced", "ultra"]);
  ensureSelect("s-format", ["7z", "zip", "tar"]);
  for (const id of ["level", "method", "dict", "word-size", "solid"]) {
    ensureSelect(id, [""]);
  }

  const browsePasswordField = ensureElement("browse-password-field", "div");
  browsePasswordField.hidden = true;
  ensureElement("browse-contents", "div");

  ensureElement("archive-name", "input");
  ensureElement("selective-search", "input");
  ensureElement("selective-dest", "input");
  ensureElement("close-settings", "button");
  ensureElement("cancel-settings", "button");
  ensureElement("save-settings", "button");
  ensureElement("check-updates", "button");
  ensureElement("export-logs", "button");
  ensureElement("open-logs-folder", "button");
  ensureElement("clear-logs", "button");
  ensureElement("show-licenses", "button");
  ensureElement("about-show-licenses", "button");
  ensureElement("close-licenses", "button");
  ensureElement("s-version-label", "div");
  ensureElement("s-platform-label", "div");
  ensureElement("settings-tab-general", "button").className = "settings-tab";
  ensureElement("settings-tab-about", "button").className = "settings-tab";
  const panelGeneral = ensureElement("settings-panel-general", "div");
  panelGeneral.className = "settings-panel";
  panelGeneral.setAttribute("data-panel", "general");
  const panelAbout = ensureElement("settings-panel-about", "div");
  panelAbout.className = "settings-panel";
  panelAbout.setAttribute("data-panel", "about");
  ensureElement("settings-overlay", "div");
  ensureElement("licenses-overlay", "div");
  ensureElement("licenses-list", "div");
  ensureElement("selective-overlay", "div");
  ensureElement("command-preview-overlay", "div");
  ensureElement("setup-wizard-overlay", "div");

  (document.getElementById("settings-overlay") as HTMLElement).hidden = true;
  (document.getElementById("licenses-overlay") as HTMLElement).hidden = true;
  (document.getElementById("selective-overlay") as HTMLElement).hidden = true;
  (document.getElementById("command-preview-overlay") as HTMLElement).hidden =
    true;
  (document.getElementById("setup-wizard-overlay") as HTMLElement).hidden =
    true;
}

function setInvokeRouter(
  handler: (command: string, payload?: unknown) => unknown,
): void {
  invokeMock.mockImplementation((command, payload) => {
    try {
      return Promise.resolve(handler(command, payload));
    } catch (err) {
      return Promise.reject(err);
    }
  });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadMainModule(): Promise<void> {
  await import("../main");
  await flushAsync();
}

beforeEach(async () => {
  vi.resetModules();
  ensureMainDomElements();

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });

  mocks.runtime.mode = "add";
  mocks.runtime.workspaceMode = "basic";

  const settings = {
    ...SETTING_DEFAULTS,
    workspaceMode: "basic" as const,
    uiDensity: "comfortable" as const,
    autoCheckUpdates: true,
    lastMode: "add" as const,
    showActivityPanel: true,
    theme: "system" as const,
  };

  mocks.settings.loadSettingsWithMetadata.mockReset();
  mocks.settings.loadSettingsWithMetadata.mockResolvedValue({
    settings,
    extras: {},
    malformed: false,
    warning: undefined,
  });
  mocks.settings.readSettingsModal.mockReset();
  mocks.settings.readSettingsModal.mockReturnValue(settings);
  mocks.settings.applyTheme.mockReset();
  mocks.settings.applySettingsToForm.mockReset();
  mocks.settings.openSettingsModal.mockReset();
  mocks.settings.closeSettingsModal.mockReset();
  mocks.settings.populateSettingsModal.mockReset();
  mocks.settings.syncSettingsSecurityControlsForFormat.mockReset();

  mocks.ui.log.mockReset();
  mocks.ui.devLog.mockReset();
  mocks.ui.toggleActivity.mockReset();
  mocks.ui.renderInputs.mockReset();
  mocks.ui.setMode.mockClear();
  mocks.ui.setActivityPanelVisible.mockReset();
  mocks.ui.setWorkspaceMode.mockClear();
  mocks.ui.getWorkspaceMode.mockClear();
  mocks.ui.setUiDensity.mockReset();
  mocks.ui.getMode.mockClear();
  mocks.ui.setBrowsePasswordFieldVisible.mockReset();
  mocks.ui.persistSettingsImmediately.mockReset();
  mocks.ui.persistSettingsImmediately.mockResolvedValue(undefined);

  mocks.archive.runAction.mockReset();
  mocks.archive.runAction.mockResolvedValue(undefined);
  mocks.archive.cancelAction.mockReset();
  mocks.archive.testArchive.mockReset();
  mocks.archive.testArchive.mockResolvedValue("passed");
  mocks.archive.browseArchive.mockReset();
  mocks.archive.browseArchive.mockResolvedValue(null);
  mocks.archive.previewCommand.mockReset();
  mocks.archive.copyCommandPreview.mockReset();
  mocks.archive.closeCommandPreviewModal.mockReset();
  mocks.archive.openSelectiveExtractModal.mockReset();
  mocks.archive.closeSelectiveExtractModal.mockReset();
  mocks.archive.setSelectiveExtractSearch.mockReset();
  mocks.archive.selectAllVisibleInPicker.mockReset();
  mocks.archive.clearPickerSelection.mockReset();
  mocks.archive.runSelectiveExtractFromModal.mockReset();
  mocks.archive.syncSelectiveDestinationAfterBrowseChoice.mockReset();
  mocks.archive.syncDestinationWhilePickerOpen.mockReset();

  mocks.archiveRules.validateArchivePaths.mockReset();
  mocks.archiveRules.validateArchivePaths.mockResolvedValue([]);

  mocks.presets.updateCompressionOptionsForFormat.mockReset();
  mocks.presets.applyPreset.mockReset();
  mocks.presets.onCompressionOptionChange.mockReset();

  mocks.updater.checkUpdates.mockReset();
  mocks.updater.autoCheckUpdates.mockReset();

  mocks.licenses.openLicensesModal.mockReset();
  mocks.licenses.closeLicensesModal.mockReset();

  mocks.files.chooseOutput.mockReset();
  mocks.files.chooseExtract.mockReset();
  mocks.files.addFiles.mockReset();
  mocks.files.addFolder.mockReset();

  mocks.quickActions.wireQuickActionEvents.mockReset();
  mocks.quickActions.refreshQuickActionRepeatState.mockReset();

  mocks.setupWizard.shouldShowSetupWizard.mockReset();
  mocks.setupWizard.shouldShowSetupWizard.mockReturnValue(false);
  mocks.setupWizard.showSetupWizard.mockReset();
  mocks.setupWizard.showSetupWizard.mockResolvedValue(null);
  mocks.setupWizard.markSetupComplete.mockReset();
  mocks.setupWizard.markSetupComplete.mockResolvedValue(undefined);

  mocks.extractPath.deriveOutputArchivePath.mockReset();
  mocks.extractPath.deriveOutputArchivePath.mockReturnValue("/tmp/out.7z");
  mocks.extractPath.resolveOutputArchiveAutofill.mockReset();
  mocks.extractPath.resolveOutputArchiveAutofill.mockReturnValue(null);

  mocks.basicUi.initBasicWorkspace.mockReset();
  mocks.basicUi.setBasicView.mockReset();
  mocks.basicUi.handleBasicDragDrop.mockReset();
  mocks.basicUi.syncBasicBeforeRun.mockReset();

  askMock.mockReset();
  askMock.mockResolvedValue(false);
  messageMock.mockReset();
  messageMock.mockResolvedValue("Ok");

  getVersionMock.mockReset();
  getVersionMock.mockResolvedValue("1.2.3");

  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});

  dragDropHandler = null;
  getCurrentWebviewWindowMock.mockReset();
  getCurrentWebviewWindowMock.mockReturnValue({
    onDragDropEvent: vi.fn().mockImplementation(async (handler) => {
      dragDropHandler = handler;
      return () => {};
    }),
  } as never);

  setInvokeRouter((command) => {
    if (command === "probe_7z") return undefined;
    if (command === "get_cpu_count") return 8;
    if (command === "get_log_dir") return "/tmp/logs";
    if (command === "get_platform_info") return "linux";
    if (command === "is_packaged") return true;
    if (command === "is_flatpak") return false;
    if (command === "get_initial_mode") return "";
    if (command === "get_initial_paths") return [];
    if (command === "drain_pending_paths") return [];
    if (command === "export_logs") return true;
    if (command === "open_log_dir") return undefined;
    if (command === "clear_logs") return undefined;
    return undefined;
  });
});

describe("main bootstrap", () => {
  it("initializes app and auto-browses a launch archive in basic workspace", async () => {
    mocks.archiveRules.validateArchivePaths.mockResolvedValue([
      { path: "/tmp/launch.7z", valid: true },
    ]);
    setInvokeRouter((command) => {
      if (command === "probe_7z") return undefined;
      if (command === "get_cpu_count") return 12;
      if (command === "get_log_dir") return "/tmp/logs";
      if (command === "get_platform_info") return "linux";
      if (command === "is_packaged") return true;
      if (command === "is_flatpak") return false;
      if (command === "get_initial_mode") return "browse";
      if (command === "get_initial_paths") return ["/tmp/launch.7z"];
      if (command === "drain_pending_paths") return [];
      return undefined;
    });

    await loadMainModule();

    expect(document.body.textContent ?? "").not.toContain("Failed to start:");

    expect(mocks.settings.applyTheme).toHaveBeenCalledWith("system");
    expect(mocks.ui.setWorkspaceMode).toHaveBeenCalledWith("basic", {
      persist: false,
    });
    expect(mocks.basicUi.initBasicWorkspace).toHaveBeenCalled();
    expect(mocks.quickActions.wireQuickActionEvents).toHaveBeenCalled();
    expect(mocks.basicUi.setBasicView).toHaveBeenCalledWith("browse");
    expect(mocks.archive.browseArchive).toHaveBeenCalled();
    expect(mocks.updater.autoCheckUpdates).toHaveBeenCalled();
    expect(
      (document.getElementById("s-version-label") as HTMLElement).textContent,
    ).toBe("v1.2.3");
    expect(document.body.classList.contains("platform-linux")).toBe(true);
  });

  it("shows startup failure details when runtime probe fails", async () => {
    setInvokeRouter((command) => {
      if (command === "probe_7z") {
        throw new Error("missing sidecar");
      }
      return undefined;
    });

    await loadMainModule();

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("runtime check failed"),
      expect.objectContaining({
        title: "Missing runtime dependency",
        kind: "error",
      }),
    );
    expect(document.body.textContent ?? "").toContain(
      "Failed to start: missing sidecar",
    );
  });

  it("handles keyboard shortcuts for browse, run, and escape overlays", async () => {
    await loadMainModule();

    mocks.runtime.mode = "browse";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }),
    );
    await flushAsync();

    expect(mocks.basicUi.syncBasicBeforeRun).toHaveBeenCalled();
    expect(mocks.archive.browseArchive).toHaveBeenCalled();

    mocks.runtime.mode = "add";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true }),
    );
    await flushAsync();

    expect(mocks.archive.runAction).toHaveBeenCalled();

    const settingsOverlay = document.getElementById(
      "settings-overlay",
    ) as HTMLElement;
    settingsOverlay.hidden = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mocks.settings.closeSettingsModal).toHaveBeenCalled();

    settingsOverlay.hidden = true;
    const selectiveOverlay = document.getElementById(
      "selective-overlay",
    ) as HTMLElement;
    selectiveOverlay.hidden = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mocks.archive.closeSelectiveExtractModal).toHaveBeenCalled();

    selectiveOverlay.hidden = true;
    const commandOverlay = document.getElementById(
      "command-preview-overlay",
    ) as HTMLElement;
    commandOverlay.hidden = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mocks.archive.closeCommandPreviewModal).toHaveBeenCalled();

    commandOverlay.hidden = true;
    const licensesOverlay = document.getElementById(
      "licenses-overlay",
    ) as HTMLElement;
    licensesOverlay.hidden = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mocks.licenses.closeLicensesModal).toHaveBeenCalled();
  });

  it("routes drag-drop events in both basic and power workspace modes", async () => {
    await loadMainModule();

    expect(dragDropHandler).not.toBeNull();

    mocks.runtime.workspaceMode = "basic";
    await dragDropHandler?.({
      payload: { type: "drop", paths: ["/tmp/basic.7z"] },
    });
    expect(mocks.basicUi.handleBasicDragDrop).toHaveBeenCalledWith("drop", [
      "/tmp/basic.7z",
    ]);

    mocks.runtime.workspaceMode = "power";
    mocks.runtime.mode = "browse";
    mocks.archiveRules.validateArchivePaths.mockResolvedValue([
      { path: "/tmp/new.7z", valid: true },
    ]);
    const { state } = await import("../state");
    state.inputs = [];

    await dragDropHandler?.({ payload: { type: "enter", paths: [] } });
    expect(
      document
        .getElementById("input-list")
        ?.classList.contains("list--dragover"),
    ).toBe(true);

    await dragDropHandler?.({ payload: { type: "leave", paths: [] } });
    expect(
      document
        .getElementById("input-list")
        ?.classList.contains("list--dragover"),
    ).toBe(false);

    await dragDropHandler?.({
      payload: { type: "drop", paths: ["/tmp/new.7z"] },
    });
    await flushAsync();

    expect(mocks.ui.setBrowsePasswordFieldVisible).toHaveBeenCalledWith(false);
    expect(mocks.ui.renderInputs).toHaveBeenCalled();
    expect(mocks.archive.browseArchive).toHaveBeenCalled();
  });

  it("executes diagnostics toolbar actions and reports errors", async () => {
    await loadMainModule();

    (document.getElementById("export-logs") as HTMLButtonElement).click();
    await flushAsync();
    expect(messageMock).toHaveBeenCalledWith("Logs exported successfully.", {
      title: "Logs exported",
    });

    askMock.mockResolvedValueOnce(true);
    (document.getElementById("clear-logs") as HTMLButtonElement).click();
    await flushAsync();
    expect(invokeMock).toHaveBeenCalledWith("clear_logs");

    setInvokeRouter((command) => {
      if (command === "open_log_dir") {
        throw new Error("permission denied");
      }
      if (command === "clear_logs") return undefined;
      return undefined;
    });
    (document.getElementById("open-logs-folder") as HTMLButtonElement).click();
    await flushAsync();

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to open logs folder."),
      expect.objectContaining({ title: "Open folder failed", kind: "error" }),
    );
  });

  it("wires command/selective controls and overlay click handlers", async () => {
    await loadMainModule();

    const { state } = await import("../state");
    state.inputs = ["/tmp/a.txt", "/tmp/b.txt"];
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/out.7z";
    (document.getElementById("archive-name") as HTMLInputElement).value =
      "bundle";

    (document.getElementById("show-command") as HTMLButtonElement).click();
    expect(mocks.archive.previewCommand).toHaveBeenCalledWith(
      document.getElementById("show-command"),
    );

    (document.getElementById("extract-preview") as HTMLButtonElement).click();
    expect(mocks.archive.previewCommand).toHaveBeenCalledWith(
      document.getElementById("extract-preview"),
    );

    (
      document.getElementById("copy-command-preview") as HTMLButtonElement
    ).click();
    expect(mocks.archive.copyCommandPreview).toHaveBeenCalled();

    (document.getElementById("command-preview-overlay") as HTMLElement).click();
    expect(mocks.archive.closeCommandPreviewModal).toHaveBeenCalled();

    (document.getElementById("browse-extract") as HTMLButtonElement).click();
    expect(mocks.ui.setMode).toHaveBeenCalledWith("extract");

    (document.getElementById("browse-selective") as HTMLButtonElement).click();
    await flushAsync();
    expect(mocks.archive.openSelectiveExtractModal).toHaveBeenCalled();

    const selectiveSearch = document.getElementById(
      "selective-search",
    ) as HTMLInputElement;
    selectiveSearch.value = "docs";
    selectiveSearch.dispatchEvent(new Event("input", { bubbles: true }));
    expect(mocks.archive.setSelectiveExtractSearch).toHaveBeenCalledWith(
      "docs",
    );

    (document.getElementById("selective-confirm") as HTMLButtonElement).click();
    await flushAsync();
    expect(mocks.archive.runSelectiveExtractFromModal).toHaveBeenCalled();

    (
      document.getElementById("selective-browse-dest") as HTMLButtonElement
    ).click();
    await flushAsync();
    expect(mocks.files.chooseExtract).toHaveBeenCalled();
    expect(
      mocks.archive.syncSelectiveDestinationAfterBrowseChoice,
    ).toHaveBeenCalled();

    const selectiveDest = document.getElementById(
      "selective-dest",
    ) as HTMLInputElement;
    selectiveDest.value = "/tmp/selective";
    selectiveDest.dispatchEvent(new Event("input", { bubbles: true }));
    expect(mocks.archive.syncDestinationWhilePickerOpen).toHaveBeenCalledWith(
      "/tmp/selective",
    );

    (document.getElementById("selective-overlay") as HTMLElement).click();
    expect(mocks.archive.closeSelectiveExtractModal).toHaveBeenCalled();

    (document.getElementById("settings-overlay") as HTMLElement).click();
    expect(mocks.settings.closeSettingsModal).toHaveBeenCalled();

    (document.getElementById("licenses-overlay") as HTMLElement).click();
    expect(mocks.licenses.closeLicensesModal).toHaveBeenCalled();

    (document.getElementById("clear-log") as HTMLButtonElement).click();
    expect((document.getElementById("log") as HTMLElement).textContent).toBe(
      "",
    );

    (document.getElementById("clear-inputs") as HTMLButtonElement).click();
    expect(state.inputs).toEqual([]);
    expect(
      (document.getElementById("output-path") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (document.getElementById("archive-name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("wires form controls and settings save success/failure paths", async () => {
    await loadMainModule();

    const { state } = await import("../state");
    state.inputs = ["/tmp/input.txt"];

    (document.getElementById("preset") as HTMLSelectElement).value = "ultra";
    (document.getElementById("preset") as HTMLSelectElement).dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    expect(mocks.presets.applyPreset).toHaveBeenCalledWith("ultra");

    (document.getElementById("s-format") as HTMLSelectElement).value = "tar";
    (document.getElementById("s-format") as HTMLSelectElement).dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    expect(
      mocks.settings.syncSettingsSecurityControlsForFormat,
    ).toHaveBeenCalledWith("tar");

    state.lastAutoOutputPath = "/tmp/auto.7z";
    const outputPath = document.getElementById(
      "output-path",
    ) as HTMLInputElement;
    outputPath.value = "/tmp/custom.7z";
    outputPath.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.lastAutoOutputPath).toBeNull();

    (document.getElementById("archive-name") as HTMLInputElement).value =
      "bundle";
    (document.getElementById("archive-name") as HTMLInputElement).dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    expect(mocks.extractPath.deriveOutputArchivePath).toHaveBeenCalled();
    expect(outputPath.value).toBe("/tmp/out.7z");

    (document.getElementById("format") as HTMLSelectElement).value = "zip";
    (document.getElementById("format") as HTMLSelectElement).dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    expect(
      mocks.presets.updateCompressionOptionsForFormat,
    ).toHaveBeenCalledWith("zip");
    expect(mocks.presets.onCompressionOptionChange).toHaveBeenCalled();

    const browsePassword = document.getElementById(
      "browse-password",
    ) as HTMLInputElement;
    const browseToggle = document.getElementById(
      "toggle-browse-password",
    ) as HTMLButtonElement;
    browsePassword.type = "password";
    browseToggle.click();
    expect(browsePassword.type).toBe("text");
    browseToggle.click();
    expect(browsePassword.type).toBe("password");

    const password = document.getElementById("password") as HTMLInputElement;
    const passwordToggle = document.getElementById(
      "toggle-password",
    ) as HTMLButtonElement;
    password.type = "password";
    passwordToggle.click();
    expect(password.type).toBe("text");
    passwordToggle.click();
    expect(password.type).toBe("password");

    const extractPassword = document.getElementById(
      "extract-password",
    ) as HTMLInputElement;
    const extractToggle = document.getElementById(
      "toggle-extract-password",
    ) as HTMLButtonElement;
    extractPassword.type = "password";
    extractToggle.click();
    expect(extractPassword.type).toBe("text");
    extractToggle.click();
    expect(extractPassword.type).toBe("password");

    state.lastAutoExtractDestination = "/tmp/auto";
    const extractPath = document.getElementById(
      "extract-path",
    ) as HTMLInputElement;
    extractPath.value = "/tmp/manual";
    extractPath.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.lastAutoExtractDestination).toBeNull();

    const savedSettings = {
      ...SETTING_DEFAULTS,
      workspaceMode: "power" as const,
      theme: "dark" as const,
      uiDensity: "compact" as const,
    };
    mocks.settings.readSettingsModal.mockReturnValueOnce(savedSettings);
    (document.getElementById("save-settings") as HTMLButtonElement).click();
    await flushAsync();
    expect(mocks.ui.persistSettingsImmediately).toHaveBeenCalled();
    expect(mocks.settings.closeSettingsModal).toHaveBeenCalled();

    mocks.settings.readSettingsModal.mockReturnValueOnce({
      ...savedSettings,
      theme: "light",
    });
    mocks.ui.persistSettingsImmediately.mockRejectedValueOnce(
      new Error("disk full"),
    );
    (document.getElementById("save-settings") as HTMLButtonElement).click();
    await flushAsync();
    expect(mocks.settings.populateSettingsModal).toHaveBeenCalled();
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save settings."),
      expect.objectContaining({ title: "Settings error", kind: "error" }),
    );
  });

  it("runs setup wizard path when required and handles setup failures", async () => {
    mocks.setupWizard.shouldShowSetupWizard.mockReturnValue(true);
    mocks.setupWizard.showSetupWizard.mockResolvedValueOnce({
      workspaceMode: "power",
      theme: "dark",
      autoCheckUpdates: false,
      updateChannel: "beta",
    });

    await loadMainModule();

    expect(mocks.setupWizard.showSetupWizard).toHaveBeenCalled();
    expect(mocks.setupWizard.markSetupComplete).toHaveBeenCalled();
    expect(mocks.ui.setWorkspaceMode).toHaveBeenCalledWith("power", {
      persist: false,
    });

    vi.resetModules();
    ensureMainDomElements();
    mocks.setupWizard.shouldShowSetupWizard.mockReturnValue(true);
    mocks.setupWizard.showSetupWizard.mockRejectedValueOnce(
      new Error("wizard crash"),
    );

    await loadMainModule();

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("Setup wizard could not be completed."),
      expect.objectContaining({ title: "Setup wizard error", kind: "error" }),
    );
    expect(document.body.textContent ?? "").toContain(
      "Failed to start: wizard crash",
    );
  });

  it("processes pending path batches into extract mode for multi-archive drops", async () => {
    mocks.archiveRules.validateArchivePaths.mockResolvedValue([
      { path: "/tmp/a.7z", valid: true },
      { path: "/tmp/b.7z", valid: true },
    ]);

    let drainCalls = 0;
    setInvokeRouter((command) => {
      if (command === "probe_7z") return undefined;
      if (command === "get_cpu_count") return 8;
      if (command === "get_log_dir") return "/tmp/logs";
      if (command === "get_platform_info") return "linux";
      if (command === "is_packaged") return true;
      if (command === "is_flatpak") return false;
      if (command === "get_initial_mode") return "";
      if (command === "get_initial_paths") return [];
      if (command === "drain_pending_paths") {
        drainCalls += 1;
        if (drainCalls === 1) {
          return [
            {
              paths: ["/tmp/a.7z", "/tmp/b.7z"],
              mode: "browse",
            },
          ];
        }
        return [];
      }
      return undefined;
    });

    await loadMainModule();

    expect(drainCalls).toBeGreaterThanOrEqual(1);
    expect(mocks.ui.setMode).toHaveBeenCalledWith("extract");
    expect(mocks.basicUi.setBasicView).toHaveBeenCalledWith("extract");
    expect(mocks.ui.renderInputs).toHaveBeenCalled();
  });
});
