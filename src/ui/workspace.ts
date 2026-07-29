import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { state, dom } from "../state";
import {
  type WorkspaceMode,
  type UiDensity,
  sanitizePowerWindowSize,
} from "../settings-model";
import { saveSettings } from "../settings";
import { syncWorkspaceWindowFx } from "../window-fx";
import { devLog } from "./log";

export { syncWorkspaceWindowFx } from "../window-fx";

const WORKING_CONTEXT_PERSIST_DEBOUNCE_MS = 140;
const BASIC_WINDOW_WIDTH = 500;
const BASIC_WINDOW_HEIGHT = 650;
let workingContextPersistTimer: number | undefined;
let settingsPersistQueue: Promise<void> = Promise.resolve();
let settingsPersistGeneration = 0;
let workspaceResizeQueue: Promise<void> = Promise.resolve();
let workspaceResizeGeneration = 0;

export interface ContextPersistOptions {
  persist?: boolean;
}

function enqueueSettingsPersist(
  snapshot: typeof state.currentSettings,
  extras: typeof state.settingsExtras,
  generation: number,
): Promise<void> {
  const operation = settingsPersistQueue
    .catch(() => undefined)
    .then(async () => {
      if (generation < settingsPersistGeneration) return;
      await saveSettings(snapshot, extras);
      if (generation === settingsPersistGeneration) {
        state.lastPersistedSettings = { ...snapshot };
      }
    });
  settingsPersistQueue = operation.catch(() => undefined);
  return operation;
}

export async function persistSettingsImmediately(
  snapshot: typeof state.currentSettings,
  extras: typeof state.settingsExtras,
): Promise<void> {
  if (workingContextPersistTimer !== undefined) {
    clearTimeout(workingContextPersistTimer);
    workingContextPersistTimer = undefined;
  }
  const generation = ++settingsPersistGeneration;
  await enqueueSettingsPersist({ ...snapshot }, { ...extras }, generation);
}

export function queuePersistWorkingContext(): void {
  if (workingContextPersistTimer !== undefined) {
    clearTimeout(workingContextPersistTimer);
  }
  const snapshot = { ...state.currentSettings };
  const extras = { ...state.settingsExtras };
  const generation = ++settingsPersistGeneration;
  workingContextPersistTimer = window.setTimeout(() => {
    workingContextPersistTimer = undefined;
    void enqueueSettingsPersist(snapshot, extras, generation).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Failed to persist working context: ${msg}`);
    });
  }, WORKING_CONTEXT_PERSIST_DEBOUNCE_MS);
}

export function getWorkspaceMode(): WorkspaceMode {
  const mode = dom.appEl.dataset.workspaceMode;
  return mode === "power" ? "power" : "basic";
}

export async function resizeWorkspaceWindow(
  mode: WorkspaceMode,
): Promise<void> {
  const generation = ++workspaceResizeGeneration;
  const size =
    mode === "basic"
      ? { width: BASIC_WINDOW_WIDTH, height: BASIC_WINDOW_HEIGHT }
      : sanitizePowerWindowSize(
          state.currentSettings.powerWindowWidth,
          state.currentSettings.powerWindowHeight,
        );
  // Same main window: Basic locks size; Power stays freely resizable.
  const resizable = mode !== "basic";
  syncBasicWindowChrome(resizable);

  const operation = workspaceResizeQueue
    .catch(() => undefined)
    .then(async () => {
      if (generation !== workspaceResizeGeneration) return;
      const appWindow = getCurrentWebviewWindow();
      if (!appWindow || typeof appWindow.setSize !== "function") return;

      try {
        if (!resizable) {
          try {
            if (
              typeof appWindow.isMaximized === "function" &&
              (await appWindow.isMaximized())
            ) {
              await appWindow.unmaximize();
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            devLog(`Unable to unmaximize before locking basic window: ${msg}`);
          }
        }

        if (generation !== workspaceResizeGeneration) return;
        const pending: Promise<unknown>[] = [];
        if (typeof appWindow.setResizable === "function") {
          pending.push(appWindow.setResizable(resizable));
        }
        if (typeof appWindow.setMaximizable === "function") {
          pending.push(appWindow.setMaximizable(resizable));
        }
        pending.push(
          appWindow.setSize(new LogicalSize(size.width, size.height)),
        );
        await Promise.all(pending);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        devLog(`Unable to resize ${mode} workspace window: ${msg}`);
      }
    });
  workspaceResizeQueue = operation;
  await operation;
}

function syncBasicWindowChrome(resizable: boolean): void {
  const maxBtn = document.getElementById(
    "titlebar-max",
  ) as HTMLButtonElement | null;
  if (!maxBtn) return;
  maxBtn.disabled = !resizable;
  maxBtn.setAttribute("aria-disabled", String(!resizable));
  maxBtn.title = resizable
    ? "Maximize"
    : "Maximize is unavailable in Basic mode";
}

export function setWorkspaceMode(
  mode: WorkspaceMode,
  options: ContextPersistOptions = {},
): void {
  const previousMode = getWorkspaceMode();
  if ((state.running || state.operationPreparing) && mode !== previousMode) {
    // Keep settings and rendered workspace coherent until the active command's
    // completion hooks have cleaned up the workspace that started it.
    state.currentSettings.workspaceMode = previousMode;
    return;
  }
  dom.appEl.dataset.workspaceMode = mode;
  document.querySelectorAll("[data-workspace-mode-btn]").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    const isActive = el.dataset.workspaceModeBtn === mode;
    el.classList.toggle("is-active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });
  state.currentSettings.workspaceMode = mode;
  if (options.persist !== false && previousMode !== mode) {
    queuePersistWorkingContext();
  }

  void resizeWorkspaceWindow(mode);
  void syncWorkspaceWindowFx();
}

export function getUiDensity(): UiDensity {
  const density = dom.appEl.dataset.density;
  return density === "compact" ? "compact" : "comfortable";
}

export function setUiDensity(
  density: UiDensity,
  options: ContextPersistOptions = {},
): void {
  const previousDensity = getUiDensity();
  dom.appEl.dataset.density = density;
  const compactEnabled = density === "compact";
  const toggle = document.getElementById(
    "toggle-density",
  ) as HTMLButtonElement | null;
  if (toggle) {
    toggle.classList.toggle("is-active", compactEnabled);
    toggle.setAttribute("aria-pressed", String(compactEnabled));
    toggle.textContent = compactEnabled ? "Comfortable" : "Compact";
  }
  state.currentSettings.uiDensity = density;
  if (options.persist !== false && previousDensity !== density) {
    queuePersistWorkingContext();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    if (getWorkspaceMode() === "power") {
      state.currentSettings.powerWindowWidth = window.innerWidth;
      state.currentSettings.powerWindowHeight = window.innerHeight;
      queuePersistWorkingContext();
    }
  });
}
