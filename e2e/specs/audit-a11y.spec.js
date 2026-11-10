import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  applyIncomingPaths,
  dismissToasts,
  setInputValue,
  switchToBasicWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-a11y");

// Text inputs that take paths, names, arguments, sizes, search text or
// passwords. Create fields offer new-password; everything else is off.
const CREATE_PASSWORD_INPUTS = [
  "password",
  "basic-password",
  "convert-password",
];
const OTHER_TEXT_INPUTS = [
  "archive-name",
  "basic-archive-name",
  "output-path",
  "basic-output-path",
  "extract-path",
  "basic-extract-path",
  "selective-dest",
  "selective-search",
  "extra-args",
  "extract-extra-args",
  "split-custom",
  "basic-split-custom",
  "convert-split-custom",
  "extract-password",
  "basic-extract-password",
  "browse-password",
  "basic-browse-password",
  "input-modal-field",
];
// The Convert dialog's toggle listener exists only while that dialog is open,
// so convert-password is checked statically and not through its toggle.
const PASSWORD_TOGGLES = [
  ["password", "toggle-password"],
  ["basic-password", "basic-toggle-password"],
  ["extract-password", "toggle-extract-password"],
  ["basic-extract-password", "basic-toggle-extract-password"],
  ["browse-password", "toggle-browse-password"],
  ["basic-browse-password", "basic-toggle-browse-password"],
];

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

async function clearBasicInputs() {
  await switchToBasicWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
}

function inputAttributes(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  return {
    tag: el.tagName,
    type: el.getAttribute("type"),
    spellcheck: el.getAttribute("spellcheck"),
    autocorrect: el.getAttribute("autocorrect"),
    autocapitalize: el.getAttribute("autocapitalize"),
    autocomplete: el.getAttribute("autocomplete"),
  };
}

function attributeProblems(attrs, expectedAutocomplete) {
  if (!attrs) return ["missing element"];
  const problems = [];
  if (attrs.spellcheck !== "false") problems.push("spellcheck");
  if (attrs.autocorrect !== "off") problems.push("autocorrect");
  if (attrs.autocapitalize !== "off") problems.push("autocapitalize");
  if (attrs.autocomplete !== expectedAutocomplete)
    problems.push("autocomplete");
  return problems;
}

async function readAttributeProblems() {
  const expected = [
    ...CREATE_PASSWORD_INPUTS.map((id) => [id, "new-password"]),
    ...OTHER_TEXT_INPUTS.map((id) => [id, "off"]),
  ];
  return browser.execute(
    (pairs) =>
      pairs.map(([id, autocomplete]) => {
        const el = document.getElementById(id);
        if (!el) return { id, problems: ["missing element"] };
        const attrs = {
          type: el.getAttribute("type"),
          spellcheck: el.getAttribute("spellcheck"),
          autocorrect: el.getAttribute("autocorrect"),
          autocapitalize: el.getAttribute("autocapitalize"),
          autocomplete: el.getAttribute("autocomplete"),
        };
        const problems = [];
        if (attrs.spellcheck !== "false") problems.push("spellcheck");
        if (attrs.autocorrect !== "off") problems.push("autocorrect");
        if (attrs.autocapitalize !== "off") problems.push("autocapitalize");
        if (attrs.autocomplete !== autocomplete) problems.push("autocomplete");
        return { id, attrs, problems };
      }),
    expected,
  );
}

async function toggleAndReadPassword(fieldId, toggleId) {
  await browser.execute((id) => {
    document.getElementById(id)?.click();
  }, toggleId);
  const shown = await browser.execute((id) => {
    const el = document.getElementById(id);
    return el ? el.getAttribute("type") : null;
  }, fieldId);
  const attrsShown = await browser.execute(inputAttributes, fieldId);
  await browser.execute((id) => {
    document.getElementById(id)?.click();
  }, toggleId);
  return { shownType: shown, attrsShown };
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

/** Contrast of a control border against its own background and its surface. */
async function borderContrast(inputId) {
  return browser.execute((id) => {
    // WebKit may report colours as rgb(a)() or color(srgb ...) depending on
    // the source value, so both forms are read.
    const parse = (value) => {
      const srgb = /color\(srgb\s+([^)]+)\)/.exec(value);
      if (srgb) {
        const parts = srgb[1]
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        return {
          r: parts[0] * 255,
          g: parts[1] * 255,
          b: parts[2] * 255,
          a: parts.length > 3 ? parts[3] : 1,
        };
      }
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) throw new Error(`cannot read colour ${value}`);
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 ? parts[3] : 1,
      };
    };
    const over = (top, below) => ({
      r: top.r * top.a + below.r * (1 - top.a),
      g: top.g * top.a + below.g * (1 - top.a),
      b: top.b * top.a + below.b * (1 - top.a),
      a: 1,
    });
    // Composite every translucent layer from the element up to the first
    // opaque one, over white when no opaque layer exists.
    const effectiveBackground = (element) => {
      const layers = [];
      let node = element;
      while (node && node.nodeType === 1) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) {
          layers.push(color);
          if (color.a >= 1) break;
        }
        node = node.parentElement;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        base = over(layers[i], base);
      }
      return base;
    };
    const luminance = (c) => {
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const input = document.getElementById(id);
    if (!input) return null;
    const style = getComputedStyle(input);
    const border = parse(style.borderTopColor);
    const inside = effectiveBackground(input);
    const outside = effectiveBackground(input.parentElement);
    const drawn = over(border, inside);
    return {
      borderColor: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      vsInput: Number(ratio(drawn, inside).toFixed(2)),
      vsSurface: Number(ratio(drawn, outside).toFixed(2)),
    };
  }, inputId);
}

