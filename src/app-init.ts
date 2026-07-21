import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { showToast } from "./toast";
import { $ } from "./utils";
import { SETTING_DEFAULTS, state, dom } from "./state";
import {
  applyTheme,
  loadSettingsWithMetadata,
  applySettingsToForm,
  openSettingsModal,
} from "./settings";
import {
  log,
  devLog,
  renderInputs,
  setMode,
  setActivityPanelVisible,
  setWorkspaceMode,
  getWorkspaceMode,
  setUiDensity,
  getMode,
  setBrowsePasswordFieldVisible,
  registerIconRefreshHook,
} from "./ui";
import { browseArchive } from "./archive";
import {
  updateCompressionOptionsForFormat,
  onCompressionOptionChange,
} from "./presets";
import { checkUpdates, autoCheckUpdates } from "./updater";
import { openLicensesModal } from "./licenses";
import { refreshQuickActionRepeatState } from "./quick-actions";
import { shouldShowSetupWizard } from "./setup-wizard";
import { initBasicWorkspace, handleBasicDragDrop } from "./basic";
import { refreshOsIntegrationStatus } from "./os-integration";
import { refreshIcons } from "./icons";
import { allPathsAreArchives, applyIncomingPaths } from "./incoming-paths";
import {
  wireEvents,
  openShortcutsModal,
  runSetupWizardFlow,
} from "./power-events";

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

export async function init() {
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
      // Don't abort app startup — Skip / finish should still leave a usable UI.
      await message(`Setup wizard could not be completed.\n\n${msg}`, {
        title: "Setup wizard error",
        kind: "error",
      });
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
