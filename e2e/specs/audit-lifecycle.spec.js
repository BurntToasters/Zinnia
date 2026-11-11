import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  listingHasMember,
  requireHostSidecar,
  run7z,
} from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  confirmDialogTitles,
  flushPendingSettingsWrites,
  invokeLoadSettingsRaw,
  queueConfirmResult,
  startPowerCompress,
  switchToPowerWorkspace,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
  waitForToastContaining,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-lifecycle");
const sidecar = requireHostSidecar();
// Keep in sync with the native confirm copy in src/window-events.ts.
const CONFIRM_TITLE = "Operation in progress";
const HANDOFF_QUEUED_COPY = "will be added when the current operation finishes";
const LIMIT_COPY = "more were not added";
const MAX_PATHS = 4096;
const LONG_JOB_BYTES = 240 * 1024 * 1024;

function writeIncompressibleFile(file, bytes) {
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

function listStdout(archive) {
  return run7z(sidecar, ["l", "-slt", "--", archive]).stdout;
}

function outputDirListing(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

async function waitForCompressRunning(timeout = 180_000) {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const power = document.getElementById("workspace-mode-power");
        return Boolean(power?.disabled);
      }),
    {
      timeout,
      interval: 50,
      timeoutMsg: `compress never entered a running state; ${await uiDiagnostics()}`,
    },
  );
}

async function powerRunStillActive() {
  return browser.execute(() => {
    const power = document.getElementById("workspace-mode-power");
    return Boolean(power?.disabled);
  });
}

/** Starts a long compress in Power and waits until it is running. */
async function startLongCompress(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "large.bin");
  const output = path.join(dir, `${name}.7z`);
  writeIncompressibleFile(input, LONG_JOB_BYTES);
  await startPowerCompress(input, output, {
    format: "7z",
    level: "9",
    run: false,
  });
  await browser.execute(() => {
    document.getElementById("run-action")?.click();
  });
  await waitForCompressRunning();
  return { dir, input, output };
}

/** Clicks the custom titlebar close, the same path a user takes. */
async function clickTitlebarClose() {
  await browser.execute(() => {
    document.getElementById("titlebar-close")?.click();
  });
}

/** Resolves when the prompt titled CONFIRM_TITLE has been shown once more. */
async function waitForNewConfirmPrompt(countBefore) {
  await browser.waitUntil(
    async () => (await confirmDialogTitles()).length > countBefore,
    {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: `no confirm prompt appeared; ${await uiDiagnostics()}`,
    },
  );
  const titles = await confirmDialogTitles();
  assert.equal(
    titles.at(-1),
    CONFIRM_TITLE,
    `unexpected confirm title: ${JSON.stringify(titles)}`,
  );
}

/** Requests quit the way Cmd+Q does: the process plugin exit, not a close. */
function requestQuitWithoutAwait() {
  return browser.execute(() => {
    window.__TAURI__?.core
      ?.invoke("plugin:process|exit", { code: 0 })
      .catch(() => undefined);
  });
}

function windowStateSettings(raw) {
  const parsed = JSON.parse(raw || "{}");
  return {
    width: parsed.powerWindowWidth,
    height: parsed.powerWindowHeight,
  };
}

async function readSavedPowerSize() {
  await flushPendingSettingsWrites();
  const result = await invokeLoadSettingsRaw();
  assert.ok(!result.error, `load_settings failed: ${result.error}`);
  return windowStateSettings(result.raw);
}

async function waitForWindowMaximized(expected, timeoutMsg) {
  await browser.waitUntil(
    async () =>
      browser.executeAsync((want, done) => {
        window.__TAURI__.core
          .invoke("plugin:window|is_maximized")
          .then((value) => done(value === want))
          .catch(() => done(false));
      }, expected),
    { timeout: 10_000, interval: 100, timeoutMsg },
  );
}

