import { ask, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relaunch } from "@tauri-apps/plugin-process";
import { showToast } from "./toast";
import {
  createIcons,
  Settings,
  Heart,
  FolderOpen,
  Folder,
  Package,
  File,
  ArrowLeft,
  Eye,
  ArchiveRestore,
  Trash2,
  FilePlus,
  FolderPlus,
  Check,
  AlertTriangle,
  Sliders,
  Monitor,
  Info,
  RotateCcw,
} from "lucide";

export function refreshIcons() {
  createIcons({
    icons: {
      Settings,
      Heart,
      FolderOpen,
      Folder,
      Package,
      File,
      ArrowLeft,
      Eye,
      ArchiveRestore,
      Trash2,
      FilePlus,
      FolderPlus,
      Check,
      AlertTriangle,
      Sliders,
      Monitor,
      Info,
      RotateCcw,
    },
    attrs: {
      "aria-hidden": "true",
    },
  });
}

import { $, trapFocus, releaseFocusTrap } from "./utils";
import { promptInput } from "./prompt-modal";
import { SETTING_DEFAULTS, state, dom } from "./state";
import {
  applyTheme,
  loadSettingsWithMetadata,
  readSettingsModal,
  applySettingsToForm,
  openSettingsModal,
  closeSettingsModal,
  populateSettingsModal,
  syncSettingsSecurityControlsForFormat,
} from "./settings";
import {
  log,
  devLog,
  toggleActivity,
  renderInputs,
  setMode,
  setActivityPanelVisible,
  setWorkspaceMode,
  getWorkspaceMode,
  setUiDensity,
  getMode,
  setBrowsePasswordFieldVisible,
  persistSettingsImmediately,
  setStatus,
  registerIconRefreshHook,
  resizeWorkspaceWindow,
  syncWorkspaceWindowFx,
} from "./ui";
import {
  runAction,
  cancelAction,
  testArchive,
  browseArchive,
  addFilesToArchive,
  convertArchive,
  previewCommand,
  copyCommandPreview,
  closeCommandPreviewModal,
  openSelectiveExtractModal,
  closeSelectiveExtractModal,
  setSelectiveExtractSearch,
  selectAllVisibleInPicker,
  clearPickerSelection,
  runSelectiveExtractFromModal,
  syncSelectiveDestinationAfterBrowseChoice,
  syncDestinationWhilePickerOpen,
} from "./archive";
import { validateArchivePaths } from "./archive-rules";
import {
  updateCompressionOptionsForFormat,
  applyPreset,
  onCompressionOptionChange,
  saveCustomPreset,
  deleteCustomPreset,
  refreshPresetDropdown,
} from "./presets";
import {
  checkUpdates,
  autoCheckUpdates,
  discardPendingUpdate,
} from "./updater";
import { openLicensesModal, closeLicensesModal } from "./licenses";
import { chooseOutput, chooseExtract, addFiles, addFolder } from "./files";
import {
  wireQuickActionEvents,
  refreshQuickActionRepeatState,
} from "./quick-actions";
import {
  shouldShowSetupWizard,
  showSetupWizard,
  markSetupComplete,
} from "./setup-wizard";
import {
  deriveOutputArchivePath,
  resolveOutputArchiveAutofill,
} from "./extract-path";
import {
  initBasicWorkspace,
  setBasicView,
  handleBasicDragDrop,
  syncBasicBeforeRun,
  syncBasicWorkspaceFromPower,
} from "./basic-ui";
import {
  refreshOsIntegrationStatus,
  wireOsIntegrationEvents,
} from "./os-integration";

let shortcutsTrigger: HTMLElement | null = null;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function openShortcutsModal(): void {
  shortcutsTrigger = document.activeElement as HTMLElement | null;
  const overlay = $("shortcuts-overlay");
  overlay.hidden = false;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) trapFocus(modal);
  $("close-shortcuts").focus();
}

function closeShortcutsModal(): void {
  const overlay = $("shortcuts-overlay");
  if (overlay.hidden) return;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
  overlay.hidden = true;
  shortcutsTrigger?.focus();
  shortcutsTrigger = null;
}

// Pull the overall rating from 7z benchmark output (the trailing "Tot:" line,
// whose last column is the combined compress/decompress rating in KiB/s-ish units).
export function parseBenchmarkSummary(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("Tot:")) {
      const nums = line.match(/\d+/g);
      if (nums && nums.length > 0) {
        return `Rating: ${nums[nums.length - 1]}`;
      }
    }
  }
  return null;
}

