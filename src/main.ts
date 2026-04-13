import { ask, message, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { $ } from "./utils";
import { SETTING_DEFAULTS, state, dom } from "./state";
import {
  applyTheme,
  loadSettingsWithMetadata,
  saveSettings,
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
} from "./ui";
import {
  runAction,
  cancelAction,
  testArchive,
  browseArchive,
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
} from "./presets";
import { checkUpdates, autoCheckUpdates } from "./updater";
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
} from "./basic-ui";

async function exportLocalLogs() {
  const suggestedName = `zinnia-logs-${new Date().toISOString().slice(0, 10)}.txt`;
  const destination = await save({
    title: "Export local diagnostics log",
    defaultPath: suggestedName,
    filters: [{ name: "Text files", extensions: ["txt", "log"] }],
  });

  if (!destination || typeof destination !== "string") return;

  try {
    await invoke("export_logs", { destinationPath: destination });
    log(`Logs exported to ${destination}`);
    await message(`Logs exported successfully.\n\n${destination}`, {
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

  const shouldAutoBrowse =
    mode !== "extract" &&
    paths.length === 1 &&
    (await allPathsAreArchives(paths));
  if (mode === "extract") {
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
    if (mode === "extract" || shouldAutoBrowse) {
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
  const result = await showSetupWizard();
  if (result) {
    state.currentSettings.workspaceMode = result.workspaceMode;
    state.currentSettings.theme = result.theme;
    state.currentSettings.autoCheckUpdates = result.autoCheckUpdates;
    state.currentSettings.updateChannel = result.updateChannel;
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

function wireEvents() {
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
  $("test-integrity").addEventListener("click", testArchive);

  $("browse-list").addEventListener("click", browseArchive);
  $("browse-test").addEventListener("click", testArchive);
  $("browse-extract").addEventListener("click", () => setMode("extract"));
  $("browse-selective").addEventListener("click", () => {
    void openSelectiveExtractModal();
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

  $("toggle-browse-password").addEventListener("click", () => {
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

  $<HTMLSelectElement>("preset").addEventListener("change", () => {
    applyPreset($<HTMLSelectElement>("preset").value);
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

  $("toggle-password").addEventListener("click", () => {
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

  $("toggle-extract-password").addEventListener("click", () => {
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
        setWorkspaceMode(mode);
        if (mode === "basic") {
          const currentMode = getMode();
          if (currentMode === "add" && state.inputs.length > 0) {
            setBasicView("compress");
          } else if (currentMode === "extract") {
            setBasicView("extract");
          } else if (currentMode === "browse") {
            setBasicView("browse");
          } else {
            setBasicView("home");
          }
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
    applyTheme(state.currentSettings.theme);
    setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
    setUiDensity(state.currentSettings.uiDensity, { persist: false });
    applySettingsToForm();
    updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
    onCompressionOptionChange();
    try {
      await saveSettings(state.currentSettings, state.settingsExtras);
      state.lastPersistedSettings = { ...state.currentSettings };
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
  $("show-licenses").addEventListener("click", (e) =>
    openLicensesModal(e.currentTarget as HTMLElement),
  );
  $("about-show-licenses").addEventListener("click", (e) =>
    openLicensesModal(e.currentTarget as HTMLElement),
  );

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
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (
        !$("setup-wizard-overlay").hidden ||
        !$("settings-overlay").hidden ||
        !$("licenses-overlay").hidden ||
        !$("selective-overlay").hidden ||
        !$("command-preview-overlay").hidden
      )
        return;
      e.preventDefault();
      syncBasicBeforeRun();
      if (getMode() === "browse") void browseArchive();
      else void runAction();
    }
  });
}

async function init() {
  try {
    await invoke("probe_7z");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(`The bundled 7-Zip binary could not be started.\n\n${msg}`, {
      title: "Missing runtime dependency",
      kind: "error",
    });
    throw err;
  }

  const cpuCount = await invoke<number>("get_cpu_count");
  SETTING_DEFAULTS.threads = cpuCount;

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

  try {
    state.logDirectory = await invoke<string>("get_log_dir");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Unable to resolve log directory: ${msg}`);
  }

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
  refreshQuickActionRepeatState();
  if (loadedSettings.malformed && loadedSettings.warning) {
    log(loadedSettings.warning, "error");
  }

  const version = `v${await getVersion()}`;
  const platform = await invoke<string>("get_platform_info");
  state.platformName = platform;
  state.appIsPackaged = await invoke<boolean>("is_packaged");
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

  const flatpak = await invoke<boolean>("is_flatpak");
  if (flatpak) {
    document.body.classList.add("platform-flatpak");
  }

  if (platform === "windows") {
    document.body.classList.add("platform-windows");
  } else if (platform === "linux") {
    document.body.classList.add("platform-linux");
  }

  let openPathsQueue = Promise.resolve();

  async function drainPendingPaths(): Promise<void> {
    const batches = await invoke<{ paths: string[]; mode: string }[]>(
      "drain_pending_paths",
    );
    for (const batch of batches) {
      if (batch.paths.length > 0) {
        await applyIncomingPaths(batch.paths, batch.mode, "Explorer");
      }
    }
  }

  await listen("pending-paths-changed", () => {
    openPathsQueue = openPathsQueue.then(drainPendingPaths).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to process incoming Explorer paths: ${msg}`, "error");
    });
  });

  const initialMode = await invoke<string>("get_initial_mode");
  const initialPaths = await invoke<string[]>("get_initial_paths");
  openPathsQueue = openPathsQueue
    .then(() => applyIncomingPaths(initialPaths, initialMode, "launch args"))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to process launch paths: ${msg}`, "error");
    });
  await openPathsQueue;

  // Drain any paths that queued up while we were initializing
  await drainPendingPaths();

  if (state.currentSettings.autoCheckUpdates && !flatpak) {
    void autoCheckUpdates();
  }

  const appWindow = getCurrentWebviewWindow();
  await appWindow.onDragDropEvent(async (event) => {
    try {
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
