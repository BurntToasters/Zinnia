import { ask, message, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { $ } from "./utils";
import { SETTING_DEFAULTS, state, dom } from "./state";
import { applyTheme, loadSettingsWithMetadata, saveSettings, readSettingsModal, applySettingsToForm, openSettingsModal, closeSettingsModal, populateSettingsModal } from "./settings";
import { log, devLog, toggleActivity, renderInputs, setMode, getMode, setBrowsePasswordFieldVisible } from "./ui";
import { runAction, cancelAction, testArchive, browseArchive, previewCommand } from "./archive";
import { validateArchivePaths } from "./archive-rules";
import { updateCompressionOptionsForFormat, applyPreset, onCompressionOptionChange } from "./presets";
import { checkUpdates, autoCheckUpdates } from "./updater";
import { openLicensesModal, closeLicensesModal } from "./licenses";
import { chooseOutput, chooseExtract, addFiles, addFolder, toggleOsIntegration, setOsIntegrationToggle, enableOsIntegration, probeOsIntegrationStatus } from "./files";

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
    await message(`Logs exported successfully.\n\n${destination}`, { title: "Logs exported" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to export logs: ${msg}`, "error");
    await message(`Failed to export logs.\n\n${msg}`, { title: "Export failed", kind: "error" });
  }
}

async function openLogsFolder() {
  try {
    await invoke("open_log_dir");
    log("Opened local logs folder.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to open logs folder: ${msg}`, "error");
    await message(`Failed to open logs folder.\n\n${msg}`, { title: "Open folder failed", kind: "error" });
  }
}