async function runBenchmark() {
  const button = $("run-benchmark") as HTMLButtonElement;
  const result = $("benchmark-result");
  button.disabled = true;
  result.textContent = "Running benchmark…";
  try {
    const res = await invoke<{ stdout: string; code: number }>("run_7z", {
      args: ["b"],
    });
    const summary = parseBenchmarkSummary(res.stdout);
    result.textContent = summary ?? "Benchmark finished (no rating reported).";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.textContent = `Benchmark failed: ${msg}`;
  } finally {
    button.disabled = false;
  }
}

async function exportLocalLogs() {
  try {
    const exported = await invoke<boolean>("export_logs");
    if (!exported) return;
    log("Logs exported successfully.");
    await message("Logs exported successfully.", {
      title: "Logs exported",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to export logs: ${msg}`, "error");
    await message(`Failed to export logs.\n\n${msg}`, {
      title: "Export failed",
      kind: "error",
    });
  }
}

async function openLogsFolder() {
  try {
    await invoke("open_log_dir");
    log("Opened local logs folder.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to open logs folder: ${msg}`, "error");
    await message(`Failed to open logs folder.\n\n${msg}`, {
      title: "Open folder failed",
      kind: "error",
    });
  }
}

async function clearLocalLogs() {
  const confirmed = await ask(
    "Clear local diagnostics logs? This cannot be undone.",
    {
      title: "Clear logs",
      kind: "warning",
      okLabel: "Clear logs",
      cancelLabel: "Cancel",
    },
  );
  if (!confirmed) return;

  try {
    await invoke("clear_logs");
    log("Local diagnostics logs cleared.");
    await message("Local diagnostics logs were cleared.", {
      title: "Logs cleared",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to clear logs: ${msg}`, "error");
    await message(`Failed to clear logs.\n\n${msg}`, {
      title: "Clear logs failed",
      kind: "error",
    });
  }
}

async function allPathsAreArchives(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  try {
    const results = await validateArchivePaths(paths);
    return (
      results.length === paths.length && results.every((result) => result.valid)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Archive probe failed for auto-detect: ${msg}`);
    return false;
  }
}

async function applyIncomingPaths(
  paths: string[],
  mode: string,
  source: string,
): Promise<void> {
  if (!paths.length) return;

  // Do not mutate the shared input model underneath an active job. Keeping
  // this promise pending also preserves file-open FIFO ordering.
  while (state.running) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }

  if (mode === "compress") {
    setMode("add");
    for (const path of paths) {
      if (!state.inputs.includes(path)) {
        state.inputs.push(path);
      }
    }
    renderInputs();
    devLog(`Received ${paths.length} path(s) from ${source}.`);
    if (getWorkspaceMode() === "basic") {
      setBasicView("compress");
    }
    return;
  }

  let allArchives: boolean;
  // Archive detection crosses the IPC boundary. An operation may start while
  // that await is pending, so re-check and retry before touching shared input.
  for (;;) {
    allArchives = await allPathsAreArchives(paths);
    if (!state.running) break;
    while (state.running) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
  }
  const shouldAutoBrowse =
    mode !== "extract" && paths.length === 1 && allArchives;
  const shouldAutoExtract =
    mode === "extract" ||
    (mode !== "extract" && paths.length > 1 && allArchives);
  if (shouldAutoExtract) {
    setMode("extract");
    state.inputs.length = 0;
  } else if (shouldAutoBrowse) {
    setMode("browse");
    state.inputs.length = 0;
  }

  for (const path of paths) {
    if (!state.inputs.includes(path)) {
      state.inputs.push(path);
    }
  }
  if (shouldAutoBrowse) {
    setBrowsePasswordFieldVisible(false);
  }
  renderInputs();
  devLog(`Received ${paths.length} path(s) from ${source}.`);

  if (getWorkspaceMode() === "basic") {
    if (shouldAutoExtract || shouldAutoBrowse) {
      setBasicView(shouldAutoBrowse ? "browse" : "extract");
    } else {
      setBasicView("compress");
    }
  }

  if (shouldAutoBrowse) {
    void browseArchive();
  }
}

async function runSetupWizardFlow(): Promise<void> {
  await resizeWorkspaceWindow("power");
  const result = await showSetupWizard();
  if (result) {
    state.currentSettings.workspaceMode = result.workspaceMode;
    state.currentSettings.theme = result.theme;
    state.currentSettings.autoCheckUpdates = result.autoCheckUpdates;
    state.currentSettings.updateChannel = result.updateChannel;
    if (typeof result.osIntegrationDismissed === "boolean") {
      state.currentSettings.osIntegrationDismissed =
        result.osIntegrationDismissed;
    }
  }

  await markSetupComplete();
  state.lastPersistedSettings = { ...state.currentSettings };

  applyTheme(state.currentSettings.theme);
  setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
  setUiDensity(state.currentSettings.uiDensity, { persist: false });
  applySettingsToForm();
  updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
  onCompressionOptionChange();
}

function resetRuntimeStateForFirstRun(): void {
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.lastPersistedSettings = { ...SETTING_DEFAULTS };
  state.settingsExtras = {};
  state.inputs = [];
  state.lastAutoExtractDestination = null;
  state.lastAutoOutputPath = null;
  state.browseArchiveInfoByPath.clear();
  state.browseSelectionsByArchive.clear();
  state.selectiveSearchQuery = "";
  state.selectiveActiveArchive = null;
  state.selectiveVisiblePaths = [];
  state.selectiveExpandedFolders.clear();
  state.inputValidationByPath.clear();
  state.inputValidationRequestId += 1;
  state.lastInputsSignature = "";
  state.lastQuickActionByMode = {};
  dom.logEl.textContent = "";
}

let eventsWired = false;

function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;
  // Sync the output-path field when format changes so the extension updates
  // automatically even if inputs were already present.
  function syncOutputPath(): void {
    const outputPathInput = document.getElementById(
      "output-path",
    ) as HTMLInputElement | null;
    const archiveNameInput = document.getElementById(
      "archive-name",
    ) as HTMLInputElement | null;
    if (!outputPathInput) return;
    const format = $<HTMLSelectElement>("format").value;
    const trimmedName = archiveNameInput?.value.trim();
    const customName =
      trimmedName && trimmedName.length > 0 ? trimmedName : undefined;
    const next = resolveOutputArchiveAutofill(
      outputPathInput.value,
      state.lastAutoOutputPath,
      state.inputs,
      format,
      customName,
    );
    if (next) {
      outputPathInput.value = next;
      state.lastAutoOutputPath = next;
    }
  }

  $("add-files").addEventListener("click", addFiles);
  $("add-folder").addEventListener("click", addFolder);
  $("clear-inputs").addEventListener("click", () => {
    state.inputs.length = 0;
    state.lastAutoOutputPath = null;
    renderInputs();
    $<HTMLInputElement>("output-path").value = "";
    $<HTMLInputElement>("archive-name").value = "";
    const bc = document.getElementById("browse-contents");
    if (bc) bc.hidden = true;
  });
  $("choose-output").addEventListener("click", chooseOutput);
  $("choose-extract").addEventListener("click", chooseExtract);
  $("run-action").addEventListener("click", runAction);
  $("cancel-action").addEventListener("click", cancelAction);
  $("show-command").addEventListener(
    "click",
    (e) => void previewCommand(e.currentTarget as HTMLElement),
  );
  $("clear-log").addEventListener("click", () => (dom.logEl.textContent = ""));

  $("extract-run").addEventListener("click", runAction);
  $("extract-cancel").addEventListener("click", cancelAction);
  $("extract-preview").addEventListener(
    "click",
    (e) => void previewCommand(e.currentTarget as HTMLElement),
  );

  $("copy-command-preview").addEventListener("click", () => {
    void copyCommandPreview();
  });
  $("close-command-preview").addEventListener(
    "click",
    closeCommandPreviewModal,
  );
  $("close-command-preview-footer").addEventListener(
    "click",
    closeCommandPreviewModal,
  );
  $("command-preview-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCommandPreviewModal();
  });

  $("close-shortcuts").addEventListener("click", closeShortcutsModal);
  $("close-shortcuts-footer").addEventListener("click", closeShortcutsModal);
  $("shortcuts-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeShortcutsModal();
  });

  $("test-integrity").addEventListener("click", testArchive);

  $("browse-list").addEventListener("click", browseArchive);
  $("browse-test").addEventListener("click", testArchive);
  $("browse-extract").addEventListener("click", () => setMode("extract"));
  $("browse-selective").addEventListener("click", () => {
    void openSelectiveExtractModal();
  });
  $("browse-add-files").addEventListener("click", () => {
    void addFilesToArchive();
  });
  $("browse-convert").addEventListener("click", () => {
    void convertArchive();
  });

  $("close-selective").addEventListener("click", closeSelectiveExtractModal);
  $("selective-cancel").addEventListener("click", closeSelectiveExtractModal);
  $("selective-search").addEventListener("input", () => {
    setSelectiveExtractSearch($<HTMLInputElement>("selective-search").value);
  });
  $("selective-select-all").addEventListener("click", selectAllVisibleInPicker);
  $("selective-clear").addEventListener("click", clearPickerSelection);
  $("selective-confirm").addEventListener("click", () => {
    void runSelectiveExtractFromModal();
  });
  $("selective-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSelectiveExtractModal();
  });
  $("selective-browse-dest").addEventListener("click", async () => {
    await chooseExtract();
    syncSelectiveDestinationAfterBrowseChoice();
  });
  $("selective-dest").addEventListener("input", () => {
    syncDestinationWhilePickerOpen($<HTMLInputElement>("selective-dest").value);
  });

  const browsePasswordToggle = $<HTMLButtonElement>("toggle-browse-password");
  if (!browsePasswordToggle.dataset.zinniaWired) {
    browsePasswordToggle.dataset.zinniaWired = "true";
    browsePasswordToggle.addEventListener("click", () => {
      const input = $<HTMLInputElement>("browse-password");
      const btn = $<HTMLButtonElement>("toggle-browse-password");
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "Hide";
        btn.setAttribute("aria-pressed", "true");
      } else {
        input.type = "password";
        btn.textContent = "Show";
        btn.setAttribute("aria-pressed", "false");
      }
    });
  }

  const updateDeletePresetButton = () => {
    const isCustom = $<HTMLSelectElement>("preset").value.startsWith("custom:");
    $("delete-preset").hidden = !isCustom;
  };

  refreshPresetDropdown();
  updateDeletePresetButton();

  $<HTMLSelectElement>("preset").addEventListener("change", () => {
    applyPreset($<HTMLSelectElement>("preset").value);
    updateDeletePresetButton();
  });

  $("save-preset").addEventListener("click", () => {
    void (async () => {
      const raw = await promptInput({
        title: "Save preset",
        label: "Name this preset:",
        placeholder: "e.g. My backup",
        confirmLabel: "Save",
      });
      const name = raw?.trim();
      if (!name) return;
      try {
        saveCustomPreset(name);
        refreshPresetDropdown(`custom:${name}`);
        updateDeletePresetButton();
        void persistSettingsImmediately(
          state.currentSettings,
          state.settingsExtras,
        );
        setStatus(`Preset "${name}" saved`, 2000);
      } catch (err) {
        setStatus(
          "Error",
          3000,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  });

  $("delete-preset").addEventListener("click", () => {
    const value = $<HTMLSelectElement>("preset").value;
    if (!value.startsWith("custom:")) return;
    const name = value.slice("custom:".length);
    deleteCustomPreset(name);
    refreshPresetDropdown("custom");
    updateDeletePresetButton();
    void persistSettingsImmediately(
      state.currentSettings,
      state.settingsExtras,
    );
    setStatus(`Preset "${name}" deleted`, 2000);
  });

  $<HTMLSelectElement>("s-format").addEventListener("change", () => {
    syncSettingsSecurityControlsForFormat(
      $<HTMLSelectElement>("s-format")
        .value as typeof state.currentSettings.format,
    );
  });

  $("output-path").addEventListener("input", () => {
    const value = $<HTMLInputElement>("output-path").value.trim();
    if (value !== (state.lastAutoOutputPath ?? "").trim()) {
      state.lastAutoOutputPath = null;
    }
  });

  $("archive-name").addEventListener("input", () => {
    // Archive name field always drives the output path (force-update).
    const outputPathInput = $<HTMLInputElement>("output-path");
    const archiveNameInput = $<HTMLInputElement>("archive-name");
    const format = $<HTMLSelectElement>("format").value;
    const customName = archiveNameInput.value.trim() || undefined;
    const next = deriveOutputArchivePath(state.inputs, format, customName);
    if (next) {
      outputPathInput.value = next;
      state.lastAutoOutputPath = next;
    }
  });

  $<HTMLSelectElement>("format").addEventListener("change", () => {
    updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
    onCompressionOptionChange();
    syncOutputPath();
  });

  for (const id of ["level", "method", "dict", "word-size", "solid"]) {
    $(id).addEventListener("change", onCompressionOptionChange);
  }

  $<HTMLSelectElement>("split-size").addEventListener("change", () => {
    const isCustom = $<HTMLSelectElement>("split-size").value === "custom";
    $("split-custom-field").hidden = !isCustom;
    if (isCustom) $<HTMLInputElement>("split-custom").focus();
  });

  const passwordToggle = $<HTMLButtonElement>("toggle-password");
  if (!passwordToggle.dataset.zinniaWired) {
    passwordToggle.dataset.zinniaWired = "true";
    passwordToggle.addEventListener("click", () => {
      const input = $<HTMLInputElement>("password");
      const btn = $<HTMLButtonElement>("toggle-password");
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "Hide";
        btn.setAttribute("aria-pressed", "true");
      } else {
        input.type = "password";
        btn.textContent = "Show";
        btn.setAttribute("aria-pressed", "false");
      }
    });
  }

  const extractPasswordToggle = $<HTMLButtonElement>("toggle-extract-password");
  if (!extractPasswordToggle.dataset.zinniaWired) {
    extractPasswordToggle.dataset.zinniaWired = "true";
    extractPasswordToggle.addEventListener("click", () => {
      const input = $<HTMLInputElement>("extract-password");
      const btn = $<HTMLButtonElement>("toggle-extract-password");
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "Hide";
        btn.setAttribute("aria-pressed", "true");
      } else {
        input.type = "password";
        btn.textContent = "Show";
        btn.setAttribute("aria-pressed", "false");
      }
    });
  }

  $("extract-path").addEventListener("input", () => {
    const value = $<HTMLInputElement>("extract-path").value.trim();
    if (value && value !== state.lastAutoExtractDestination) {
      state.lastAutoExtractDestination = null;
    }
  });

  $("toggle-activity").addEventListener("click", toggleActivity);
  document
    .querySelectorAll<HTMLButtonElement>("[data-workspace-mode-btn]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode =
          btn.dataset.workspaceModeBtn === "power" ? "power" : "basic";
        if (mode === "power") {
          syncBasicBeforeRun();
        }
        setWorkspaceMode(mode);
        if (mode === "basic") {
          syncBasicWorkspaceFromPower();
          setBasicView("home");
        }
        refreshQuickActionRepeatState();
      });
    });
  $("toggle-density").addEventListener("click", () => {
    const nextDensity =
      state.currentSettings.uiDensity === "compact" ? "comfortable" : "compact";
    setUiDensity(nextDensity);
  });
  document.addEventListener("zinnia:mode-changed", () => {
    refreshQuickActionRepeatState();
  });

  $("open-settings").addEventListener("click", openSettingsModal);
  $("close-settings").addEventListener("click", closeSettingsModal);
  $("cancel-settings").addEventListener("click", closeSettingsModal);
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettingsModal();
  });
  $("save-settings").addEventListener("click", async () => {
    const previous = { ...state.lastPersistedSettings };
    state.currentSettings = readSettingsModal();
    if (state.currentSettings.updateChannel !== previous.updateChannel) {
      discardPendingUpdate();
    }
    applyTheme(state.currentSettings.theme);
    setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
    void syncWorkspaceWindowFx();
    if (
      state.currentSettings.workspaceMode === "basic" &&
      previous.workspaceMode !== "basic"
    ) {
      setBasicView("home");
    }
    setUiDensity(state.currentSettings.uiDensity, { persist: false });
    applySettingsToForm();
    updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
    onCompressionOptionChange();
    try {
      await persistSettingsImmediately(
        state.currentSettings,
        state.settingsExtras,
      );
      log("Settings saved successfully.");
      closeSettingsModal();
    } catch (err) {
      state.currentSettings = previous;
      applyTheme(state.currentSettings.theme);
      setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
      setUiDensity(state.currentSettings.uiDensity, { persist: false });
      applySettingsToForm();
      populateSettingsModal();
      updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
      onCompressionOptionChange();

      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to save settings: ${msg}`, "error");
      await message(`Failed to save settings.\n\n${msg}`, {
        title: "Settings error",
        kind: "error",
      });
    }
  });
  $("rerun-setup-wizard").addEventListener("click", async () => {
    closeSettingsModal();
    try {
      await runSetupWizardFlow();
      renderInputs();
      refreshQuickActionRepeatState();
      log("Setup wizard completed.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Setup wizard failed: ${msg}`, "error");
      await message(`Failed to run setup wizard.\n\n${msg}`, {
        title: "Setup wizard error",
        kind: "error",
      });
    }
  });

  $("reset-settings").addEventListener("click", async () => {
    const confirmed = await ask(
      "Are you sure you want to reset all settings to default and restart Zinnia?",
      {
        title: "Reset Settings",
        kind: "warning",
        okLabel: "Reset & Restart",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) return;

    try {
      discardPendingUpdate();
      await invoke("reset_settings");
      await invoke("clear_logs").catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to clear logs during reset: ${msg}`);
      });
      resetRuntimeStateForFirstRun();
      await relaunch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to reset settings: ${msg}`, "error");
      await message(`Failed to reset settings.\n\n${msg}`, {
        title: "Reset settings error",
        kind: "error",
      });
    }
  });

  const settingsTabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".settings-tab"),
  );
  settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      settingsTabs.forEach((t) => {
        t.classList.remove("is-active");
        t.setAttribute("aria-selected", "false");
        t.setAttribute("tabindex", "-1");
      });
      document
        .querySelectorAll(".settings-panel")
        .forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      tab.setAttribute("aria-selected", "true");
      tab.setAttribute("tabindex", "0");
      const panel = document.querySelector(`[data-panel="${tab.dataset.tab}"]`);
      if (panel) panel.classList.add("is-active");
    });

    tab.addEventListener("keydown", (e) => {
      const idx = settingsTabs.indexOf(tab);
      let next: HTMLButtonElement | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        next = settingsTabs[(idx + 1) % settingsTabs.length];
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        next =
          settingsTabs[(idx - 1 + settingsTabs.length) % settingsTabs.length];
      } else if (e.key === "Home") {
        next = settingsTabs[0];
      } else if (e.key === "End") {
        next = settingsTabs[settingsTabs.length - 1];
      }
      if (next) {
        e.preventDefault();
        next.focus();
        next.click();
      }
    });
  });

  $("check-updates").addEventListener("click", checkUpdates);
  $("export-logs").addEventListener("click", exportLocalLogs);
  $("open-logs-folder").addEventListener("click", openLogsFolder);
  $("clear-logs").addEventListener("click", clearLocalLogs);
  $("run-benchmark").addEventListener("click", runBenchmark);
  $("show-licenses").addEventListener("click", (e) =>
    openLicensesModal(e.currentTarget as HTMLElement),
  );
  $("about-show-licenses").addEventListener("click", (e) =>
    openLicensesModal(e.currentTarget as HTMLElement),
  );
  wireOsIntegrationEvents();

  $("close-licenses").addEventListener("click", closeLicensesModal);
  $("licenses-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeLicensesModal();
  });

  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = (btn as HTMLButtonElement).dataset.modeBtn;
      if (m === "extract") setMode("extract");
      else if (m === "browse") setMode("browse");
      else setMode("add");
      refreshQuickActionRepeatState();
    });
  });

  wireQuickActionEvents();

  document.addEventListener("keydown", (e) => {
    if (!$("setup-wizard-overlay").hidden) {
      if (e.key === "Escape") {
        e.preventDefault();
      }
      return;
    }
    if (!$("input-modal-overlay").hidden) {
      if (e.key === "Escape") {
        return;
      }
      if (
        e.key === "?" ||
        (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
        (e.key === "," && (e.ctrlKey || e.metaKey))
      ) {
        return;
      }
    }
    if (e.key === "," && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if ($("settings-overlay").hidden) {
        openSettingsModal();
      }
      return;
    }
    if (e.key === "Escape") {
      if (!$("settings-overlay").hidden) {
        closeSettingsModal();
        return;
      }
      if (!$("selective-overlay").hidden) {
        closeSelectiveExtractModal();
        return;
      }
      if (!$("command-preview-overlay").hidden) {
        closeCommandPreviewModal();
        return;
      }
      if (!$("licenses-overlay").hidden) {
        closeLicensesModal();
        return;
      }
      if (!$("shortcuts-overlay").hidden) {
        closeShortcutsModal();
        return;
      }
    }
    if (e.key === "?" && !isEditableTarget(e.target)) {
      if (
        !$("setup-wizard-overlay").hidden ||
        !$("settings-overlay").hidden ||
        !$("selective-overlay").hidden ||
        !$("command-preview-overlay").hidden ||
        !$("licenses-overlay").hidden ||
        !$("input-modal-overlay").hidden
      )
        return;
      e.preventDefault();
      openShortcutsModal();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (
        !$("setup-wizard-overlay").hidden ||
        !$("settings-overlay").hidden ||
        !$("input-modal-overlay").hidden ||
        !$("licenses-overlay").hidden ||
        !$("selective-overlay").hidden ||
        !$("command-preview-overlay").hidden ||
        !$("shortcuts-overlay").hidden
      )
        return;
      e.preventDefault();
      syncBasicBeforeRun();
      if (getMode() === "browse") void browseArchive();
      else void runAction();
    }
  });
}

