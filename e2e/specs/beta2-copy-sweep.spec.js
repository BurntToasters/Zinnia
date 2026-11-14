import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  clickSettingsTab,
  closeSettingsModalViaUi,
  dispatchDocumentKey,
  isShortcutsOverlayOpen,
  openSettingsModal,
  switchToBasicWorkspace,
  switchToPowerWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const SHIPPED_MARKUP = [
  fileURLToPath(new URL("../../src/index.html", import.meta.url)),
  fileURLToPath(new URL("../../src/extract.html", import.meta.url)),
  fileURLToPath(new URL("../../src/debug-console.html", import.meta.url)),
];
const OS_PILL_IDS = [
  "os-file-assoc-status",
  "os-context-status",
  "os-finder-sync-status",
  "os-finder-services-status",
  "os-win11-menu-status",
];
const PICKER_IDS = [
  "choose-output",
  "choose-extract",
  "selective-browse-dest",
  "basic-choose-output",
  "basic-choose-extract",
];
const THREE_DOTS = /\.\.\./;
const PLURAL_PARENS = /\((?:s|es)\)/;
const ACTIVITY_LOG = /activity log/i;

function readVisibleCopy(scopeId) {
  const scope = scopeId ? document.getElementById(scopeId) : document.body;
  if (!scope) return { items: [], innerText: "" };
  const items = [];
  const selector =
    "button, h1, h2, h3, h4, label, summary, [role='tab'], .status-pill, .setting-title, .settings-label, .setting-desc";
  for (const el of scope.querySelectorAll(selector)) {
    if (el.getClientRects().length === 0) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text === "") continue;
    items.push({ id: el.id || null, tag: el.tagName.toLowerCase(), text });
  }
  return {
    items,
    innerText: (scope.innerText ?? "").replace(/\s+/g, " ").trim(),
  };
}

function readPickerText(ids) {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    out[id] = el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : null;
  }
  return out;
}

function readPillState(ids) {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    out[id] = el
      ? {
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
          classes: Array.from(el.classList),
        }
      : null;
  }
  return out;
}

function violationsIn(items) {
  const threeDots = items.filter((item) => THREE_DOTS.test(item.text));
  const plurals = items.filter((item) => PLURAL_PARENS.test(item.text));
  return { threeDots, plurals };
}

function pillTextFromShippedMarkup(file, id) {
  const source = fs.readFileSync(file, "utf8");
  const match = new RegExp(
    `<span\\s+class="([^"]*)"\\s+id="${id}"\\s*>\\s*Checking…`,
  ).exec(source);
  return match ? match[1].split(/\s+/) : null;
}

