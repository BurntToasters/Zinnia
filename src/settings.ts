import { invoke } from "@tauri-apps/api/core";
import { $, parseThreads, trapFocus, releaseFocusTrap } from "./utils";
import { state } from "./state";
import {
  LoadSettingsResult,
  UserSettings,
  SETTING_DEFAULTS,
  mergeSettingsPayload,
  parseSettingsRaw,
} from "./settings-model";
import { getCompressionSecuritySupport } from "./compression-security";

export function applyTheme(pref: string) {
  const resolved =
    pref === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : pref;
  document.documentElement.setAttribute("data-theme", resolved);
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
  $<HTMLSelectElement>("path-mode").value = state.currentSettings.pathMode;
  $<HTMLInputElement>("sfx").checked = state.currentSettings.sfx;
  $<HTMLInputElement>("encrypt-headers").checked =
    state.currentSettings.encryptHeaders;
  $<HTMLInputElement>("delete-after").checked =
    state.currentSettings.deleteAfter;
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
  $<HTMLSelectElement>("s-path-mode").value = state.currentSettings.pathMode;
  $<HTMLInputElement>("s-sfx").checked = state.currentSettings.sfx;
  $<HTMLInputElement>("s-encrypt-headers").checked =
    state.currentSettings.encryptHeaders;
  $<HTMLInputElement>("s-delete-after").checked =
    state.currentSettings.deleteAfter;
  $<HTMLInputElement>("s-auto-check-updates").checked =
    state.currentSettings.autoCheckUpdates;
  $<HTMLSelectElement>("s-update-channel").value =
    state.currentSettings.updateChannel;
  $<HTMLInputElement>("s-local-logging").checked =
    state.currentSettings.localLoggingEnabled;
  $<HTMLSelectElement>("s-log-verbosity").value =
    state.currentSettings.logVerbosity;
  syncSettingsSecurityControlsForFormat(state.currentSettings.format);

  const logDir = document.getElementById("s-log-dir");
  if (logDir) {
    logDir.textContent = state.logDirectory || "Unavailable";
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
    pathMode: $<HTMLSelectElement>("s-path-mode")
      .value as UserSettings["pathMode"],
    sfx: $<HTMLInputElement>("s-sfx").checked,
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
  };
}

export function openSettingsModal() {
  populateSettingsModal();
  const overlay = $("settings-overlay");
  overlay.hidden = false;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) trapFocus(modal);
}

export function closeSettingsModal() {
  const overlay = $("settings-overlay");
  overlay.hidden = true;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
}
