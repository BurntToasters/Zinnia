import { ask, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { $ } from "./utils";
import { promptInput } from "./prompt-modal";
import { state, dom } from "./state";
import {
  applyTheme,
  readSettingsModal,
  applySettingsToForm,
  closeSettingsModal,
  toggleSettingsModal,
  populateSettingsModal,
  syncSettingsSecurityControlsForFormat,
} from "./settings";
import {
  log,
  toggleActivity,
  renderInputs,
  setMode,
  setWorkspaceMode,
  setUiDensity,
  getMode,
  persistSettingsImmediately,
  setStatus,
  resizeWorkspaceWindow,
} from "./ui";
import { syncWorkspaceWindowFx } from "./window-fx";
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
import {
  updateCompressionOptionsForFormat,
  applyPreset,
  onCompressionOptionChange,
  saveCustomPreset,
  deleteCustomPreset,
  refreshPresetDropdown,
} from "./presets";
import { checkUpdates, discardPendingUpdate } from "./updater";
import { openLicensesModal, closeLicensesModal } from "./licenses";
import { chooseOutput, chooseExtract, addFiles, addFolder } from "./files";
import {
  wireQuickActionEvents,
  refreshQuickActionRepeatState,
} from "./quick-actions";
import {
  showSetupWizard,
  markSetupComplete,
  type SetupWizardOptions,
} from "./setup-wizard";
import {
  deriveOutputArchivePath,
  resolveOutputArchiveAutofill,
} from "./extract-path";
import {
  setBasicView,
  syncBasicBeforeRun,
  syncBasicWorkspaceFromPower,
} from "./basic";
import { wireOsIntegrationEvents } from "./os-integration";
import { runBenchmark } from "./benchmark";
import { showToast } from "./toast";
import {
  isDebugEnabled,
  setDebugEnabled,
  setDebugConsoleVisible,
  wireDebugConsoleControls,
} from "./debug-mode";
import {
  isEditableTarget,
  resetRuntimeStateForFirstRun,
  wirePasswordToggle,
} from "./power-helpers";
import {
  openShortcutsModal,
  closeShortcutsModal,
  wireShortcutsEvents,
} from "./power-shortcuts";
import { exportLocalLogs, openLogsFolder, clearLocalLogs } from "./power-logs";

export { openShortcutsModal } from "./power-shortcuts";

export async function promptAndToggleDebugMode(): Promise<void> {
  const enabling = !isDebugEnabled();
  const confirmed = await ask(
    enabling
      ? "Enable debug mode? This shows a Debug Console with verbose process output."
      : "Disable debug mode and hide the Debug Console?",
    {
      title: enabling ? "Enable debug mode" : "Disable debug mode",
      kind: "info",
      okLabel: enabling ? "Enable" : "Disable",
      cancelLabel: "Cancel",
    },
  );
  if (!confirmed) return;

  state.currentSettings = { ...state.currentSettings, debug: enabling };
  try {
    await persistSettingsImmediately(
      state.currentSettings,
      state.settingsExtras,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Could not save debug setting: ${msg}`, "error");
    return;
  }

  setDebugEnabled(enabling);
  if (enabling) {
    setDebugConsoleVisible(true);
    showToast("Debug mode enabled.", "info");
  } else {
    showToast("Debug mode disabled.", "info");
  }
}

const BASIC_RECENT_ARCHIVES_KEY = "zinnia.basic.recentArchives";

export async function runSetupWizardFlow(
  options: SetupWizardOptions = {},
): Promise<void> {
  await resizeWorkspaceWindow("power");
  const result = await showSetupWizard(options);
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

  let persistError: unknown = null;
  try {
    await markSetupComplete();
  } catch (err) {
    persistError = err;
  }

  applyTheme(state.currentSettings.theme);
  setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
  setUiDensity(state.currentSettings.uiDensity, { persist: false });
  applySettingsToForm();
  updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
  onCompressionOptionChange();

  if (persistError) {
    throw persistError;
  }
}

let eventsWired = false;

export function wireEvents() {
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
    const rawName = archiveNameInput?.value;
    const customName = rawName && rawName.length > 0 ? rawName : undefined;
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
    if (
      state.running ||
      state.operationPreparing ||
      state.incomingPathsApplying
    ) {
      return;
    }
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

  wireShortcutsEvents();

  $("test-integrity").addEventListener("click", testArchive);

  $("browse-list").addEventListener("click", browseArchive);
  $("browse-cancel").addEventListener("click", cancelAction);
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
    setSelectiveExtractSearch(
      $<HTMLInputElement>("selective-search").value,
      true,
    );
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

  wirePasswordToggle("browse-password", "toggle-browse-password");

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
      const previousPresets = state.currentSettings.customPresets.map(
        (preset) => ({ ...preset }),
      );
      try {
        saveCustomPreset(name);
        refreshPresetDropdown(`custom:${name}`);
        updateDeletePresetButton();
        await persistSettingsImmediately(
          state.currentSettings,
          state.settingsExtras,
        );
        setStatus(`Preset "${name}" saved`, 2000);
      } catch (err) {
        state.currentSettings.customPresets = previousPresets;
        refreshPresetDropdown("custom");
        updateDeletePresetButton();
        const detail = err instanceof Error ? err.message : String(err);
        setStatus("Error", 3000, detail);
        await message(`Could not save preset "${name}".\n\n${detail}`, {
          title: "Preset not saved",
          kind: "error",
        });
      }
    })();
  });

  $("delete-preset").addEventListener("click", () => {
    void (async () => {
      const value = $<HTMLSelectElement>("preset").value;
      if (!value.startsWith("custom:")) return;
      const name = value.slice("custom:".length);
      const previousPresets = state.currentSettings.customPresets.map(
        (preset) => ({ ...preset }),
      );
      try {
        deleteCustomPreset(name);
        refreshPresetDropdown("custom");
        updateDeletePresetButton();
        await persistSettingsImmediately(
          state.currentSettings,
          state.settingsExtras,
        );
        setStatus(`Preset "${name}" deleted`, 2000);
      } catch (err) {
        state.currentSettings.customPresets = previousPresets;
        refreshPresetDropdown(value);
        updateDeletePresetButton();
        const detail = err instanceof Error ? err.message : String(err);
        setStatus("Error", 3000, detail);
        await message(`Could not delete preset "${name}".\n\n${detail}`, {
          title: "Preset not deleted",
          kind: "error",
        });
      }
    })();
  });

  $<HTMLSelectElement>("s-format").addEventListener("change", () => {
    syncSettingsSecurityControlsForFormat(
      $<HTMLSelectElement>("s-format")
        .value as typeof state.currentSettings.format,
    );
  });

  $("output-path").addEventListener("input", () => {
    const value = $<HTMLInputElement>("output-path").value;
    if (value !== (state.lastAutoOutputPath ?? "")) {
      state.lastAutoOutputPath = null;
    }
  });

  $("archive-name").addEventListener("input", () => {
    // Archive name field always drives the output path (force-update).
    const outputPathInput = $<HTMLInputElement>("output-path");
    const archiveNameInput = $<HTMLInputElement>("archive-name");
    const format = $<HTMLSelectElement>("format").value;
    const customName = archiveNameInput.value || undefined;
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
    $(id).addEventListener("change", () => {
      if (id === "method") {
        updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
      }
      onCompressionOptionChange();
    });
  }

  $<HTMLSelectElement>("split-size").addEventListener("change", () => {
    const isCustom = $<HTMLSelectElement>("split-size").value === "custom";
    $("split-custom-field").hidden = !isCustom;
    if (isCustom) $<HTMLInputElement>("split-custom").focus();
  });

  wirePasswordToggle("password", "toggle-password");

  wirePasswordToggle("extract-password", "toggle-extract-password");

  $("extract-path").addEventListener("input", () => {
    const value = $<HTMLInputElement>("extract-path").value;
    if (value && value !== state.lastAutoExtractDestination) {
      state.lastAutoExtractDestination = null;
    }
  });

  $("toggle-activity").addEventListener("click", toggleActivity);
  document
    .querySelectorAll<HTMLButtonElement>("[data-workspace-mode-btn]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.running || state.operationPreparing) return;
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

  $("open-settings").addEventListener("click", toggleSettingsModal);
  $("close-settings").addEventListener("click", () => closeSettingsModal());
  $("cancel-settings").addEventListener("click", () => closeSettingsModal());
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
      closeSettingsModal({ preserveLivePreview: true });
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
      await runSetupWizardFlow({
        skipUpdates: document.body.classList.contains("platform-flatpak"),
      });
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
      // Basic-mode recents are local UI state, not backend settings. Reset them
      // alongside the persisted settings and diagnostics history.
      try {
        localStorage.removeItem(BASIC_RECENT_ARCHIVES_KEY);
        sessionStorage.removeItem(BASIC_RECENT_ARCHIVES_KEY);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to clear recent archives during reset: ${msg}`);
      }
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
  const aboutDebugToggle = $("about-debug-toggle");
  aboutDebugToggle.addEventListener("click", () => {
    void promptAndToggleDebugMode();
  });
  aboutDebugToggle.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    void promptAndToggleDebugMode();
  });
  wireDebugConsoleControls();
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
      // Licenses can be stacked above Settings. Do not toggle the lower sheet
      // while the topmost modal owns focus.
      if (!$("licenses-overlay").hidden) return;
      toggleSettingsModal();
      return;
    }
    if (e.key === "Escape") {
      // Licenses may be nested over Settings in Basic mode; always dismiss the
      // visually topmost sheet first.
      if (!$("licenses-overlay").hidden) {
        closeLicensesModal();
        return;
      }
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
      // The backend runs at most one 7z operation at a time. Basic
      // preparation (password probes, encryption checks) and incoming-path
      // application both run with `state.running === false`, so this global
      // shortcut must check them too or it can start a second, conflicting
      // operation while one of those is in flight.
      if (
        state.running ||
        state.operationPreparing ||
        state.incomingPathsApplying
      )
        return;
      e.preventDefault();
      syncBasicBeforeRun();
      if (getMode() === "browse") void browseArchive();
      else void runAction();
    }
  });
}
