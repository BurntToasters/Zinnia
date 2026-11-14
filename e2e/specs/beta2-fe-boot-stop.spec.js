import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  confirmDialogTitles,
  queueConfirmResult,
  startPowerBatchExtract,
  switchToBasicWorkspace,
  switchToPowerWorkspace,
  uiDiagnostics,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-fe-boot-stop");
const sidecar = requireHostSidecar();
const CONFIRM_TITLE = "Operation in progress";
const BIG_BYTES = 768 * 1024 * 1024;
const BIG_NAME = "big.bin";
const MAXIMIZE_TOOLTIP_BASIC = "Maximize is unavailable in Basic mode";
const LATER_ARCHIVE_FOLDERS = ["second", "third"];

function writeRandomFile(file, bytes) {
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

async function batchProgressText() {
  return browser.execute(
    () => document.getElementById("progress")?.textContent?.trim() ?? "",
  );
}

function firstArchivePercent(text) {
  const match = /^(\d{1,3})% \(1\/3\)/.exec(text);
  return match ? Number(match[1]) : null;
}

function outputDirListing(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

function outputFilesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (current, relative) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = relative ? `${relative}/${name}` : name;
      if (fs.lstatSync(full).isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  };
  walk(dir, "");
  return files;
}

async function statusText() {
  return browser.execute(
    () => document.getElementById("status")?.textContent?.trim() ?? "",
  );
}

async function powerRunStillActive() {
  return browser.execute(() => {
    const power = document.getElementById("workspace-mode-power");
    return Boolean(power?.disabled);
  });
}

async function clickTitlebarClose() {
  await browser.execute(() => {
    document.getElementById("titlebar-close")?.click();
  });
}

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

async function maximizeButtonState() {
  return browser.execute(() => {
    const button = document.getElementById("titlebar-max");
    return {
      ariaLabel: button?.getAttribute("aria-label") ?? null,
      title: button?.getAttribute("title") ?? null,
      disabled: button?.disabled ?? null,
    };
  });
}

async function waitForMaximizeLabel(expected, timeoutMsg) {
  await browser.waitUntil(
    async () => (await maximizeButtonState()).ariaLabel === expected,
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `${timeoutMsg}: ${JSON.stringify(await maximizeButtonState())}`,
    },
  );
}

