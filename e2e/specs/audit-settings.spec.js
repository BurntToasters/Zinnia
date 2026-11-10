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
  clickSettingsTab,
  closeSettingsModalViaUi,
  confirmDialogTitles,
  dispatchDocumentKey,
  flushPendingSettingsWrites,
  invokeLoadSettingsRaw,
  isSetupWizardVisible,
  isSettingsOverlayOpen,
  openSettingsModal,
  queueConfirmResult,
  reloadMainWindow,
  setSelectValue,
  switchToPowerWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
  waitForSettingsSavedAndClosed,
  clickSettingsSave,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

// Titles the app passes to confirmWithE2eQueue. The E2E hook records them.
const DISCARD_TITLE = "Discard unsaved settings";
const RESET_TITLE = "Reset Settings";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK_ROOT = path.join(process.env.ZINNIA_E2E_WORK, "audit-settings");

function e2eProfileDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("E2E profile home env is missing");
  return path.dirname(home);
}

function settingsDir() {
  return settingsDirForProfile(e2eProfileDir(), process.platform);
}

function settingsJsonPath() {
  return path.join(settingsDir(), "settings.json");
}

function readSettingsFileRaw() {
  const file = settingsJsonPath();
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

function corruptBackups() {
  return fs
    .readdirSync(settingsDir())
    .filter((name) => /^settings\.json\.corrupt-/.test(name))
    .sort();
}

async function loadSettingsObject() {
  const result = await invokeLoadSettingsRaw();
  if (result.error) throw new Error(result.error);
  return JSON.parse(result.raw);
}

async function settingsMethodValues() {
  return browser.execute(() =>
    [...document.getElementById("s-method").options].map(
      (option) => option.value,
    ),
  );
}

async function settingsValue(selector) {
  return browser.execute(
    (target) => document.querySelector(target)?.value ?? null,
    selector,
  );
}

async function clickById(id) {
  await browser.execute((target) => {
    const el = document.getElementById(target);
    if (!el) throw new Error(`missing #${target}`);
    el.click();
  }, id);
}

async function waitForWizard(visible, timeoutMsg) {
  await browser.waitUntil(
    async () => (await isSetupWizardVisible()) === visible,
    { timeout: 15_000, timeoutMsg },
  );
}

async function restoreBaselineSettings() {
  if (browser.sessionId) {
    try {
      if (await isSettingsOverlayOpen()) {
        await closeSettingsModalViaUi().catch(() => undefined);
      }
      await switchToPowerWorkspace().catch(() => undefined);
      await waitForArchiveIdle().catch(() => undefined);
      await flushPendingSettingsWrites();
    } catch {
      // A reset relaunch can end the session before cleanup runs.
    }
  }
  seedE2eSettings(settingsDir());
  updateE2eSettings(e2eProfileDir(), {
    setupComplete: true,
    workspaceMode: "basic",
    theme: "system",
    customPresets: [],
  });
}

describe("Audit settings flows", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
  });

  afterEach(async () => {
    await restoreBaselineSettings().catch(() => undefined);
  });

  it("recovers from an unparsable settings.json and keeps saving", async () => {
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    const seed = "{ not valid json, theme: ";
    fs.writeFileSync(path.join(WORK_ROOT, "seed-settings.json"), seed);
    fs.mkdirSync(settingsDir(), { recursive: true });
    const backupsBefore = corruptBackups();
    fs.writeFileSync(settingsJsonPath(), seed);
    await flushPendingSettingsWrites();
    await reloadMainWindow();

    // E2E builds treat a file that is not explicitly setupComplete:false as
    // complete (app-init.ts), so the wizard stays hidden here. The save below
    // is what must recover the file.
    await waitForMainWindow();
    assert.equal(
      await isSetupWizardVisible(),
      false,
      "wizard showed in E2E for an unparsable file without setupComplete:false",
    );

    await openSettingsModal();
    await setSelectValue("#s-theme", "dark");
    await clickSettingsSave();
    await waitForSettingsSavedAndClosed();

    const loaded = await loadSettingsObject();
    assert.equal(loaded.theme, "dark", "saved theme did not persist");
    assert.equal(JSON.parse(readSettingsFileRaw() ?? "{}").theme, "dark");

    const backups = corruptBackups().filter(
      (name) => !backupsBefore.includes(name),
    );
    assert.equal(
      backups.length,
      1,
      `expected one quarantined file, got ${backups}`,
    );
    const quarantined = fs.readFileSync(
      path.join(settingsDir(), backups[0]),
      "utf8",
    );
    assert.equal(quarantined, seed, "quarantined file lost the original bytes");

    await reloadMainWindow();
    assert.equal(
      await isSetupWizardVisible(),
      false,
      "setup wizard reappeared after a save on a recovered file",
    );
    assert.equal((await loadSettingsObject()).theme, "dark");

    writeEvidence(EVIDENCE_DIR, "audit-settings-corrupt-settings", {
      spec: "audit-settings",
      case: "corrupt-settings-recovery",
      quarantined: backups[0],
      theme: loaded.theme,
      wizardReappeared: false,
    });
  });

  it("offers only the methods the selected format supports", async () => {
    await openSettingsModal();
    await setSelectValue("#s-format", "zip");
    assert.deepEqual(await settingsMethodValues(), ["deflate", "lzma"]);

    await setSelectValue("#s-format", "7z");
    assert.deepEqual(await settingsMethodValues(), ["lzma2", "lzma"]);

    // Format went 7z -> zip -> 7z with no other edits: nothing to discard, so
    // no confirm answer is queued (a stale queued answer would leak).
    await closeSettingsModalViaUi();

    writeEvidence(EVIDENCE_DIR, "audit-settings-method-list", {
      spec: "audit-settings",
      case: "format-filtered-methods",
      zip: ["deflate", "lzma"],
      sevenZip: ["lzma2", "lzma"],
    });
  });

  it("normalizes a saved method that the format does not support", async () => {
    updateE2eSettings(e2eProfileDir(), { format: "zip", method: "lzma2" });
    await reloadMainWindow();

    await openSettingsModal();
    assert.equal(
      await settingsValue("#s-method"),
      "deflate",
      "zip with a 7z-only method was not normalized on load",
    );
    await closeSettingsModalViaUi();
  });

  it("asks before Escape discards unsaved Settings edits", async () => {
    await openSettingsModal();
    await setSelectValue("#s-theme", "dark");

    await queueConfirmResult(false);
    await dispatchDocumentKey("Escape");
    await browser.waitUntil(
      async () => (await confirmDialogTitles()).includes(DISCARD_TITLE),
      { timeout: 10_000, timeoutMsg: "Escape did not ask about discarding" },
    );
    assert.ok(
      await isSettingsOverlayOpen(),
      "declining the discard prompt still closed Settings",
    );
    assert.equal(await settingsValue("#s-theme"), "dark");

    await queueConfirmResult(true);
    await dispatchDocumentKey("Escape");
    await browser.waitUntil(async () => !(await isSettingsOverlayOpen()), {
      timeout: 10_000,
      timeoutMsg: "accepting the discard prompt did not close Settings",
    });
    assert.notEqual(
      (await loadSettingsObject()).theme,
      "dark",
      "discarded edit was saved",
    );

    writeEvidence(EVIDENCE_DIR, "audit-settings-discard-prompt", {
      spec: "audit-settings",
      case: "escape-discard-prompt",
      promptShown: true,
      declineKeepsOpen: true,
      acceptDiscards: true,
    });
  });

  it("closes Settings without a prompt when nothing changed", async () => {
    await openSettingsModal();
    const titlesBefore = (await confirmDialogTitles()).length;
    await dispatchDocumentKey("Escape");
    await browser.waitUntil(async () => !(await isSettingsOverlayOpen()), {
      timeout: 5_000,
      timeoutMsg: "unchanged Settings did not close on Escape",
    });
    assert.equal(
      (await confirmDialogTitles()).length,
      titlesBefore,
      "unchanged Settings asked a discard question",
    );
  });

  it("names the reset scope in its confirmation and keeps settings when declined", async () => {
    await openSettingsModal();
    await clickSettingsTab("tab-general");
    await queueConfirmResult(false);
    await clickById("reset-settings");
    await browser.waitUntil(
      async () => (await confirmDialogTitles()).includes(RESET_TITLE),
      { timeout: 10_000, timeoutMsg: "reset did not ask for confirmation" },
    );
    assert.notEqual(
      readSettingsFileRaw(),
      null,
      "declined reset removed settings",
    );
    await closeSettingsModalViaUi();
  });

  it("shows the Balanced preset on a first run", async () => {
    // Only an explicit setupComplete:false makes the E2E build show the
    // wizard (app-init.ts). No compression keys: the defaults must apply.
    await flushPendingSettingsWrites();
    fs.mkdirSync(settingsDir(), { recursive: true });
    fs.writeFileSync(
      settingsJsonPath(),
      `${JSON.stringify({ setupComplete: false })}\n`,
    );
    await reloadMainWindow();

    await waitForWizard(true, "wizard did not show on a first run");
    await clickById("setup-welcome-skip");
    await waitForWizard(false, "wizard did not close after skip");

    // app-init awaits the wizard before it wires workspace buttons, so a
    // click made as the wizard closes is lost. Retry until the switch sticks.
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          document.getElementById("workspace-mode-power")?.click();
        });
        return browser.execute(
          () =>
            document.getElementById("app")?.dataset.workspaceMode === "power",
        );
      },
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: "Power workspace did not activate after the wizard",
      },
    );
    await waitForArchiveIdle();
    const values = {
      preset: await settingsValue("#preset"),
      format: await settingsValue("#format"),
      level: await settingsValue("#level"),
      method: await settingsValue("#method"),
      dict: await settingsValue("#dict"),
      wordSize: await settingsValue("#word-size"),
      solid: await settingsValue("#solid"),
    };
    assert.deepEqual(values, {
      preset: "balanced",
      format: "7z",
      level: "5",
      method: "lzma2",
      dict: "64m",
      wordSize: "64",
      solid: "4g",
    });

    writeEvidence(EVIDENCE_DIR, "audit-settings-first-run-preset", {
      spec: "audit-settings",
      case: "first-run-balanced",
      ...values,
    });
  });

  it("skips the wizard from a later step and closes it on Escape", async () => {
    await openSettingsModal();
    await clickById("rerun-setup-wizard");
    await waitForWizard(true, "re-run wizard did not open");
    await clickById("setup-welcome-next");
    await clickById("setup-skip-step-1");
    await waitForWizard(false, "Skip on step 1 did not close the wizard");

    await clickById("rerun-setup-wizard");
    await waitForWizard(true, "second re-run wizard did not open");
    await clickById("setup-welcome-next");
    await clickById("setup-workspace-next");
    await dispatchDocumentKey("Escape");
    await waitForWizard(false, "Escape on step 2 did not close the wizard");
    assert.equal(
      (await loadSettingsObject()).setupComplete,
      true,
      "closing the wizard early did not mark setup complete",
    );

    writeEvidence(EVIDENCE_DIR, "audit-settings-wizard-skip", {
      spec: "audit-settings",
      case: "wizard-skip-and-escape",
      skipFromStep1: true,
      escapeFromStep2: true,
    });
  });
});