async function clearLocalLogs() {
  const confirmed = await ask("Clear local diagnostics logs? This cannot be undone.", {
    title: "Clear logs",
    kind: "warning",
    okLabel: "Clear logs",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return;

  try {
    await invoke("clear_logs");
    log("Local diagnostics logs cleared.");
    await message("Local diagnostics logs were cleared.", { title: "Logs cleared" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to clear logs: ${msg}`, "error");
    await message(`Failed to clear logs.\n\n${msg}`, { title: "Clear logs failed", kind: "error" });
  }
}

async function allPathsAreArchives(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  try {
    const results = await validateArchivePaths(paths);
    return results.length === paths.length && results.every(result => result.valid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Archive probe failed for auto-detect: ${msg}`);
    return false;
  }
}

async function applyIncomingPaths(paths: string[], mode: string, source: string): Promise<void> {
  if (!paths.length) return;

  const shouldAutoBrowse = mode !== "extract" && await allPathsAreArchives(paths);
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

  if (shouldAutoBrowse) {
    void browseArchive();
  }
}

function wireEvents() {
  $("add-files").addEventListener("click", addFiles);
  $("add-folder").addEventListener("click", addFolder);
  $("clear-inputs").addEventListener("click", () => {
    state.inputs.length = 0;
    renderInputs();
    const bc = document.getElementById("browse-contents");
    if (bc) bc.hidden = true;
  });
  $("choose-output").addEventListener("click", chooseOutput);
  $("choose-extract").addEventListener("click", chooseExtract);
  $("run-action").addEventListener("click", runAction);
  $("cancel-action").addEventListener("click", cancelAction);
  $("show-command").addEventListener("click", previewCommand);
  $("clear-log").addEventListener("click", () => (dom.logEl.textContent = ""));

  $("extract-run").addEventListener("click", runAction);
  $("extract-cancel").addEventListener("click", cancelAction);
  $("extract-preview").addEventListener("click", previewCommand);
  $("test-integrity").addEventListener("click", testArchive);

  $("browse-list").addEventListener("click", browseArchive);
  $("browse-test").addEventListener("click", testArchive);
  $("browse-extract").addEventListener("click", () => setMode("extract"));

  $("toggle-browse-password").addEventListener("click", () => {
    const input = $<HTMLInputElement>("browse-password");
    const btn = $<HTMLButtonElement>("toggle-browse-password");
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });

  $<HTMLSelectElement>("preset").addEventListener("change", () => {
    applyPreset($<HTMLSelectElement>("preset").value);
  });

  $<HTMLSelectElement>("format").addEventListener("change", () => {
    updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
    onCompressionOptionChange();
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
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });

  $("toggle-extract-password").addEventListener("click", () => {
    const input = $<HTMLInputElement>("extract-password");
    const btn = $<HTMLButtonElement>("toggle-extract-password");
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });

  $("toggle-activity").addEventListener("click", toggleActivity);

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
      applySettingsToForm();
      populateSettingsModal();
      updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
      onCompressionOptionChange();

      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to save settings: ${msg}`, "error");
      await message(`Failed to save settings.\n\n${msg}`, { title: "Settings error", kind: "error" });
    }
  });

  document.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("is-active"));
      document.querySelectorAll(".settings-panel").forEach(p => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      const panel = document.querySelector(`[data-panel="${tab.dataset.tab}"]`);
      if (panel) panel.classList.add("is-active");
    });
  });

  $("check-updates").addEventListener("click", checkUpdates);
  $("export-logs").addEventListener("click", exportLocalLogs);
  $("open-logs-folder").addEventListener("click", openLogsFolder);
  $("clear-logs").addEventListener("click", clearLocalLogs);
  $("s-os-integration").addEventListener("change", toggleOsIntegration);
  $("show-licenses").addEventListener("click", openLicensesModal);
  $("about-show-licenses").addEventListener("click", openLicensesModal);

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
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("settings-overlay").hidden) { closeSettingsModal(); return; }
      if (!$("licenses-overlay").hidden) { closeLicensesModal(); return; }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (!$("settings-overlay").hidden || !$("licenses-overlay").hidden) return;
      e.preventDefault();
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
    await message(
      `The bundled 7-Zip binary could not be started.\n\n${msg}`,
      { title: "Missing runtime dependency", kind: "error" }
    );
    throw err;
  }

  const cpuCount = await invoke<number>("get_cpu_count");
  SETTING_DEFAULTS.threads = cpuCount;

  const loadedSettings = await loadSettingsWithMetadata();
  state.currentSettings = loadedSettings.settings;
  state.lastPersistedSettings = { ...loadedSettings.settings };
  state.settingsExtras = { ...loadedSettings.extras };
  applyTheme(state.currentSettings.theme);
  applySettingsToForm();
  updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
  onCompressionOptionChange();

  try {
    state.logDirectory = await invoke<string>("get_log_dir");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Unable to resolve log directory: ${msg}`);
  }

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.currentSettings.theme === "system") applyTheme("system");
  });

  renderInputs();
  wireEvents();
  if (loadedSettings.malformed && loadedSettings.warning) {
    log(loadedSettings.warning, "error");
  }

  const version = `v${await getVersion()}`;
  const platform = await invoke<string>("get_platform_info");
  state.platformName = platform;
  state.appIsPackaged = await invoke<boolean>("is_packaged");
  const platformDisplay = platform === "windows" ? "Windows" :
                          platform === "macos" ? "macOS" :
                          platform === "linux" ? "Linux" : platform;
  dom.versionLabel.textContent = version;
  dom.platformLabel.textContent = platformDisplay;
  $("s-version-label").textContent = version;
  $("s-platform-label").textContent = platformDisplay;

  const flatpak = await invoke<boolean>("is_flatpak");
  if (flatpak) {
    document.body.classList.add("platform-flatpak");
  }

  const osRow = document.getElementById("os-integration-row");
  const hasOsIntegration = platform === "windows" || (platform === "linux" && !flatpak);
  if (osRow) {
    osRow.style.display = hasOsIntegration ? "" : "none";
  }

  if (platform === "windows") {
    document.body.classList.add("platform-windows");
    const title = document.getElementById("os-integration-title");
    const desc = document.getElementById("os-integration-desc");
    if (title) title.textContent = "Windows Explorer integration";
    if (desc) desc.textContent = "Add \"Compress with Zinnia\" and \"Extract with Zinnia\" to right-click menus.";
  } else if (platform === "linux") {
    document.body.classList.add("platform-linux");
    const title = document.getElementById("os-integration-title");
    const desc = document.getElementById("os-integration-desc");
    if (title) title.textContent = "File manager integration";
    if (desc) desc.textContent = "Register Zinnia as a handler for archive files in your desktop environment.";
  }

  if (hasOsIntegration && state.appIsPackaged) {
    const isEnabled = await probeOsIntegrationStatus();
    setOsIntegrationToggle(isEnabled);

    if (!isEnabled) {
      const userDisabled = state.settingsExtras._integrationUserDisabled === true;
      const autoEnabled = state.settingsExtras._integrationAutoEnabled === true;
      if (!userDisabled && !autoEnabled) {
        if (await enableOsIntegration()) {
          setOsIntegrationToggle(true);
          state.settingsExtras._integrationUserDisabled = false;
          devLog("File manager integration auto-enabled on first run.");
        }
        state.settingsExtras._integrationAutoEnabled = true;
        try {
          await saveSettings(state.currentSettings, state.settingsExtras);
          state.lastPersistedSettings = { ...state.currentSettings };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Failed to persist integration metadata: ${msg}`, "error");
        }
      }
    }
  } else if (!state.appIsPackaged) {
    const input = document.getElementById("s-os-integration") as HTMLInputElement | null;
    if (input) {
      input.disabled = true;
    }
    const desc = document.getElementById("os-integration-desc");
    if (desc) desc.textContent = "Disabled in development builds. Only packaged installations can register.";
  }

  let openPathsQueue = Promise.resolve();
  await listen<{ paths: string[]; mode: string }>("open-paths", (event) => {
    const { paths, mode } = event.payload;
    openPathsQueue = openPathsQueue
      .then(() => applyIncomingPaths(paths, mode, "Explorer"))
      .catch((err) => {
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

  if (state.currentSettings.autoCheckUpdates && !flatpak) {
    autoCheckUpdates();
  }

  const appWindow = getCurrentWebviewWindow();
  await appWindow.onDragDropEvent(async (event) => {
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
        if (getMode() === "browse" && (state.inputs[0] ?? null) !== previousPrimary) {
          setBrowsePasswordFieldVisible(false);
        }
        renderInputs();
        if (getMode() === "browse" && state.inputs.length > 0 && await allPathsAreArchives([state.inputs[0]])) {
          void browseArchive();
        }
      }
    }
  });
}

init().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
