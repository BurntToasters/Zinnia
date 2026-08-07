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
import { openExternalUrl } from "./external-links";
import { refreshQuickActionRepeatState } from "./quick-actions";
import { shouldShowSetupWizard } from "./setup-wizard";
import { initBasicWorkspace, handleBasicDragDrop } from "./basic";
import { refreshOsIntegrationStatus } from "./os-integration";
import { refreshIcons } from "./icons";
import {
  setDebugEnabled,
  debugLog,
  restoreDebugConsolePopOutIfNeeded,
} from "./debug-mode";
import {
  allPathsAreArchives,
  applyIncomingPaths,
  acquireIncomingPathLock,
  isIncomingPathBusy,
  releaseIncomingPathLock,
} from "./incoming-paths";
import {
  wireEvents,
  openShortcutsModal,
  runSetupWizardFlow,
} from "./power-events";
import { MAX_ARCHIVE_PATHS } from "./archive-rules";

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
      // Basic mode locks window size; ignore maximize even if the OS APIs allow it.
      if (getWorkspaceMode() === "basic") return;
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
          void openExternalUrl("https://rosie.run/support");
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
  // Basic archive pickers need platform capability policy during their setup,
  // before the later version/package probes complete.
  state.platformName = platform;
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

  let isFlatpak = false;
  try {
    isFlatpak = await invoke<boolean>("is_flatpak");
    if (isFlatpak) {
      document.body.classList.add("platform-flatpak");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Unable to detect Flatpak context: ${msg}`);
  }

  if (shouldShowSetupWizard()) {
    try {
      await runSetupWizardFlow({ skipUpdates: isFlatpak });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't abort app startup: Skip / finish should still leave a usable UI.
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
  setDebugEnabled(state.currentSettings.debug);
  if (state.currentSettings.debug) {
    debugLog(
      `Debug mode restored (v${dom.versionLabel.textContent || "?"}, ${dom.platformLabel.textContent || state.platformName || "?"}).`,
    );
    void restoreDebugConsolePopOutIfNeeded();
  }
  renderInputs();
  wireEvents();
  initBasicWorkspace();
  uiReadyForOpenPaths = true;
  refreshQuickActionRepeatState();
  if (loadedSettings.malformed && loadedSettings.warning) {
    log(loadedSettings.warning, "error");
    if (state.currentSettings.debug) {
      debugLog(`Settings load warning: ${loadedSettings.warning}`);
    }
  }

  const startupRecoveryStatus = invoke<string | null>(
    "get_startup_recovery_status",
  );
  void startupRecoveryStatus
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

  // A cold launch resolves a Windows shell handoff (Explorer's "Extract
  // with Zinnia" / "Compress with Zinnia") during Rust setup(), before any
  // window or event listener exists to receive an emitted failure. Poll it
  // once here instead, same as the startup recovery status above, and reuse
  // the toast already wired for the "open-paths-dropped" event so a rejected
  // or unreadable handoff is visible instead of silently opening with no
  // paths.
  void invoke<string | null>("get_shell_handoff_error")
    .then((message) => {
      if (!message) return;
      const detail = `Could not read the file selection from Explorer: ${message}`;
      showToast(detail, "error", 5000);
      log(detail, "error");
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Unable to read shell handoff status: ${msg}`);
    });

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

  // Flatpak has no in-app updater; skip auto-check using the flag resolved
  // before the setup wizard so we do not race a second is_flatpak probe.
  if (!isFlatpak && state.currentSettings.autoCheckUpdates) {
    // Recovery can still be repairing a previous archive transaction. Avoid
    // offering an install/restart until its eventual success or failure is
    // known; the status promise is deliberately non-blocking for the UI.
    void startupRecoveryStatus.catch(() => null).then(() => autoCheckUpdates());
  }

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
  await invoke("mark_main_window_ready").catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to mark main window ready: ${msg}`, "error");
  });

  const appWindow = getCurrentWebviewWindow();
  await appWindow.onDragDropEvent(async (event) => {
    try {
      const isDrop = event.payload.type === "drop";
      // Enter/over/leave still ignore while busy; drops wait on the lock.
      if (!isDrop && (state.running || isIncomingPathBusy())) {
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
      } else if (isDrop) {
        dom.inputList.classList.remove("list--dragover");
        const paths = event.payload.paths;
        if (!paths.length) return;
        await acquireIncomingPathLock();
        try {
          const previousPrimary = state.inputs[0] ?? null;
          const known = new Set(state.inputs);
          let rejected = 0;
          for (const path of paths) {
            if (known.has(path)) continue;
            if (state.inputs.length >= MAX_ARCHIVE_PATHS) {
              rejected += 1;
              continue;
            }
            state.inputs.push(path);
            known.add(path);
          }
          if (
            getMode() === "browse" &&
            (state.inputs[0] ?? null) !== previousPrimary
          ) {
            setBrowsePasswordFieldVisible(false);
          }
          renderInputs();
          if (rejected > 0) {
            const detail = `Added the first ${MAX_ARCHIVE_PATHS} unique items; ${rejected} more were not added.`;
            showToast(detail, "error", 5000);
            log(detail, "error");
          }
          if (getMode() === "browse" && state.inputs.length > 0) {
            // Snapshot before the async archive probe so a concurrent mode or
            // input change cannot browse a different primary after await.
            const primary = state.inputs[0];
            if (
              (await allPathsAreArchives([primary])) === true &&
              getMode() === "browse" &&
              state.inputs[0] === primary
            ) {
              void browseArchive();
            }
          }
        } finally {
          releaseIncomingPathLock();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Drag-drop handler error: ${msg}`);
    }
  });
}
