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
  /** Keep process resident after quick-extract so the next file-open is warm. */
  quickExtractKeepWarm: boolean;
  /** Idle minutes before warm-resident quick-extract exits (5/10/30/60). */
  quickExtractWarmIdleMinutes: number;
  /**
   * macOS/Windows: translucent Basic window with OS-native blur.
   * Ignored on Linux (Basic stays opaque).
   */
  basicWindowEffects: boolean;
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
  localLoggingEnabled: false,
  logVerbosity: "info",
  lastMode: "add",
  showActivityPanel: false,
  workspaceMode: "basic",
  uiDensity: "comfortable",
  osIntegrationDismissed: false,
  // Off by default: quick-extract should fully quit when its window closes.
  // Opt in via Settings for faster subsequent file-association opens.
  quickExtractKeepWarm: false,
  quickExtractWarmIdleMinutes: 10,
  basicWindowEffects: true,
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

// Compression parameter allow-sets — reject corrupt/hostile persisted values
// that would otherwise flow into 7z as -mx=, -m0=, -md=, -mfb=, -ms= switches.
const VALID_LEVELS = new Set(["0", "1", "3", "5", "7", "9"]);
const VALID_METHODS = new Set([
  "",
  "lzma",
  "lzma2",
  "ppmd",
  "bzip2",
  "deflate",
  "deflate64",
  "copy",
  "zstd",
]);
const VALID_DICTS = new Set([
  "",
  "64k",
  "256k",
  "1m",
  "2m",
  "4m",
  "8m",
  "16m",
  "32m",
  "64m",
  "128m",
  "256m",
  "512m",
  "1g",
  "1536m",
]);
const VALID_WORD_SIZES = new Set([
  "",
  "8",
  "12",
  "16",
  "24",
  "32",
  "48",
  "64",
  "96",
  "128",
  "192",
  "256",
  "273",
]);
const VALID_SOLIDS = new Set([
  "",
  "off",
  "on",
  "solid",
  "1g",
  "2g",
  "4g",
  "8g",
  "16g",
  "32g",
  "64g",
  "e1g",
  "e2g",
  "e4g",
  "e8g",
  "e16g",
  "e32g",
  "e64g",
]);
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
  "quickExtractKeepWarm",
  "quickExtractWarmIdleMinutes",
  "basicWindowEffects",
  "customPresets",
  "powerWindowWidth",
  "powerWindowHeight",
  "setupComplete",
]);

const WARM_IDLE_MINUTES = new Set([5, 10, 30, 60]);

function asWarmIdleMinutes(value: unknown, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return WARM_IDLE_MINUTES.has(rounded) ? rounded : fallback;
}

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
      format: asString(r.format, SETTING_DEFAULTS.format),
      level: asString(r.level, SETTING_DEFAULTS.level),
      method: asString(r.method, SETTING_DEFAULTS.method),
      dict: asString(r.dict, SETTING_DEFAULTS.dict),
      wordSize: asString(r.wordSize, SETTING_DEFAULTS.wordSize),
      solid: asString(r.solid, SETTING_DEFAULTS.solid),
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
    level: asSetValue(settings.level, VALID_LEVELS, fallback.level),
    method: asSetValue(settings.method, VALID_METHODS, fallback.method),
    dict: asSetValue(settings.dict, VALID_DICTS, fallback.dict),
    wordSize: asSetValue(
      settings.wordSize,
      VALID_WORD_SIZES,
      fallback.wordSize,
    ),
    solid: asSetValue(settings.solid, VALID_SOLIDS, fallback.solid),
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
    quickExtractKeepWarm: asBoolean(
      settings.quickExtractKeepWarm,
      fallback.quickExtractKeepWarm,
    ),
    quickExtractWarmIdleMinutes: asWarmIdleMinutes(
      settings.quickExtractWarmIdleMinutes,
      fallback.quickExtractWarmIdleMinutes,
    ),
    basicWindowEffects: asBoolean(
      settings.basicWindowEffects,
      fallback.basicWindowEffects,
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
