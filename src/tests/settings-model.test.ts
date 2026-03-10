import assert from "node:assert/strict";

import {
  SETTING_DEFAULTS,
  mergeSettingsPayload,
  normalizeUserSettings,
  parseSettingsJson,
  parseSettingsRaw,
  splitSettingsPayload,
} from "../settings-model.ts";

export function runSettingsModelTests() {
  const settings = parseSettingsJson("{broken json");
  assert.deepEqual(settings, SETTING_DEFAULTS);

  const malformed = parseSettingsRaw("{broken json");
  assert.equal(malformed.malformed, true);
  assert.equal(typeof malformed.warning, "string");
  assert.deepEqual(malformed.settings, SETTING_DEFAULTS);

  const normalized = normalizeUserSettings({
    theme: "invalid",
    format: "zip",
    pathMode: "absolute",
    threads: 999,
    autoCheckUpdates: false,
    localLoggingEnabled: false,
    logVerbosity: "debug",
  });

  assert.equal(normalized.theme, SETTING_DEFAULTS.theme);
  assert.equal(normalized.format, "zip");
  assert.equal(normalized.pathMode, "absolute");
  assert.equal(normalized.threads, 128);
  assert.equal(normalized.autoCheckUpdates, false);
  assert.equal(normalized.localLoggingEnabled, false);
  assert.equal(normalized.logVerbosity, "debug");

  const normalizedFallback = normalizeUserSettings({
    sfx: "true",
    deleteAfter: 1,
    localLoggingEnabled: "yes",
  });

  assert.equal(normalizedFallback.sfx, SETTING_DEFAULTS.sfx);
  assert.equal(normalizedFallback.deleteAfter, SETTING_DEFAULTS.deleteAfter);
  assert.equal(normalizedFallback.localLoggingEnabled, SETTING_DEFAULTS.localLoggingEnabled);

  const split = splitSettingsPayload({
    ...SETTING_DEFAULTS,
    _integrationAutoEnabled: true,
    _integrationUserDisabled: false,
    customInternal: "x",
  });
  assert.equal(split.settings.theme, SETTING_DEFAULTS.theme);
  assert.equal(split.extras._integrationAutoEnabled, true);
  assert.equal(split.extras._integrationUserDisabled, false);
  assert.equal(split.extras.customInternal, "x");

  const merged = mergeSettingsPayload(SETTING_DEFAULTS, {
    _integrationAutoEnabled: true,
    customInternal: "x",
  });
  assert.equal(merged._integrationAutoEnabled, true);
  assert.equal(merged.customInternal, "x");
  assert.equal(merged.theme, SETTING_DEFAULTS.theme);
}
