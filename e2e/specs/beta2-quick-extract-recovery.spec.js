import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { browser, $ } from "@wdio/globals";
import { waitForMainWindow } from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const HELLO_7Z = process.env.ZINNIA_E2E_HELLO_7Z;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const ROOT = path.join(WORK, "beta2-quick-extract-recovery");
const READONLY_DIR = path.join(ROOT, "readonly");
const READONLY_ARCHIVE = path.join(READONLY_DIR, "hello.7z");
const READONLY_DESTINATION = path.join(READONLY_DIR, "hello");
const LONG_DIR = path.join(ROOT, "long");
const LONG_ARCHIVE_NAME = `${"q".repeat(197)}.7z`;
const OPEN_REQUEST = path.join(WORK, "e2e-open-extract.json");
const PICK_ANSWER = path.join(WORK, "e2e-extract-pick.txt");
const QUICK_EXTRACT_TIMEOUT_MS = 60_000;
const FOOTER_IDS = ["choose-folder-btn", "retry-btn", "close-btn"];
const ANNOUNCEMENT_TEXTS = new Set([
  "Started",
  "25% done",
  "50% done",
  "75% done",
  "100% done",
  "Finished",
  "Failed",
  "Cancelled",
]);
const MAX_ANNOUNCEMENTS = 6;
const WINDOW_WIDTH = 440;
const WINDOW_HEIGHT = 320;

function writeAtomically(target, text) {
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, target);
}

function removeFiles(...files) {
  for (const file of files) fs.rmSync(file, { recursive: true, force: true });
}

function denyWriteToFolder(dir) {
  if (process.platform === "win32") {
    execFileSync("icacls", [dir, "/deny", "*S-1-1-0:(WD,AD)"], {
      stdio: "ignore",
    });
    return;
  }
  fs.chmodSync(dir, 0o555);
  let writable = true;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  assert.equal(writable, false, `${dir} is still writable after chmod 0555`);
}

function restoreFolderWrite(dir) {
  if (process.platform === "win32") {
    execFileSync("icacls", [dir, "/remove:d", "*S-1-1-0"], {
      stdio: "ignore",
    });
    return;
  }
  fs.chmodSync(dir, 0o755);
}

function listDirectory(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    return `unreadable: ${error.code ?? error.message}`;
  }
}

async function quickExtractState() {
  return browser.execute(() => {
    const byId = (id) => document.getElementById(id);
    const errorBox = byId("extract-error");
    return {
      title: document.title,
      heading: document.querySelector("h1")?.textContent ?? null,
      status: byId("extract-status")?.textContent ?? null,
      destination: byId("extract-dest")?.textContent ?? null,
      errorShown: errorBox ? !errorBox.hidden : null,
      errorTitle:
        errorBox?.querySelector(".extract-error-title")?.textContent ?? null,
      errorDetail: (byId("error-detail")?.textContent ?? "").slice(0, 500),
      chooseHidden: byId("choose-folder-btn")?.hidden ?? null,
      retryHidden: byId("retry-btn")?.hidden ?? null,
      closeHidden: byId("close-btn")?.hidden ?? null,
      focus: document.activeElement?.id ?? null,
    };
  });
}

