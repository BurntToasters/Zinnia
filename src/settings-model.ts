import { parseThreads } from "./utils.ts";

export type ThemePreference = "system" | "light" | "dark";
export type ArchiveFormat = "7z" | "zip" | "tar" | "gzip" | "bzip2" | "xz";
export type PathMode = "relative" | "absolute";
export type LogVerbosity = "info" | "debug";
export type UpdateChannel = "auto" | "stable" | "beta";
export type WorkingMode = "add" | "extract" | "browse";
export type WorkspaceMode = "basic" | "power";
export type UiDensity = "comfortable" | "compact";

export const POWER_WINDOW_WIDTH_MIN = 800;
export const POWER_WINDOW_WIDTH_MAX = 4096;
export const POWER_WINDOW_HEIGHT_MIN = 600;
export const POWER_WINDOW_HEIGHT_MAX = 2160;

export interface CustomPreset {
  name: string;
  format: string;
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
}

export interface UserSettings {
  theme: ThemePreference;
  format: ArchiveFormat;
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
  threads: number;
  pathMode: PathMode;
  sfx: boolean;
  encryptHeaders: boolean;
  deleteAfter: boolean;
  autoCheckUpdates: boolean;
  updateChannel: UpdateChannel;
  localLoggingEnabled: boolean;
  logVerbosity: LogVerbosity;
  lastMode: WorkingMode;
  showActivityPanel: boolean;
  workspaceMode: WorkspaceMode;
  uiDensity: UiDensity;
  osIntegrationDismissed: boolean;
  customPresets: CustomPreset[];
  powerWindowWidth: number;
  powerWindowHeight: number;
  setupComplete: boolean;
}

export interface LoadSettingsResult {
  settings: UserSettings;
  extras: Record<string, unknown>;
  malformed: boolean;
  warning?: string;
}

export const SETTING_DEFAULTS: UserSettings = {
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
  updateChannel: "auto",
  localLoggingEnabled: true,
  logVerbosity: "info",
  lastMode: "add",
  showActivityPanel: false,
  workspaceMode: "basic",
  uiDensity: "comfortable",
  osIntegrationDismissed: false,
  customPresets: [],
  powerWindowWidth: 1100,
  powerWindowHeight: 720,
  setupComplete: false,
};

