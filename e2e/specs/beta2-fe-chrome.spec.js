import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  clickSettingsSave,
  closeSettingsModalViaUi,
  dismissToasts,
  flushPendingSettingsWrites,
  invokeLoadSettingsRaw,
  isSettingsOverlayOpen,
  openBasicBrowseForArchive,
  openSettingsModal,
  queueConfirmResult,
  reloadMainWindow,
  switchToBasicWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
  waitForSettingsSavedAndClosed,
} from "../helpers/ui-driver.js";
import {
  seedE2eSettings,
  settingsDirForProfile,
  updateE2eSettings,
} from "../helpers/profile.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-fe-chrome");
const HELLO_7Z = process.env.ZINNIA_E2E_HELLO_7Z;
const UNREADABLE_SEED = "{ not valid json, theme: ";
const INERT_IDS = [
  "titlebar-min",
  "titlebar-max",
  "titlebar-close",
  "open-settings",
];
const MESSAGE_FRAGMENT = "Select an archive to test.";

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

async function clearBasicInputs() {
  await switchToBasicWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
}

async function errorToastState() {
  return browser.execute(() => {
    const toast = document.querySelector(".toast--error");
    const message = toast?.querySelector(".toast-message");
    return {
      present: Boolean(toast),
      leaving: Boolean(toast?.classList.contains("toast--leaving")),
      text: message?.textContent ?? "",
      userSelect: message ? getComputedStyle(message).userSelect : "",
      hasCopy: Boolean(toast?.querySelector(".toast-copy")),
    };
  });
}

async function chromeInertState() {
  return browser.execute((ids) => {
    const state = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      state[id] = el ? Boolean(el.closest("[inert]")) : null;
    }
    return state;
  }, INERT_IDS);
}

async function waitForInputOverlay(open) {
  await browser.waitUntil(
    async () =>
      browser
        .execute(
          () =>
            document.getElementById("input-modal-overlay")?.hidden === false,
        )
        .then((isOpen) => isOpen === open),
    {
      timeout: 15_000,
      timeoutMsg: `replace-settings confirm did not ${open ? "open" : "close"}`,
    },
  );
}

async function makeSettingsUnreadable() {
  fs.mkdirSync(settingsDir(), { recursive: true });
  fs.writeFileSync(settingsJsonPath(), UNREADABLE_SEED);
  await flushPendingSettingsWrites();
  await reloadMainWindow();
  await waitForMainWindow();
}

async function restoreBaselineSettings() {
  if (browser.sessionId) {
    if (await isSettingsOverlayOpen().catch(() => false)) {
      await closeSettingsModalViaUi().catch(() => undefined);
    }
    await flushPendingSettingsWrites().catch(() => undefined);
  }
  seedE2eSettings(settingsDir());
  updateE2eSettings(e2eProfileDir(), {
    setupComplete: true,
    workspaceMode: "basic",
    theme: "system",
    customPresets: [],
  });
  if (browser.sessionId) {
    await reloadMainWindow();
  }
}

