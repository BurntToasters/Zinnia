import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";
import {
  shouldShowSetupWizard,
  markSetupComplete,
  showSetupWizard,
} from "../setup-wizard";

const e2eEnv = vi.hoisted(() => ({
  isE2eFrontend: vi.fn(() => false),
}));
vi.mock("../e2e-env", () => e2eEnv);

const mockSaveSettings = vi.fn().mockResolvedValue(undefined);
const mockApplyTheme = vi.fn();
const mockRefreshDefaultArchiverActionButton = vi
  .fn()
  .mockResolvedValue(undefined);
const mockRunDefaultArchiverAction = vi.fn().mockResolvedValue(undefined);

vi.mock("../settings", () => ({
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
  applyTheme: (...args: unknown[]) => mockApplyTheme(...args),
}));

vi.mock("../os-integration", () => ({
  refreshDefaultArchiverActionButton: (...args: unknown[]) =>
    mockRefreshDefaultArchiverActionButton(...args),
  runDefaultArchiverAction: (...args: unknown[]) =>
    mockRunDefaultArchiverAction(...args),
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
  mockRefreshDefaultArchiverActionButton.mockClear();
  mockRunDefaultArchiverAction.mockClear();
  e2eEnv.isE2eFrontend.mockReturnValue(false);
});

describe("setup wizard state", () => {
  it("shows wizard when setup is incomplete", () => {
    expect(shouldShowSetupWizard()).toBe(true);
  });

  it("never shows the wizard in unpackaged E2E builds", () => {
    e2eEnv.isE2eFrontend.mockReturnValue(true);
    expect(shouldShowSetupWizard()).toBe(false);
  });

  it("does not show wizard when setup is complete for current version", () => {
    state.currentSettings.setupComplete = true;
    state.settingsExtras._setupComplete = true;
    state.settingsExtras._setupWizardVersion = 3;
    expect(shouldShowSetupWizard()).toBe(false);
  });

  it("shows the upgraded wizard for legacy completion without a version", () => {
    state.currentSettings.setupComplete = false;
    state.settingsExtras._setupComplete = true;
    delete state.settingsExtras._setupWizardVersion;
    expect(shouldShowSetupWizard()).toBe(true);
  });

  it("shows wizard again when setup version is outdated", () => {
    state.currentSettings.setupComplete = true;
    state.settingsExtras._setupComplete = true;
    state.settingsExtras._setupWizardVersion = 0;
    expect(shouldShowSetupWizard()).toBe(true);
  });

  it("marks setup complete and persists settings", async () => {
    await markSetupComplete();
    expect(state.currentSettings.setupComplete).toBe(true);
    expect(state.settingsExtras._setupComplete).toBe(true);
    expect(state.settingsExtras._setupWizardVersion).toBe(3);
    expect(mockSaveSettings).toHaveBeenCalledOnce();
  });
});

describe("showSetupWizard", () => {
  it("moves focus and dialog context to each visible step", async () => {
    const promise = showSetupWizard();
    const overlay = document.getElementById(
      "setup-wizard-overlay",
    ) as HTMLElement;
    const title0 = document.getElementById("setup-wizard-title-0");
    const title1 = document.getElementById("setup-wizard-title-1");
    const progress = document.getElementById("setup-wizard-progress-bar");

    expect(document.activeElement).toBe(title0);
    expect(overlay.getAttribute("aria-labelledby")).toBe(
      "setup-wizard-title-0",
    );
    expect(progress?.getAttribute("aria-valuenow")).toBe("0");
    expect(progress?.getAttribute("aria-valuetext")).toBe("Step 1 of 5");

    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();

    expect(document.activeElement).toBe(title1);
    expect(overlay.getAttribute("aria-labelledby")).toBe(
      "setup-wizard-title-1",
    );
    expect(progress?.getAttribute("aria-valuenow")).toBe("25");
    expect(progress?.getAttribute("aria-valuetext")).toBe("Step 2 of 5");

    (
      document.getElementById("setup-workspace-back") as HTMLButtonElement
    ).click();
    (
      document.getElementById("setup-welcome-skip") as HTMLButtonElement
    ).click();
    await promise;
  });

  it("supports skipping setup from welcome", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const promise = showSetupWizard();
    (
      document.getElementById("setup-welcome-skip") as HTMLButtonElement
    ).click();

    const result = await promise;
    expect(result).toBeNull();
    expect(
      (document.getElementById("setup-wizard-overlay") as HTMLElement).hidden,
    ).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
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
    (document.getElementById("setup-os-next") as HTMLButtonElement).click();

    const result = await promise;
    expect(result).toEqual({
      workspaceMode: "power",
      theme: "dark",
      autoCheckUpdates: false,
      updateChannel: "beta",
      osIntegrationDismissed: true,
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
    (document.getElementById("setup-os-next") as HTMLButtonElement).click();

    const result = await promise;
    expect(result?.updateChannel).toBe("auto");
  });

  it("uses the shared default archiver action in the OS integration step", async () => {
    const promise = showSetupWizard();
    const setupOsOpen = document.getElementById(
      "setup-os-open",
    ) as HTMLButtonElement;

    expect(mockRefreshDefaultArchiverActionButton).toHaveBeenCalledWith(
      setupOsOpen,
    );

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
    setupOsOpen.click();
    (document.getElementById("setup-os-next") as HTMLButtonElement).click();

    await promise;

    expect(mockRunDefaultArchiverAction).toHaveBeenCalledWith(setupOsOpen);
  });

  it("skips the updates step and forces autoCheckUpdates off when requested", async () => {
    state.currentSettings.autoCheckUpdates = true;
    state.currentSettings.updateChannel = "stable";
    const promise = showSetupWizard({ skipUpdates: true });

    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (
      document.getElementById("setup-workspace-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-dark") as HTMLButtonElement).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();

    const updatesStep = document.querySelector<HTMLElement>(
      '.setup-wizard-step[data-step="3"]',
    );
    const osStep = document.querySelector<HTMLElement>(
      '.setup-wizard-step[data-step="4"]',
    );
    const themeStep = document.querySelector<HTMLElement>(
      '.setup-wizard-step[data-step="2"]',
    );
    expect(updatesStep?.hidden).toBe(true);
    expect(osStep?.hidden).toBe(false);
    expect(
      document
        .getElementById("setup-wizard-progress-bar")
        ?.getAttribute("aria-valuetext"),
    ).toBe("Step 4 of 4");

    (document.getElementById("setup-os-back") as HTMLButtonElement).click();
    expect(osStep?.hidden).toBe(true);
    expect(themeStep?.hidden).toBe(false);
    expect(updatesStep?.hidden).toBe(true);

    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    (document.getElementById("setup-os-next") as HTMLButtonElement).click();

    const result = await promise;
    expect(result).toEqual({
      workspaceMode: "basic",
      theme: "dark",
      autoCheckUpdates: false,
      updateChannel: "stable",
      osIntegrationDismissed: true,
    });
  });
});