function clampWindowDimension(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

export function sanitizePowerWindowSize(
  width: unknown,
  height: unknown,
  fallbackWidth = SETTING_DEFAULTS.powerWindowWidth,
  fallbackHeight = SETTING_DEFAULTS.powerWindowHeight,
): { width: number; height: number } {
  return {
    width: clampWindowDimension(
      width,
      fallbackWidth,
      POWER_WINDOW_WIDTH_MIN,
      POWER_WINDOW_WIDTH_MAX,
    ),
    height: clampWindowDimension(
      height,
      fallbackHeight,
      POWER_WINDOW_HEIGHT_MIN,
      POWER_WINDOW_HEIGHT_MAX,
    ),
  };
}

const THEMES = new Set<ThemePreference>(["system", "light", "dark"]);
const FORMATS = new Set<ArchiveFormat>([
  "7z",
  "zip",
  "tar",
  "gzip",
  "bzip2",
  "xz",
]);
const PATH_MODES = new Set<PathMode>(["relative", "absolute"]);
const LOG_VERBOSITY = new Set<LogVerbosity>(["info", "debug"]);
const UPDATE_CHANNELS = new Set<UpdateChannel>(["auto", "stable", "beta"]);
const WORKING_MODES = new Set<WorkingMode>(["add", "extract", "browse"]);
const WORKSPACE_MODES = new Set<WorkspaceMode>(["basic", "power"]);
const UI_DENSITIES = new Set<UiDensity>(["comfortable", "compact"]);
const USER_SETTING_KEYS = new Set<keyof UserSettings>([
  "theme",
  "format",
  "level",
  "method",
  "dict",
  "wordSize",
  "solid",
  "threads",
  "pathMode",
  "sfx",
  "encryptHeaders",
  "deleteAfter",
  "autoCheckUpdates",
  "updateChannel",
  "localLoggingEnabled",
  "logVerbosity",
  "lastMode",
  "showActivityPanel",
  "workspaceMode",
  "uiDensity",
  "osIntegrationDismissed",
  "customPresets",
  "powerWindowWidth",
  "powerWindowHeight",
  "setupComplete",
]);

const MAX_CUSTOM_PRESETS = 50;

function asCustomPresets(
  value: unknown,
  fallback: CustomPreset[],
): CustomPreset[] {
  if (!Array.isArray(value)) return [...fallback];
  const presets: CustomPreset[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const r = asRecord(item);
    const name = asString(r.name, "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    presets.push({
      name,
      format: asString(r.format, "7z"),
      level: asString(r.level, "5"),
      method: asString(r.method, "lzma2"),
      dict: asString(r.dict, "64m"),
      wordSize: asString(r.wordSize, "64"),
      solid: asString(r.solid, "off"),
    });
    if (presets.length >= MAX_CUSTOM_PRESETS) break;
  }
  return presets;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asSetValue<T extends string>(
  value: unknown,
  valid: Set<T>,
  fallback: T,
): T {
  return typeof value === "string" && valid.has(value as T)
    ? (value as T)
    : fallback;
}

export function normalizeUserSettings(
  input: unknown,
  fallback: UserSettings = SETTING_DEFAULTS,
): UserSettings {
  const settings = asRecord(input);
  const powerWindowSize = sanitizePowerWindowSize(
    settings.powerWindowWidth,
    settings.powerWindowHeight,
    fallback.powerWindowWidth,
    fallback.powerWindowHeight,
  );
  return {
    theme: asSetValue(settings.theme, THEMES, fallback.theme),
    format: asSetValue(settings.format, FORMATS, fallback.format),
    level: asString(settings.level, fallback.level),
    method: asString(settings.method, fallback.method),
    dict: asString(settings.dict, fallback.dict),
    wordSize: asString(settings.wordSize, fallback.wordSize),
    solid: asString(settings.solid, fallback.solid),
    threads: parseThreads(
      String(settings.threads ?? fallback.threads),
      fallback.threads,
    ),
    pathMode: asSetValue(settings.pathMode, PATH_MODES, fallback.pathMode),
    sfx: asBoolean(settings.sfx, fallback.sfx),
    encryptHeaders: asBoolean(settings.encryptHeaders, fallback.encryptHeaders),
    deleteAfter: asBoolean(settings.deleteAfter, fallback.deleteAfter),
    autoCheckUpdates: asBoolean(
      settings.autoCheckUpdates,
      fallback.autoCheckUpdates,
    ),
    updateChannel: asSetValue(
      settings.updateChannel,
      UPDATE_CHANNELS,
      fallback.updateChannel,
    ),
    localLoggingEnabled: asBoolean(
      settings.localLoggingEnabled,
      fallback.localLoggingEnabled,
    ),
    logVerbosity: asSetValue(
      settings.logVerbosity,
      LOG_VERBOSITY,
      fallback.logVerbosity,
    ),
    lastMode: asSetValue(settings.lastMode, WORKING_MODES, fallback.lastMode),
    showActivityPanel: asBoolean(
      settings.showActivityPanel,
      fallback.showActivityPanel,
    ),
    workspaceMode: asSetValue(
      settings.workspaceMode,
      WORKSPACE_MODES,
      fallback.workspaceMode,
    ),
    uiDensity: asSetValue(settings.uiDensity, UI_DENSITIES, fallback.uiDensity),
    osIntegrationDismissed: asBoolean(
      settings.osIntegrationDismissed,
      fallback.osIntegrationDismissed,
    ),
    customPresets: asCustomPresets(
      settings.customPresets,
      fallback.customPresets,
    ),
    powerWindowWidth: powerWindowSize.width,
    powerWindowHeight: powerWindowSize.height,
    setupComplete: asBoolean(settings.setupComplete, fallback.setupComplete),
  };
}

export function parseSettingsJson(
  raw: string,
  fallback: UserSettings = SETTING_DEFAULTS,
): UserSettings {
  try {
    const parsed = JSON.parse(raw);
    return normalizeUserSettings(parsed, fallback);
  } catch {
    return { ...fallback };
  }
}

export function splitSettingsPayload(input: unknown): LoadSettingsResult {
  const obj = asRecord(input);
  const userOnly: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (USER_SETTING_KEYS.has(key as keyof UserSettings)) {
      userOnly[key] = value;
    } else {
      extras[key] = value;
    }
  }

  return {
    settings: normalizeUserSettings(userOnly, SETTING_DEFAULTS),
    extras,
    malformed: false,
  };
}

export function parseSettingsRaw(raw: string): LoadSettingsResult {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        settings: { ...SETTING_DEFAULTS },
        extras: {},
        malformed: true,
        warning:
          "Settings file did not contain an object. Defaults were loaded.",
      };
    }
    return splitSettingsPayload(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      settings: { ...SETTING_DEFAULTS },
      extras: {},
      malformed: true,
      warning: `Settings file is malformed (${msg}). Defaults were loaded.`,
    };
  }
}

export function mergeSettingsPayload(
  settings: UserSettings,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extras, ...settings };
}
