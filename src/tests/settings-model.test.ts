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

  it("accepts valid format and pathMode", () => {
    const result = normalizeUserSettings({
      format: "zip",
      pathMode: "absolute",
    });
    expect(result.format).toBe("zip");
    expect(result.pathMode).toBe("absolute");
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
      logVerbosity: "debug",
    });
    expect(result.autoCheckUpdates).toBe(false);
    expect(result.localLoggingEnabled).toBe(false);
    expect(result.logVerbosity).toBe("debug");
  });

  it("accepts valid updateChannel", () => {
    const result = normalizeUserSettings({
      updateChannel: "beta",
    });
    expect(result.updateChannel).toBe("beta");
  });

  it("accepts valid working context settings", () => {
    const result = normalizeUserSettings({
      lastMode: "browse",
      showActivityPanel: true,
      workspaceMode: "power",
      uiDensity: "compact",
    });
    expect(result.lastMode).toBe("browse");
    expect(result.showActivityPanel).toBe(true);
    expect(result.workspaceMode).toBe("power");
    expect(result.uiDensity).toBe("compact");
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
