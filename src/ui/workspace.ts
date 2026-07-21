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
  const appWindow = getCurrentWebviewWindow();
  if (!appWindow || typeof appWindow.setSize !== "function") return;

  const size =
    mode === "basic"
      ? { width: BASIC_WINDOW_WIDTH, height: BASIC_WINDOW_HEIGHT }
      : sanitizePowerWindowSize(
          state.currentSettings.powerWindowWidth,
          state.currentSettings.powerWindowHeight,
        );

  try {
    await appWindow.setSize(new LogicalSize(size.width, size.height));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Unable to resize ${mode} workspace window: ${msg}`);
  }
}

export function setWorkspaceMode(
  mode: WorkspaceMode,
  options: ContextPersistOptions = {},
): void {
  const previousMode = getWorkspaceMode();
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