describe("beta2 copy sweep: one copy standard across Power, Basic and dialogs", function () {
  this.timeout(5 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    await waitForArchiveIdle();
  });

  it("Power visible buttons, headings, labels and tabs have no three-dot ellipsis or (s) plural, and picker buttons read Choose…", async () => {
    await switchToPowerWorkspace();
    const copy = await browser.execute(readVisibleCopy, null);
    const pickers = await browser.execute(readPickerText, PICKER_IDS);
    const { threeDots, plurals } = violationsIn(copy.items);

    assert.deepEqual(
      threeDots,
      [],
      "Power copy still has a three-dot ellipsis",
    );
    assert.deepEqual(plurals, [], "Power copy still has a (s) plural");
    assert.equal(pickers["choose-output"], "Choose…");
    assert.equal(pickers["choose-extract"], "Choose…");
    assert.equal(pickers["selective-browse-dest"], "Choose…");

    writeEvidence(EVIDENCE_DIR, "beta2-copy-sweep-power", {
      scenario: "power-visible-copy",
      visibleItems: copy.items.length,
      threeDotViolations: threeDots.length,
      pluralViolations: plurals.length,
      pickers,
    });
  });

  it("Settings (General, Compression, OS integration, About), Shortcuts follow the copy standard, and OS pills use --unknown while Checking", async () => {
    await openSettingsModal();
    const seen = [];
    const pillStates = [];
    for (const tab of [
      "tab-general",
      "tab-compression",
      "tab-os",
      "tab-about",
    ]) {
      await clickSettingsTab(tab);
      const copy = await browser.execute(readVisibleCopy, "settings-overlay");
      seen.push(...copy.items);
      pillStates.push(await browser.execute(readPillState, OS_PILL_IDS));
    }
    await closeSettingsModalViaUi();

    const settingsViolations = violationsIn(seen);
    assert.deepEqual(
      settingsViolations.threeDots,
      [],
      "Settings copy still has a three-dot ellipsis",
    );
    assert.deepEqual(
      settingsViolations.plurals,
      [],
      "Settings copy still has a (s) plural",
    );

    let checkingPills = 0;
    for (const snapshot of pillStates) {
      for (const id of OS_PILL_IDS) {
        const pill = snapshot[id];
        if (!pill) continue;
        if (pill.text === "Checking…") {
          checkingPills += 1;
          assert.ok(
            pill.classes.includes("status-pill--unknown"),
            `${id} shows Checking… without status-pill--unknown`,
          );
          assert.ok(
            !pill.classes.includes("status-pill--warn"),
            `${id} shows Checking… with status-pill--warn`,
          );
        }
      }
    }

    let shippedCheckingPills = 0;
    for (const id of OS_PILL_IDS) {
      const classes = pillTextFromShippedMarkup(SHIPPED_MARKUP[0], id);
      assert.ok(classes, `${id} initial Checking… markup not found`);
      shippedCheckingPills += 1;
      assert.ok(
        classes.includes("status-pill--unknown"),
        `${id} ships with the wrong initial class`,
      );
      assert.ok(
        !classes.includes("status-pill--warn"),
        `${id} ships with status-pill--warn while checking`,
      );
    }

    await dispatchDocumentKey("?");
    await browser.waitUntil(async () => isShortcutsOverlayOpen(), {
      timeout: 10_000,
      timeoutMsg: "shortcuts overlay did not open",
    });
    const shortcuts = await browser.execute(
      readVisibleCopy,
      "shortcuts-overlay",
    );
    const shortcutViolations = violationsIn(shortcuts.items);
    assert.deepEqual(shortcutViolations.threeDots, []);
    assert.deepEqual(shortcutViolations.plurals, []);
    await dispatchDocumentKey("Escape");

    writeEvidence(EVIDENCE_DIR, "beta2-copy-sweep-dialogs", {
      scenario: "settings-about-shortcuts",
      settingsItems: seen.length,
      shortcutItems: shortcuts.items.length,
      threeDotViolations:
        settingsViolations.threeDots.length +
        shortcutViolations.threeDots.length,
      pluralViolations:
        settingsViolations.plurals.length + shortcutViolations.plurals.length,
      checkingPillSnapshots: checkingPills,
      shippedCheckingPills,
    });
  });

  it("Basic workspace has no activity-log mention, three-dot ellipsis or (s) plural, and picker buttons read Choose…", async () => {
    await switchToBasicWorkspace();
    const copy = await browser.execute(readVisibleCopy, "basic-workspace");
    const pickers = await browser.execute(readPickerText, PICKER_IDS);
    const { threeDots, plurals } = violationsIn(copy.items);
    const activityHits = copy.items.filter((item) =>
      ACTIVITY_LOG.test(item.text),
    );
    const innerActivity = ACTIVITY_LOG.test(copy.innerText);

    assert.deepEqual(activityHits, [], "Basic copy mentions the activity log");
    assert.equal(
      innerActivity,
      false,
      "Basic visible text mentions the activity log",
    );
    assert.deepEqual(
      threeDots,
      [],
      "Basic copy still has a three-dot ellipsis",
    );
    assert.deepEqual(plurals, [], "Basic copy still has a (s) plural");
    assert.equal(pickers["basic-choose-output"], "Choose…");
    assert.equal(pickers["basic-choose-extract"], "Choose…");

    writeEvidence(EVIDENCE_DIR, "beta2-copy-sweep-basic", {
      scenario: "basic-visible-copy",
      visibleItems: copy.items.length,
      activityLogHits: activityHits.length + (innerActivity ? 1 : 0),
      threeDotViolations: threeDots.length,
      pluralViolations: plurals.length,
      pickers,
    });
  });

  it("the input modal lists Cancel before OK and marks OK as the primary action", async () => {
    const order = await browser.execute(() => {
      const cancel = document.getElementById("input-modal-cancel");
      const confirm = document.getElementById("input-modal-confirm");
      if (!cancel || !confirm) return null;
      const following = Boolean(
        cancel.compareDocumentPosition(confirm) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      return {
        cancelBeforeConfirm: following,
        confirmIsPrimary: confirm.classList.contains("btn--primary"),
      };
    });
    assert.ok(order, "input modal buttons are missing");
    assert.equal(order.cancelBeforeConfirm, true, "Cancel does not precede OK");
    assert.equal(order.confirmIsPrimary, true, "OK lacks btn--primary");

    writeEvidence(EVIDENCE_DIR, "beta2-copy-sweep-dialog-footer", {
      scenario: "input-modal-footer",
      ...order,
    });
  });

  it("shipped markup has no three-dot ellipsis or (s) plural in index, extract or debug console pages", async () => {
    const report = SHIPPED_MARKUP.map((file) => {
      const source = fs.readFileSync(file, "utf8");
      return {
        file: path.basename(file),
        threeDots: (source.match(/\.\.\./g) ?? []).length,
        plurals: (source.match(/\((?:s|es)\)/g) ?? []).length,
      };
    });
    for (const entry of report) {
      assert.equal(
        entry.threeDots,
        0,
        `${entry.file} still has a three-dot ellipsis`,
      );
      assert.equal(entry.plurals, 0, `${entry.file} still has a (s) plural`);
    }

    writeEvidence(EVIDENCE_DIR, "beta2-copy-sweep-markup", {
      scenario: "shipped-markup",
      files: report,
    });
  });
});