describe("Zinnia main window boot, stop and maximize", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("relabels the Maximize button to Restore while the window is maximized", async () => {
    await switchToPowerWorkspace();
    const normal = await maximizeButtonState();
    assert.equal(normal.ariaLabel, "Maximize", "Power starts with Maximize");

    await browser.execute(() => {
      document.getElementById("titlebar-max")?.click();
    });
    await waitForWindowMaximized(true, "titlebar maximize did not maximize");
    await waitForMaximizeLabel(
      "Restore",
      "maximized window kept the Maximize label",
    );
    const maximized = await maximizeButtonState();

    await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke("plugin:window|internal_toggle_maximize")
        .then(() => done(null))
        .catch((err) => done(String(err)));
    });
    await waitForWindowMaximized(false, "double-click toggle did not restore");
    await waitForMaximizeLabel(
      "Maximize",
      "restored window kept the Restore label",
    );
    const restored = await maximizeButtonState();

    await browser.execute(() => {
      document.getElementById("titlebar-max")?.click();
    });
    await waitForWindowMaximized(true, "second maximize did not maximize");
    await waitForMaximizeLabel(
      "Restore",
      "second maximize kept the Maximize label",
    );
    await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke("plugin:window|unmaximize")
        .then(() => done(null))
        .catch((err) => done(String(err)));
    });
    await waitForWindowMaximized(false, "window did not unmaximize");
    await waitForMaximizeLabel(
      "Maximize",
      "unmaximized window kept the Restore label",
    );

    await switchToBasicWorkspace();
    const basic = await maximizeButtonState();
    await browser.execute(() => {
      document.getElementById("titlebar-max")?.click();
    });
    await browser.pause(500);
    const basicMaximized = await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke("plugin:window|is_maximized")
        .then((value) => done(value))
        .catch(() => done(null));
    });
    assert.equal(basic.ariaLabel, "Maximize", "Basic showed Restore");
    assert.equal(basic.title, MAXIMIZE_TOOLTIP_BASIC, "Basic lost its tooltip");
    assert.equal(basicMaximized, false, "Basic maximize was not ignored");
    await switchToPowerWorkspace();

    writeEvidence(EVIDENCE_DIR, "beta2-fe-boot-stop-maximize-label", {
      scenario: "maximize-label-restore-and-basic-ignored",
      normal,
      maximized,
      restored,
      basic,
      basicWindowMaximized: basicMaximized,
    });
  });

  it("stops a running three-archive batch on an accepted close and starts no later archive", async () => {
    const batchRoot = path.join(ROOT, "batch-close");
    const dest = path.join(batchRoot, "out");
    const src = path.join(batchRoot, "src");
    fs.rmSync(batchRoot, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });

    const bigSource = path.join(src, BIG_NAME);
    writeRandomFile(bigSource, BIG_BYTES);
    const first = path.join(batchRoot, "first.7z");
    run7z(
      sidecar,
      ["a", "-t7z", "-m0=BZip2", "-mx=1", "-bd", first, "--", BIG_NAME],
      {
        cwd: src,
        timeout: 900_000,
      },
    );
    fs.rmSync(bigSource, { force: true });

    fs.writeFileSync(path.join(src, "two.txt"), "archive two\n");
    const second = path.join(batchRoot, "second.7z");
    run7z(sidecar, ["a", "-t7z", "-mx=0", second, "--", "two.txt"], {
      cwd: src,
      timeout: 120_000,
    });
    fs.writeFileSync(path.join(src, "three.txt"), "archive three\n");
    const third = path.join(batchRoot, "third.7z");
    run7z(sidecar, ["a", "-t7z", "-mx=0", third, "--", "three.txt"], {
      cwd: src,
      timeout: 120_000,
    });

    await startPowerBatchExtract([first, second, third], dest);
    await browser.waitUntil(
      async () => {
        const percent = firstArchivePercent(await batchProgressText());
        return percent !== null && percent >= 1 && percent <= 60;
      },
      {
        timeout: 120_000,
        interval: 50,
        timeoutMsg: `batch never showed a live percent for archive 1; ${await uiDiagnostics()}`,
      },
    );
    const percentAtPrompt = firstArchivePercent(await batchProgressText());
    const statusAtPrompt = await statusText();
    assert.match(
      statusAtPrompt,
      /^Extracting 1 of 3/,
      "batch did not start on archive 1",
    );

    const titlesBeforeDecline = (await confirmDialogTitles()).length;
    await queueConfirmResult(false);
    await clickTitlebarClose();
    await waitForNewConfirmPrompt(titlesBeforeDecline);
    await browser.pause(500);
    assert.equal(
      await powerRunStillActive(),
      true,
      "declined close stopped the batch",
    );
    const percentAfterDecline = firstArchivePercent(await batchProgressText());
    assert.ok(
      percentAfterDecline !== null && percentAfterDecline < 100,
      `archive 1 was no longer extracting after the declined close: ${await batchProgressText()}`,
    );
    const outputsAfterDecline = outputDirListing(dest);

    const percentAtAccept = firstArchivePercent(await batchProgressText());
    assert.ok(
      percentAtAccept !== null && percentAtAccept < 100,
      `archive 1 was no longer extracting at the accepted close: ${await batchProgressText()}`,
    );
    const statusAtAccept = await statusText();
    assert.match(
      statusAtAccept,
      /^Extracting 1 of 3/,
      "batch left archive 1 before the accepted close",
    );

    const titlesBeforeAccept = (await confirmDialogTitles()).length;
    await queueConfirmResult(true);
    await clickTitlebarClose();
    await waitForNewConfirmPrompt(titlesBeforeAccept);

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

    const outputsAfterAccept = outputDirListing(dest);
    const laterArchiveOutputs = [
      ...LATER_ARCHIVE_FOLDERS.flatMap((folder) =>
        outputFilesUnder(path.join(dest, folder)).map(
          (file) => `${folder}/${file}`,
        ),
      ),
      ...outputsAfterAccept.filter(
        (name) => name === "two.txt" || name === "three.txt",
      ),
    ];
    assert.deepEqual(
      laterArchiveOutputs,
      [],
      `archives after the current one wrote output: ${JSON.stringify(outputsAfterAccept)}`,
    );
    const publishedBig = outputFilesUnder(dest).filter((file) =>
      file.endsWith(BIG_NAME),
    );
    assert.deepEqual(
      publishedBig,
      [],
      `cancelled first archive published ${BIG_NAME}: ${JSON.stringify(publishedBig)}`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-boot-stop-batch-close", {
      scenario: "accepted-close-stops-batch-before-next-archive",
      archivesInBatch: 3,
      firstArchiveBytes: BIG_BYTES,
      percentAtPrompt,
      percentAfterDecline,
      percentAtAccept,
      statusAtPrompt,
      statusAtAccept,
      declinedCloseKeptRunning: true,
      outputsAfterDecline,
      outputsAfterAcceptedClose: outputsAfterAccept,
      laterArchiveOutputs,
      confirmTitle: CONFIRM_TITLE,
    });
  });
});
