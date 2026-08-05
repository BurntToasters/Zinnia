import { describe, it, expect } from "vitest";
import {
  SETTING_DEFAULTS,
  mergeSettingsPayload,
  normalizeUserSettings,
  parseSettingsJson,
  parseSettingsRaw,
  splitSettingsPayload,
} from "../settings-model";

describe("parseSettingsJson", () => {
  it("returns defaults for broken JSON", () => {
    expect(parseSettingsJson("{broken json")).toEqual(SETTING_DEFAULTS);
  });

  it("parses valid JSON and merges with defaults", () => {
    const result = parseSettingsJson(JSON.stringify({ theme: "dark" }));
    expect(result.theme).toBe("dark");
    expect(result.format).toBe(SETTING_DEFAULTS.format);
  });
});

describe("parseSettingsRaw", () => {
  it("marks malformed JSON and returns defaults", () => {
    const result = parseSettingsRaw("{broken json");
    expect(result.malformed).toBe(true);
    expect(typeof result.warning).toBe("string");
    expect(result.settings).toEqual(SETTING_DEFAULTS);
  });
});

describe("normalizeUserSettings", () => {
  it("clamps threads to 128", () => {
    const result = normalizeUserSettings({ threads: 999 });
    expect(result.threads).toBe(128);
  });

  it("rejects invalid theme and uses default", () => {
    const result = normalizeUserSettings({ theme: "invalid" });
    expect(result.theme).toBe(SETTING_DEFAULTS.theme);
  });

  it("migrates unsafe absolute pathMode to relative", () => {
    const result = normalizeUserSettings({
      format: "zip",
      pathMode: "absolute",
    });
    expect(result.format).toBe("zip");
    expect(result.pathMode).toBe("relative");
  });

  it("rejects wrong types for boolean fields", () => {
    const result = normalizeUserSettings({
      sfx: "true",
      deleteAfter: 1,
      localLoggingEnabled: "yes",
    });
    expect(result.sfx).toBe(SETTING_DEFAULTS.sfx);
    expect(result.deleteAfter).toBe(SETTING_DEFAULTS.deleteAfter);
    expect(result.localLoggingEnabled).toBe(
      SETTING_DEFAULTS.localLoggingEnabled,
    );
  });

  it("accepts valid logVerbosity and booleans", () => {
    const result = normalizeUserSettings({
      autoCheckUpdates: false,
      localLoggingEnabled: false,
      osIntegrationDismissed: true,
      logVerbosity: "debug",
    });
    expect(result.autoCheckUpdates).toBe(false);
    expect(result.localLoggingEnabled).toBe(false);
    expect(result.osIntegrationDismissed).toBe(true);
    expect(result.logVerbosity).toBe("debug");
  });

  it("accepts valid updateChannel", () => {
    const result = normalizeUserSettings({
      updateChannel: "beta",
    });
    expect(result.updateChannel).toBe("beta");
  });

  it("accepts quick-extract warm-idle prefs and clamps invalid minutes", () => {
    const ok = normalizeUserSettings({
      quickExtractKeepWarm: false,
      quickExtractWarmIdleMinutes: 30,
      basicWindowEffects: false,
    });
    expect(ok.quickExtractKeepWarm).toBe(false);
    expect(ok.quickExtractWarmIdleMinutes).toBe(30);
    expect(ok.basicWindowEffects).toBe(false);
    expect(SETTING_DEFAULTS.basicWindowEffects).toBe(true);

    const clamped = normalizeUserSettings({
      quickExtractWarmIdleMinutes: 7,
    });
    expect(clamped.quickExtractWarmIdleMinutes).toBe(10);

    const fromString = normalizeUserSettings({
      quickExtractWarmIdleMinutes: "60",
    });
    expect(fromString.quickExtractWarmIdleMinutes).toBe(60);
  });

  it("accepts valid working context settings", () => {
    const result = normalizeUserSettings({
      lastMode: "browse",
      showActivityPanel: true,
      workspaceMode: "power",
      uiDensity: "compact",
      powerWindowWidth: 960,
      powerWindowHeight: 640,
      setupComplete: true,
    });
    expect(result.lastMode).toBe("browse");
    expect(result.showActivityPanel).toBe(true);
    expect(result.workspaceMode).toBe("power");
    expect(result.uiDensity).toBe("compact");
    expect(result.powerWindowWidth).toBe(960);
    expect(result.powerWindowHeight).toBe(640);
    expect(result.setupComplete).toBe(true);
  });

  it("clamps invalid power window size values", () => {
    const result = normalizeUserSettings({
      powerWindowWidth: -10,
      powerWindowHeight: 99999,
    });
    expect(result.powerWindowWidth).toBe(800);
    expect(result.powerWindowHeight).toBe(2160);
  });

  it("rejects invalid lastMode and uses default", () => {
    const result = normalizeUserSettings({
      lastMode: "invalid",
      workspaceMode: "unknown",
      uiDensity: "dense",
    });
    expect(result.lastMode).toBe(SETTING_DEFAULTS.lastMode);
    expect(result.workspaceMode).toBe(SETTING_DEFAULTS.workspaceMode);
    expect(result.uiDensity).toBe(SETTING_DEFAULTS.uiDensity);
  });

  it("rejects invalid updateChannel and uses default", () => {
    const result = normalizeUserSettings({
      updateChannel: "nightly",
    });
    expect(result.updateChannel).toBe(SETTING_DEFAULTS.updateChannel);
  });

  it("accepts 'auto' updateChannel", () => {
    const result = normalizeUserSettings({
      updateChannel: "auto",
    });
    expect(result.updateChannel).toBe("auto");
  });

  it("normalizes custom presets and drops invalid or duplicate names", () => {
    const result = normalizeUserSettings({
      customPresets: [
        { name: "  Fast  ", format: "zip", level: "1" },
        { name: "Fast", format: "7z", level: "9" },
        { name: "", format: "7z" },
        "not-an-object",
        {
          name: "Solid",
          method: "lzma2",
          dict: "64m",
          wordSize: "32",
          solid: "8g",
        },
      ],
    });
    expect(result.customPresets).toHaveLength(2);
    expect(result.customPresets[0]).toMatchObject({
      name: "Fast",
      format: "zip",
      level: "1",
    });
    expect(result.customPresets[1].name).toBe("Solid");
    expect(result.customPresets[1].format).toBe(SETTING_DEFAULTS.format);
  });

  it("sanitizes every custom preset compression field", () => {
    const result = normalizeUserSettings({
      customPresets: [
        {
          name: "Hostile",
          format: "rar",
          level: "99",
          method: "@listfile",
          dict: "999g",
          wordSize: "999",
          solid: "../../escape",
        },
      ],
    });

    expect(result.customPresets[0]).toEqual({
      name: "Hostile",
      format: SETTING_DEFAULTS.format,
      level: SETTING_DEFAULTS.level,
      method: SETTING_DEFAULTS.method,
      dict: SETTING_DEFAULTS.dict,
      wordSize: SETTING_DEFAULTS.wordSize,
      solid: SETTING_DEFAULTS.solid,
    });
  });

  it("falls back when customPresets is not an array", () => {
    const result = normalizeUserSettings({
      customPresets: { nope: true },
    });
    expect(result.customPresets).toEqual(SETTING_DEFAULTS.customPresets);
  });

  it("caps custom presets at 50 entries", () => {
    const presets = Array.from({ length: 60 }, (_, i) => ({
      name: `Preset ${i}`,
      format: "7z",
    }));
    const result = normalizeUserSettings({ customPresets: presets });
    expect(result.customPresets).toHaveLength(50);
    expect(result.customPresets[0].name).toBe("Preset 0");
    expect(result.customPresets[49].name).toBe("Preset 49");
  });
});

