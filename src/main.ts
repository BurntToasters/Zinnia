import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { $, isArchiveFile } from "./utils";
import { SETTING_DEFAULTS, state, dom } from "./state";
import { applyTheme, loadSettings, saveSettings, readSettingsModal, applySettingsToForm, openSettingsModal, closeSettingsModal } from "./settings";
import { log, devLog, toggleActivity, renderInputs, setMode, getMode } from "./ui";
import { runAction, cancelAction, testArchive, browseArchive, previewCommand } from "./archive";
import { updateCompressionOptionsForFormat, applyPreset, onCompressionOptionChange } from "./presets";
import { checkUpdates, autoCheckUpdates } from "./updater";
import { openLicensesModal, closeLicensesModal } from "./licenses";
import { chooseOutput, chooseExtract, addFiles, addFolder, toggleOsIntegration, setOsIntegrationToggle, enableOsIntegration, probeOsIntegrationStatus } from "./files";

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
    state.currentSettings = readSettingsModal();
    applyTheme(state.currentSettings.theme);
    applySettingsToForm();
    try {
      await saveSettings(state.currentSettings);
      log("Settings saved successfully.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to save settings: ${msg}`);
      await message(`Failed to save settings.\n\n${msg}`, { title: "Settings error", kind: "error" });
    }
    closeSettingsModal();
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
      e.preventDefault();
      if (getMode() === "browse") browseArchive();
      else runAction();
    }
  });
}

async function init() {
  const cpuCount = await invoke<number>("get_cpu_count");
  SETTING_DEFAULTS.threads = cpuCount;

  state.currentSettings = await loadSettings();
  applyTheme(state.currentSettings.theme);
  applySettingsToForm();

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.currentSettings.theme === "system") applyTheme("system");
  });

  renderInputs();
  wireEvents();

  updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);

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
      const raw = await invoke<string>("load_settings");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed._integrationAutoEnabled === undefined) {
        if (await enableOsIntegration()) {
          setOsIntegrationToggle(true);
          devLog("File manager integration auto-enabled on first run.");
        }
        parsed._integrationAutoEnabled = true;
        await invoke("save_settings", { json: JSON.stringify(parsed) });
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

  await listen<{ paths: string[]; mode: string }>("open-paths", (event) => {
    const { paths, mode } = event.payload;
    if (paths.length) {
      if (mode === "extract") {
        setMode("extract");
        state.inputs.length = 0;
      } else if (paths.every(p => isArchiveFile(p))) {
        setMode("browse");
        state.inputs.length = 0;
      }
      for (const path of paths) {
        if (!state.inputs.includes(path)) {
          state.inputs.push(path);
        }
      }
      renderInputs();
      devLog(`Received ${paths.length} path(s) from Explorer.`);
      if (getMode() === "browse") browseArchive();
    }
  });

  const initialMode = await invoke<string>("get_initial_mode");
  const initialPaths = await invoke<string[]>("get_initial_paths");
  if (initialPaths.length) {
    for (const path of initialPaths) {
      if (!state.inputs.includes(path)) {
        state.inputs.push(path);
      }
    }
    if (initialMode === "extract") {
      setMode("extract");
    } else if (initialPaths.every(p => isArchiveFile(p))) {
      setMode("browse");
    }
    renderInputs();
    devLog(`Loaded ${initialPaths.length} path(s) from launch args.`);
    if (getMode() === "browse") browseArchive();
  }

  if (state.currentSettings.autoCheckUpdates && !flatpak) {
    autoCheckUpdates();
  }

  const appWindow = getCurrentWebviewWindow();
  await appWindow.onDragDropEvent((event) => {
    if (event.payload.type === "enter" || event.payload.type === "over") {
      dom.inputList.classList.add("list--dragover");
    } else if (event.payload.type === "leave") {
      dom.inputList.classList.remove("list--dragover");
    } else if (event.payload.type === "drop") {
      dom.inputList.classList.remove("list--dragover");
      const paths = event.payload.paths;
      if (paths.length) {
        for (const path of paths) {
          if (!state.inputs.includes(path)) {
            state.inputs.push(path);
          }
        }
        renderInputs();
        if (getMode() === "browse" && state.inputs.length > 0 && isArchiveFile(state.inputs[0])) {
          browseArchive();
        }
      }
    }
  });
}

init().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
