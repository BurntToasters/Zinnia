import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { $, parseThreads, trapFocus, releaseFocusTrap } from "./utils";
import { state } from "./state";
import {
  LoadSettingsResult,
  UserSettings,
  SETTING_DEFAULTS,
  COMPRESSION_METHODS_BY_FORMAT,
  mergeSettingsPayload,
  normalizeAutoCloseDelay,
  parseSettingsRaw,
} from "./settings-model";
import { getCompressionSecuritySupport } from "./compression-security";
import { getDefaultThreads } from "./window-events";
import { syncWorkspaceWindowFx } from "./window-fx";
import { confirmWithE2eQueue } from "./e2e-dialog";

const METHOD_LABELS: Record<string, string> = {
  lzma2: "LZMA2",
  lzma: "LZMA",
  deflate: "Deflate",
};

export const DISCARD_SETTINGS_TITLE = "Discard unsaved settings";

let settingsModalBasicWindowEffects: boolean | null = null;
/** Modal values when it opened; a different value on close means unsaved edits. */
let settingsSnapshotOnOpen: string | null = null;
let discardPromptOpen = false;

export function applyTheme(pref: string) {
  const resolved =
    pref === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  void syncWorkspaceWindowFx();
}

export async function loadSettings(): Promise<UserSettings> {
  const result = await loadSettingsWithMetadata();
  return result.settings;
}

export async function loadSettingsWithMetadata(): Promise<LoadSettingsResult> {
  try {
    const raw = await invoke<string>("load_settings");
    return parseSettingsRaw(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      settings: { ...SETTING_DEFAULTS },
      extras: {},
      malformed: true,
      warning: `Settings file could not be read (${msg}). Defaults were loaded.`,
    };
  }
}

export async function saveSettings(
  settings: UserSettings,
  extras: Record<string, unknown> = {},
): Promise<void> {
  await invoke("save_settings", {
    json: JSON.stringify(mergeSettingsPayload(settings, extras)),
  });
}

export function applySettingsToForm() {
  $<HTMLSelectElement>("format").value = state.currentSettings.format;
  $<HTMLSelectElement>("level").value = state.currentSettings.level;
  $<HTMLSelectElement>("method").value = state.currentSettings.method;
  $<HTMLSelectElement>("dict").value = state.currentSettings.dict;
  $<HTMLSelectElement>("word-size").value = state.currentSettings.wordSize;
  $<HTMLSelectElement>("solid").value = state.currentSettings.solid;
  $<HTMLInputElement>("threads").value = String(state.currentSettings.threads);
  $<HTMLInputElement>("encrypt-headers").checked =
    state.currentSettings.encryptHeaders;
}

type CompressionFormValues = {
  format: UserSettings["format"];
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
  threads: string;
  encryptHeaders: boolean;
};

function liveOrFallback(live: string | undefined, fallback: string): string {
  return live && live.length > 0 ? live : fallback;
}

function savedCompressionValues(): CompressionFormValues {
  const saved = state.currentSettings;
  return {
    format: saved.format,
    level: saved.level,
    method: saved.method,
    dict: saved.dict,
    wordSize: saved.wordSize,
    solid: saved.solid,
    threads: String(saved.threads),
    encryptHeaders: saved.encryptHeaders,
  };
}

function sessionCompressionValues(): CompressionFormValues {
  const saved = savedCompressionValues();
  const select = (id: string) =>
    document.getElementById(id) as HTMLSelectElement | null;
  const input = (id: string) =>
    document.getElementById(id) as HTMLInputElement | null;
  return {
    format: liveOrFallback(
      select("format")?.value,
      saved.format,
    ) as UserSettings["format"],
    level: liveOrFallback(select("level")?.value, saved.level),
    method: liveOrFallback(select("method")?.value, saved.method),
    dict: liveOrFallback(select("dict")?.value, saved.dict),
    wordSize: liveOrFallback(select("word-size")?.value, saved.wordSize),
    solid: liveOrFallback(select("solid")?.value, saved.solid),
    threads: liveOrFallback(input("threads")?.value, saved.threads),
    encryptHeaders: input("encrypt-headers")?.checked ?? saved.encryptHeaders,
  };
}

