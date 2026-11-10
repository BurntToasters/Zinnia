import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  applyIncomingPaths,
  clickBasicRunExtract,
  dismissToasts,
  dispatchDocumentKey,
  domValue,
  setSelectValue,
  isShortcutsOverlayOpen,
  openBasicBrowseForArchive,
  openBasicRecentsMenu,
  openSettingsModal,
  prepareBasicExtract,
  setInputValue,
  switchToBasicWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
  isSettingsOverlayOpen,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-keyboard");
const HELLO_TXT = process.env.ZINNIA_E2E_HELLO_TXT;
const HELLO_7Z = process.env.ZINNIA_E2E_HELLO_7Z;
const HELLO_ZIP = process.env.ZINNIA_E2E_HELLO_ZIP;

/** Visible Basic view ids and the file rows in the compress list. */
async function basicViewState() {
  return browser.execute(() => ({
    activeViews: [
      ...document.querySelectorAll("#basic-workspace .basic-view.is-active"),
    ].map((el) => el.id),
    files: [...document.querySelectorAll("#basic-input-list .basic-file-item")]
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean),
  }));
}

async function loadCompressWithFile() {
  await switchToBasicWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
  await applyIncomingPaths([HELLO_TXT], "compress");
  await browser.waitUntil(
    async () => {
      const state = await basicViewState();
      return (
        state.activeViews.includes("basic-compress") && state.files.length > 0
      );
    },
    {
      timeout: 30_000,
      timeoutMsg: "Basic Compress did not load with a file in the list",
    },
  );
}

/** Dispatch a keydown on the focused element so it bubbles like a real key. */
async function pressOnActive(key) {
  await browser.execute((nextKey) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: nextKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, key);
}

/** Sticky toasts still on screen (not fading out). */
async function stickyToastCount() {
  return browser.execute(
    () =>
      document.querySelectorAll(
        '.toast[data-sticky="true"]:not(.toast--leaving)',
      ).length,
  );
}

/** Enter with the IME flag set, dispatched on the named control. */
async function dispatchEnterOn(id, { composing }) {
  await browser.execute(
    (nextId, nextComposing) => {
      const el = document.getElementById(nextId);
      if (!el) throw new Error(`missing #${nextId}`);
      el.focus();
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: nextComposing,
        bubbles: true,
        cancelable: true,
      });
      if (nextComposing) {
        Object.defineProperty(event, "keyCode", { get: () => 229 });
      }
      el.dispatchEvent(event);
    },
    id,
    composing,
  );
}

async function isRecentMenuOpen() {
  return browser.execute(
    () =>
      document.getElementById("header-recent")?.classList.contains("is-open") ??
      false,
  );
}

async function recentItemLabels() {
  return browser.execute(() =>
    [
      ...document.querySelectorAll("#header-recent-menu .header-recent__item"),
    ].map((el) => el.textContent?.trim() ?? ""),
  );
}

async function activeRecentIndex() {
  return browser.execute(() => {
    const items = [
      ...document.querySelectorAll("#header-recent-menu .header-recent__item"),
    ];
    return items.indexOf(document.activeElement);
  });
}

