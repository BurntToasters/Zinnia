import { invoke } from "@tauri-apps/api/core";
import { $, parseThreads, trapFocus, releaseFocusTrap } from "./utils";
import { state } from "./state";
import {
  LoadSettingsResult,
  UserSettings,
  SETTING_DEFAULTS,
  mergeSettingsPayload,
  normalizeAutoCloseDelay,
  parseSettingsRaw,
} from "./settings-model";
import { getCompressionSecuritySupport } from "./compression-security";
import { syncWorkspaceWindowFx } from "./window-fx";

let settingsModalBasicWindowEffects: boolean | null = null;

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
  $<HTMLInputElement>("path-mode").value = "relative";
  $<HTMLInputElement>("sfx").checked = false;
  $<HTMLInputElement>("sfx").disabled = true;
  $<HTMLInputElement>("encrypt-headers").checked =
    state.currentSettings.encryptHeaders;
  $<HTMLInputElement>("delete-after").checked = false;
}

export function populateSettingsModal() {
  $<HTMLSelectElement>("s-theme").value = state.currentSettings.theme;
  $<HTMLSelectElement>("s-format").value = state.currentSettings.format;
  $<HTMLSelectElement>("s-level").value = state.currentSettings.level;
  $<HTMLSelectElement>("s-method").value = state.currentSettings.method;
  $<HTMLSelectElement>("s-dict").value = state.currentSettings.dict;
  $<HTMLSelectElement>("s-word-size").value = state.currentSettings.wordSize;
  $<HTMLSelectElement>("s-solid").value = state.currentSettings.solid;
  $<HTMLInputElement>("s-threads").value = String(
    state.currentSettings.threads,
  );
  $<HTMLInputElement>("s-path-mode").value = "relative";
  $<HTMLInputElement>("s-sfx").checked = false;
  $<HTMLInputElement>("s-sfx").disabled = true;
  $<HTMLInputElement>("s-encrypt-headers").checked =
    state.currentSettings.encryptHeaders;
  $<HTMLInputElement>("s-delete-after").checked = false;
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
  syncSettingsSecurityControlsForFormat(state.currentSettings.format);
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
      SETTING_DEFAULTS.threads,
    ),
    // Absolute member paths make archives non-relocatable and fail Zinnia's
    // secure extraction preflight. Preserve the setting only for migration.
    pathMode: "relative",
    sfx: false,
    encryptHeaders:
      securitySupport.encryptHeaders &&
      $<HTMLInputElement>("s-encrypt-headers").checked,
    deleteAfter: $<HTMLInputElement>("s-delete-after").checked,
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

function syncSettingsTriggerState(open: boolean) {
  const trigger = document.getElementById("open-settings");
  if (!trigger) return;
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
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
  overlay.hidden = false;
  syncSettingsTriggerState(true);
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) {
    trapFocus(modal);
    const activeTab = modal.querySelector<HTMLElement>(
      ".settings-tab.is-active",
    );
    activeTab?.focus();
  }
}

export function toggleSettingsModal() {
  if ($("settings-overlay").hidden) {
    openSettingsModal();
  } else {
    closeSettingsModal();
  }
}

export function closeSettingsModal(
  options: { preserveLivePreview?: boolean } = {},
) {
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
  syncSettingsTriggerState(false);
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
  const trigger = document.getElementById("open-settings");
  trigger?.focus();
}
