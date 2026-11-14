import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isE2eFrontend } from "../e2e-env";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { state, dom } from "../state";
import {
  type WorkspaceMode,
  type UiDensity,
  sanitizePowerWindowSize,
} from "../settings-model";
import {
  isSettingsFileUnreadable,
  persistableSettingsSnapshot,
  saveSettings,
  takeSettingsReplacementPermit,
} from "../settings";
import { syncWorkspaceWindowFx } from "../window-fx";
import { showToast } from "../toast";
import { devLog } from "./log";

export { syncWorkspaceWindowFx } from "../window-fx";

const WORKING_CONTEXT_PERSIST_DEBOUNCE_MS = 140;
const BASIC_WINDOW_WIDTH = 500;
const BASIC_WINDOW_HEIGHT = 650;
let workingContextPersistTimer: number | undefined;
let settingsPersistQueue: Promise<void> = Promise.resolve();
let settingsPersistGeneration = 0;
let workingContextFailureReported = false;
type WorkspaceModeListener = (mode: WorkspaceMode) => void;
const workspaceModeListeners = new Set<WorkspaceModeListener>();

export function onWorkspaceModeChange(listener: WorkspaceModeListener): void {
  workspaceModeListeners.add(listener);
}

export class SettingsPersistSupersededError extends Error {
  constructor() {
    super("Settings save was superseded by a newer save.");
    this.name = "SettingsPersistSupersededError";
  }
}

export function isSettingsPersistSupersededError(err: unknown): boolean {
  return err instanceof SettingsPersistSupersededError;
}
let workspaceResizeQueue: Promise<void> = Promise.resolve();
let workspaceResizeGeneration = 0;

export interface ContextPersistOptions {
  persist?: boolean;
}

