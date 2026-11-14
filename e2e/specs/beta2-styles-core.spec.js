import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  bannerState,
  closeSettingsModalViaUi,
  dismissToasts,
  flushPendingSettingsWrites,
  isSettingsOverlayOpen,
  openBasicBrowseForArchive,
  openBrowseArchive,
  openSelectiveExtractPicker,
  openSettingsModal,
  reloadMainWindow,
  switchToBasicWorkspace,
  switchToPowerWorkspace,
  toggleSelectiveMember,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import {
  seedE2eSettings,
  settingsDirForProfile,
  updateE2eSettings,
} from "../helpers/profile.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-styles-core");
const HELLO_7Z = process.env.ZINNIA_E2E_HELLO_7Z;
const UNREADABLE_SEED = "{ not valid json, theme: ";
const LONG_NAME = `${"n".repeat(296)}.txt`;
const LONG_TOAST_TEXT = Array.from(
  { length: 300 },
  (_, index) => `error line ${index} of a very long failure report`,
).join("\n");
const SELECTIVE_MEMBER = "hello.txt";
const MAX_TOAST_VIEWPORT_SHARE = 0.4;

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

async function startFromIdle() {
  await switchToBasicWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
}

async function startFromPower() {
  await switchToPowerWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
}

function parseRgb(value) {
  const match = /^rgba?\(([^)]+)\)$/.exec(value.trim());
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
}

function relativeLuminance(colour) {
  const lin = (value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * lin(colour.r) + 0.7152 * lin(colour.g) + 0.0722 * lin(colour.b)
  );
}

function contrastRatio(first, second) {
  const [hi, lo] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  );
  return (hi + 0.05) / (lo + 0.05);
}

async function closeSelectivePicker() {
  await browser.execute(() => {
    document.getElementById("selective-cancel")?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("selective-overlay")?.hidden === true,
      ),
    {
      timeout: 15_000,
      timeoutMsg: "selective picker did not close",
    },
  );
}

async function setTheme(theme) {
  await browser.execute((value) => {
    if (value) document.documentElement.setAttribute("data-theme", value);
    else document.documentElement.removeAttribute("data-theme");
  }, theme);
}