/**
 * Rebuild the Settings method list for a format, as the main form does.
 * Formats without a method choice get a disabled N/A option.
 */
export function syncSettingsMethodOptions(
  format: UserSettings["format"],
  preferred: string,
): void {
  const select = $<HTMLSelectElement>("s-method");
  const methods = COMPRESSION_METHODS_BY_FORMAT[format];
  select.replaceChildren();
  if (methods.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "N/A";
    select.appendChild(option);
    select.value = "";
    select.disabled = true;
    return;
  }
  for (const method of methods) {
    const option = document.createElement("option");
    option.value = method;
    option.textContent = METHOD_LABELS[method] ?? method;
    select.appendChild(option);
  }
  select.value = methods.includes(preferred) ? preferred : methods[0];
  select.disabled = false;
}

/** Re-filter the method list after the Settings format select changes. */
export function syncSettingsMethodForSelectedFormat(): void {
  const format = $<HTMLSelectElement>("s-format")
    .value as UserSettings["format"];
  syncSettingsMethodOptions(format, $<HTMLSelectElement>("s-method").value);
}

function writeCompressionValuesToModal(values: CompressionFormValues) {
  $<HTMLSelectElement>("s-format").value = values.format;
  $<HTMLSelectElement>("s-level").value = values.level;
  syncSettingsMethodOptions(values.format, values.method);
  $<HTMLSelectElement>("s-dict").value = values.dict;
  $<HTMLSelectElement>("s-word-size").value = values.wordSize;
  $<HTMLSelectElement>("s-solid").value = values.solid;
  $<HTMLInputElement>("s-threads").value = values.threads;
  $<HTMLInputElement>("s-encrypt-headers").checked = values.encryptHeaders;
  syncSettingsSecurityControlsForFormat(values.format);
}

export function useSessionCompressionValues() {
  writeCompressionValuesToModal(sessionCompressionValues());
}

export function populateSettingsModal() {
  $<HTMLSelectElement>("s-theme").value = state.currentSettings.theme;
  writeCompressionValuesToModal(savedCompressionValues());
  $<HTMLInputElement>("s-auto-check-updates").checked =
    state.currentSettings.autoCheckUpdates;
  $<HTMLSelectElement>("s-update-channel").value =
    state.currentSettings.updateChannel;
  $<HTMLInputElement>("s-local-logging").checked =
    state.currentSettings.localLoggingEnabled;
  $<HTMLSelectElement>("s-log-verbosity").value =
    state.currentSettings.logVerbosity;
  $<HTMLSelectElement>("s-workspace-mode").value =
    state.currentSettings.workspaceMode;
  $<HTMLSelectElement>("s-ui-density").value = state.currentSettings.uiDensity;
  $<HTMLInputElement>("s-os-integration-dismissed").checked =
    state.currentSettings.osIntegrationDismissed;
  $<HTMLInputElement>("s-quick-extract-keep-warm").checked =
    state.currentSettings.quickExtractKeepWarm;
  $<HTMLSelectElement>("s-quick-extract-warm-idle").value = String(
    state.currentSettings.quickExtractWarmIdleMinutes,
  );
  $<HTMLSelectElement>("s-extract-auto-close").value = String(
    state.currentSettings.extractAutoCloseSeconds,
  );
  const basicFx = document.getElementById(
    "s-basic-window-effects",
  ) as HTMLInputElement | null;
  if (basicFx) {
    basicFx.checked = state.currentSettings.basicWindowEffects;
  }
  syncQuickExtractWarmIdleControl();
  void syncBasicWindowEffectsVisibility();

  const logDir = document.getElementById("s-log-dir");
  if (logDir) {
    const text = state.logDirectory || "Unavailable";
    logDir.textContent = text;
    logDir.title = state.logDirectory ? state.logDirectory : "";
  }
}

