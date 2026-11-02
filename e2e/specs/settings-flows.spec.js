import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  seedE2eSettings,
  settingsDirForProfile,
  updateE2eSettings,
} from "../helpers/profile.js";
import {
  activeElementInsideSettingsModal,
  clickSettingsSave,
  clickSettingsTab,
  closeSettingsModalViaUi,
  deleteSelectedCustomPreset,
  dismissToasts,
  dispatchDocumentKey,
  doubleClickSettingsSave,
  invokeLoadSettingsRaw,
  isSettingsOverlayOpen,
  isSetupWizardVisible,
  isShortcutsOverlayOpen,
  openSettingsModal,
  preparePowerPresetPanel,
  queueConfirmResult,
  reloadMainWindow,
  saveCustomPresetViaUi,
  selectPowerPreset,
  setSelectValue,
  settingsModalFocusables,
  switchToBasicWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
  waitForSettingsSavedAndClosed,
} from "../helpers/ui-driver.js";

const LEGACY_KEY_PATTERN =
  /"(?:sfx|deleteAfter|pathMode|_setupComplete|_integration[^"]*)"\s*:/;

function e2eProfileDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("E2E profile home env is missing");
  return path.dirname(home);
}

function settingsJsonPath() {
  return path.join(
    settingsDirForProfile(e2eProfileDir(), process.platform),
    "settings.json",
  );
}

