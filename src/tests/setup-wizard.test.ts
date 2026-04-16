import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";
import {
  shouldShowSetupWizard,
  markSetupComplete,
  showSetupWizard,
} from "../setup-wizard";

const mockSaveSettings = vi.fn().mockResolvedValue(undefined);
const mockApplyTheme = vi.fn();

vi.mock("../settings", () => ({
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
  applyTheme: (...args: unknown[]) => mockApplyTheme(...args),
}));

beforeEach(() => {
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.settingsExtras = {};
  state.lastPersistedSettings = { ...SETTING_DEFAULTS };
  const overlay = document.getElementById(
    "setup-wizard-overlay",
  ) as HTMLElement;
  overlay.hidden = true;
  mockSaveSettings.mockClear();
  mockApplyTheme.mockClear();
});

describe("setup wizard state", () => {
  it("shows wizard when setup is incomplete", () => {
    expect(shouldShowSetupWizard()).toBe(true);
  });

  it("does not show wizard when setup is complete for current version", () => {
    state.settingsExtras._setupComplete = true;
    state.settingsExtras._setupWizardVersion = 1;
    expect(shouldShowSetupWizard()).toBe(false);
  });

  it("shows wizard again when setup version is outdated", () => {
    state.settingsExtras._setupComplete = true;
    state.settingsExtras._setupWizardVersion = 0;
    expect(shouldShowSetupWizard()).toBe(true);
  });

  it("marks setup complete and persists settings", async () => {
    await markSetupComplete();
    expect(state.settingsExtras._setupComplete).toBe(true);
    expect(state.settingsExtras._setupWizardVersion).toBe(1);
    expect(mockSaveSettings).toHaveBeenCalledOnce();
  });
});

describe("showSetupWizard", () => {
  it("supports skipping setup from welcome", async () => {
    const promise = showSetupWizard();
    (
      document.getElementById("setup-welcome-skip") as HTMLButtonElement
    ).click();

    const result = await promise;
    expect(result).toBeNull();
    expect(
      (document.getElementById("setup-wizard-overlay") as HTMLElement).hidden,
    ).toBe(true);
  });

  it("returns selected preferences when completed", async () => {
    const promise = showSetupWizard();

    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-mode-power") as HTMLButtonElement).click();
    (
      document.getElementById("setup-workspace-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-dark") as HTMLButtonElement).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();

    const autoUpdates = document.getElementById(
      "setup-auto-updates",
    ) as HTMLInputElement;
    autoUpdates.checked = false;
    autoUpdates.dispatchEvent(new Event("change"));
    const channel = document.getElementById(
      "setup-update-channel",
    ) as HTMLSelectElement;
    channel.value = "beta";
    channel.dispatchEvent(new Event("change"));
    (
      document.getElementById("setup-updates-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-done-btn") as HTMLButtonElement).click();

    const result = await promise;
    expect(result).toEqual({
      workspaceMode: "power",
      theme: "dark",
      autoCheckUpdates: false,
      updateChannel: "beta",
    });
    expect(mockApplyTheme).toHaveBeenCalledWith("dark");
  });

  it("preserves auto update channel when unchanged", async () => {
    state.currentSettings.updateChannel = "auto";
    const promise = showSetupWizard();

    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (
      document.getElementById("setup-workspace-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    (
      document.getElementById("setup-updates-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-done-btn") as HTMLButtonElement).click();

    const result = await promise;
    expect(result?.updateChannel).toBe("auto");
  });
});