// Transitions are switched off while the colours are read: a window that is
// not animating can freeze a border-color transition at a mid value.
async function setNoTransitions(enabled) {
  await browser.execute((on) => {
    const id = "a11y-no-transition";
    document.getElementById(id)?.remove();
    if (!on) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent =
      "*, *::before, *::after { transition: none !important; }";
    document.head.appendChild(style);
  }, enabled);
}

async function setTheme(theme) {
  await browser.execute((value) => {
    document.documentElement.setAttribute("data-theme", value);
  }, theme);
}

describe("audit a11y: input attributes, progress announcements, names, contrast and text size", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it("sets spellcheck, autocorrect, autocapitalize and autocomplete on every target input, also after Show", async () => {
    const problems = await readAttributeProblems();
    const failing = problems.filter((row) => row.problems.length > 0);
    assert.deepEqual(
      failing,
      [],
      `inputs with missing or wrong attributes: ${JSON.stringify(failing)}`,
    );

    const toggles = [];
    for (const [fieldId, toggleId] of PASSWORD_TOGGLES) {
      const result = await toggleAndReadPassword(fieldId, toggleId);
      assert.equal(
        result.shownType,
        "text",
        `${toggleId} did not switch ${fieldId} to type text`,
      );
      const after = attributeProblems(
        result.attrsShown,
        CREATE_PASSWORD_INPUTS.includes(fieldId) ? "new-password" : "off",
      );
      assert.deepEqual(
        after,
        [],
        `${fieldId} lost attributes after Show: ${after.join(", ")}`,
      );
      toggles.push({ fieldId, toggleId, after: result.attrsShown });
    }

    const afterToggle = await readAttributeProblems();
    const failingAfter = afterToggle.filter((row) => row.problems.length > 0);
    assert.deepEqual(
      failingAfter,
      [],
      `inputs changed after the Show toggles: ${JSON.stringify(failingAfter)}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-a11y-input-attributes", {
      scenario: "input-attributes",
      checked: problems.length,
      failing: failing.length,
      togglesChecked: toggles.length,
      toggles,
    });
  });

  it("does not announce each percent of a Basic compress and keeps #progress off the live regions", async () => {
    const liveState = await browser.execute(() => {
      const progress = document.getElementById("progress");
      const announcer = document.getElementById("progress-announcer");
      const status = document.getElementById("status");
      return {
        progressLive: progress?.getAttribute("aria-live") ?? null,
        announcerLive: announcer?.getAttribute("aria-live") ?? null,
        announcerRole: announcer?.getAttribute("role") ?? null,
        statusLive: status?.getAttribute("aria-live") ?? null,
      };
    });
    assert.equal(liveState.progressLive, null, "#progress still has aria-live");
    assert.equal(liveState.announcerLive, "polite");
    assert.equal(liveState.announcerRole, "status");
    assert.equal(
      liveState.statusLive,
      "polite",
      "#status must keep announcing status changes",
    );

    const payload = path.join(ROOT, "announce", "payload.bin");
    const output = path.join(ROOT, "announce", "payload.7z");
    fs.rmSync(output, { force: true });
    writeRandomFile(payload, 16 * 1024 * 1024);

    await clearBasicInputs();
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
      announced.count <= 6,
      `the announcer changed ${announced.count} times during one compress: ${JSON.stringify(announced.texts)}`,
    );
    assert.ok(
      announced.count >= 1,
      "the announcer never reported the compress",
    );

    writeEvidence(EVIDENCE_DIR, "audit-a11y-progress-announcements", {
      scenario: "progress-announcements",
      output,
      announcerUpdates: announced.count,
      announcements: announced.texts,
      progressLive: liveState.progressLive,
    });
  });

  it("gives every Basic progress bar a stable accessible name and keeps list and tab names", async () => {
    const semantics = await browser.execute(() => {
      const nameOf = (el) => {
        const label = el.getAttribute("aria-label");
        if (label) return label.trim();
        const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/);
        return ids
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
      };
      const bars = [
        ...document.querySelectorAll(
          '#basic-compress-progress [role="progressbar"], #basic-extract-progress [role="progressbar"]',
        ),
      ].map((bar) => ({
        id: bar.closest("[id]")?.id ?? "",
        name: nameOf(bar),
      }));
      const inputList = document.getElementById("input-list");
      const listChildren = inputList
        ? [...inputList.children].map((child) => child.getAttribute("role"))
        : [];
      const tabs = [
        ...document.querySelectorAll('[role="tab"][aria-controls]'),
      ].map((tab) => {
        const panel = document.getElementById(
          tab.getAttribute("aria-controls") ?? "",
        );
        return {
          tab: tab.id,
          panelRole: panel?.getAttribute("role") ?? null,
          panelLabelledBy: panel?.getAttribute("aria-labelledby") ?? null,
        };
      });
      const titles = [
        "basic-compress-completion-title",
        "basic-extract-completion-title",
      ].map((id) => ({
        id,
        text: document.getElementById(id)?.textContent?.trim() ?? "",
      }));
      return {
        bars,
        inputListRole: inputList?.getAttribute("role") ?? null,
        inputListName: inputList?.getAttribute("aria-label") ?? "",
        listChildren,
        tabs,
        titles,
      };
    });

    assert.equal(semantics.bars.length, 2, "expected two Basic progress bars");
    for (const bar of semantics.bars) {
      assert.ok(
        bar.name.length > 0,
        `progress bar ${bar.id} has no accessible name`,
      );
    }
    assert.ok(
      semantics.inputListRole !== "list" ||
        semantics.listChildren.every((role) => role === "listitem"),
      `#input-list has role list without listitem children: ${JSON.stringify(semantics.listChildren)}`,
    );
    for (const tab of semantics.tabs) {
      assert.equal(
        tab.panelRole,
        "tabpanel",
        `${tab.tab} controls a non-tabpanel`,
      );
      assert.equal(
        tab.panelLabelledBy,
        tab.tab,
        `panel of ${tab.tab} is not labelled by it`,
      );
    }
    for (const title of semantics.titles) {
      assert.ok(title.text.length > 0, `${title.id} is empty`);
    }

    writeEvidence(EVIDENCE_DIR, "audit-a11y-accessible-names", {
      scenario: "accessible-names",
      bars: semantics.bars,
      inputListRole: semantics.inputListRole,
      tabs: semantics.tabs.length,
    });
  });

  it("removes the hidden debug image from the tab order and keeps the settings trigger a dialog opener", async () => {
    const state = await browser.execute(() => {
      const trigger = document.getElementById("open-settings");
      const debug = document.getElementById("about-debug-toggle");
      return {
        haspopup: trigger?.getAttribute("aria-haspopup") ?? null,
        controls: trigger?.getAttribute("aria-controls") ?? null,
        debugTabindex: debug?.getAttribute("tabindex") ?? null,
      };
    });
    assert.equal(state.haspopup, "dialog");
    assert.equal(
      state.controls,
      null,
      "#open-settings still has aria-controls",
    );
    assert.equal(
      state.debugTabindex,
      "-1",
      "debug image is still in the tab order",
    );

    writeEvidence(EVIDENCE_DIR, "audit-a11y-trigger-and-tab-order", {
      scenario: "trigger-and-tab-order",
      ...state,
    });
  });

  it("keeps control borders at 3:1 against the input background and its surface in both themes", async () => {
    const original = await browser.execute(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    const inputs = [
      "archive-name",
      "extra-args",
      "basic-archive-name",
      "basic-output-path",
    ];
    const results = {};
    await setNoTransitions(true);
    try {
      for (const theme of ["dark", "light"]) {
        await setTheme(theme);
        results[theme] = {};
        for (const id of inputs) {
          const measured = await borderContrast(id);
          assert.ok(measured, `#${id} is missing`);
          results[theme][id] = measured;
          assert.ok(
            measured.vsInput >= 3 && measured.vsSurface >= 3,
            `${theme} border of #${id} is ${measured.vsInput}:1 on its background and ${measured.vsSurface}:1 on its surface (${measured.borderColor})`,
          );
        }
      }
    } finally {
      await setNoTransitions(false);
      if (original) await setTheme(original);
      else
        await browser.execute(() =>
          document.documentElement.removeAttribute("data-theme"),
        );
    }

    writeEvidence(EVIDENCE_DIR, "audit-a11y-control-contrast", {
      scenario: "control-border-contrast",
      minimumRatio: 3,
      results,
    });
  });

  it("renders every element with readable text at 12 px or larger", async () => {
    const small = await browser.execute(() => {
      const skip = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
      const rows = [];
      for (const el of document.body.querySelectorAll("*")) {
        if (skip.has(el.tagName)) continue;
        const ownText = [...el.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join("")
          .trim();
        if (ownText.length === 0) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 12) {
          rows.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            className: typeof el.className === "string" ? el.className : "",
            size,
            text: ownText.slice(0, 40),
          });
        }
      }
      return rows;
    });

    assert.deepEqual(
      small,
      [],
      `text below 12 px: ${JSON.stringify(small.slice(0, 20))}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-a11y-text-size", {
      scenario: "minimum-text-size",
      minimumPx: 12,
      exceptions: [],
      belowMinimum: small.length,
    });
  });
});
