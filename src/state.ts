import { $ } from "./utils";
import { SETTING_DEFAULTS, UserSettings } from "./settings-model";
import type { ArchiveInfo } from "./browse-model";

export { SETTING_DEFAULTS };
export type { UserSettings };

const MAX_CACHED_ARCHIVES = 10;

export type InputValidationState = "unknown" | "valid" | "invalid";

export interface InputValidationInfo {
  state: InputValidationState;
  reason?: string;
  reasonShort?: string;
}

export type QuickActionMode = "add" | "extract" | "browse";
export type LastQuickActionByMode = Partial<Record<QuickActionMode, string>>;

function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function cacheBrowseInfo(archive: string, info: ArchiveInfo): void {
  evictOldest(state.browseArchiveInfoByPath, MAX_CACHED_ARCHIVES);
  state.browseArchiveInfoByPath.set(archive, info);
}

export function cacheSelection(archive: string, set: Set<string>): void {
  evictOldest(state.browseSelectionsByArchive, MAX_CACHED_ARCHIVES);
  state.browseSelectionsByArchive.set(archive, set);
}

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
  lastAutoOutputPath: null as string | null,
  browseArchiveInfoByPath: new Map<string, ArchiveInfo>(),
  browseSelectionsByArchive: new Map<string, Set<string>>(),
  selectiveSearchQuery: "",
  selectiveActiveArchive: null as string | null,
  selectiveVisiblePaths: [] as string[],
  inputValidationByPath: new Map<string, InputValidationInfo>(),
  inputValidationRequestId: 0,
  lastInputValidationMode: "add" as "add" | "extract" | "browse",
  lastInputsSignature: "",
  lastQuickActionByMode: {} as LastQuickActionByMode,
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
