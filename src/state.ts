import { $ } from "./utils";
import { SETTING_DEFAULTS, UserSettings } from "./settings-model";

export { SETTING_DEFAULTS };
export type { UserSettings };

export const state = {
  currentSettings: { ...SETTING_DEFAULTS } as UserSettings,
  lastPersistedSettings: { ...SETTING_DEFAULTS } as UserSettings,
  settingsExtras: {} as Record<string, unknown>,
  inputs: [] as string[],
  running: false,
  batchCancelled: false,
  cancelRequested: false,
  statusTimeout: undefined as number | undefined,
  osIntegrationEnabled: false,
  platformName: "",
  appIsPackaged: false,
  logDirectory: "",
  lastAutoExtractDestination: null as string | null,
};

export const dom = {
  inputList: $("input-list"),
  logEl: $("log"),
  statusEl: $("status"),
  progressEl: $("progress"),
  versionLabel: $("version-label"),
  platformLabel: $("platform-label"),
  appEl: $("app"),
  gridEl: document.querySelector<HTMLElement>(".grid")!,
  runBtn: $<HTMLButtonElement>("run-action"),
  cancelBtn: $<HTMLButtonElement>("cancel-action"),
  extractRunBtn: $<HTMLButtonElement>("extract-run"),
  extractCancelBtn: $<HTMLButtonElement>("extract-cancel"),
};
