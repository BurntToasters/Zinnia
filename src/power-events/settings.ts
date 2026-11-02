import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { $ } from "../utils";
import { state } from "../state";
import {
  applyTheme,
  readSettingsModal,
  applySettingsToForm,
  closeSettingsModal,
  toggleSettingsModal,
  populateSettingsModal,
} from "../settings";
import {
  log,
  renderInputs,
  setWorkspaceMode,
  setUiDensity,
  persistSettingsImmediately,
  isSettingsPersistSupersededError,
  awaitInFlightSettingsPersistence,
  flushPendingSettingsPersistence,
} from "../ui";
import { syncWorkspaceWindowFx } from "../window-fx";
import {
  updateCompressionOptionsForFormat,
  onCompressionOptionChange,
} from "../presets";
import { discardPendingUpdate } from "../updater";
import { setBasicView, syncBasicWorkspaceFromPower } from "../basic";
import { resetRuntimeStateForFirstRun } from "../power-helpers";
import { showToast } from "../toast";
import { runSetupWizardFlow } from "./setup-wizard-flow";
import { refreshQuickActionRepeatState } from "../quick-actions";
import { confirmWithE2eQueue } from "../e2e-dialog";

const BASIC_RECENT_ARCHIVES_KEY = "zinnia.basic.recentArchives";

export function wireSettingsEvents(): void {
  $("open-settings").addEventListener("click", toggleSettingsModal);
  $("close-settings").addEventListener("click", () => closeSettingsModal());
  $("cancel-settings").addEventListener("click", () => closeSettingsModal());
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettingsModal();
  });
  $("save-settings").addEventListener("click", async () => {
    const saveButton = $<HTMLButtonElement>("save-settings");
    if (saveButton.disabled) return;
    saveButton.disabled = true;
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
    if (state.currentSettings.workspaceMode === "basic") {
      syncBasicWorkspaceFromPower();
    }
    const finishSettingsSaveSuccess = () => {
      log("Settings saved successfully.");
      closeSettingsModal({ preserveLivePreview: true });
    };

    const rollbackSettingsSave = (err: unknown) => {
      state.currentSettings = previous;
      applyTheme(state.currentSettings.theme);
      setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
      setUiDensity(state.currentSettings.uiDensity, { persist: false });
      applySettingsToForm();
      populateSettingsModal();
      updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
      onCompressionOptionChange();
      if (state.currentSettings.workspaceMode === "basic") {
        syncBasicWorkspaceFromPower();
      }

      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to save settings: ${msg}`, "error");
      showToast(`Failed to save settings. ${msg}`, "error", 0);
    };

    try {
      try {
        await persistSettingsImmediately(
          state.currentSettings,
          state.settingsExtras,
        );
      } catch (err) {
        if (!isSettingsPersistSupersededError(err)) throw err;
        await awaitInFlightSettingsPersistence();
        await persistSettingsImmediately(
          state.currentSettings,
          state.settingsExtras,
        );
      }
      finishSettingsSaveSuccess();
    } catch (err) {
      rollbackSettingsSave(err);
    } finally {
      saveButton.disabled = false;
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
      showToast(`Failed to run setup wizard. ${msg}`, "error", 0);
    }
  });

  $("reset-settings").addEventListener("click", async () => {
    const confirmed = await confirmWithE2eQueue(() =>
      ask(
        "Are you sure you want to reset all settings to default and restart Zinnia?",
        {
          title: "Reset Settings",
          kind: "warning",
          okLabel: "Reset & Restart",
          cancelLabel: "Cancel",
        },
      ),
    );
    if (!confirmed) return;

    try {
      discardPendingUpdate();
      await flushPendingSettingsPersistence();
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
      showToast(`Failed to reset settings. ${msg}`, "error", 0);
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
}