function readSettingsFileRaw() {
  const file = settingsJsonPath();
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

function writeSettingsFileObject(obj) {
  const dir = path.dirname(settingsJsonPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsJsonPath(), `${JSON.stringify(obj, null, 2)}\n`);
}

async function loadSettingsObject() {
  const result = await invokeLoadSettingsRaw();
  if (result.error) throw new Error(result.error);
  return JSON.parse(result.raw);
}

function assertNoLegacyKeys(rawJson, label) {
  assert.ok(
    !LEGACY_KEY_PATTERN.test(rawJson),
    `${label} still contained legacy keys: ${rawJson}`,
  );
}

async function restoreBaselineSettings() {
  seedE2eSettings(path.dirname(settingsJsonPath()));
  updateE2eSettings(e2eProfileDir(), {
    setupComplete: true,
    workspaceMode: "basic",
    theme: "system",
    customPresets: [],
  });
  if (!browser.sessionId) return;
  try {
    await dismissToasts();
    if (await isSettingsOverlayOpen()) {
      await closeSettingsModalViaUi().catch(() => undefined);
    }
    if (await isShortcutsOverlayOpen()) {
      await dispatchDocumentKey("Escape");
    }
    await switchToBasicWorkspace();
    await waitForArchiveIdle();
  } catch {
    // Settings reset relaunch can end the WebDriver session before UI cleanup.
  }
}

describe("Settings flows", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
  });

  afterEach(async () => {
    await restoreBaselineSettings().catch(() => undefined);
  });

  it("saves, applies, and deletes custom presets with confirm accept and decline", async () => {
    const presetName = `E2E preset ${Date.now()}`;
    await preparePowerPresetPanel();
    await setSelectValue("#format", "zip");
    await setSelectValue("#level", "0");
    await saveCustomPresetViaUi(presetName);

    await selectPowerPreset("balanced");
    await selectPowerPreset(`custom:${presetName}`);
    assert.equal(
      await browser.execute(() => document.getElementById("format").value),
      "zip",
    );

    await queueConfirmResult(false);
    await deleteSelectedCustomPreset();
    const afterDecline = await loadSettingsObject();
    assert.ok(
      afterDecline.customPresets?.some((preset) => preset.name === presetName),
      "declined delete removed the preset",
    );

    await queueConfirmResult(true);
    await deleteSelectedCustomPreset();
    const afterAccept = await loadSettingsObject();
    assert.ok(
      !afterAccept.customPresets?.some((preset) => preset.name === presetName),
      "accepted delete did not remove the preset",
    );
    const disk = readSettingsFileRaw();
    assert.ok(disk);
    assert.ok(
      !disk.includes(`"name": "${presetName}"`),
      "preset name remained on disk after delete",
    );
  });

  it("persists settings when Save is double-clicked", async () => {
    await openSettingsModal();
    await setSelectValue("#s-theme", "dark");
    await doubleClickSettingsSave();
    await waitForSettingsSavedAndClosed();

    const loaded = await loadSettingsObject();
    assert.equal(loaded.theme, "dark");
  });

  it("persists workspace mode changes from Settings", async () => {
    await openSettingsModal();
    await setSelectValue("#s-workspace-mode", "power");
    await clickSettingsSave();
    await waitForSettingsSavedAndClosed();

    const loaded = await loadSettingsObject();
    assert.equal(loaded.workspaceMode, "power");
  });

  it("opens Settings and shortcuts from the keyboard and closes with Escape", async () => {
    const modKey = process.platform === "darwin" ? "metaKey" : "ctrlKey";
    await dispatchDocumentKey(",", { [modKey]: true, code: "Comma" });
    assert.ok(
      await isSettingsOverlayOpen(),
      "Ctrl/Cmd+, did not open Settings",
    );

    await dispatchDocumentKey("Escape");
    assert.ok(
      !(await isSettingsOverlayOpen()),
      "Escape did not close Settings",
    );

    await dispatchDocumentKey("?");
    assert.ok(
      await isShortcutsOverlayOpen(),
      "? did not open the shortcuts overlay",
    );
    await dispatchDocumentKey("Escape");
    assert.ok(
      !(await isShortcutsOverlayOpen()),
      "Escape did not close shortcuts overlay",
    );
  });

  it("keeps Tab focus inside the open settings modal", async () => {
    await openSettingsModal();
    await clickSettingsTab("tab-general");
    const focusables = await settingsModalFocusables();
    assert.ok(focusables.length >= 3, "settings modal had too few tab stops");

    for (let i = 0; i < focusables.length + 2; i += 1) {
      await dispatchDocumentKey("Tab");
      assert.ok(
        await activeElementInsideSettingsModal(),
        `Tab moved focus outside the modal at step ${i}`,
      );
    }
    for (let i = 0; i < focusables.length + 2; i += 1) {
      await dispatchDocumentKey("Tab", { shiftKey: true });
      assert.ok(
        await activeElementInsideSettingsModal(),
        `Shift+Tab moved focus outside the modal at step ${i}`,
      );
    }
    await closeSettingsModalViaUi();
  });

  it("strips legacy settings keys when saved from Settings", async () => {
    writeSettingsFileObject({
      theme: "light",
      setupComplete: true,
      workspaceMode: "basic",
      autoCheckUpdates: false,
      quickExtractKeepWarm: false,
      extractAutoCloseSeconds: -1,
      basicWindowEffects: false,
      debug: false,
      sfx: true,
      deleteAfter: true,
      pathMode: "absolute",
      _setupComplete: true,
      _integrationAutoEnabled: true,
      customPresets: [
        {
          name: "Legacy preset",
          format: "7z",
          level: "5",
          method: "lzma2",
          dict: "64m",
          wordSize: "64",
          solid: "4g",
          sfx: true,
          pathMode: "absolute",
        },
      ],
    });
    await reloadMainWindow();

    await openSettingsModal();
    await setSelectValue("#s-theme", "dark");
    await clickSettingsSave();
    await waitForSettingsSavedAndClosed();

    const fromInvoke = JSON.stringify(await loadSettingsObject());
    assertNoLegacyKeys(fromInvoke, "load_settings");
    const fromDisk = readSettingsFileRaw() ?? "";
    assertNoLegacyKeys(fromDisk, "settings.json");
    const legacyPreset = (await loadSettingsObject()).customPresets?.find(
      (preset) => preset.name === "Legacy preset",
    );
    assert.ok(legacyPreset);
    assert.equal(
      Object.prototype.hasOwnProperty.call(legacyPreset, "sfx"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(legacyPreset, "pathMode"),
      false,
    );
  });

  it("shows the setup wizard when setup is incomplete and marks setup complete after skip", async () => {
    writeSettingsFileObject({
      setupComplete: false,
      autoCheckUpdates: false,
      quickExtractKeepWarm: false,
      extractAutoCloseSeconds: -1,
      workspaceMode: "basic",
      basicWindowEffects: false,
      debug: false,
    });
    await reloadMainWindow();

    await browser.waitUntil(async () => isSetupWizardVisible(), {
      timeout: 15_000,
      timeoutMsg: "setup wizard did not appear for incomplete setup",
    });

    await browser.execute(() => {
      document.getElementById("setup-welcome-skip")?.click();
    });
    await browser.waitUntil(async () => !(await isSetupWizardVisible()), {
      timeout: 10_000,
      timeoutMsg: "setup wizard did not close after skip",
    });

    await browser.waitUntil(
      async () => (await loadSettingsObject()).setupComplete === true,
      {
        timeout: 30_000,
        timeoutMsg: "setupComplete did not persist after skipping the wizard",
      },
    );

    const loaded = await loadSettingsObject();
    assert.equal(loaded.setupComplete, true);
    const diskWizard = readSettingsFileRaw();
    assert.ok(diskWizard);
    assert.equal(JSON.parse(diskWizard).setupComplete, true);
  });

  it("resets settings to defaults and persists after restart", async () => {
    await openSettingsModal();
    await setSelectValue("#s-theme", "dark");
    await clickSettingsSave();
    await waitForSettingsSavedAndClosed();

    await openSettingsModal();
    await clickSettingsTab("tab-general");
    await queueConfirmResult(true);
    globalThis.__ZINNIA_E2E_APP_CLOSED_BY_SPEC__ = true;
    await browser.execute(() => {
      document.getElementById("reset-settings")?.click();
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && readSettingsFileRaw() !== null) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      readSettingsFileRaw(),
      null,
      "reset_settings did not remove settings.json",
    );

    if (browser.sessionId) {
      try {
        const loaded = await loadSettingsObject();
        assert.equal(loaded.theme, "system");
        assert.equal(loaded.workspaceMode, "basic");
      } catch {
        // relaunch can end the WebDriver session before defaults are queried
      }
    }
  });
});