function wireTitlebar(): void {
  const appWindow = getCurrentWebviewWindow();
  const minBtn = document.getElementById("titlebar-min");
  const maxBtn = document.getElementById("titlebar-max");
  const closeBtn = document.getElementById("titlebar-close");

  if (minBtn) {
    minBtn.addEventListener("click", () => {
      void appWindow.minimize();
    });
  }
  if (maxBtn) {
    maxBtn.addEventListener("click", async () => {
      const isMax = await appWindow.isMaximized();
      if (isMax) {
        void appWindow.unmaximize();
      } else {
        void appWindow.maximize();
      }
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      void appWindow.close();
    });
  }
}

async function init() {
  let uiReadyForOpenPaths = false;
  let openPathsQueue = Promise.resolve();

  async function drainPendingPaths(): Promise<void> {
    let batches: { paths: string[]; mode: string }[] = [];
    try {
      batches = await invoke<{ paths: string[]; mode: string }[]>(
        "drain_pending_paths",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to read pending Explorer paths: ${msg}`, "error");
      return;
    }
    for (const batch of batches) {
      if (batch.paths.length > 0) {
        await applyIncomingPaths(batch.paths, batch.mode, "Explorer");
      }
    }
  }

  try {
    await listen("pending-paths-changed", () => {
      if (!uiReadyForOpenPaths) return;
      openPathsQueue = openPathsQueue.then(drainPendingPaths).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to process incoming Explorer paths: ${msg}`, "error");
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to subscribe to Explorer open events: ${msg}`, "error");
  }

  try {
    await listen<string>("app-menu", (event) => {
      const action = typeof event.payload === "string" ? event.payload : "";
      switch (action) {
        case "menu-settings":
          openSettingsModal();
          break;
        case "menu-check-updates":
          void checkUpdates();
          break;
        case "menu-shortcuts":
          openShortcutsModal();
          break;
        case "menu-licenses":
          openLicensesModal();
          break;
        case "menu-support":
          window.open(
            "https://rosie.run/support",
            "_blank",
            "noopener,noreferrer",
          );
          break;
        default:
          break;
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to subscribe to app menu events: ${msg}`, "error");
  }

  try {
    await listen<string>("open-paths-dropped", (event) => {
      const detail =
        typeof event.payload === "string" && event.payload.trim()
          ? event.payload
          : "Zinnia could not accept another open request right now.";
      showToast(detail, "error", 5000);
      log(detail, "error");
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to subscribe to open-paths-dropped: ${msg}`, "error");
  }

  // Detect platform and show titlebar immediately to prevent layout flash
  let platform = "unknown";
  try {
    platform = await invoke<string>("get_platform_info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Unable to detect platform: ${msg}`);
  }
  if (platform === "windows") {
    document.body.classList.add("platform-windows");
  } else if (platform === "macos") {
    document.body.classList.add("platform-macos");
  } else if (platform === "linux") {
    document.body.classList.add("platform-linux");
  }
  wireTitlebar();

  try {
    const cpuCount = await invoke<number>("get_cpu_count");
    SETTING_DEFAULTS.threads = cpuCount;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Unable to determine CPU count, using default: ${msg}`);
  }

  const loadedSettings = await loadSettingsWithMetadata();
  state.currentSettings = loadedSettings.settings;
  state.lastPersistedSettings = { ...loadedSettings.settings };
  state.settingsExtras = { ...loadedSettings.extras };

  if (shouldShowSetupWizard()) {
    try {
      await runSetupWizardFlow();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message(`Setup wizard could not be completed.\n\n${msg}`, {
        title: "Setup wizard error",
        kind: "error",
      });
      throw err;
    }
  }

  applyTheme(state.currentSettings.theme);
  setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
  setUiDensity(state.currentSettings.uiDensity, { persist: false });
  applySettingsToForm();
  updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
  onCompressionOptionChange();
  registerIconRefreshHook(refreshIcons);
  refreshIcons();

  void invoke<string>("get_log_dir")
    .then((directory) => {
      state.logDirectory = directory;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Unable to resolve log directory: ${msg}`);
    });

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (state.currentSettings.theme === "system") applyTheme("system");
    });

  setMode(state.currentSettings.lastMode, { persist: false });
  setActivityPanelVisible(state.currentSettings.showActivityPanel, {
    persist: false,
  });
  renderInputs();
  wireEvents();
  initBasicWorkspace();
  uiReadyForOpenPaths = true;
  refreshQuickActionRepeatState();
  if (loadedSettings.malformed && loadedSettings.warning) {
    log(loadedSettings.warning, "error");
  }

  void invoke<string | null>("get_startup_recovery_status")
    .then((message) => {
      if (!message) return;
      const banner = document.getElementById("startup-recovery-banner");
      const text = document.getElementById("startup-recovery-banner-text");
      const dismiss = document.getElementById(
        "startup-recovery-banner-dismiss",
      );
      if (!banner || !text) return;
      text.textContent = `Could not finish recovering an interrupted archive job: ${message}`;
      banner.hidden = false;
      dismiss?.addEventListener(
        "click",
        () => {
          banner.hidden = true;
        },
        { once: true },
      );
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Unable to read startup recovery status: ${msg}`);
    });

  state.platformName = platform;
  const [versionResult, packagedResult] = await Promise.allSettled([
    getVersion(),
    invoke<boolean>("is_packaged"),
  ]);
  const version =
    versionResult.status === "fulfilled" ? `v${versionResult.value}` : "v?";
  if (versionResult.status === "rejected") {
    devLog(`Unable to read app version: ${String(versionResult.reason)}`);
  }
  state.appIsPackaged =
    packagedResult.status === "fulfilled" ? packagedResult.value : false;
  if (packagedResult.status === "rejected") {
    devLog(
      `Unable to determine package state: ${String(packagedResult.reason)}`,
    );
  }
  const platformDisplay =
    platform === "windows"
      ? "Windows"
      : platform === "macos"
        ? "macOS"
        : platform === "linux"
          ? "Linux"
          : platform;
  dom.versionLabel.textContent = version;
  dom.platformLabel.textContent = platformDisplay;
  $("s-version-label").textContent = version;
  $("s-platform-label").textContent = platformDisplay;
  void refreshOsIntegrationStatus().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Unable to read OS integration status: ${msg}`);
  });

  void invoke<boolean>("is_flatpak")
    .then((flatpak) => {
      if (flatpak) {
        document.body.classList.add("platform-flatpak");
      } else if (state.currentSettings.autoCheckUpdates) {
        void autoCheckUpdates();
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Unable to detect Flatpak context: ${msg}`);
      if (state.currentSettings.autoCheckUpdates) void autoCheckUpdates();
    });

  let initialMode = "";
  let initialPaths: string[] = [];
  try {
    initialMode = await invoke<string>("get_initial_mode");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to read initial mode: ${msg}`, "error");
  }
  try {
    initialPaths = await invoke<string[]>("get_initial_paths");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to read launch paths: ${msg}`, "error");
  }
  openPathsQueue = openPathsQueue
    .then(() => applyIncomingPaths(initialPaths, initialMode, "launch args"))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to process launch paths: ${msg}`, "error");
    });
  await openPathsQueue;

  // Drain any paths that queued up while we were initializing
  await drainPendingPaths();
  await invoke("mark_main_window_ready").catch(() => {});

  const appWindow = getCurrentWebviewWindow();
  await appWindow.onDragDropEvent(async (event) => {
    try {
      if (state.running) {
        dom.inputList.classList.remove("list--dragover");
        handleBasicDragDrop("leave");
        return;
      }
      if (getWorkspaceMode() === "basic") {
        handleBasicDragDrop(
          event.payload.type,
          event.payload.type === "drop" ? event.payload.paths : undefined,
        );
        return;
      }
      if (event.payload.type === "enter" || event.payload.type === "over") {
        dom.inputList.classList.add("list--dragover");
      } else if (event.payload.type === "leave") {
        dom.inputList.classList.remove("list--dragover");
      } else if (event.payload.type === "drop") {
        dom.inputList.classList.remove("list--dragover");
        const paths = event.payload.paths;
        if (paths.length) {
          const previousPrimary = state.inputs[0] ?? null;
          for (const path of paths) {
            if (!state.inputs.includes(path)) {
              state.inputs.push(path);
            }
          }
          if (
            getMode() === "browse" &&
            (state.inputs[0] ?? null) !== previousPrimary
          ) {
            setBrowsePasswordFieldVisible(false);
          }
          renderInputs();
          if (
            getMode() === "browse" &&
            state.inputs.length > 0 &&
            (await allPathsAreArchives([state.inputs[0]]))
          ) {
            void browseArchive();
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Drag-drop handler error: ${msg}`);
    }
  });
}

init().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