async function waitForQuickExtractState(predicate, description) {
  const deadline = Date.now() + QUICK_EXTRACT_TIMEOUT_MS;
  let state = await quickExtractState();
  while (!predicate(state)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${description}; last window state ${JSON.stringify(state)}`,
      );
    }
    await browser.pause(250);
    state = await quickExtractState();
  }
  return state;
}

async function openQuickExtract(archive) {
  const before = new Set(await browser.tauri.listWindows());
  writeAtomically(OPEN_REQUEST, JSON.stringify({ paths: [archive] }));
  let label = null;
  await browser.waitUntil(
    async () => {
      label =
        (await browser.tauri.listWindows()).find(
          (name) => name.startsWith("extract-") && !before.has(name),
        ) ?? null;
      return label !== null;
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `quick-extract window never opened for ${path.basename(archive)}`,
    },
  );
  await browser.tauri.switchWindow(label);
  await $("#extract-app").waitForExist({ timeout: 30_000 });
  return label;
}

async function closeQuickExtract(label) {
  await browser.tauri.switchWindow(label);
  await $("#close-btn")
    .click()
    .catch(() =>
      browser
        .execute(() => {
          document.getElementById("close-btn")?.click();
        })
        .catch(() => undefined),
    );
  await browser.switchToWindow("main");
  await browser.tauri.switchWindow("main");
  await browser.waitUntil(
    async () => !(await browser.tauri.listWindows()).includes(label),
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `${label} did not close`,
    },
  );
}

async function closeQuickExtractWindows() {
  const labels = (await browser.tauri.listWindows()).filter((name) =>
    name.startsWith("extract-"),
  );
  for (const label of labels) {
    await closeQuickExtract(label);
  }
  await browser.tauri.switchWindow("main");
}

async function chooseFolderAndWaitForCompletion(folder) {
  writeAtomically(PICK_ANSWER, folder);
  await $("#choose-folder-btn").click();
  return waitForQuickExtractState(
    (state) => state.heading === "Extraction complete",
    `extraction into ${folder} never completed`,
  );
}

async function openReadonlyFailure() {
  const label = await openQuickExtract(READONLY_ARCHIVE);
  const state = await waitForQuickExtractState(
    (current) => current.title !== "Zinnia: Extracting",
    "read-only quick extract never reached a final state",
  );
  console.log(
    `QUICK_EXTRACT_READONLY ${JSON.stringify({
      label,
      ...state,
      readonlyDestinationExists: fs.existsSync(READONLY_DESTINATION),
      readonlyEntries: listDirectory(READONLY_DIR),
    })}`,
  );
  return { label, state };
}

describe("Zinnia beta 2 quick-extract recovery", function () {
  this.timeout(10 * 60_000);

  before(async function () {
    await waitForMainWindow();
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(READONLY_DIR, { recursive: true });
    fs.mkdirSync(path.join(ROOT, "writable"), { recursive: true });
    fs.mkdirSync(LONG_DIR, { recursive: true });
    fs.copyFileSync(HELLO_7Z, READONLY_ARCHIVE);
    fs.copyFileSync(HELLO_7Z, path.join(LONG_DIR, LONG_ARCHIVE_NAME));
    denyWriteToFolder(READONLY_DIR);
  });

  beforeEach(async function () {
    await closeQuickExtractWindows();
    removeFiles(
      OPEN_REQUEST,
      PICK_ANSWER,
      `${OPEN_REQUEST}.tmp`,
      `${PICK_ANSWER}.tmp`,
      READONLY_DESTINATION,
    );
  });

  after(async function () {
    try {
      await closeQuickExtractWindows();
    } catch (error) {
      console.warn(`Could not close quick-extract windows: ${error.message}`);
    } finally {
      try {
        restoreFolderWrite(READONLY_DIR);
      } catch (error) {
        console.warn(
          `Could not restore write access to ${READONLY_DIR}: ${error.message}`,
        );
      }
      removeFiles(OPEN_REQUEST, PICK_ANSWER);
    }
  });

  it("fails into a read-only folder, names the cause, and keeps every action inside the window", async function () {
    const { label, state } = await openReadonlyFailure();
    assert.equal(
      state.chooseHidden,
      false,
      `Choose another folder was not offered after the read-only failure: ${JSON.stringify(state)}`,
    );
    assert.equal(state.retryHidden, false, "Retry was not offered");

    const cause = (await $("#error-detail").getText()).trim();
    assert.match(
      cause,
      /permission denied|read-only/i,
      `failure does not name the cause: ${cause}`,
    );

    const layout = await browser.execute(() => {
      const boxOf = (id) => {
        const el = document.getElementById(id);
        if (!el || el.hidden) return null;
        const rect = el.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
      };
      const titlebar = document.getElementById("titlebar");
      const titlebarShown =
        titlebar !== null &&
        getComputedStyle(titlebar).display !== "none" &&
        titlebar.getBoundingClientRect().height > 0;
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        activeId: document.activeElement?.id ?? null,
        boxes: {
          "choose-folder-btn": boxOf("choose-folder-btn"),
          "retry-btn": boxOf("retry-btn"),
          "close-btn": boxOf("close-btn"),
        },
        titlebarShown,
        titlebarTop: titlebarShown
          ? titlebar.getBoundingClientRect().top
          : null,
        scrollTop: document.scrollingElement?.scrollTop ?? 0,
        horizontalOverflowPx:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });

    assert.equal(layout.innerWidth, WINDOW_WIDTH, "window width changed");
    assert.equal(layout.innerHeight, WINDOW_HEIGHT, "window height changed");
    assert.equal(
      layout.activeId,
      "choose-folder-btn",
      "focus did not move to Choose another folder for a permission failure",
    );
    for (const id of FOOTER_IDS) {
      const box = layout.boxes[id];
      assert.ok(box, `${id} is not shown after the failure`);
      assert.ok(
        box.left >= 0 &&
          box.top >= 0 &&
          box.right <= layout.innerWidth &&
          box.bottom <= layout.innerHeight,
        `${id} is outside the ${WINDOW_WIDTH}x${WINDOW_HEIGHT} window: ${JSON.stringify(box)}`,
      );
    }
    if (layout.titlebarShown) {
      assert.equal(layout.titlebarTop, 0, "titlebar scrolled away");
    }
    assert.equal(layout.scrollTop, 0, "window content scrolled vertically");
    assert.equal(layout.horizontalOverflowPx, 0, "window scrolls sideways");

    writeEvidence(EVIDENCE_DIR, "beta2-quick-extract-readonly-failure", {
      scenario: "readonly-destination-failure",
      label,
      cause,
      focusedControl: layout.activeId,
      windowSize: { width: layout.innerWidth, height: layout.innerHeight },
      footerBoxes: layout.boxes,
      titlebarTop: layout.titlebarTop,
      scrollTop: layout.scrollTop,
      horizontalOverflowPx: layout.horizontalOverflowPx,
    });
  });

  it("keeps the destination when the picker is cancelled, then extracts into the folder the user chose", async function () {
    await openReadonlyFailure();
    const originalDestination = (await quickExtractState()).destination;

    await $("#choose-folder-btn").click();
    await browser.pause(1_000);
    const afterCancel = await quickExtractState();
    assert.equal(
      afterCancel.destination,
      originalDestination,
      `a cancelled picker changed the destination: ${JSON.stringify(afterCancel)}`,
    );
    assert.equal(
      afterCancel.chooseHidden,
      false,
      `a cancelled picker hid Choose another folder: ${JSON.stringify(afterCancel)}`,
    );
    assert.equal(
      afterCancel.errorShown,
      true,
      `a cancelled picker cleared the failure: ${JSON.stringify(afterCancel)}`,
    );

    const chosenFolder = path.join(ROOT, "writable", "cancel-then-choose");
    fs.mkdirSync(chosenFolder, { recursive: true });
    const completed = await chooseFolderAndWaitForCompletion(chosenFolder);

    const expectedDestination = path.join(chosenFolder, "hello");
    const extractedFile = path.join(expectedDestination, "hello.txt");
    assert.equal(
      fs.readFileSync(extractedFile, "utf8"),
      PAYLOAD,
      `chosen folder did not receive ${extractedFile}`,
    );
    assert.equal(
      fs.existsSync(PICK_ANSWER),
      false,
      "the picker answer was not consumed",
    );
    assert.equal(completed.destination, expectedDestination);

    writeEvidence(EVIDENCE_DIR, "beta2-quick-extract-choose-folder", {
      scenario: "choose-another-folder",
      cancelledDestination: originalDestination,
      chosenDestination: expectedDestination,
      extractedFile: path.basename(extractedFile),
      extractedBytes: Buffer.byteLength(PAYLOAD),
    });
  });

  it("announces a full quick-extract run at most six times through its own live region", async function () {
    await openReadonlyFailure();
    await browser.execute(() => {
      const log = [];
      window.__zinniaAnnouncements = log;
      const announcer = document.getElementById("extract-announcer");
      new MutationObserver((records) => {
        for (const record of records) {
          log.push(
            Array.from(record.addedNodes, (node) => node.textContent).join(""),
          );
        }
      }).observe(announcer, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });

    const chosenFolder = path.join(ROOT, "writable", "live-region");
    fs.mkdirSync(chosenFolder, { recursive: true });
    await chooseFolderAndWaitForCompletion(chosenFolder);

    const announcements = await browser.execute(() =>
      window.__zinniaAnnouncements.slice(),
    );
    assert.ok(
      announcements.length > 0,
      "no announcements were recorded for the retried run",
    );
    assert.ok(
      announcements.length <= MAX_ANNOUNCEMENTS,
      `announced ${announcements.length} times: ${announcements.join(" | ")}`,
    );
    for (const text of announcements) {
      assert.ok(
        ANNOUNCEMENT_TEXTS.has(text),
        `unexpected announcement ${JSON.stringify(text)}`,
      );
    }
    assert.equal(announcements[0], "Started");
    assert.equal(announcements.at(-1), "Finished");

    const region = await browser.execute(() => {
      const status = document.getElementById("extract-status");
      const announcer = document.getElementById("extract-announcer");
      return {
        statusLive: status?.getAttribute("aria-live") ?? null,
        announcerRole: announcer?.getAttribute("role") ?? null,
        announcerLive: announcer?.getAttribute("aria-live") ?? null,
      };
    });
    assert.equal(region.statusLive, null, "the visible status is still live");
    assert.equal(region.announcerRole, "status");
    assert.equal(region.announcerLive, "polite");

    writeEvidence(EVIDENCE_DIR, "beta2-quick-extract-live-region", {
      scenario: "full-run-announcements",
      announcementCount: announcements.length,
      maxAllowed: MAX_ANNOUNCEMENTS,
      announcements,
      statusLive: region.statusLive,
      announcerRole: region.announcerRole,
    });
  });

  it("keeps a 200-character archive name from scrolling the quick-extract window", async function () {
    assert.equal(LONG_ARCHIVE_NAME.length, 200);

    const label = await openQuickExtract(
      path.join(LONG_DIR, LONG_ARCHIVE_NAME),
    );
    const finalState = await waitForQuickExtractState(
      (state) => state.title !== "Zinnia: Extracting",
      "long-name quick extract never reached a final state",
    );

    const metrics = await browser.execute(() => {
      const overflowOf = (el) => (el ? el.scrollWidth - el.clientWidth : null);
      const closeRect = document
        .getElementById("close-btn")
        ?.getBoundingClientRect();
      return {
        title: document.title,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        documentOverflowPx:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        appOverflowPx: overflowOf(document.getElementById("extract-app")),
        bodyOverflowPx: overflowOf(document.querySelector(".extract-body")),
        statusOverflowPx: overflowOf(document.getElementById("extract-status")),
        archiveNameLength: (
          document.getElementById("archive-name")?.textContent ?? ""
        ).length,
        closeWithinWindow:
          closeRect !== undefined &&
          closeRect.left >= 0 &&
          closeRect.right <= window.innerWidth &&
          closeRect.bottom <= window.innerHeight,
      };
    });

    assert.equal(metrics.innerWidth, WINDOW_WIDTH, "window width changed");
    assert.equal(metrics.innerHeight, WINDOW_HEIGHT, "window height changed");
    assert.equal(metrics.archiveNameLength, 200, "archive name was truncated");
    assert.ok(
      metrics.documentOverflowPx <= 0,
      `window scrolls sideways by ${metrics.documentOverflowPx}px`,
    );
    assert.ok(
      metrics.appOverflowPx <= 0,
      `extract content overflows by ${metrics.appOverflowPx}px`,
    );
    assert.ok(
      metrics.statusOverflowPx <= 0,
      `status line overflows by ${metrics.statusOverflowPx}px`,
    );
    assert.equal(metrics.closeWithinWindow, true, "Close left the window");

    writeEvidence(EVIDENCE_DIR, "beta2-quick-extract-long-name", {
      scenario: "two-hundred-character-archive-name",
      label,
      finalStatus: finalState.status,
      archiveNameLength: metrics.archiveNameLength,
      finalTitle: metrics.title,
      windowSize: { width: metrics.innerWidth, height: metrics.innerHeight },
      documentOverflowPx: metrics.documentOverflowPx,
      extractAppOverflowPx: metrics.appOverflowPx,
      bodyOverflowPx: metrics.bodyOverflowPx,
      statusOverflowPx: metrics.statusOverflowPx,
    });
  });
});
