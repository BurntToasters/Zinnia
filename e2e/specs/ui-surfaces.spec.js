import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import {
  assertOsIntegrationTabMatchesBackend,
  clickBasicRecentArchive,
  clickBasicRunExtract,
  clickPowerExtractPasswordToggle,
  closeSettingsModalViaUi,
  dismissToasts,
  domText,
  enableLocalLoggingViaSettings,
  exportDiagnosticsLogsTo,
  basicBrowseStatusState,
  openBasicBrowseForArchive,
  openBasicRecentsMenu,
  openOsIntegrationSettingsTab,
  powerExtractPasswordToggleState,
  prepareBasicExtract,
  startPowerExtract,
  switchToPowerWorkspace,
  waitForArchiveIdle,
  waitForBasicBrowseStatusIdle,
  waitForDomText,
  waitForE2eHook,
  waitForMainWindow,
  waitForSettingsLogDirectory,
  waitForInputListCleared,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "ui-surfaces");
const ARCHIVE = process.env.ZINNIA_E2E_ENCRYPTED_7Z;
const PASSWORD = process.env.ZINNIA_E2E_PASSWORD;
const HELLO = process.env.ZINNIA_E2E_HELLO_7Z;

describe("ui surfaces", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it("renders OS Integration status from get_os_integration_status without error text", async () => {
    await openOsIntegrationSettingsTab();
    await assertOsIntegrationTabMatchesBackend();
    await closeSettingsModalViaUi();
  });

  it("shows Basic browse status while loading and an error for corrupt archives", async () => {
    const good = HELLO;
    await openBasicBrowseForArchive(good);
    await waitForBasicBrowseStatusIdle(
      "Basic browse did not finish listing a valid archive",
    );

    let sawLoading = false;
    await browser.execute(() => {
      document.getElementById("basic-browse-contents")?.click();
    });
    await browser.waitUntil(
      async () => {
        const state = await basicBrowseStatusState();
        if (state.loading === 1 || state.busy === 1) sawLoading = true;
        return sawLoading && state.busy === 0 && state.loading === 0
          ? "ready"
          : false;
      },
      {
        timeout: 120_000,
        timeoutMsg:
          "Basic browse did not show loading then clear for a valid archive",
      },
    );
    const idle = await basicBrowseStatusState();
    assert.equal(idle.error, 0);
    assert.ok(
      idle.text.length > 0,
      "Basic browse cleared without a status message",
    );

    const badArchive = path.join(ROOT, "corrupt.7z");
    fs.copyFileSync(HELLO, badArchive);
    fs.truncateSync(badArchive, 128);
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await openBasicBrowseForArchive(badArchive);
    await $("#basic-browse-status.is-error").waitForExist({
      timeout: 120_000,
      timeoutMsg: "corrupt archive browse did not show an error state",
    });
    const corrupt = await basicBrowseStatusState();
    assert.equal(corrupt.error, 1);
    assert.ok(
      corrupt.text.length > 0,
      "corrupt archive browse did not show an error message",
    );
  });

  it("does not leak the archive password in exported diagnostics logs after an encrypted extract", async () => {
    await enableLocalLoggingViaSettings();
    const dest = path.join(ROOT, "encrypted-extract");
    fs.mkdirSync(dest, { recursive: true });
    await dismissToasts();
    await startPowerExtract(ARCHIVE, dest, { password: PASSWORD });
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 120_000,
      timeoutMsg: `encrypted extract did not write ${extracted}`,
    });
    await waitForArchiveIdle();

    const activityLog = String(await domText("#log"));
    assert.ok(
      !activityLog.includes(PASSWORD),
      `activity log leaked the archive password: ${activityLog.slice(-500)}`,
    );

    const logDir = await waitForSettingsLogDirectory(
      "Settings did not show the diagnostics log directory",
    );
    const onDiskLog = path.join(logDir, "zinnia.log");
    await browser.waitUntil(() => fs.existsSync(onDiskLog), {
      timeout: 30_000,
      timeoutMsg: `local diagnostics log missing at ${onDiskLog}`,
    });
    const exported = fs.readFileSync(onDiskLog, "utf8");
    assert.ok(
      !exported.includes(PASSWORD),
      `local diagnostics log leaked the archive password: ${exported.slice(-500)}`,
    );

    const exportedPath = path.join(ROOT, "exported-logs.txt");
    await exportDiagnosticsLogsTo(exportedPath);
    assert.ok(fs.existsSync(exportedPath), "exported diagnostics file missing");
    const exportedFile = fs.readFileSync(exportedPath, "utf8");
    assert.ok(exportedFile.length > 0, "exported diagnostics file is empty");
    assert.ok(
      !exportedFile.includes(PASSWORD),
      `exported diagnostics file leaked the archive password: ${exportedFile.slice(-500)}`,
    );

    writeEvidence(EVIDENCE_DIR, "log-export-redaction", {
      scenario: "log-export-redaction",
      logDirectory: logDir,
      onDiskLog,
      exportedPath,
      passwordInActivityLog: activityLog.includes(PASSWORD),
      passwordInOnDiskLog: exported.includes(PASSWORD),
      passwordInExportedFile: exportedFile.includes(PASSWORD),
    });
  });

  it("lists a Basic extract in recents and re-opens it from the menu", async () => {
    const dest = path.join(ROOT, "basic-recents");
    fs.mkdirSync(dest, { recursive: true });
    await dismissToasts();
    await prepareBasicExtract(HELLO, dest);
    await clickBasicRunExtract();
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 120_000,
      timeoutMsg: `basic extract for recents did not write ${extracted}`,
    });
    await waitForArchiveIdle();

    await openBasicRecentsMenu();
    await clickBasicRecentArchive(HELLO);
    await waitForDomText(
      "#basic-extract-archive-name",
      path.basename(HELLO),
      "re-opening from recents did not load the extract archive",
    );
    assert.equal(await domText("#basic-extract-archive-name"), "hello.7z");
  });

  it("toggles Power extract password visibility via aria-label and input type", async () => {
    await switchToPowerWorkspace();
    await waitForArchiveIdle();
    await browser.execute(() => {
      document.querySelector('[data-mode-btn="extract"]')?.click();
      const field = document.getElementById("extract-password");
      if (field) field.value = "probe-password";
    });

    const hidden = await powerExtractPasswordToggleState();
    assert.equal(hidden.inputType, "password");
    assert.equal(hidden.ariaLabel, "Show password");
    assert.equal(hidden.pressed, "false");

    await clickPowerExtractPasswordToggle();
    const shown = await powerExtractPasswordToggleState();
    assert.equal(shown.inputType, "text");
    assert.equal(shown.ariaLabel, "Hide password");
    assert.equal(shown.pressed, "true");

    await clickPowerExtractPasswordToggle();
    const hiddenAgain = await powerExtractPasswordToggleState();
    assert.equal(hiddenAgain.inputType, "password");
    assert.equal(hiddenAgain.ariaLabel, "Show password");
    assert.equal(hiddenAgain.pressed, "false");
  });
});