describe("splitSettingsPayload", () => {
  it("separates known settings from extras", () => {
    const split = splitSettingsPayload({
      ...SETTING_DEFAULTS,
      _integrationAutoEnabled: true,
      _integrationUserDisabled: false,
      customInternal: "x",
    });
    expect(split.settings.theme).toBe(SETTING_DEFAULTS.theme);
    expect(split.extras._integrationAutoEnabled).toBe(true);
    expect(split.extras._integrationUserDisabled).toBe(false);
    expect(split.extras.customInternal).toBe("x");
  });

  it("keeps working context keys in the user settings payload", () => {
    const split = splitSettingsPayload({
      ...SETTING_DEFAULTS,
      lastMode: "extract",
      showActivityPanel: true,
      workspaceMode: "power",
      uiDensity: "compact",
      _integrationAutoEnabled: true,
    });
    expect(split.settings.lastMode).toBe("extract");
    expect(split.settings.showActivityPanel).toBe(true);
    expect(split.settings.workspaceMode).toBe("power");
    expect(split.settings.uiDensity).toBe("compact");
    expect(split.extras._integrationAutoEnabled).toBe(true);
  });
});

describe("mergeSettingsPayload", () => {
  it("merges extras back into settings", () => {
    const merged = mergeSettingsPayload(SETTING_DEFAULTS, {
      _integrationAutoEnabled: true,
      customInternal: "x",
    });
    expect(merged._integrationAutoEnabled).toBe(true);
    expect(merged.customInternal).toBe("x");
    expect(merged.theme).toBe(SETTING_DEFAULTS.theme);
  });
});