describe("Main-window chrome beta 2", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    assert.ok(HELLO_7Z, "ZINNIA_E2E_HELLO_7Z is not set");
    fs.mkdirSync(ROOT, { recursive: true });
    await restoreBaselineSettings();
  });

  afterEach(async () => {
    await restoreBaselineSettings().catch(() => undefined);
  });

  it("keeps an error toast when its text is clicked, lets the text be selected and copied, and dismisses only from its close button", async () => {
    const corrupt = path.join(ROOT, "toast", "corrupt.7z");
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.copyFileSync(HELLO_7Z, corrupt);
    fs.truncateSync(corrupt, 128);

    await openBasicBrowseForArchive(corrupt);
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(document.querySelector(".toast--error .toast-dismiss")),
        ),
      {
        timeout: 120_000,
        timeoutMsg: "corrupt archive browse did not show an error toast",
      },
    );

    const clipboardHooked = await browser.execute(() => {
      if (!navigator.clipboard) return false;
      window.__zinniaCopied = null;
      navigator.clipboard.writeText = async (text) => {
        window.__zinniaCopied = String(text);
      };
      return true;
    });
    assert.equal(clipboardHooked, true, "navigator.clipboard is unavailable");

    const before = await errorToastState();
    assert.equal(before.present, true);
    assert.equal(before.hasCopy, true, "error toast has no Copy button");
    assert.ok(before.text.trim().length > 0, "error toast has no text");

    await browser.execute(() => {
      document.querySelector(".toast--error .toast-message")?.click();
    });
    await browser.pause(400);
    const afterBodyClick = await errorToastState();
    assert.equal(
      afterBodyClick.present,
      true,
      "body click dismissed the toast",
    );
    assert.equal(afterBodyClick.leaving, false, "body click started dismissal");

    const selected = await browser.execute(() => {
      const el = document.querySelector(".toast--error .toast-message");
      if (!el) return "";
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection ? selection.toString() : "";
    });
    assert.equal(
      selected.trim(),
      before.text.trim(),
      "the toast text could not be selected",
    );
    assert.notEqual(before.userSelect, "none", "toast text is not selectable");

    await browser.execute(() => {
      document.querySelector(".toast--error .toast-copy")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() => typeof window.__zinniaCopied === "string"),
      { timeout: 10_000, timeoutMsg: "Copy did not call writeText" },
    );
    const copied = await browser.execute(() => window.__zinniaCopied);
    assert.equal(copied, before.text, "Copy did not write the message text");

    await browser.execute(() => {
      document.querySelector(".toast--error .toast-dismiss")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() => !document.querySelector(".toast--error")),
      { timeout: 10_000, timeoutMsg: "the close button did not dismiss it" },
    );

    await browser.execute(() => {
      delete window.__zinniaCopied;
      delete navigator.clipboard.writeText;
    });

    writeEvidence(EVIDENCE_DIR, "beta2-fe-chrome-toast-copy-dismiss", {
      spec: "beta2-fe-chrome",
      case: "error-toast-text-copy-close",
      messageLength: before.text.length,
      keptAfterBodyClick: afterBodyClick.present,
      selectedMatchesMessage: selected.trim() === before.text.trim(),
      userSelect: before.userSelect,
      copiedMatchesMessage: copied === before.text,
      dismissedByCloseButton: true,
    });
  });

  it("collapses two identical Basic toasts into one that shows the count", async () => {
    await clearBasicInputs();
    await dismissToasts();
    await browser.execute(() => {
      document.getElementById("basic-tab-browse")?.click();
      document.getElementById("basic-browse-test")?.click();
      document.getElementById("basic-browse-test")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (fragment) =>
            [...document.querySelectorAll(".toast-message")].some((el) =>
              (el.textContent ?? "").includes(fragment),
            ),
          MESSAGE_FRAGMENT,
        ),
      {
        timeout: 30_000,
        timeoutMsg: "Basic test with no archive did not show its toast",
      },
    );

    const toasts = await browser.execute((fragment) => {
      const matching = [...document.querySelectorAll(".toast")].filter((el) =>
        (el.querySelector(".toast-message")?.textContent ?? "").includes(
          fragment,
        ),
      );
      return {
        count: matching.length,
        badge: matching[0]?.querySelector(".toast-count")?.textContent ?? "",
      };
    }, MESSAGE_FRAGMENT);
    assert.equal(toasts.count, 1, "identical toasts stacked");
    assert.equal(toasts.badge, "(2)", "the collapsed toast does not show (2)");

    writeEvidence(EVIDENCE_DIR, "beta2-fe-chrome-toast-collapse", {
      spec: "beta2-fe-chrome",
      case: "identical-toasts-collapse",
      toastCount: toasts.count,
      badge: toasts.badge,
    });
  });

  it("keeps the titlebar and header inert while the replace-settings confirm is open and restores them after Settings closes", async () => {
    await makeSettingsUnreadable();
    await openSettingsModal();
    await clickSettingsSave();
    await waitForInputOverlay(true);

    const duringConfirm = await chromeInertState();
    for (const id of INERT_IDS) {
      assert.equal(duringConfirm[id], true, `#${id} is interactive in a modal`);
    }
    const confirmInert = await browser.execute(() =>
      Boolean(
        document.getElementById("input-modal-confirm")?.closest("[inert]"),
      ),
    );
    assert.equal(confirmInert, false, "the confirm buttons are inert");

    await browser.execute(() => {
      document.getElementById("input-modal-cancel")?.click();
    });
    await waitForInputOverlay(false);
    const whileSettingsOpen = await chromeInertState();
    assert.equal(
      whileSettingsOpen["titlebar-close"],
      true,
      "the header became live while Settings is still open",
    );

    await closeSettingsModalViaUi();
    const afterClose = await chromeInertState();
    for (const id of INERT_IDS) {
      assert.equal(afterClose[id], false, `#${id} stayed inert after close`);
    }

    writeEvidence(EVIDENCE_DIR, "beta2-fe-chrome-inert-confirm", {
      spec: "beta2-fe-chrome",
      case: "titlebar-inert-under-confirm",
      duringConfirm,
      whileSettingsOpen: whileSettingsOpen["titlebar-close"],
      afterClose,
    });
  });

  it("does not persist a Settings preview made before an automatic save, and Cancel restores the previous value", async () => {
    await openSettingsModal();
    await clickSettingsSave();
    await waitForSettingsSavedAndClosed();
    await flushPendingSettingsWrites();
    const baselineRaw = readSettingsFileRaw();
    assert.ok(baselineRaw, "the baseline settings file was not written");
    const baseline = JSON.parse(baselineRaw);

    await openSettingsModal();
    const fxBefore = await browser.execute(
      () => document.getElementById("s-basic-window-effects")?.checked ?? null,
    );
    const themeBefore = await browser.execute(
      () => document.documentElement.dataset.theme ?? "",
    );
    assert.equal(
      typeof fxBefore,
      "boolean",
      "the window-effects control is missing",
    );

    await browser.execute(() => {
      const fx = document.getElementById("s-basic-window-effects");
      fx.checked = !fx.checked;
      fx.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("toggle-activity")?.click();
      document.getElementById("toggle-activity")?.click();
    });
    await browser.pause(800);

    const duringPreview = JSON.parse(readSettingsFileRaw() ?? "{}");
    assert.deepEqual(
      duringPreview,
      baseline,
      "an automatic save persisted the unconfirmed Settings preview",
    );

    await queueConfirmResult(true);
    await closeSettingsModalViaUi();

    await openSettingsModal();
    const fxAfter = await browser.execute(
      () => document.getElementById("s-basic-window-effects")?.checked ?? null,
    );
    const themeAfter = await browser.execute(
      () => document.documentElement.dataset.theme ?? "",
    );
    await closeSettingsModalViaUi();
    await flushPendingSettingsWrites();

    assert.equal(
      fxAfter,
      fxBefore,
      "Cancel did not restore the window-effects value",
    );
    assert.equal(themeAfter, themeBefore, "Cancel changed the theme");
    assert.deepEqual(
      JSON.parse(readSettingsFileRaw() ?? "{}"),
      baseline,
      "the settings file changed after Cancel",
    );
    const loaded = JSON.parse((await invokeLoadSettingsRaw()).raw);
    assert.equal(loaded.basicWindowEffects, baseline.basicWindowEffects);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-chrome-preview-cancel", {
      spec: "beta2-fe-chrome",
      case: "settings-preview-then-cancel",
      basicWindowEffectsBaseline: baseline.basicWindowEffects,
      fxBefore,
      fxAfter,
      themeBefore,
      themeAfter,
      fileUnchangedAfterCancel: true,
    });
  });

  it("keeps automatic writes out of an unreadable settings file and asks before Save replaces it, with the confirm described by its message", async () => {
    await makeSettingsUnreadable();
    const seedRaw = readSettingsFileRaw();
    assert.equal(
      seedRaw,
      UNREADABLE_SEED,
      "the unreadable seed was not written",
    );

    await browser.execute(() => {
      document.getElementById("toggle-activity")?.click();
      document.getElementById("toggle-activity")?.click();
    });
    await browser.pause(800);
    assert.equal(
      readSettingsFileRaw(),
      seedRaw,
      "an automatic write replaced the unreadable settings file",
    );

    await openSettingsModal();
    await clickSettingsSave();
    await waitForInputOverlay(true);

    const dialog = await browser.execute(() => {
      const modal = document.querySelector("#input-modal-overlay .modal");
      const describedBy = modal?.getAttribute("aria-describedby") ?? "";
      const target = describedBy ? document.getElementById(describedBy) : null;
      return {
        role: modal?.getAttribute("role") ?? "",
        describedBy,
        targetText: target?.textContent?.trim() ?? "",
        messageText:
          document.getElementById("input-modal-label")?.textContent?.trim() ??
          "",
      };
    });
    assert.equal(dialog.role, "dialog");
    assert.ok(dialog.describedBy, "the confirm dialog has no aria-describedby");
    assert.ok(
      dialog.targetText.length > 0,
      "aria-describedby points at nothing",
    );
    assert.equal(
      dialog.targetText,
      dialog.messageText,
      "aria-describedby does not point at the message",
    );
    assert.match(dialog.targetText, /Saving will replace/);

    await browser.execute(() => {
      document.getElementById("input-modal-cancel")?.click();
    });
    await waitForInputOverlay(false);
    assert.equal(
      readSettingsFileRaw(),
      seedRaw,
      "declining the replacement changed the unreadable file",
    );
    assert.equal(
      await isSettingsOverlayOpen(),
      true,
      "declining the replacement closed Settings",
    );

    await clickSettingsSave();
    await waitForInputOverlay(true);
    await browser.execute(() => {
      document.getElementById("input-modal-confirm")?.click();
    });
    await waitForSettingsSavedAndClosed();

    const replaced = readSettingsFileRaw();
    assert.ok(replaced, "the settings file was not written after Replace");
    assert.equal(typeof JSON.parse(replaced).theme, "string");

    writeEvidence(EVIDENCE_DIR, "beta2-fe-chrome-unreadable-replace", {
      spec: "beta2-fe-chrome",
      case: "automatic-blocked-confirm-described-decline-replace",
      describedBy: dialog.describedBy,
      messageMatchesTarget: dialog.targetText === dialog.messageText,
      declineKeptBytes: true,
      replacedWithValidJson: true,
    });
  });
});
