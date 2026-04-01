import { parseThreads } from "./utils.ts";

export type ThemePreference = "system" | "light" | "dark";
export type ArchiveFormat = "7z" | "zip" | "tar" | "gzip" | "bzip2" | "xz";
export type PathMode = "relative" | "absolute";
export type LogVerbosity = "info" | "debug";
export type UpdateChannel = "stable" | "beta";

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
  updateChannel: "stable",
  localLoggingEnabled: true,
  logVerbosity: "info",
};

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
const UPDATE_CHANNELS = new Set<UpdateChannel>(["stable", "beta"]);
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
]);

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