function enqueueSettingsPersist(
  snapshot: typeof state.currentSettings,
  extras: typeof state.settingsExtras,
  generation: number,
  replacementAllowed: boolean,
): Promise<void> {
  const operation = settingsPersistQueue
    .catch(() => undefined)
    .then(async () => {
      if (generation < settingsPersistGeneration) {
        throw new SettingsPersistSupersededError();
      }
      await saveSettings(snapshot, extras, { replacementAllowed });
      if (generation !== settingsPersistGeneration) {
        throw new SettingsPersistSupersededError();
      }
      state.lastPersistedSettings = { ...snapshot };
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
  const replacementAllowed = takeSettingsReplacementPermit();
  const generation = ++settingsPersistGeneration;
  await enqueueSettingsPersist(
    { ...snapshot },
    { ...extras },
    generation,
    replacementAllowed,
  );
}

/**
 * Stop debounced settings writes and wait for any write already in flight.
 * Reset-settings uses this barrier before deleting backend settings so a stale
 * frontend snapshot cannot be written back after the reset completes.
 */
/**
 * Wait for queued or in-flight settings writes without bumping generation
 * (unlike flushPendingSettingsPersistence, which cancels stale snapshots).
 */
export async function awaitInFlightSettingsPersistence(): Promise<void> {
  await settingsPersistQueue.catch(() => undefined);
}

export async function flushPendingSettingsPersistence(): Promise<void> {
  if (workingContextPersistTimer !== undefined) {
    clearTimeout(workingContextPersistTimer);
    workingContextPersistTimer = undefined;
  }
  settingsPersistGeneration += 1;
  await settingsPersistQueue.catch(() => undefined);
}

export function queuePersistWorkingContext(): void {
  if (workingContextPersistTimer !== undefined) {
    clearTimeout(workingContextPersistTimer);
    workingContextPersistTimer = undefined;
  }
  if (isSettingsFileUnreadable()) return;
  const snapshot = persistableSettingsSnapshot();
  const extras = { ...state.settingsExtras };
  const generation = ++settingsPersistGeneration;
  workingContextPersistTimer = window.setTimeout(() => {
    workingContextPersistTimer = undefined;
    if (isSettingsFileUnreadable()) return;
    void enqueueSettingsPersist(snapshot, extras, generation, false)
      .then(() => {
        workingContextFailureReported = false;
      })
      .catch((err) => {
        if (isSettingsPersistSupersededError(err)) return;
        const msg = err instanceof Error ? err.message : String(err);
        devLog(`Failed to persist working context: ${msg}`);
        if (workingContextFailureReported) return;
        workingContextFailureReported = true;
        showToast(`Could not save settings. ${msg}`, "error", 0);
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
  const resizable = mode !== "basic";
  syncBasicWindowChrome(resizable);
  if (isE2eFrontend()) return;
  const generation = ++workspaceResizeGeneration;
  const size =
    mode === "basic"
      ? { width: BASIC_WINDOW_WIDTH, height: basicWindowHeight() }
      : sanitizePowerWindowSize(
          state.currentSettings.powerWindowWidth,
          state.currentSettings.powerWindowHeight,
        );
  // Same main window: Basic locks size; Power stays freely resizable.

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

function basicWindowHeight(): number {
  const available = window.screen?.availHeight;
  if (
    typeof available === "number" &&
    Number.isFinite(available) &&
    available > 0
  ) {
    return Math.min(BASIC_WINDOW_HEIGHT, Math.floor(available));
  }
  return BASIC_WINDOW_HEIGHT;
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
  const workspaceSelect = document.getElementById(
    "s-workspace-mode",
  ) as HTMLSelectElement | null;
  if (workspaceSelect) workspaceSelect.value = mode;
  for (const listener of workspaceModeListeners) listener(mode);
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
  }
  state.currentSettings.uiDensity = density;
  const densitySelect = document.getElementById(
    "s-ui-density",
  ) as HTMLSelectElement | null;
  if (densitySelect) densitySelect.value = density;
  if (options.persist !== false && previousDensity !== density) {
    queuePersistWorkingContext();
  }
}

let powerWindowSizeSeq = 0;
// The OS animates maximize and restore for a few hundred milliseconds, and the
// resize events can end before the final size is reported. Sample until two
// reads agree, so the saved size is the settled one.
const POWER_SIZE_SETTLE_MS = 150;
const POWER_SIZE_SETTLE_ATTEMPTS = 12;

/**
 * Saves the Power size only once the window is normal and its size has settled.
 * A maximized or fullscreen size would restore as a very large normal window.
 * When the state cannot be read, nothing is saved.
 */
async function savePowerWindowSizeWhenSettled(seq: number): Promise<void> {
  let previous: { width: number; height: number } | null = null;
  for (let attempt = 0; attempt < POWER_SIZE_SETTLE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, POWER_SIZE_SETTLE_MS),
      );
    }
    if (seq !== powerWindowSizeSeq || getWorkspaceMode() !== "power") return;
    let normal: boolean;
    try {
      const appWindow = getCurrentWebviewWindow();
      const [maximized, fullscreen] = await Promise.all([
        appWindow.isMaximized(),
        appWindow.isFullscreen(),
      ]);
      normal = !maximized && !fullscreen;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Skipped saving Power window size: ${msg}`);
      return;
    }
    // A newer resize owns the decision now.
    if (seq !== powerWindowSizeSeq) return;
    if (!normal) {
      previous = null;
      continue;
    }
    // Read after the state answer: the size captured at event time can be
    // mid-animation by now.
    const sample = { width: window.innerWidth, height: window.innerHeight };
    if (
      previous?.width === sample.width &&
      previous?.height === sample.height
    ) {
      state.currentSettings.powerWindowWidth = sample.width;
      state.currentSettings.powerWindowHeight = sample.height;
      queuePersistWorkingContext();
      return;
    }
    previous = sample;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    if (getWorkspaceMode() !== "power") return;
    const seq = ++powerWindowSizeSeq;
    void savePowerWindowSizeWhenSettled(seq);
  });
}
