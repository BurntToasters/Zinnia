import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  applyIncomingPaths,
  dismissToasts,
  dispatchDocumentKey,
  isShortcutsOverlayOpen,
  setInputValue,
  switchToBasicWorkspace,
  switchToPowerWorkspace,
  waitForArchiveIdle,
  waitForDomText,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-ui-markup");
const HELLO_7Z = process.env.ZINNIA_E2E_HELLO_7Z;
const REMOVED_METHODS = ["ppmd", "bzip2", "zstd"];

function writeRandomFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = fs.openSync(file, "w");
  try {
    const chunk = 4 * 1024 * 1024;
    for (let written = 0; written < bytes; written += chunk) {
      fs.writeSync(
        handle,
        crypto.randomBytes(Math.min(chunk, bytes - written)),
      );
    }
  } finally {
    fs.closeSync(handle);
  }
}

async function startIdle() {
  await switchToBasicWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
}

async function clearBasicInputs() {
  await startIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
}

async function startAnnouncerCounter() {
  await browser.execute(() => {
    const el = document.getElementById("progress-announcer");
    const state = { count: 0, texts: [] };
    window.__zinniaAnnouncer = state;
    if (!el) return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList" || record.type === "characterData") {
          state.count += 1;
          state.texts.push(el.textContent ?? "");
        }
      }
    });
    observer.observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.__zinniaAnnouncerObserver = observer;
  });
}

async function stopAnnouncerCounter() {
  return browser.execute(() => {
    window.__zinniaAnnouncerObserver?.disconnect();
    delete window.__zinniaAnnouncerObserver;
    const state = window.__zinniaAnnouncer ?? { count: 0, texts: [] };
    delete window.__zinniaAnnouncer;
    return state;
  });
}

