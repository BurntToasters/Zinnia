import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  closeSettingsModalViaUi,
  openSettingsModal,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-copy");

// Visible text for each control, read from the DOM. Hidden controls (Power
// only, behind a mode) keep their text, so the labels are read without
// switching workspaces.
function readLabels() {
  const text = (selector) =>
    document
      .querySelector(selector)
      ?.textContent?.replace(/\s+/g, " ")
      .trim() ?? null;
  return {
    powerCompressTab: text('[data-mode-btn="add"]'),
    quickExtractSelective: text("#quick-extract-selective"),
    quickBrowseSelective: text("#quick-browse-selective"),
    quickBrowseList: text("#quick-browse-list"),
    browseSelective: text("#browse-selective"),
    selectiveTitle: text("#selective-title"),
    selectiveConfirm: text("#selective-confirm"),
    selectiveDestLabel: text('label[for="selective-dest"]'),
    powerOutputLabel: text('label[for="output-path"]'),
    powerExtractLabel: text('label[for="extract-path"]'),
    basicOutputLabel: text('label[for="basic-output-path"]'),
    basicChooseOutput: text("#basic-choose-output"),
    basicExtractLabel: text('label[for="basic-extract-path"]'),
    localLoggingTitle: text("#title-local-logging"),
  };
}

describe("audit copy: terminology, settings wording, trigger and density semantics", function () {
  this.timeout(5 * 60_000);

  before(async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    await waitForMainWindow();
    await waitForE2eHook();
    await waitForArchiveIdle();
  });

  it("uses one term per action in Power, the selective picker, Basic output and Settings", async () => {
    const labels = await browser.execute(readLabels);

    assert.equal(labels.powerCompressTab, "Compress");
    assert.equal(labels.quickExtractSelective, "Extract selected");
    assert.equal(labels.quickBrowseSelective, "Extract selected");
    assert.equal(labels.quickBrowseList, "List contents");
    assert.equal(labels.browseSelective, "Extract selected...");
    assert.equal(labels.selectiveTitle, "Extract selected");
    assert.equal(labels.selectiveConfirm, "Extract selected");
    assert.equal(labels.selectiveDestLabel, "Destination folder");
    assert.equal(labels.powerOutputLabel, "Output archive");
    assert.equal(labels.powerExtractLabel, "Destination folder");
    assert.equal(labels.basicOutputLabel, "Output archive");
    assert.equal(labels.basicChooseOutput, "Choose location");
    assert.equal(labels.basicExtractLabel, "Destination folder");
    assert.match(
      labels.localLoggingTitle ?? "",
      /writes operations, paths and errors to a log file on this device/,
    );

    writeEvidence(EVIDENCE_DIR, "audit-copy-terms", {
      scenario: "terms",
      ...labels,
    });
  });

  it("leaves no aria-expanded on the settings trigger after opening and closing Settings", async () => {
    await openSettingsModal();
    const whileOpen = await browser.execute(() => {
      const trigger = document.getElementById("open-settings");
      return {
        expanded: trigger?.getAttribute("aria-expanded") ?? null,
        haspopup: trigger?.getAttribute("aria-haspopup") ?? null,
      };
    });
    await closeSettingsModalViaUi();

    // Open and close once more through the trigger itself, which is the path
    // that used to write aria-expanded.
    await browser.execute(() => {
      document.getElementById("open-settings")?.click();
    });
    await browser.execute(() => {
      document.getElementById("open-settings")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.getElementById("settings-overlay")?.hidden === true,
        ),
      { timeout: 10_000, timeoutMsg: "settings did not close via trigger" },
    );

    const afterClose = await browser.execute(() => {
      const trigger = document.getElementById("open-settings");
      return {
        hasExpanded: trigger?.hasAttribute("aria-expanded") ?? null,
        haspopup: trigger?.getAttribute("aria-haspopup") ?? null,
        controls: trigger?.getAttribute("aria-controls") ?? null,
      };
    });

    assert.equal(whileOpen.haspopup, "dialog");
    assert.equal(whileOpen.expanded, null, "aria-expanded set while open");
    assert.equal(
      afterClose.hasExpanded,
      false,
      "aria-expanded set after close",
    );
    assert.equal(afterClose.haspopup, "dialog");
    assert.equal(afterClose.controls, null);

    writeEvidence(EVIDENCE_DIR, "audit-copy-settings-trigger", {
      scenario: "settings-trigger",
      whileOpen,
      afterClose,
    });
  });

  it("keeps the density toggle label fixed while aria-pressed changes", async () => {
    const read = () =>
      browser.execute(() => {
        const toggle = document.getElementById("toggle-density");
        return {
          label: toggle?.textContent?.trim() ?? null,
          pressed: toggle?.getAttribute("aria-pressed") ?? null,
          density: document.getElementById("app")?.dataset.density ?? null,
        };
      });
    const press = () =>
      browser.execute(() => {
        document.getElementById("toggle-density")?.click();
      });

    const before = await read();
    await press();
    const pressed = await read();
    await press();
    const restored = await read();

    assert.equal(pressed.label, before.label, "density label changed on press");
    assert.equal(
      restored.label,
      before.label,
      "density label changed on release",
    );
    assert.notEqual(
      pressed.pressed,
      before.pressed,
      "aria-pressed did not change",
    );
    assert.notEqual(pressed.density, before.density, "density did not change");
    assert.equal(restored.pressed, before.pressed);
    assert.equal(restored.density, before.density);

    writeEvidence(EVIDENCE_DIR, "audit-copy-density-toggle", {
      scenario: "density-toggle",
      before,
      pressed,
      restored,
    });
  });
});