describe("beta 2 styles core: toasts, disabled controls, overflow, overlays, contrast and selection", function () {
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

  it("drops the pointer cursor from error toast text, keeps it on the buttons, and gives the toast a real shadow", async () => {
    await startFromIdle();
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

    const state = await browser.execute(() => {
      const toast = document.querySelector(".toast--error");
      const message = toast?.querySelector(".toast-message");
      const copy = toast?.querySelector(".toast-copy");
      const dismiss = toast?.querySelector(".toast-dismiss");
      return {
        bodyCursor: getComputedStyle(document.body).cursor,
        toastCursor: toast ? getComputedStyle(toast).cursor : "",
        messageCursor: message ? getComputedStyle(message).cursor : "",
        copyCursor: copy ? getComputedStyle(copy).cursor : "",
        dismissCursor: dismiss ? getComputedStyle(dismiss).cursor : "",
        boxShadow: toast ? getComputedStyle(toast).boxShadow : "",
        hasCopy: Boolean(copy),
      };
    });

    assert.equal(state.hasCopy, true, "error toast has no Copy button");
    assert.notEqual(
      state.toastCursor,
      "pointer",
      "the error toast still has a pointer cursor",
    );
    assert.notEqual(
      state.messageCursor,
      "pointer",
      "the error toast text still has a pointer cursor",
    );
    assert.equal(
      state.copyCursor,
      "pointer",
      "the Copy button lost its pointer cursor",
    );
    assert.equal(
      state.dismissCursor,
      "pointer",
      "the close button lost its pointer cursor",
    );
    assert.notEqual(
      state.boxShadow,
      "none",
      "the error toast has no box-shadow",
    );

    await browser.execute(() => {
      document.querySelector(".toast--error .toast-dismiss")?.click();
    });

    writeEvidence(EVIDENCE_DIR, "beta2-styles-core-toast-cursor-shadow", {
      spec: "beta2-styles-core",
      case: "error-toast-cursor-and-shadow",
      bodyCursor: state.bodyCursor,
      toastCursor: state.toastCursor,
      messageCursor: state.messageCursor,
      copyCursor: state.copyCursor,
      dismissCursor: state.dismissCursor,
      boxShadow: state.boxShadow,
    });
  });

  it("caps a very long error toast's height and scrolls its message inside the toast", async () => {
    await startFromIdle();

    const measured = await browser.execute((text) => {
      let region = document.getElementById("toast-region");
      if (!region) {
        region = document.createElement("div");
        region.id = "toast-region";
        region.className = "toast-region";
        document.body.appendChild(region);
      }
      const toast = document.createElement("div");
      toast.className = "toast toast--error";
      toast.setAttribute("role", "alert");
      toast.dataset.styleProbe = "long";
      toast.tabIndex = 0;
      const message = document.createElement("span");
      message.className = "toast-message";
      message.textContent = text;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn btn--ghost btn--sm toast-copy";
      copy.textContent = "Copy";
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "toast-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      toast.append(message, copy, dismiss);
      region.appendChild(toast);
      const style = getComputedStyle(toast);
      const rect = toast.getBoundingClientRect();
      const result = {
        innerHeight: window.innerHeight,
        height: rect.height,
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        scrollHeight: toast.scrollHeight,
        clientHeight: toast.clientHeight,
        scrollWidth: toast.scrollWidth,
        clientWidth: toast.clientWidth,
      };
      toast.remove();
      return result;
    }, LONG_TOAST_TEXT);

    assert.notEqual(
      measured.maxHeight,
      "none",
      "the error toast has no max height",
    );
    assert.ok(
      measured.height <= measured.innerHeight * MAX_TOAST_VIEWPORT_SHARE + 1,
      `long error toast is ${measured.height}px tall in a ${measured.innerHeight}px window`,
    );
    assert.ok(
      ["auto", "scroll"].includes(measured.overflowY),
      `long error toast overflow-y is ${measured.overflowY}`,
    );
    assert.ok(
      measured.scrollHeight > measured.clientHeight,
      "the long error toast does not scroll",
    );
    assert.ok(
      measured.scrollWidth <= measured.clientWidth,
      `the long error toast scrolls sideways by ${measured.scrollWidth - measured.clientWidth}px`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-core-toast-height-cap", {
      spec: "beta2-styles-core",
      case: "long-error-toast-capped-and-scrolls",
      innerHeight: measured.innerHeight,
      height: measured.height,
      maxHeight: measured.maxHeight,
      overflowY: measured.overflowY,
      scrollHeight: measured.scrollHeight,
      clientHeight: measured.clientHeight,
    });
  });

  it("keeps a disabled .btn hoverable for its title with a not-allowed cursor", async () => {
    await startFromPower();

    const probe = await browser.execute(() => {
      const el = document.getElementById("clear-inputs");
      if (!el) return { found: false };
      const original = { disabled: el.disabled, title: el.title };
      el.disabled = true;
      el.title = "Clear is unavailable while a job runs";
      const style = getComputedStyle(el);
      const result = {
        found: true,
        isBtn: el.classList.contains("btn"),
        disabledAfter: el.disabled,
        matchesDisabled: el.matches(":disabled"),
        pointerEvents: style.pointerEvents,
        cursor: style.cursor,
        title: el.title,
      };
      el.disabled = original.disabled;
      el.title = original.title;
      return result;
    });

    assert.equal(probe.found, true, "the Clear button is missing");
    assert.equal(probe.isBtn, true, "the Clear button is not a .btn");
    assert.equal(
      probe.disabledAfter,
      true,
      "the probe did not disable the button",
    );
    assert.equal(probe.matchesDisabled, true, ":disabled does not match");
    assert.notEqual(
      probe.pointerEvents,
      "none",
      "a disabled .btn drops pointer events, so its title tooltip never shows",
    );
    assert.equal(
      probe.cursor,
      "not-allowed",
      "a disabled .btn does not show not-allowed",
    );
    assert.equal(
      probe.title,
      "Clear is unavailable while a job runs",
      "the title was not kept on the disabled button",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-core-disabled-btn-title", {
      spec: "beta2-styles-core",
      case: "disabled-btn-keeps-pointer-and-title",
      pointerEvents: probe.pointerEvents,
      cursor: probe.cursor,
      titleKept: probe.title.length > 0,
    });
  });

  it("keeps a 300-character name inside the window and ellipsizes the status item", async () => {
    await startFromPower();
    const originalStatus = await browser.execute(
      () => document.getElementById("status")?.textContent ?? "",
    );

    await browser.execute((name) => {
      const status = document.getElementById("status");
      if (status) status.textContent = name;
    }, LONG_NAME);

    const metrics = await browser.execute(() => {
      const status = document.getElementById("status");
      const bar = status?.parentElement;
      const platform = document.getElementById("platform-label");
      const version = document.getElementById("version-label");
      return {
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        textLength: (status?.textContent ?? "").length,
        textOverflow: status ? getComputedStyle(status).textOverflow : "",
        whiteSpace: status ? getComputedStyle(status).whiteSpace : "",
        statusScrollWidth: status ? status.scrollWidth : 0,
        statusClientWidth: status ? status.clientWidth : 0,
        barOverflowX: bar ? getComputedStyle(bar).overflowX : "",
        platformRight: platform ? platform.getBoundingClientRect().right : 0,
        versionRight: version ? version.getBoundingClientRect().right : 0,
      };
    });

    await browser.execute((text) => {
      const status = document.getElementById("status");
      if (status) status.textContent = text;
    }, originalStatus);

    assert.equal(
      metrics.textLength,
      300,
      "the status text is not 300 characters",
    );
    assert.ok(
      metrics.documentScrollWidth <= metrics.innerWidth,
      `the window scrolls sideways: ${metrics.documentScrollWidth} > ${metrics.innerWidth}`,
    );
    assert.equal(
      metrics.textOverflow,
      "ellipsis",
      "the status item does not ellipsize",
    );
    assert.equal(
      metrics.whiteSpace,
      "nowrap",
      "the status item wraps its text",
    );
    assert.ok(
      metrics.statusScrollWidth > metrics.statusClientWidth,
      "the status text is not clipped inside its item",
    );
    assert.notEqual(
      metrics.barOverflowX,
      "visible",
      "the status bar scrolls horizontally",
    );
    assert.ok(
      metrics.platformRight <= metrics.innerWidth,
      `the platform label is off-screen at ${metrics.platformRight}px`,
    );
    assert.ok(
      metrics.versionRight <= metrics.innerWidth,
      `the version label is off-screen at ${metrics.versionRight}px`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-core-statusbar-long-name", {
      spec: "beta2-styles-core",
      case: "statusbar-300-char-name",
      innerWidth: metrics.innerWidth,
      documentScrollWidth: metrics.documentScrollWidth,
      textOverflow: metrics.textOverflow,
      whiteSpace: metrics.whiteSpace,
      statusScrollWidth: metrics.statusScrollWidth,
      statusClientWidth: metrics.statusClientWidth,
      barOverflowX: metrics.barOverflowX,
    });
  });

  it("keeps the Settings overlay below a visible startup banner and below the titlebar controls", async () => {
    await makeSettingsUnreadable();
    await startFromPower();
    const banner = await bannerState();
    assert.equal(banner.visible, true, "the settings banner did not show");

    await openSettingsModal();
    const geometry = await browser.execute(() => {
      const rectOf = (el) => {
        if (!el || el.hidden) return null;
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      };
      return {
        innerHeight: window.innerHeight,
        banner: rectOf(document.getElementById("startup-recovery-banner")),
        titlebar: rectOf(document.getElementById("titlebar")),
        overlay: rectOf(document.getElementById("settings-overlay")),
        modal: rectOf(document.querySelector("#settings-overlay .modal")),
      };
    });

    assert.ok(
      geometry.banner && geometry.banner.height > 0,
      "the banner has no height",
    );
    assert.ok(geometry.overlay, "the Settings overlay is not shown");
    assert.ok(
      geometry.overlay.top >= geometry.banner.bottom,
      `the Settings overlay starts at ${geometry.overlay.top}px, above the banner bottom ${geometry.banner.bottom}px`,
    );
    assert.ok(
      geometry.modal.top >= geometry.banner.bottom,
      `the Settings modal starts at ${geometry.modal.top}px, above the banner bottom ${geometry.banner.bottom}px`,
    );
    if (geometry.titlebar && geometry.titlebar.height > 0) {
      assert.ok(
        geometry.overlay.top >= geometry.titlebar.bottom,
        `the Settings overlay covers the titlebar controls (top ${geometry.overlay.top}px, titlebar bottom ${geometry.titlebar.bottom}px)`,
      );
    }
    assert.ok(
      geometry.overlay.bottom >= geometry.innerHeight - 1,
      `the Settings overlay stops at ${geometry.overlay.bottom}px, above the window bottom`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-core-banner-overlay-offset", {
      spec: "beta2-styles-core",
      case: "overlay-below-startup-banner",
      bannerText: banner.text,
      innerHeight: geometry.innerHeight,
      bannerBottom: geometry.banner.bottom,
      titlebarBottom: geometry.titlebar ? geometry.titlebar.bottom : null,
      overlayTop: geometry.overlay.top,
      overlayBottom: geometry.overlay.bottom,
      modalTop: geometry.modal.top,
    });
  });

  it("gives a selected picker row a background that differs from an unselected row", async () => {
    await startFromIdle();
    await openBrowseArchive(HELLO_7Z, SELECTIVE_MEMBER);
    await openSelectiveExtractPicker();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (member) =>
            Boolean(document.querySelector(`[data-member-path="${member}"]`)),
          SELECTIVE_MEMBER,
        ),
      {
        timeout: 30_000,
        timeoutMsg: `selective picker did not list ${SELECTIVE_MEMBER}`,
      },
    );

    const readRow = () =>
      browser.execute((member) => {
        const row = document.querySelector(`[data-member-path="${member}"]`);
        if (!row) return null;
        return {
          className: row.className,
          selected: row.classList.contains("is-selected"),
          background: getComputedStyle(row).backgroundColor,
        };
      }, SELECTIVE_MEMBER);

    const unselected = await readRow();
    assert.ok(unselected, `no row for ${SELECTIVE_MEMBER}`);
    assert.equal(unselected.selected, false, "the row starts selected");

    await toggleSelectiveMember(SELECTIVE_MEMBER);
    await browser.waitUntil(
      async () => {
        const row = await readRow();
        return Boolean(row && row.selected);
      },
      {
        timeout: 10_000,
        timeoutMsg: "toggling the row did not add is-selected",
      },
    );
    const selected = await readRow();

    assert.notEqual(
      selected.background,
      unselected.background,
      `selected row background ${selected.background} matches the unselected row`,
    );
    assert.notEqual(
      selected.background,
      "rgba(0, 0, 0, 0)",
      "the selected row has no visible background",
    );

    await closeSelectivePicker();

    writeEvidence(EVIDENCE_DIR, "beta2-styles-core-selected-row", {
      spec: "beta2-styles-core",
      case: "selected-row-background",
      member: SELECTIVE_MEMBER,
      unselectedBackground: unselected.background,
      selectedBackground: selected.background,
      selectedClass: selected.className,
    });
  });

  it("keeps white text on the dark primary button hover at 4.5:1 or better", async () => {
    await startFromIdle();
    const original = await browser.execute(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    await setTheme("dark");
    let measured;
    try {
      measured = await browser.execute(() => {
        const probeBg = document.createElement("div");
        probeBg.style.backgroundColor = "var(--accent-hover)";
        const probeFg = document.createElement("div");
        probeFg.style.color = "var(--text-on-accent)";
        document.body.append(probeBg, probeFg);
        const background = getComputedStyle(probeBg).backgroundColor;
        const foreground = getComputedStyle(probeFg).color;
        probeBg.remove();
        probeFg.remove();
        const hoverBackgrounds = [];
        for (const sheet of Array.from(document.styleSheets)) {
          let rules;
          try {
            rules = Array.from(sheet.cssRules);
          } catch {
            continue;
          }
          for (const rule of rules) {
            if (rule.selectorText === ".btn--primary:hover") {
              hoverBackgrounds.push(
                rule.style.getPropertyValue("background") ||
                  rule.style.getPropertyValue("background-color"),
              );
            }
          }
        }
        return {
          theme: document.documentElement.getAttribute("data-theme"),
          background,
          foreground,
          hoverBackgrounds,
        };
      });
    } finally {
      await setTheme(original);
    }

    assert.equal(measured.theme, "dark", "the dark theme was not applied");
    assert.ok(
      measured.hoverBackgrounds.some((value) =>
        value.includes("--accent-hover"),
      ),
      `the primary hover rule does not read --accent-hover: ${JSON.stringify(measured.hoverBackgrounds)}`,
    );
    const ratio = contrastRatio(
      parseRgb(measured.foreground),
      parseRgb(measured.background),
    );
    const rounded = Number(ratio.toFixed(2));
    assert.ok(
      rounded >= 4.5,
      `dark primary hover contrast is ${rounded}:1 (${measured.foreground} on ${measured.background})`,
    );

    writeEvidence(
      EVIDENCE_DIR,
      "beta2-styles-core-dark-primary-hover-contrast",
      {
        spec: "beta2-styles-core",
        case: "dark-primary-hover-contrast",
        theme: measured.theme,
        hoverBackground: measured.background,
        text: measured.foreground,
        ratio: rounded,
        minimumRatio: 4.5,
      },
    );
  });

  it("renders the sr-only and visually-hidden classes from one rule", async () => {
    await startFromIdle();
    const boxes = await browser.execute(() => {
      const pick = (el) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          position: style.position,
          width: style.width,
          height: style.height,
          overflow: style.overflow,
          clip: style.clip,
          whiteSpace: style.whiteSpace,
          padding: style.padding,
          borderWidth: style.borderTopWidth,
          margin: style.margin,
        };
      };
      return {
        srOnly: pick(document.getElementById("progress-announcer")),
        visuallyHidden: pick(document.querySelector("h1.visually-hidden")),
      };
    });

    assert.ok(boxes.srOnly, "the sr-only progress announcer is missing");
    assert.ok(boxes.visuallyHidden, "the visually-hidden heading is missing");
    assert.deepEqual(
      boxes.srOnly,
      boxes.visuallyHidden,
      "the sr-only and visually-hidden classes compute different boxes",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-styles-core-visually-hidden-rule", {
      spec: "beta2-styles-core",
      case: "sr-only-matches-visually-hidden",
      srOnly: boxes.srOnly,
      visuallyHidden: boxes.visuallyHidden,
    });
  });
});
