import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import {
  closeSettingsModalViaUi,
  clickSettingsTab,
  openSettingsModal,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-tools");
const RATING_LABEL = /^Rating: \d{1,3}(,\d{3})* MIPS$/;

/** True when this launch is the quick-extract window (`--extract`). */
async function launchedAsExtractWindow() {
  return browser.execute(() => Boolean(document.getElementById("extract-app")));
}

async function benchmarkSnapshot() {
  return browser.execute(() => {
    const run = document.getElementById("run-benchmark");
    const cancel = document.getElementById("cancel-benchmark");
    const addFiles = document.getElementById("add-files");
    const result = document.getElementById("benchmark-result");
    return {
      runDisabled: run instanceof HTMLButtonElement ? run.disabled : null,
      cancelVisible: cancel instanceof HTMLElement ? !cancel.hidden : false,
      addFilesDisabled:
        addFiles instanceof HTMLButtonElement ? addFiles.disabled : null,
      result: result?.textContent?.trim() ?? "",
    };
  });
}

async function clickById(id) {
  await browser.execute((elementId) => {
    document.getElementById(elementId)?.click();
  }, id);
}

describe("audit tools: main window", function () {
  this.timeout(10 * 60_000);

  before(async function () {
    if (await launchedAsExtractWindow()) this.skip();
    fs.mkdirSync(ROOT, { recursive: true });
    await waitForMainWindow();
    await waitForE2eHook();
    await openSettingsModal();
    await clickSettingsTab("tab-about");
  });

  after(async () => {
    if (await isSettingsOpenSafe()) await closeSettingsModalViaUi();
  });

  it("runs the CPU benchmark under the busy state and reports its MIPS unit", async () => {
    await clickById("run-benchmark");

    await browser.waitUntil(
      async () => {
        const snap = await benchmarkSnapshot();
        return snap.runDisabled === true && snap.cancelVisible === true;
      },
      {
        timeout: 30_000,
        timeoutMsg: "benchmark did not enter the busy state with Cancel shown",
      },
    );
    const busy = await benchmarkSnapshot();
    assert.equal(
      busy.addFilesDisabled,
      true,
      "archive controls stayed enabled while the benchmark ran",
    );

    await browser.waitUntil(
      async () => RATING_LABEL.test((await benchmarkSnapshot()).result),
      {
        timeout: 300_000,
        interval: 500,
        timeoutMsg: "benchmark never reported a rating with the MIPS unit",
      },
    );
    const done = await benchmarkSnapshot();
    assert.equal(done.runDisabled, false, "Run stayed disabled after finish");
    assert.equal(
      done.cancelVisible,
      false,
      "Cancel stayed visible after finish",
    );
    assert.equal(
      done.addFilesDisabled,
      false,
      "archive controls stayed locked",
    );

    writeEvidence(EVIDENCE_DIR, "audit-tools-benchmark-rating", {
      scenario: "benchmark-rating-unit",
      busy,
      result: done.result,
    });
  });

  it("cancels a second benchmark run and returns to idle", async () => {
    await clickById("run-benchmark");
    await browser.waitUntil(
      async () => (await benchmarkSnapshot()).cancelVisible === true,
      {
        timeout: 30_000,
        timeoutMsg: "second benchmark run did not show Cancel",
      },
    );

    await clickById("cancel-benchmark");
    await browser.waitUntil(
      async () => (await benchmarkSnapshot()).result === "Benchmark cancelled.",
      {
        timeout: 120_000,
        interval: 250,
        timeoutMsg: "cancelled benchmark did not report Benchmark cancelled.",
      },
    );
    const idle = await benchmarkSnapshot();
    assert.equal(idle.runDisabled, false, "Run stayed disabled after cancel");
    assert.equal(
      idle.cancelVisible,
      false,
      "Cancel stayed visible after cancel",
    );
    assert.equal(
      idle.addFilesDisabled,
      false,
      "archive controls stayed locked after cancel",
    );

    writeEvidence(EVIDENCE_DIR, "audit-tools-benchmark-cancel", {
      scenario: "benchmark-cancel-to-idle",
      result: idle.result,
    });
  });

  it("allows the native context menu on text inputs and suppresses it on plain elements", async () => {
    const probe = await browser.execute(() => {
      const fire = (target) => {
        const event = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const input = document.getElementById("output-path");
      const plain = document.querySelector(".statusbar");
      return {
        inputPrevented: input ? fire(input) : null,
        plainPrevented: plain ? fire(plain) : null,
      };
    });
    assert.equal(
      probe.inputPrevented,
      false,
      "native context menu was blocked on a text input",
    );
    assert.equal(
      probe.plainPrevented,
      true,
      "native context menu was allowed on a plain status bar element",
    );

    writeEvidence(EVIDENCE_DIR, "audit-tools-context-menu", {
      scenario: "context-menu-editable-targets",
      ...probe,
    });
  });
});

async function isSettingsOpenSafe() {
  try {
    return await browser.execute(
      () => document.getElementById("settings-overlay")?.hidden === false,
    );
  } catch {
    return false;
  }
}

describe("audit tools: quick extract window", function () {
  this.timeout(10 * 60_000);

  before(async function () {
    if (!(await launchedAsExtractWindow())) this.skip();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("offers Retry after a quick extract into an unwritable destination", async () => {
    await $("#extract-error").waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: "quick extract into a read-only destination did not fail",
    });

    const retry = await $("#retry-btn");
    await retry.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "Retry button was not shown after the failed quick extract",
    });
    assert.equal((await retry.getText()).trim(), "Retry");
    assert.equal(
      await browser.execute(
        () => document.getElementById("choose-folder-btn") !== null,
      ),
      false,
      "Choose another folder must not be offered: the quick-extract destination is bound",
    );

    const closeLabel = (await $("#close-btn").getText()).trim();
    writeEvidence(EVIDENCE_DIR, "audit-tools-quick-extract-recovery", {
      scenario: "quick-extract-unwritable-recovery",
      archive: process.env.ZINNIA_E2E_AUDIT_RO_ARCHIVE ?? null,
      retryVisible: await retry.isDisplayed(),
      closeLabel,
    });
  });
});
