import { invoke } from "@tauri-apps/api/core";
import { $, parseThreads } from "./utils";
import { UserSettings, SETTING_DEFAULTS, state } from "./state";

export function applyTheme(pref: string) {
  const resolved = pref === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : pref;
  document.documentElement.setAttribute("data-theme", resolved);
}

export async function loadSettings(): Promise<UserSettings> {
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return { ...SETTING_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTING_DEFAULTS };
  }
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await invoke("save_settings", { json: JSON.stringify(settings) });
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
  $<HTMLInputElement>("encrypt-headers").checked = state.currentSettings.encryptHeaders;
  $<HTMLInputElement>("delete-after").checked = state.currentSettings.deleteAfter;
}

export function populateSettingsModal() {
  $<HTMLSelectElement>("s-theme").value = state.currentSettings.theme;
  $<HTMLSelectElement>("s-format").value = state.currentSettings.format;
  $<HTMLSelectElement>("s-level").value = state.currentSettings.level;
  $<HTMLSelectElement>("s-method").value = state.currentSettings.method;
  $<HTMLSelectElement>("s-dict").value = state.currentSettings.dict;
  $<HTMLSelectElement>("s-word-size").value = state.currentSettings.wordSize;
  $<HTMLSelectElement>("s-solid").value = state.currentSettings.solid;
  $<HTMLInputElement>("s-threads").value = String(state.currentSettings.threads);
  $<HTMLSelectElement>("s-path-mode").value = state.currentSettings.pathMode;
  $<HTMLInputElement>("s-sfx").checked = state.currentSettings.sfx;
  $<HTMLInputElement>("s-encrypt-headers").checked = state.currentSettings.encryptHeaders;
  $<HTMLInputElement>("s-delete-after").checked = state.currentSettings.deleteAfter;
  $<HTMLInputElement>("s-auto-check-updates").checked = state.currentSettings.autoCheckUpdates;
}

export function readSettingsModal(): UserSettings {
  return {
    theme: $<HTMLSelectElement>("s-theme").value,
    format: $<HTMLSelectElement>("s-format").value,
    level: $<HTMLSelectElement>("s-level").value,
    method: $<HTMLSelectElement>("s-method").value,
    dict: $<HTMLSelectElement>("s-dict").value,
    wordSize: $<HTMLSelectElement>("s-word-size").value,
    solid: $<HTMLSelectElement>("s-solid").value,
    threads: parseThreads($<HTMLInputElement>("s-threads").value, SETTING_DEFAULTS.threads),
    pathMode: $<HTMLSelectElement>("s-path-mode").value,
    sfx: $<HTMLInputElement>("s-sfx").checked,
    encryptHeaders: $<HTMLInputElement>("s-encrypt-headers").checked,
    deleteAfter: $<HTMLInputElement>("s-delete-after").checked,
    autoCheckUpdates: $<HTMLInputElement>("s-auto-check-updates").checked,
  };
}

export function openSettingsModal() {
  populateSettingsModal();
  $("settings-overlay").hidden = false;
}

export function closeSettingsModal() {
  $("settings-overlay").hidden = true;
}
