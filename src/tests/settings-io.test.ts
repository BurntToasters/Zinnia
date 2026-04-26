import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  loadSettings,
  loadSettingsWithMetadata,
  saveSettings,
} from "../settings";
import { SETTING_DEFAULTS } from "../settings-model";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("loadSettingsWithMetadata", () => {
  it("parses valid settings payload and metadata extras", async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        theme: "dark",
        _setupComplete: true,
      }),
    );

    const result = await loadSettingsWithMetadata();

    expect(result.settings.theme).toBe("dark");
    expect(result.extras._setupComplete).toBe(true);
    expect(result.malformed).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("falls back to defaults when load fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("disk unavailable"));

    const result = await loadSettingsWithMetadata();

    expect(result.settings).toEqual(SETTING_DEFAULTS);
    expect(result.extras).toEqual({});
    expect(result.malformed).toBe(true);
    expect(result.warning).toContain("disk unavailable");
  });
});

describe("loadSettings", () => {
  it("returns only settings from metadata payload", async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        updateChannel: "beta",
        _custom: 123,
      }),
    );

    const settings = await loadSettings();

    expect(settings.updateChannel).toBe("beta");
    expect(Object.prototype.hasOwnProperty.call(settings, "_custom")).toBe(
      false,
    );
  });
});

describe("saveSettings", () => {
  it("serializes merged settings + extras and invokes backend command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await saveSettings(
      {
        ...SETTING_DEFAULTS,
        workspaceMode: "power",
      },
      { _setupComplete: true },
    );

    expect(invokeMock).toHaveBeenCalledOnce();
    const [command, payload] = invokeMock.mock.calls[0];
    expect(command).toBe("save_settings");
    const typedPayload = payload as { json?: string } | undefined;
    expect(typeof typedPayload?.json).toBe("string");

    const decoded = JSON.parse(typedPayload?.json as string);
    expect(decoded.workspaceMode).toBe("power");
    expect(decoded._setupComplete).toBe(true);
  });
});