export function syncSettingsSecurityControlsForFormat(
  format: UserSettings["format"],
) {
  const support = getCompressionSecuritySupport(format);
  const encryptHeadersCheckbox = $<HTMLInputElement>("s-encrypt-headers");
  if (!support.encryptHeaders) {
    encryptHeadersCheckbox.checked = false;
  }
  encryptHeadersCheckbox.disabled = !support.encryptHeaders;
}

export function readSettingsModal(): UserSettings {
  const format = $<HTMLSelectElement>("s-format")
    .value as UserSettings["format"];
  const securitySupport = getCompressionSecuritySupport(format);
  return {
    theme: $<HTMLSelectElement>("s-theme").value as UserSettings["theme"],
    format,
    level: $<HTMLSelectElement>("s-level").value,
    method: $<HTMLSelectElement>("s-method").value,
    dict: $<HTMLSelectElement>("s-dict").value,
    wordSize: $<HTMLSelectElement>("s-word-size").value,
    solid: $<HTMLSelectElement>("s-solid").value,
    threads: parseThreads(
      $<HTMLInputElement>("s-threads").value,
      getDefaultThreads(),
    ),
    encryptHeaders:
      securitySupport.encryptHeaders &&
      $<HTMLInputElement>("s-encrypt-headers").checked,
    autoCheckUpdates: $<HTMLInputElement>("s-auto-check-updates").checked,
    updateChannel: $<HTMLSelectElement>("s-update-channel")
      .value as UserSettings["updateChannel"],
    localLoggingEnabled: $<HTMLInputElement>("s-local-logging").checked,
    logVerbosity: $<HTMLSelectElement>("s-log-verbosity")
      .value as UserSettings["logVerbosity"],
    lastMode: state.currentSettings.lastMode,
    debug: state.currentSettings.debug,
    debugConsolePoppedOut: state.currentSettings.debugConsolePoppedOut,
    showActivityPanel: state.currentSettings.showActivityPanel,
    workspaceMode: $<HTMLSelectElement>("s-workspace-mode")
      .value as UserSettings["workspaceMode"],
    uiDensity: $<HTMLSelectElement>("s-ui-density")
      .value as UserSettings["uiDensity"],
    osIntegrationDismissed: $<HTMLInputElement>("s-os-integration-dismissed")
      .checked,
    quickExtractKeepWarm: $<HTMLInputElement>("s-quick-extract-keep-warm")
      .checked,
    quickExtractWarmIdleMinutes: parseWarmIdleMinutes(
      $<HTMLSelectElement>("s-quick-extract-warm-idle").value,
      SETTING_DEFAULTS.quickExtractWarmIdleMinutes,
    ),
    extractAutoCloseSeconds: normalizeAutoCloseDelay(
      $<HTMLSelectElement>("s-extract-auto-close").value,
      state.currentSettings.extractAutoCloseSeconds,
    ),
    basicWindowEffects: (() => {
      const el = document.getElementById(
        "s-basic-window-effects",
      ) as HTMLInputElement | null;
      return el ? el.checked : state.currentSettings.basicWindowEffects;
    })(),
    customPresets: state.currentSettings.customPresets,
    powerWindowWidth: state.currentSettings.powerWindowWidth,
    powerWindowHeight: state.currentSettings.powerWindowHeight,
    setupComplete: state.currentSettings.setupComplete,
  };
}

function parseWarmIdleMinutes(raw: string, fallback: number): number {
  const n = Number(raw);
  if (n === 5 || n === 10 || n === 30 || n === 60) return n;
  return fallback;
}

export function syncQuickExtractWarmIdleControl(): void {
  const enabled = $<HTMLInputElement>("s-quick-extract-keep-warm").checked;
  $<HTMLSelectElement>("s-quick-extract-warm-idle").disabled = !enabled;
}

export async function syncBasicWindowEffectsVisibility(): Promise<void> {
  const row = document.getElementById("setting-basic-window-effects");
  if (!row) return;
  let supports = false;
  try {
    supports = await invoke<boolean>("supports_workspace_window_fx");
  } catch {
    supports = false;
  }
  row.hidden = !supports;
}