async function windowInnerSize() {
  return browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

describe("Zinnia window lifecycle and incoming paths", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  after(async () => {
    await flushPendingSettingsWrites().catch(() => undefined);
  });

  it("asks before closing or quitting during a compress and keeps the job when declined", async () => {
    await switchToPowerWorkspace();
    const { dir, output } = await startLongCompress("decline");

    const titlesBeforeClose = (await confirmDialogTitles()).length;
    await queueConfirmResult(false);
    await clickTitlebarClose();
    await waitForNewConfirmPrompt(titlesBeforeClose);
    await browser.pause(500);
    assert.equal(
      await powerRunStillActive(),
      true,
      "declined close cancelled the running compress",
    );
    const closeTitles = await confirmDialogTitles();

    const titlesBeforeQuit = (await confirmDialogTitles()).length;
    await queueConfirmResult(false);
    await requestQuitWithoutAwait();
    await waitForNewConfirmPrompt(titlesBeforeQuit);
    assert.equal(
      await powerRunStillActive(),
      true,
      "declined quit cancelled the running compress",
    );

    const queuedAt = Date.now();
    const handoffFile = path.join(dir, "queued-handoff.txt");
    fs.writeFileSync(handoffFile, "queued during a job\n");
    await browser.execute((file) => {
      // Not awaited: the hand-off waits for the job, so an await would block.
      void window.__ZINNIA_E2E__.applyIncomingPaths([file], "compress");
    }, handoffFile);
    const queuedLines = await waitForToastContaining(
      HANDOFF_QUEUED_COPY,
      `hand-off during a job showed no queued toast; ${await uiDiagnostics()}`,
    );
    const queuedToast = queuedLines.find((line) =>
      line.includes(HANDOFF_QUEUED_COPY),
    );

    await waitForArchiveIdle(180_000);
    assert.ok(
      fs.existsSync(output),
      `declined compress did not finish: ${outputDirListing(dir).join(", ")}`,
    );
    assert.ok(
      listingHasMember(listStdout(output), "large.bin"),
      "completed compress lacks large.bin",
    );

    writeEvidence(EVIDENCE_DIR, "audit-lifecycle-decline", {
      scenario: "decline-close-and-quit",
      closeTitles,
      confirmTitle: CONFIRM_TITLE,
      queuedToast,
      queuedElapsedMs: Date.now() - queuedAt,
      outputBytes: fs.statSync(output).size,
    });
  });

  it("reports Power hand-offs over the 4,096-path limit with a toast", async () => {
    await switchToPowerWorkspace();
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    const paths = Array.from({ length: MAX_PATHS + 5 }, (_, index) =>
      path.join(ROOT, "limit", `f-${index}.txt`),
    );
    await applyIncomingPaths(paths, "compress");
    const limitLines = await waitForToastContaining(
      LIMIT_COPY,
      `hand-off over ${MAX_PATHS} paths showed no limit toast; ${await uiDiagnostics()}`,
    );
    const limitToast = limitLines.find((line) => line.includes(LIMIT_COPY));
    assert.ok(limitToast, "limit toast text was not captured");
    assert.doesNotMatch(
      limitToast,
      /dropped files/i,
      "hand-off limit copy still says dropped files",
    );
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });

    writeEvidence(EVIDENCE_DIR, "audit-lifecycle-limit-toast", {
      scenario: "handoff-over-limit",
      submitted: paths.length,
      limitToast,
    });
  });

  it("keeps the Power window size when maximized and saves again after restore", async () => {
    await switchToPowerWorkspace();
    const beforeSaved = await readSavedPowerSize();
    const normal = await windowInnerSize();

    await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke("plugin:window|maximize")
        .then(() => done(null))
        .catch((err) => done(String(err)));
    });
    await waitForWindowMaximized(true, "window did not maximize");
    await browser.pause(1_500);
    const maximized = await windowInnerSize();
    const savedWhileMaximized = await readSavedPowerSize();
    assert.equal(
      savedWhileMaximized.width,
      beforeSaved.width,
      `maximized width ${maximized.width} was saved as the Power width`,
    );
    assert.equal(
      savedWhileMaximized.height,
      beforeSaved.height,
      `maximized height ${maximized.height} was saved as the Power height`,
    );

    // The double-click path. Without core:window:allow-internal-toggle-maximize
    // this invoke is rejected, so a rejection here is the regression.
    const toggleError = await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke("plugin:window|internal_toggle_maximize")
        .then(() => done(null))
        .catch((err) => done(String(err)));
    });
    assert.equal(
      toggleError,
      null,
      `titlebar double-click toggle was rejected: ${toggleError}`,
    );
    await waitForWindowMaximized(false, "double-click toggle did not restore");

    await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke("plugin:window|unmaximize")
        .then(() => done(null))
        .catch((err) => done(String(err)));
    });
    await waitForWindowMaximized(false, "window did not unmaximize");
    await browser.pause(1_500);
    const restored = await windowInnerSize();
    const savedAfterRestore = await readSavedPowerSize();
    assert.equal(
      savedAfterRestore.width,
      restored.width,
      `restored window width was not saved after leaving maximized state; saved=${JSON.stringify(savedAfterRestore)} restored=${JSON.stringify(restored)}`,
    );
    assert.equal(
      savedAfterRestore.height,
      restored.height,
      "restored window height was not saved after leaving maximized state",
    );

    writeEvidence(EVIDENCE_DIR, "audit-lifecycle-window-size", {
      scenario: "maximize-does-not-save-size",
      normal,
      maximized,
      restored,
      beforeSaved,
      savedWhileMaximized,
      savedAfterRestore,
    });
  });

  it("cancels a running compress when the close prompt is accepted", async () => {
    await switchToPowerWorkspace();
    const { dir, output } = await startLongCompress("accept");

    const titlesBeforeClose = (await confirmDialogTitles()).length;
    await queueConfirmResult(true);
    await clickTitlebarClose();
    await waitForNewConfirmPrompt(titlesBeforeClose);

    // The accepted close tears the main window down, so the harness must not
    // ask the app to shut down through the session afterwards.
    globalThis.__ZINNIA_E2E_APP_CLOSED_BY_SPEC__ = true;
    await browser.waitUntil(
      async () => {
        try {
          await browser.execute(() => document.readyState);
          return false;
        } catch {
          return true;
        }
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "accepted close did not close the main window",
      },
    );

    assert.equal(
      fs.existsSync(output),
      false,
      `accepted close left ${output}; dir=${outputDirListing(dir).join(", ")}`,
    );
    writeEvidence(EVIDENCE_DIR, "audit-lifecycle-accept-close", {
      scenario: "accept-close-cancels-and-closes",
      outputExists: fs.existsSync(output),
    });
  });
});
