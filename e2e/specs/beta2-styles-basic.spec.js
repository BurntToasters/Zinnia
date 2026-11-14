import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  closeSettingsModalViaUi,
  dismissToasts,
  openSettingsModal,
  openBasicBrowseForArchive,
  openBasicRecentsMenu,
  switchToBasicWorkspace,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-styles-basic");
const sidecar = requireHostSidecar();

const RUN_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 30_000;
const BASIC_WINDOW_WIDTH = 500;
const BASIC_WINDOW_HEIGHT = 650;
const LARGE_FILE_COUNT = 2_000;
const LARGE_ROW_FLOOR = 1_000;
const TOAST_FIXTURE_COUNT = 8;
const FIXTURE_ATTR = "data-e2e-fixture";

let windowBefore = null;
let smallArchive = null;
let largeArchive = null;

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeSource(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function buildArchive(archive, srcDir, member, content) {
  writeSource(srcDir, member, content);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-t7z", archive, member], { cwd: srcDir });
  return archive;
}

function buildLargeArchive(archive, srcDir, count) {
  mkdirFresh(srcDir);
  for (let index = 1; index <= count; index += 1) {
    fs.writeFileSync(
      path.join(srcDir, `entry-${String(index).padStart(4, "0")}.txt`),
      `entry ${index}\n`,
    );
  }
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-t7z", "-mx=0", archive, "*"], {
    cwd: srcDir,
    timeout: 900_000,
  });
  return archive;
}

function windowInnerSize() {
  return browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

async function setWindowInnerSize(width, height) {
  const error = await browser.executeAsync(
    (nextWidth, nextHeight, done) => {
      window.__TAURI__.core
        .invoke("plugin:window|set_size", {
          value: { Logical: { width: nextWidth, height: nextHeight } },
        })
        .then(() => done(null))
        .catch((err) => done(err instanceof Error ? err.message : String(err)));
    },
    width,
    height,
  );
  if (error) throw new Error(`set_size ${width}x${height} failed: ${error}`);
  try {
    await browser.waitUntil(
      async () => {
        const size = await windowInnerSize();
        return size.width === width && size.height === height;
      },
      { timeout: STEP_TIMEOUT_MS, interval: 100 },
    );
  } catch {
    const actual = await windowInnerSize();
    throw new Error(
      `window inner size is ${actual.width}x${actual.height}, expected ${width}x${height}`,
    );
  }
}

function clickById(id) {
  return browser.execute((target) => {
    document.getElementById(target)?.click();
  }, id);
}

async function waitForActiveView(id) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (target) =>
          document.getElementById(target)?.classList.contains("is-active") ??
          false,
        id,
      ),
    {
      timeout: STEP_TIMEOUT_MS,
      timeoutMsg: `${id} did not become the active Basic view`,
    },
  );
}

async function clickBasicTab(view) {
  await clickById(`basic-tab-${view}`);
  await waitForActiveView(`basic-${view}`);
}