export function openSettingsModal() {
  if (
    state.running ||
    state.operationPreparing ||
    state.incomingPathsApplying
  ) {
    return;
  }
  const overlay = $("settings-overlay");
  if (!overlay.hidden) return;

  settingsModalBasicWindowEffects ??= state.currentSettings.basicWindowEffects;
  populateSettingsModal();
  const keepWarm = document.getElementById(
    "s-quick-extract-keep-warm",
  ) as HTMLInputElement | null;
  if (keepWarm && !keepWarm.dataset.warmIdleBound) {
    keepWarm.dataset.warmIdleBound = "1";
    keepWarm.addEventListener("change", () => {
      syncQuickExtractWarmIdleControl();
    });
  }
  const basicFx = document.getElementById(
    "s-basic-window-effects",
  ) as HTMLInputElement | null;
  if (basicFx && !basicFx.dataset.liveFxBound) {
    basicFx.dataset.liveFxBound = "1";
    basicFx.addEventListener("change", () => {
      state.currentSettings.basicWindowEffects = basicFx.checked;
      void syncWorkspaceWindowFx();
    });
  }
  settingsSnapshotOnOpen = currentSettingsSnapshot();
  overlay.hidden = false;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) {
    trapFocus(modal);
    const activeTab = modal.querySelector<HTMLElement>(
      ".settings-tab.is-active",
    );
    activeTab?.focus();
  }
}

function currentSettingsSnapshot(): string {
  return JSON.stringify(readSettingsModal());
}

function hasUnsavedSettingsEdits(): boolean {
  return (
    settingsSnapshotOnOpen !== null &&
    currentSettingsSnapshot() !== settingsSnapshotOnOpen
  );
}

export type CloseSettingsOptions = {
  preserveLivePreview?: boolean;
  /** Set by Save: the modal values were just persisted, so nothing is discarded. */
  saved?: boolean;
  discardConfirmed?: boolean;
};

/** Ask before dropping unsaved edits. Resolves false when the user keeps editing. */
async function confirmDiscardSettingsEdits(): Promise<boolean> {
  if (discardPromptOpen) return false;
  discardPromptOpen = true;
  try {
    return await confirmWithE2eQueue(
      () =>
        ask("Your changes to Settings have not been saved. Discard them?", {
          title: DISCARD_SETTINGS_TITLE,
          kind: "warning",
          okLabel: "Discard",
          cancelLabel: "Keep editing",
        }),
      DISCARD_SETTINGS_TITLE,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not ask about discarding Settings edits: ${msg}`);
    return false;
  } finally {
    discardPromptOpen = false;
  }
}

/**
 * Close Settings, asking first when the modal has unsaved edits. Resolves true
 * once the modal is closed and false when the user keeps editing.
 */
export async function requestCloseSettingsModal(
  options: CloseSettingsOptions = {},
): Promise<boolean> {
  if (options.saved || options.discardConfirmed || !hasUnsavedSettingsEdits()) {
    closeSettingsModal(options);
    return true;
  }
  if (!(await confirmDiscardSettingsEdits())) return false;
  closeSettingsModal({ ...options, discardConfirmed: true });
  return true;
}

export function toggleSettingsModal() {
  if ($("settings-overlay").hidden) {
    openSettingsModal();
  } else {
    closeSettingsModal();
  }
}

export function closeSettingsModal(options: CloseSettingsOptions = {}) {
  if (
    !options.saved &&
    !options.discardConfirmed &&
    hasUnsavedSettingsEdits()
  ) {
    void requestCloseSettingsModal(options);
    return;
  }
  settingsSnapshotOnOpen = null;
  if (
    !options.preserveLivePreview &&
    settingsModalBasicWindowEffects !== null
  ) {
    state.currentSettings.basicWindowEffects = settingsModalBasicWindowEffects;
    void syncWorkspaceWindowFx();
  }
  settingsModalBasicWindowEffects = null;
  const overlay = $("settings-overlay");
  overlay.hidden = true;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
  const trigger = document.getElementById("open-settings");
  trigger?.focus();
}