async function announcerState() {
  return browser.execute(() => {
    const el = document.getElementById("progress-announcer");
    if (!el) return { present: false };
    const hiddenAncestors = [];
    for (
      let node = el;
      node && node !== document.documentElement;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (
        node.hidden ||
        style.display === "none" ||
        style.visibility === "hidden"
      ) {
        hiddenAncestors.push(node.id || node.tagName.toLowerCase());
      }
    }
    const rect = el.getBoundingClientRect();
    return {
      present: true,
      count: document.querySelectorAll("#progress-announcer").length,
      role: el.getAttribute("role"),
      live: el.getAttribute("aria-live"),
      srOnly: el.classList.contains("sr-only"),
      insideStatusbar: el.closest(".statusbar") !== null,
      hiddenAncestors,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function cardAccessibleName(cardId) {
  return browser.execute((id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const ariaLabel = el.getAttribute("aria-label");
    const source =
      labelledBy.length > 0
        ? labelledBy
            .map((ref) => document.getElementById(ref)?.textContent ?? "")
            .join(" ")
        : (ariaLabel ?? el.textContent ?? "");
    return {
      name: source.replace(/\s+/g, " ").trim(),
      ariaLabel,
      role: el.getAttribute("role"),
      tabindex: el.getAttribute("tabindex"),
    };
  }, cardId);
}

async function shortcutRows() {
  return browser.execute(() =>
    [...document.querySelectorAll("#shortcut-list .shortcut-list__row")].map(
      (row) => ({
        workspace: row.dataset.workspace ?? null,
        keys: (row.querySelector("dt")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        description: (row.querySelector("dd")?.textContent ?? "").trim(),
      }),
    ),
  );
}

async function openShortcutsWithQuestionMark() {
  await dispatchDocumentKey("?");
  await browser.waitUntil(() => isShortcutsOverlayOpen(), {
    timeout: 10_000,
    timeoutMsg: "? did not open the shortcuts overlay",
  });
  return shortcutRows();
}

async function closeShortcuts() {
  await browser.execute(() => {
    document.getElementById("close-shortcuts")?.click();
  });
  await browser.waitUntil(async () => !(await isShortcutsOverlayOpen()), {
    timeout: 10_000,
    timeoutMsg: "shortcuts overlay did not close",
  });
}

function workspacesOf(rows) {
  return [...new Set(rows.map((row) => row.workspace))].sort();
}

describe("beta2 ui markup: progress announcer, card names, method options, shortcuts, live regions and Options group", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    await waitForMainWindow();
    await waitForE2eHook();
  });

  after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("keeps #progress-announcer outside hidden chrome and receives text during a Basic compress", async () => {
    await clearBasicInputs();
    const basicState = await announcerState();
    assert.equal(basicState.present, true, "#progress-announcer is missing");
    assert.equal(basicState.count, 1, "more than one #progress-announcer");
    assert.equal(
      basicState.insideStatusbar,
      false,
      "#progress-announcer is inside the statusbar, which Basic hides",
    );
    assert.deepEqual(
      basicState.hiddenAncestors,
      [],
      "#progress-announcer has a hidden ancestor in Basic",
    );
    assert.equal(basicState.role, "status");
    assert.equal(basicState.live, "polite");
    assert.equal(basicState.srOnly, true, "#progress-announcer lost sr-only");
    assert.ok(
      basicState.width <= 1 && basicState.height <= 1,
      `#progress-announcer takes layout space: ${basicState.width}x${basicState.height}`,
    );

    await switchToPowerWorkspace();
    const powerState = await announcerState();
    assert.deepEqual(
      powerState.hiddenAncestors,
      [],
      "#progress-announcer has a hidden ancestor in Power",
    );
    await switchToBasicWorkspace();

    const payload = path.join(ROOT, "announce", "payload.bin");
    const output = path.join(ROOT, "announce", "payload.7z");
    fs.rmSync(output, { force: true });
    writeRandomFile(payload, 16 * 1024 * 1024);

    await applyIncomingPaths([payload], "compress");
    await setInputValue("#basic-output-path", output);
    await startAnnouncerCounter();
    await browser.execute(() => {
      document.getElementById("basic-run-compress")?.click();
    });
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: 180_000,
      timeoutMsg: `basic compress did not write ${output}`,
    });
    await waitForArchiveIdle();
    const announced = await stopAnnouncerCounter();

    assert.ok(
      announced.count >= 1,
      "the announcer received no text during a Basic compress",
    );
    assert.ok(
      announced.texts.some((text) => text.trim().length > 0),
      `the announcer stayed empty: ${JSON.stringify(announced.texts)}`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-ui-markup-announcer", {
      scenario: "progress-announcer-outside-hidden-chrome",
      basic: basicState,
      power: powerState,
      announcerUpdates: announced.count,
      announcements: announced.texts,
    });
  });

  it("names each Basic archive card by the archive file name", async () => {
    const archiveName = path.basename(HELLO_7Z);

    await clearBasicInputs();
    await applyIncomingPaths([HELLO_7Z], "extract");
    await waitForDomText(
      "#basic-extract-archive-name",
      archiveName,
      "Basic extract did not show the archive",
    );
    const extract = await cardAccessibleName("basic-extract-archive-info");

    await clearBasicInputs();
    await applyIncomingPaths([HELLO_7Z], "");
    await waitForDomText(
      "#basic-browse-archive-name",
      archiveName,
      "Basic browse did not show the archive",
    );
    const browse = await cardAccessibleName("basic-browse-archive-info");

    for (const [scope, card] of [
      ["extract", extract],
      ["browse", browse],
    ]) {
      assert.ok(card, `#basic-${scope}-archive-info is missing`);
      assert.ok(
        card.name.includes(archiveName),
        `the Basic ${scope} card is named "${card.name}" and does not include ${archiveName}`,
      );
      assert.equal(card.role, "button", `Basic ${scope} card lost role=button`);
      assert.equal(
        card.tabindex,
        "0",
        `Basic ${scope} card left the tab order`,
      );
    }

    await clearBasicInputs();
    writeEvidence(EVIDENCE_DIR, "beta2-ui-markup-card-names", {
      scenario: "basic-archive-card-accessible-name",
      archiveName,
      extractName: extract.name,
      extractAriaLabel: extract.ariaLabel,
      browseName: browse.name,
      browseAriaLabel: browse.ariaLabel,
    });
  });

  it("offers no PPMd, BZip2 or Zstandard method in any format the Format select offers", async () => {
    await startIdle();
    await switchToPowerWorkspace();
    const sweep = await browser.execute(() => {
      const ids = ["format", "s-format", "method", "s-method"];
      const missing = ids.filter((id) => !document.getElementById(id));
      if (missing.length > 0) return { missing };
      const format = document.getElementById("format");
      const sFormat = document.getElementById("s-format");
      const method = document.getElementById("method");
      const sMethod = document.getElementById("s-method");
      const optionValues = (select) =>
        [...select.options].map((option) => option.value);
      const choose = (select, value) => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const originalFormat = format.value;
      const originalSettingsFormat = sFormat.value;
      const formats = optionValues(format);
      const perFormat = formats.map((name) => {
        choose(format, name);
        choose(sFormat, name);
        return {
          format: name,
          settingsFormat: sFormat.value,
          method: optionValues(method),
          settingsMethod: optionValues(sMethod),
        };
      });
      choose(format, originalFormat);
      choose(sFormat, originalSettingsFormat);
      return {
        missing,
        formats,
        perFormat,
        originalFormat,
        restoredFormat: format.value,
      };
    });

    assert.deepEqual(
      sweep.missing,
      [],
      `the method check cannot find ${sweep.missing.join(", ")}`,
    );
    assert.ok(
      sweep.formats.includes("bzip2"),
      "the Format select lost bzip2, which is a real archive format",
    );
    assert.ok(
      sweep.perFormat.some((row) => row.method.length > 0),
      "no format showed a method list, so the sweep read nothing",
    );
    for (const row of sweep.perFormat) {
      assert.equal(
        row.settingsFormat,
        row.format,
        `the Settings format did not follow ${row.format}`,
      );
      for (const [label, values] of [
        ["#method", row.method],
        ["#s-method", row.settingsMethod],
      ]) {
        const removed = values.filter((value) =>
          REMOVED_METHODS.includes(value),
        );
        assert.deepEqual(
          removed,
          [],
          `${label} still offers ${removed.join(", ")} for format ${row.format}`,
        );
      }
    }
    assert.equal(
      sweep.restoredFormat,
      sweep.originalFormat,
      "the sweep did not restore the Format select",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-ui-markup-method-options", {
      scenario: "method-selects-per-format-without-removed-methods",
      removedMethods: REMOVED_METHODS,
      formats: sweep.formats,
      perFormat: sweep.perFormat,
      originalFormat: sweep.originalFormat,
      restoredFormat: sweep.restoredFormat,
    });
  });

  it("shows only the rows of the workspace that is active when the shortcuts dialog opens", async () => {
    await startIdle();
    await switchToPowerWorkspace();
    const power = await openShortcutsWithQuestionMark();
    await closeShortcuts();

    await switchToBasicWorkspace();
    const basic = await openShortcutsWithQuestionMark();
    await closeShortcuts();

    assert.deepEqual(
      workspacesOf(power),
      ["all", "power"],
      `Power shortcuts show the wrong rows: ${JSON.stringify(power)}`,
    );
    assert.deepEqual(
      workspacesOf(basic),
      ["all", "basic"],
      `Basic shortcuts show the wrong rows: ${JSON.stringify(basic)}`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-ui-markup-shortcuts", {
      scenario: "shortcuts-follow-open-workspace",
      powerWorkspaces: workspacesOf(power),
      powerRows: power.length,
      basicWorkspaces: workspacesOf(basic),
      basicRows: basic.length,
    });
  });

  it("keeps aria-live off the bulk lists and on the short status lines", async () => {
    await startIdle();
    const live = await browser.execute(() => {
      const attr = (id) =>
        document.getElementById(id)?.getAttribute("aria-live") ?? null;
      return {
        licensesList: attr("licenses-list"),
        osDefaultList: attr("os-archive-default-list"),
        commandPreview: attr("command-preview-text"),
        status: attr("status"),
        osHelp: attr("os-integration-help"),
        selectiveSummary: attr("selective-summary"),
        announcer: attr("progress-announcer"),
      };
    });

    assert.equal(live.licensesList, null, "#licenses-list is still live");
    assert.equal(
      live.osDefaultList,
      null,
      "#os-archive-default-list is still live",
    );
    assert.equal(
      live.commandPreview,
      null,
      "#command-preview-text is still live",
    );
    assert.equal(live.status, "polite", "#status lost its live region");
    assert.equal(
      live.osHelp,
      "polite",
      "#os-integration-help lost its live region",
    );
    assert.equal(
      live.selectiveSummary,
      "polite",
      "#selective-summary lost its live region",
    );
    assert.equal(
      live.announcer,
      "polite",
      "#progress-announcer lost its live region",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-ui-markup-live-regions", {
      scenario: "live-region-audit",
      ...live,
    });
  });

  it("renders a hidden, named Basic update banner inside the Basic workspace", async () => {
    await startIdle();
    const indicator = await browser.execute(() => {
      const el = document.getElementById("basic-update-indicator");
      if (!el) return { present: false };
      return {
        present: true,
        count: document.querySelectorAll("#basic-update-indicator").length,
        tag: el.tagName,
        type: el.getAttribute("type"),
        hidden: el.hidden,
        display: getComputedStyle(el).display,
        name: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        inBasicWorkspace: el.closest("#basic-workspace") !== null,
        inHeaderStrip: el.closest(".header__actions") !== null,
      };
    });

    assert.equal(indicator.present, true, "#basic-update-indicator is missing");
    assert.equal(indicator.count, 1, "more than one #basic-update-indicator");
    assert.equal(indicator.tag, "BUTTON");
    assert.equal(indicator.type, "button");
    assert.equal(indicator.hidden, true, "the update button shows by default");
    assert.equal(indicator.display, "none");
    assert.ok(indicator.name.length > 0, "the update button has no name");
    assert.equal(
      indicator.inBasicWorkspace,
      true,
      "the update banner is outside #basic-workspace",
    );
    assert.equal(
      indicator.inHeaderStrip,
      false,
      "the update banner is still inside the header strip",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-ui-markup-update-indicator", {
      scenario: "basic-update-indicator-hidden-by-default",
      ...indicator,
    });
  });

  it("names the Power Options group by its caption and keeps the confirm message id", async () => {
    await startIdle();
    const markup = await browser.execute(() => {
      const group =
        document.getElementById("update-mode")?.closest(".toggle-row") ?? null;
      const labelIds = (group?.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      return {
        role: group?.getAttribute("role") ?? null,
        name: labelIds
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
        checkboxes: group
          ? group.querySelectorAll('input[type="checkbox"]').length
          : 0,
        confirmMessageId:
          document.getElementById("input-modal-label")?.id ?? null,
      };
    });

    assert.equal(
      markup.role,
      "group",
      "the Options checkboxes are not a group",
    );
    assert.equal(
      markup.name,
      "Options",
      "the Options group has no caption name",
    );
    assert.equal(markup.checkboxes, 3);
    assert.equal(
      markup.confirmMessageId,
      "input-modal-label",
      "the confirm message element lost its id",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-ui-markup-options-group", {
      scenario: "options-group-name-and-confirm-message-id",
      ...markup,
    });
  });
});