async function goBasicHome() {
  const atHome = await browser.execute(
    () =>
      document.getElementById("basic-home")?.classList.contains("is-active") ??
      false,
  );
  if (!atHome) {
    await clickById("basic-tab-home");
    await waitForActiveView("basic-home");
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

async function openBasicBrowse(archive, expectedFiles) {
  await openBasicBrowseForArchive(archive);
  await clickById("basic-browse-contents");
  await waitForActiveView("basic-browse");
  await browser.waitUntil(
    () =>
      browser.execute((count) => {
        const summary =
          document.getElementById("basic-browse-summary")?.textContent ?? "";
        const rows = document.querySelectorAll("#basic-browse-tbody tr").length;
        return rows > 0 && summary.includes(`${count} file`);
      }, expectedFiles),
    {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic browse did not list ${expectedFiles} files; ${await uiDiagnostics()}`,
    },
  );
  await waitForArchiveIdle();
}

function readBrowseLayout() {
  return browser.execute(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const wrap = document.querySelector(
      "#basic-browse .basic-browse-table-wrap",
    );
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      rows: document.querySelectorAll("#basic-browse-tbody tr").length,
      wrap: wrap
        ? {
            scrollHeight: wrap.scrollHeight,
            clientHeight: wrap.clientHeight,
            overflowY: getComputedStyle(wrap).overflowY,
          }
        : null,
      extractAll: box("basic-browse-extract-all"),
      test: box("basic-browse-test"),
    };
  });
}

function readStatusStyles() {
  return browser.execute(() => {
    const el = document.getElementById("basic-browse-status");
    const original = el.className;
    const read = () => {
      const cs = getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        borderTopColor: cs.borderTopColor,
        borderTopWidth: cs.borderTopWidth,
        fontWeight: cs.fontWeight,
      };
    };
    const states = {};
    for (const name of ["idle", "is-loading", "is-success", "is-error"]) {
      el.className =
        name === "idle"
          ? "basic-browse-summary"
          : `basic-browse-summary ${name}`;
      states[name] = read();
    }
    el.className = original;
    return states;
  });
}

function probeDisabledButton(id) {
  return browser.execute((target) => {
    const button = document.getElementById(target);
    const wasDisabled = button.disabled;
    const enabledCs = getComputedStyle(button);
    const enabled = {
      opacity: enabledCs.opacity,
      cursor: enabledCs.cursor,
      pointerEvents: enabledCs.pointerEvents,
    };
    button.disabled = true;
    const disabledCs = getComputedStyle(button);
    const disabled = {
      opacity: disabledCs.opacity,
      cursor: disabledCs.cursor,
      pointerEvents: disabledCs.pointerEvents,
    };
    button.disabled = wasDisabled;

    const selectors = [];
    const collect = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText) selectors.push(rule.selectorText);
        if (rule.cssRules) collect(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        collect(sheet.cssRules);
      } catch {}
    }
    const hoverRules = selectors.filter((s) =>
      /\.basic-btn--(primary|secondary|ghost|danger):hover/.test(s),
    );
    const disabledRules = selectors.filter(
      (s) => s.includes(".basic-btn") && s.includes(":disabled"),
    );
    return { enabled, disabled, hoverRules, disabledRules };
  }, id);
}

async function readDropzoneStyle(dragOver) {
  await browser.execute((over) => {
    document
      .getElementById("basic-dropzone")
      ?.classList.toggle("is-drag-over", over);
  }, dragOver);
  await browser.pause(400);
  return browser.execute(() => {
    const cs = getComputedStyle(document.getElementById("basic-dropzone"));
    return {
      borderTopColor: cs.borderTopColor,
      backgroundColor: cs.backgroundColor,
    };
  });
}

function addToastFixtures(count, marker) {
  return browser.execute(
    (total, attr) => {
      let region = document.getElementById("toast-region");
      if (!region) {
        region = document.createElement("div");
        region.id = "toast-region";
        region.className = "toast-region";
        document.body.appendChild(region);
      }
      for (let index = 1; index <= total; index += 1) {
        const toast = document.createElement("div");
        toast.className = "toast toast--info";
        toast.setAttribute("role", "status");
        toast.setAttribute(attr, "true");
        const message = document.createElement("span");
        message.className = "toast-message";
        message.textContent = `Fixture toast ${index}. ${"This long message wraps across several lines in the Basic toast region. ".repeat(6)}`;
        toast.appendChild(message);
        region.appendChild(toast);
      }
    },
    count,
    marker,
  );
}

function removeToastFixtures(marker) {
  return browser.execute((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((node) => node.remove());
  }, marker);
}

function readToastLayout(marker) {
  return browser.execute((attr) => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const region = document.getElementById("toast-region");
    const bar = document.querySelector(
      "#basic-compress .basic-view-sticky-bottom",
    );
    const toasts = Array.from(document.querySelectorAll(`.toast[${attr}]`)).map(
      (toast) => {
        const max = parseFloat(getComputedStyle(toast).maxHeight);
        return {
          height: toast.getBoundingClientRect().height,
          scrollHeight: toast.scrollHeight,
          maxHeight: Number.isFinite(max) ? max : null,
        };
      },
    );
    return {
      viewportHeight: window.innerHeight,
      region: box(region),
      actionBar: box(bar),
      overflowY: region ? getComputedStyle(region).overflowY : null,
      scrollHeight: region ? region.scrollHeight : 0,
      clientHeight: region ? region.clientHeight : 0,
      toasts,
    };
  }, marker);
}

function readSkipLinkCover() {
  return browser.execute(() => {
    const link = document.querySelector(".skip-link");
    const header = document.querySelector(".header");
    const declarations = [];
    const collect = (rules) => {
      for (const rule of rules) {
        if (rule.media) {
          if (window.matchMedia(rule.media.mediaText).matches) {
            collect(rule.cssRules);
          }
          continue;
        }
        const selector = rule.selectorText;
        if (!selector || !selector.includes(".skip-link:focus")) continue;
        const unfocused = selector.replace(/:focus\b/g, "");
        if (link.matches(unfocused)) {
          declarations.push(`${unfocused} { ${rule.style.cssText} }`);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        collect(sheet.cssRules);
      } catch {}
    }
    const sheets = [...document.styleSheets];
    const target = sheets[sheets.length - 1];
    const inserted = [];
    for (const declaration of declarations) {
      inserted.push(target.insertRule(declaration, target.cssRules.length));
    }
    const headerPointerEvents = header.style.pointerEvents;
    let result;
    try {
      header.style.pointerEvents = "auto";
      const r = link.getBoundingClientRect();
      const top = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      const cs = getComputedStyle(link);
      result = {
        ruleCount: declarations.length,
        rect: {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          width: r.width,
          height: r.height,
        },
        left: cs.left,
        zIndex: cs.zIndex,
        headerZIndex: getComputedStyle(header).zIndex,
        viewportHeight: window.innerHeight,
        topIsLink: Boolean(top && (top === link || link.contains(top))),
        topTag: top ? top.tagName : null,
      };
    } finally {
      header.style.pointerEvents = headerPointerEvents;
      for (let i = inserted.length - 1; i >= 0; i -= 1) {
        target.deleteRule(inserted[i]);
      }
    }
    return result;
  });
}

function readIndicatorStyle() {
  return browser.execute(() => {
    const el = document.getElementById("basic-update-indicator");
    const originallyHidden = el.hidden;
    el.hidden = false;
    const shown = getComputedStyle(el);
    const visible = {
      display: shown.display,
      height: shown.height,
      whiteSpace: shown.whiteSpace,
    };
    el.hidden = true;
    const hidden = { display: getComputedStyle(el).display };
    el.hidden = originallyHidden;
    return { visible, hidden };
  });
}

function readRecentItem() {
  return browser.execute(() => {
    const item = document.querySelector(
      "#header-recent-menu .header-recent__item",
    );
    const name = item.querySelector(".header-recent__name");
    const folder = item.querySelector(".header-recent__folder");
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        height: r.height,
      };
    };
    const nameCs = getComputedStyle(name);
    const folderCs = getComputedStyle(folder);
    return {
      item: box(item),
      name: box(name),
      folder: box(folder),
      nameText: name.textContent,
      folderText: folder.textContent,
      nameFontPx: parseFloat(nameCs.fontSize),
      folderFontPx: parseFloat(folderCs.fontSize),
      nameFontWeight: parseInt(nameCs.fontWeight, 10),
      folderFontWeight: parseInt(folderCs.fontWeight, 10),
      nameColor: nameCs.color,
      folderColor: folderCs.color,
      nameTextOverflow: nameCs.textOverflow,
      folderTextOverflow: folderCs.textOverflow,
    };
  });
}

function readSettingsLayout() {
  return browser.execute(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const banner = document.getElementById("startup-recovery-banner");
    const overlay = document.getElementById("settings-overlay");
    const save = document.getElementById("save-settings");
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      bannerDisplay: getComputedStyle(banner).display,
      banner: box(banner),
      overlay: box(overlay),
      overlayPosition: getComputedStyle(overlay).position,
      save: box(save),
    };
  });
}

describe("beta 2 styles Basic: Browse layout, states, disabled controls, feedback and header hooks", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
    windowBefore = await windowInnerSize();
    await setWindowInnerSize(BASIC_WINDOW_WIDTH, BASIC_WINDOW_HEIGHT);
    smallArchive = buildArchive(
      path.join(ROOT, "small", "hello-browse.7z"),
      path.join(ROOT, "small", "src"),
      "hello.txt",
      "hello browse\n",
    );
    largeArchive = buildLargeArchive(
      path.join(ROOT, "large", "large-2000.7z"),
      path.join(ROOT, "large", "src"),
      LARGE_FILE_COUNT,
    );
  });

  after(async () => {
    if (windowBefore) {
      await setWindowInnerSize(windowBefore.width, windowBefore.height).catch(
        () => undefined,
      );
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await dismissToasts().catch(() => undefined);
  });

  it("keeps Extract all and Test integrity inside the 500x650 window while the listing scrolls", async () => {
    const started = Date.now();
    await openBasicBrowse(largeArchive, LARGE_FILE_COUNT);
    const layout = await readBrowseLayout();
    const size = await windowInnerSize();

    assert.deepEqual(size, {
      width: BASIC_WINDOW_WIDTH,
      height: BASIC_WINDOW_HEIGHT,
    });
    assert.ok(
      layout.rows >= LARGE_ROW_FLOOR,
      `only ${layout.rows} Browse rows were rendered`,
    );
    assert.ok(layout.wrap, "the Browse table wrap is missing");
    assert.ok(
      layout.wrap.scrollHeight > layout.wrap.clientHeight,
      `the table wrap does not scroll: ${JSON.stringify(layout.wrap)}`,
    );
    assert.ok(
      layout.wrap.overflowY === "auto" || layout.wrap.overflowY === "scroll",
      `the table wrap overflow-y is ${layout.wrap.overflowY}`,
    );
    for (const [label, button] of [
      ["Extract all", layout.extractAll],
      ["Test integrity", layout.test],
    ]) {
      assert.ok(button, `${label} is missing`);
      assert.ok(
        button.height > 0 &&
          button.top >= 0 &&
          button.bottom <= layout.viewportHeight,
        `${label} is outside the viewport: ${JSON.stringify(button)}`,
      );
    }

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-browse-layout", {
      scenario: "two-thousand-entry-browse-keeps-actions-visible",
      viewport: { width: size.width, height: size.height },
      rows: layout.rows,
      wrap: layout.wrap,
      extractAll: layout.extractAll,
      test: layout.test,
      durationMs: Date.now() - started,
    });
  });

  it("gives the loading, success and error Browse status lines distinct computed styles", async () => {
    const started = Date.now();
    await openBasicBrowse(smallArchive, 1);
    const styles = await readStatusStyles();
    const sig = (state) =>
      [
        state.color,
        state.backgroundColor,
        state.borderTopColor,
        state.borderTopWidth,
      ].join("|");

    for (const name of ["is-loading", "is-success", "is-error"]) {
      assert.notEqual(
        sig(styles[name]),
        sig(styles.idle),
        `${name} looks idle`,
      );
    }
    assert.notEqual(
      sig(styles["is-loading"]),
      sig(styles["is-success"]),
      "loading and success look the same",
    );
    assert.notEqual(
      sig(styles["is-loading"]),
      sig(styles["is-error"]),
      "loading and error look the same",
    );
    assert.notEqual(
      sig(styles["is-success"]),
      sig(styles["is-error"]),
      "success and error look the same",
    );
    assert.notEqual(
      styles["is-error"].color,
      styles["is-success"].color,
      "error text uses the success color",
    );
    assert.notEqual(
      styles["is-error"].backgroundColor,
      styles["is-success"].backgroundColor,
      "error background matches success",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-browse-status", {
      scenario: "browse-status-loading-success-error-styles",
      styles,
      durationMs: Date.now() - started,
    });
  });

  it("keeps pointer events on a disabled Basic button and suppresses hover on disabled Basic buttons", async () => {
    const started = Date.now();
    await openBasicBrowse(smallArchive, 1);
    const probe = await probeDisabledButton("basic-browse-test");

    assert.notEqual(
      probe.disabled.pointerEvents,
      "none",
      "a disabled Basic button has pointer-events none, which hides its title",
    );
    assert.equal(probe.enabled.opacity, "1");
    assert.ok(
      Number.parseFloat(probe.disabled.opacity) <
        Number.parseFloat(probe.enabled.opacity),
      `disabled opacity ${probe.disabled.opacity} is not lower than enabled`,
    );
    assert.equal(probe.disabled.cursor, "not-allowed");
    assert.ok(
      probe.disabledRules.length > 0,
      "no stylesheet rule styles a disabled Basic button",
    );
    assert.ok(
      probe.hoverRules.length >= 3,
      "Basic button hover rules are missing",
    );
    assert.ok(
      probe.hoverRules.every((selector) =>
        selector.includes(":not(:disabled)"),
      ),
      `a Basic button hover rule lights up disabled buttons: ${probe.hoverRules.join(" ; ")}`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-disabled-button", {
      scenario: "disabled-basic-button-keeps-pointer-events-and-no-hover",
      enabled: probe.enabled,
      disabled: probe.disabled,
      disabledRuleCount: probe.disabledRules.length,
      hoverRules: probe.hoverRules,
      durationMs: Date.now() - started,
    });
  });

  it("changes the home drop target border and background while a drag is over it", async () => {
    const started = Date.now();
    await clearBasicInputs();
    await goBasicHome();
    const idle = await readDropzoneStyle(false);
    const over = await readDropzoneStyle(true);
    await readDropzoneStyle(false);

    assert.notEqual(
      over.backgroundColor,
      idle.backgroundColor,
      "the drag-over background matches the idle background",
    );
    assert.notEqual(
      over.borderTopColor,
      idle.borderTopColor,
      "the drag-over border matches the idle border",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-drop-target", {
      scenario: "drag-over-changes-computed-border-and-background",
      idle,
      over,
      durationMs: Date.now() - started,
    });
  });

  it("places the Basic toast region above the sticky action bar and bounds a long stack", async () => {
    const started = Date.now();
    const source = writeSource(
      path.join(ROOT, "toast", "src"),
      "toast.txt",
      "toast payload\n",
    );
    await clearBasicInputs();
    await applyIncomingPaths([source], "compress");
    await clickBasicTab("compress");
    await browser.pause(400);
    let layout;
    try {
      await addToastFixtures(TOAST_FIXTURE_COUNT, FIXTURE_ATTR);
      await browser.pause(400);
      layout = await readToastLayout(FIXTURE_ATTR);
    } finally {
      await removeToastFixtures(FIXTURE_ATTR);
    }

    assert.ok(layout.region, "the toast region is missing");
    assert.ok(layout.region.height > 0, "no toast was laid out");
    assert.ok(layout.actionBar, "the Compress action bar is missing");
    assert.ok(
      layout.region.bottom < layout.actionBar.top,
      `toast region bottom ${layout.region.bottom} is not above the action bar top ${layout.actionBar.top}`,
    );
    assert.ok(layout.region.top >= 0, "the toast region is above the window");
    assert.ok(
      layout.region.height <= layout.viewportHeight * 0.4 + 1,
      `the toast stack is ${layout.region.height}px tall, over 40vh`,
    );
    assert.equal(layout.overflowY, "auto");
    assert.ok(
      layout.scrollHeight > layout.clientHeight,
      `the long toast stack does not scroll inside the region: ${JSON.stringify({ scrollHeight: layout.scrollHeight, clientHeight: layout.clientHeight, region: layout.region })}`,
    );
    assert.equal(layout.toasts.length, TOAST_FIXTURE_COUNT);
    for (const toast of layout.toasts) {
      const natural = Math.min(toast.scrollHeight, toast.maxHeight ?? Infinity);
      assert.ok(
        toast.height >= natural - 1,
        `a toast shrank below its natural height: ${JSON.stringify(toast)}`,
      );
    }

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-toast-placement", {
      scenario: "toast-region-above-action-bar-with-internal-scroll",
      viewportHeight: layout.viewportHeight,
      region: layout.region,
      actionBar: layout.actionBar,
      scrollHeight: layout.scrollHeight,
      clientHeight: layout.clientHeight,
      toasts: layout.toasts,
      durationMs: Date.now() - started,
    });
  });

  it("shows the focus rule for the skip link above the Basic header without OS focus", async () => {
    const started = Date.now();
    await switchToBasicWorkspace();
    await waitForArchiveIdle();
    const cover = await readSkipLinkCover();

    assert.ok(
      cover.ruleCount >= 2,
      `only ${cover.ruleCount} skip link focus rules apply in Basic`,
    );
    assert.equal(cover.left, "8px", "the focus rule did not move the link");
    assert.ok(cover.rect.width > 0, "the skip link has no size when focused");
    assert.ok(cover.rect.top >= 0, "the focused skip link is above the window");
    assert.ok(
      cover.rect.bottom <= cover.viewportHeight,
      "the focused skip link is below the window",
    );
    assert.ok(
      Number(cover.zIndex) > Number(cover.headerZIndex),
      `the skip link z-index ${cover.zIndex} does not beat the header ${cover.headerZIndex}`,
    );
    assert.ok(
      cover.topIsLink,
      `the header covers the focused skip link; top element is ${cover.topTag}; ${JSON.stringify(cover)}`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-skip-link", {
      scenario: "focus-rule-applied-skip-link-above-basic-header",
      ruleCount: cover.ruleCount,
      left: cover.left,
      rect: cover.rect,
      zIndex: cover.zIndex,
      headerZIndex: cover.headerZIndex,
      topElement: cover.topTag,
      durationMs: Date.now() - started,
    });
  });

  it("sizes the Basic update indicator like a header button and hides it with the hidden attribute", async () => {
    const started = Date.now();
    await switchToBasicWorkspace();
    await waitForArchiveIdle();
    const style = await readIndicatorStyle();

    assert.notEqual(style.visible.display, "none", "the indicator is hidden");
    assert.equal(style.visible.height, "30px");
    assert.equal(style.visible.whiteSpace, "nowrap");
    assert.equal(
      style.hidden.display,
      "none",
      "hidden did not hide the indicator",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-update-indicator", {
      scenario: "update-indicator-header-size-and-hidden",
      visible: style.visible,
      hidden: style.hidden,
      durationMs: Date.now() - started,
    });
  });

  it("shows each Recent entry as a name and a smaller folder on one line", async () => {
    const started = Date.now();
    const archive = buildArchive(
      path.join(ROOT, "recent", "archives", "recent-entry.7z"),
      path.join(ROOT, "recent", "src"),
      "recent.txt",
      "recent payload\n",
    );
    await clearBasicInputs();
    await applyIncomingPaths([archive], "extract");
    await clickBasicTab("extract");
    await clickById("basic-run-extract");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (
              document.getElementById("basic-extract-completion-title")
                ?.textContent ?? ""
            ).trim() === "Extraction complete",
        ),
      {
        timeout: RUN_TIMEOUT_MS,
        timeoutMsg: `Basic extract did not complete; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();
    await openBasicRecentsMenu();
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelectorAll(
              "#header-recent-menu .header-recent__item",
            ).length > 0,
        ),
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: "the Recent menu has no entries",
      },
    );
    const item = await readRecentItem();
    await clickById("header-recent-btn");

    assert.ok(
      item.nameText.includes("recent-entry.7z"),
      `the first Recent name is ${item.nameText}`,
    );
    assert.ok(item.folderText.length > 0, "the Recent folder is empty");
    assert.ok(
      item.folderFontPx >= 12,
      `the Recent folder is ${item.folderFontPx}px, below the 12px floor`,
    );
    assert.ok(
      item.nameFontWeight > item.folderFontWeight ||
        item.nameColor !== item.folderColor,
      "the Recent name and folder have no weight or color hierarchy",
    );
    assert.ok(
      item.name.height < item.nameFontPx * 2,
      `the Recent name wraps: ${item.name.height}px`,
    );
    assert.ok(
      item.folder.height < item.folderFontPx * 2,
      `the Recent folder wraps: ${item.folder.height}px`,
    );
    assert.ok(
      item.name.right <= item.item.right + 0.5 &&
        item.folder.right <= item.item.right + 0.5,
      "a Recent span runs past the item edge",
    );
    assert.ok(
      item.folder.left > item.name.left,
      "the folder is not after the name",
    );
    assert.equal(item.nameTextOverflow, "ellipsis");
    assert.equal(item.folderTextOverflow, "ellipsis");

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-recent-entry", {
      scenario: "recent-entry-name-then-smaller-folder-one-line",
      nameText: item.nameText,
      folderText: item.folderText,
      nameFontPx: item.nameFontPx,
      folderFontPx: item.folderFontPx,
      nameFontWeight: item.nameFontWeight,
      folderFontWeight: item.folderFontWeight,
      nameColor: item.nameColor,
      folderColor: item.folderColor,
      durationMs: Date.now() - started,
    });
  });

  it("keeps the Basic settings overlay below a visible recovery banner inside the 500x650 window", async () => {
    const started = Date.now();
    await switchToBasicWorkspace();
    await waitForArchiveIdle();
    const bannerWasHidden = await browser.execute(() => {
      const banner = document.getElementById("startup-recovery-banner");
      const wasHidden = banner.hidden;
      banner.hidden = false;
      return wasHidden;
    });
    let layout;
    try {
      await openSettingsModal();
      await browser.pause(400);
      layout = await readSettingsLayout();
    } finally {
      await closeSettingsModalViaUi().catch(() => undefined);
      await browser.execute((wasHidden) => {
        document.getElementById("startup-recovery-banner").hidden = wasHidden;
      }, bannerWasHidden);
    }

    assert.equal(layout.viewportWidth, BASIC_WINDOW_WIDTH);
    assert.equal(layout.viewportHeight, BASIC_WINDOW_HEIGHT);
    assert.notEqual(layout.bannerDisplay, "none", "the banner is not shown");
    assert.ok(layout.banner.height > 0, "the banner has no height");
    assert.equal(layout.overlayPosition, "absolute");
    assert.ok(
      layout.overlay.top >= layout.banner.bottom - 0.5,
      `the settings overlay starts at ${layout.overlay.top}, under the banner bottom ${layout.banner.bottom}`,
    );
    assert.ok(layout.save, "the Save button is missing");
    assert.ok(
      layout.save.height > 0 &&
        layout.save.top >= 0 &&
        layout.save.bottom <= layout.viewportHeight,
      `Save is outside the 500x650 window: ${JSON.stringify(layout.save)}`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-basic-settings-banner", {
      scenario: "basic-settings-overlay-below-visible-banner",
      viewport: { width: layout.viewportWidth, height: layout.viewportHeight },
      banner: layout.banner,
      overlay: layout.overlay,
      overlayPosition: layout.overlayPosition,
      save: layout.save,
      durationMs: Date.now() - started,
    });
  });
});