describe("audit keyboard", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it("Esc closes Settings and leaves Basic Compress with its file list", async () => {
    await loadCompressWithFile();
    const before = await basicViewState();

    await openSettingsModal();
    await dispatchDocumentKey("Escape");
    await browser.waitUntil(async () => !(await isSettingsOverlayOpen()), {
      timeout: 10_000,
      timeoutMsg: "Esc did not close Settings",
    });

    const after = await basicViewState();
    assert.ok(
      after.activeViews.includes("basic-compress"),
      `Esc from Settings left Basic on ${JSON.stringify(after.activeViews)}`,
    );
    assert.deepEqual(after.files, before.files);

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-settings-esc", {
      scenario: "settings-esc-keeps-compress",
      before,
      after,
    });
  });

  it("Esc closes Keyboard Shortcuts and leaves Basic Compress with its file list", async () => {
    await loadCompressWithFile();
    const before = await basicViewState();

    await dispatchDocumentKey("?");
    await browser.waitUntil(async () => isShortcutsOverlayOpen(), {
      timeout: 10_000,
      timeoutMsg: "? did not open Keyboard Shortcuts",
    });
    await dispatchDocumentKey("Escape");
    await browser.waitUntil(async () => !(await isShortcutsOverlayOpen()), {
      timeout: 10_000,
      timeoutMsg: "Esc did not close Keyboard Shortcuts",
    });

    const after = await basicViewState();
    assert.ok(
      after.activeViews.includes("basic-compress"),
      `Esc from Shortcuts left Basic on ${JSON.stringify(after.activeViews)}`,
    );
    assert.deepEqual(after.files, before.files);

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-shortcuts-esc", {
      scenario: "shortcuts-esc-keeps-compress",
      before,
      after,
    });
  });

  it("Esc on a focused sticky toast dismisses it without leaving Basic", async () => {
    const corrupt = path.join(ROOT, "corrupt-sticky.7z");
    fs.copyFileSync(HELLO_7Z, corrupt);
    fs.truncateSync(corrupt, 128);

    await dismissToasts();
    await openBasicBrowseForArchive(corrupt);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector(".toast--error .toast-dismiss") !== null,
        ),
      {
        timeout: 120_000,
        timeoutMsg:
          "corrupt archive browse did not show a sticky error toast; update this case",
      },
    );

    await applyIncomingPaths([HELLO_TXT], "compress");
    const before = await basicViewState();
    assert.ok(before.activeViews.includes("basic-compress"));

    const wrap = await browser.execute(() => {
      const el = document.querySelector(".toast--error .toast-message");
      if (!el) throw new Error("sticky toast message missing");
      const style = getComputedStyle(el);
      return {
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
      };
    });
    assert.equal(wrap.whiteSpace, "pre-line");
    assert.equal(wrap.overflowWrap, "anywhere");

    await browser.execute(() => {
      const toast = document.querySelector(".toast--error");
      if (!toast) throw new Error("sticky toast missing");
      toast.focus();
      toast.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelectorAll(".toast--error").length === 0,
        ),
      { timeout: 10_000, timeoutMsg: "Esc did not dismiss the sticky toast" },
    );

    const after = await basicViewState();
    assert.deepEqual(after.activeViews, before.activeViews);
    assert.deepEqual(after.files, before.files);

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-sticky-toast-esc", {
      scenario: "sticky-toast-esc-keeps-view",
      wrap,
      before,
      after,
    });
  });

  it("keeps at most three sticky toasts on screen", async () => {
    const corrupt = path.join(ROOT, "corrupt-cap.7z");
    fs.copyFileSync(HELLO_7Z, corrupt);
    fs.truncateSync(corrupt, 128);

    await dismissToasts();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await openBasicBrowseForArchive(corrupt);
      const expectedAtLeast = Math.min(attempt, 3);
      await browser.waitUntil(
        async () => (await stickyToastCount()) >= expectedAtLeast,
        {
          timeout: 120_000,
          timeoutMsg: `browse ${attempt} did not add a sticky toast`,
        },
      );
    }
    await browser.waitUntil(async () => (await stickyToastCount()) === 3, {
      timeout: 30_000,
      timeoutMsg: "sticky toasts were not capped at three",
    });
    const count = await stickyToastCount();

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-sticky-cap", {
      scenario: "sticky-toast-cap-three",
      stickyCount: count,
    });
    await dismissToasts();
  });

  it("Esc on a focused timed toast dismisses it from the keyboard", async () => {
    await loadCompressWithFile();
    await dismissToasts();
    // Test with a file still selected runs against that file, not the
    // "no archive" branch that shows the timed toast, so clear the list first.
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await browser.execute(() => {
      document.getElementById("basic-tab-browse")?.click();
      document.getElementById("basic-browse-test")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.querySelectorAll(".toast-message")].some((el) =>
            (el.textContent ?? "").includes("Select an archive to test."),
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: "Test with no archive did not show a timed toast",
      },
    );
    const before = await basicViewState();

    await browser.execute(() => {
      const toast = [...document.querySelectorAll(".toast")].find((el) =>
        (el.textContent ?? "").includes("Select an archive to test."),
      );
      if (!toast) throw new Error("timed toast missing");
      toast.focus();
      toast.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            ![...document.querySelectorAll(".toast-message")].some((el) =>
              (el.textContent ?? "").includes("Select an archive to test."),
            ),
        ),
      { timeout: 5_000, timeoutMsg: "Esc did not dismiss the timed toast" },
    );

    const after = await basicViewState();
    assert.deepEqual(after.activeViews, before.activeViews);

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-timed-toast-esc", {
      scenario: "timed-toast-esc",
      before,
      after,
    });
  });

  it("Enter during IME composition starts nothing, and a plain Enter still starts", async () => {
    await loadCompressWithFile();
    const output = path.join(ROOT, "ime-guard.7z");
    fs.rmSync(output, { force: true });
    await setInputValue("#basic-output-path", output);

    await dispatchEnterOn("basic-password", { composing: true });
    await browser.pause(3_000);
    const startedWhileComposing = fs.existsSync(output);
    assert.equal(
      startedWhileComposing,
      false,
      "Enter during IME composition started a compression",
    );

    await dispatchEnterOn("basic-password", { composing: false });
    try {
      await browser.waitUntil(() => fs.existsSync(output), {
        timeout: 120_000,
        timeoutMsg: `plain Enter did not write ${output}`,
      });
    } catch (err) {
      const diagnostics = await browser.execute(() => ({
        activeId: document.activeElement?.id ?? "",
        activeType: document.activeElement?.type ?? "",
        runDisabled:
          document.getElementById("basic-run-compress")?.disabled ?? null,
        status: document.getElementById("basic-compress-status")?.textContent,
        toasts: [...document.querySelectorAll(".toast-message")].map(
          (el) => el.textContent,
        ),
        outputPath: document.getElementById("basic-output-path")?.value,
      }));
      const rootEntries = fs.readdirSync(ROOT);
      throw new Error(
        `${err.message}; diagnostics ${JSON.stringify({ diagnostics, rootEntries })}`,
      );
    }
    await waitForArchiveIdle();

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-ime-enter", {
      scenario: "ime-enter-does-not-run",
      startedWhileComposing,
      plainEnterWroteArchive: fs.existsSync(output),
    });
  });

  it("Enter on a checkbox in Basic Compress does not start an operation", async () => {
    await loadCompressWithFile();
    const output = path.join(ROOT, "checkbox-guard.7z");
    fs.rmSync(output, { force: true });
    await setInputValue("#basic-output-path", output);
    // The encrypt-headers row only appears for formats that support header
    // encryption, so select 7z first and restore the original format after.
    const originalFormat = await domValue("#basic-format");
    await setSelectValue("#basic-format", "7z");

    const checkedBefore = await browser.execute(
      () => document.getElementById("basic-encrypt-headers")?.checked,
    );
    await dispatchEnterOn("basic-encrypt-headers", { composing: false });
    await browser.pause(3_000);

    const started = fs.existsSync(output);
    assert.equal(started, false, "Enter on a checkbox started a compression");
    const checkedAfter = await browser.execute(
      () => document.getElementById("basic-encrypt-headers")?.checked,
    );
    assert.equal(checkedAfter, checkedBefore);

    await setSelectValue("#basic-format", originalFormat);

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-checkbox-enter", {
      scenario: "checkbox-enter-does-not-run",
      started,
      checkedBefore,
      checkedAfter,
    });
  });

  it("Recent menu moves focus with arrow, Home and End keys and Esc returns focus to the trigger", async () => {
    const dest1 = path.join(ROOT, "recent-extract-1");
    const dest2 = path.join(ROOT, "recent-extract-2");
    fs.mkdirSync(dest1, { recursive: true });
    fs.mkdirSync(dest2, { recursive: true });
    await prepareBasicExtract(HELLO_7Z, dest1);
    await clickBasicRunExtract();
    await waitForArchiveIdle();
    await prepareBasicExtract(HELLO_ZIP, dest2);
    await clickBasicRunExtract();
    await waitForArchiveIdle();

    await dismissToasts();
    await openBasicRecentsMenu();
    await browser.waitUntil(
      async () => (await recentItemLabels()).length >= 2,
      { timeout: 10_000, timeoutMsg: "Recent menu did not list two archives" },
    );
    await browser.waitUntil(async () => (await activeRecentIndex()) === 0, {
      timeout: 10_000,
      timeoutMsg: "Recent menu did not focus its first item on open",
    });
    const count = (await recentItemLabels()).length;
    const before = await basicViewState();

    await pressOnActive("ArrowDown");
    assert.equal(await activeRecentIndex(), 1 % count, "ArrowDown");
    await pressOnActive("ArrowDown");
    assert.equal(await activeRecentIndex(), 2 % count, "ArrowDown wrap");
    await pressOnActive("ArrowUp");
    assert.equal(await activeRecentIndex(), 1 % count, "ArrowUp");
    await pressOnActive("End");
    assert.equal(await activeRecentIndex(), count - 1, "End");
    await pressOnActive("Home");
    assert.equal(await activeRecentIndex(), 0, "Home");

    await pressOnActive("Escape");
    await browser.waitUntil(async () => !(await isRecentMenuOpen()), {
      timeout: 10_000,
      timeoutMsg: "Esc did not close the Recent menu",
    });
    const trigger = await browser.execute(
      () => document.activeElement?.id ?? "",
    );
    assert.equal(trigger, "header-recent-btn", "focus did not return");

    const after = await basicViewState();
    assert.deepEqual(after.activeViews, before.activeViews);

    writeEvidence(EVIDENCE_DIR, "audit-keyboard-recent-menu", {
      scenario: "recent-menu-arrow-navigation",
      itemCount: count,
      focusAfterEsc: trigger,
      before,
      after,
    });
  });
});
