import { $ } from "./utils";

export interface UserSettings {
  theme: string;
  format: string;
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
  threads: number;
  pathMode: string;
  sfx: boolean;
  encryptHeaders: boolean;
  deleteAfter: boolean;
  autoCheckUpdates: boolean;
}

export let SETTING_DEFAULTS: UserSettings = {
  theme: "system",
  format: "7z",
  level: "5",
  method: "lzma2",
  dict: "256m",
  wordSize: "64",
  solid: "16g",
  threads: 8,
  pathMode: "relative",
  sfx: false,
  encryptHeaders: false,
  deleteAfter: false,
  autoCheckUpdates: true,
};

export const state = {
  currentSettings: { ...SETTING_DEFAULTS } as UserSettings,
  inputs: [] as string[],
  running: false,
  batchCancelled: false,
  statusTimeout: undefined as number | undefined,
  osIntegrationEnabled: false,
  platformName: "",
  appIsPackaged: false,
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
