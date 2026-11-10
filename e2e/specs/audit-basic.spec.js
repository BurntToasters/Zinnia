import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  clickBasicRunExtract,
  dismissToasts,
  prepareBasicExtract,
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
const ROOT = path.join(WORK, "audit-basic");
const HELLO_TXT = process.env.ZINNIA_E2E_HELLO_TXT;
const HELLO_7Z = process.env.ZINNIA_E2E_HELLO_7Z;
const sidecar = requireHostSidecar();

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

/**
 * Record every change of the Basic compress progress state inside the page.
 * The sampler runs in the webview, so a fast operation cannot hide a state
 * between two WebDriver round trips.
 */
async function startProgressSampler(section) {
  await browser.execute((name) => {
    const samples = [];
    const timer = setInterval(() => {
      const progress = document.getElementById(`basic-${name}-progress`);
      const sample = {
        active: Boolean(progress?.classList.contains("is-active")),
        label:
          document
            .getElementById(`basic-${name}-status`)
            ?.textContent?.trim() ?? "",
        percent:
          progress
            ?.querySelector(".basic-progress__percent")
            ?.textContent?.trim() ?? "",
        bar:
          progress
            ?.querySelector('[role="progressbar"]')
            ?.getAttribute("aria-valuenow") ?? "",
      };
      const last = samples.at(-1);
      if (!last || JSON.stringify(last) !== JSON.stringify(sample)) {
        samples.push(sample);
      }
    }, 20);
    window.__zinniaBasicSampler = { samples, timer };
  }, section);
}

async function stopProgressSampler() {
  return browser.execute(() => {
    const sampler = window.__zinniaBasicSampler;
    if (!sampler) return [];
    clearInterval(sampler.timer);
    delete window.__zinniaBasicSampler;
    return sampler.samples;
  });
}

async function quickRepeatState() {
  return browser.execute(() => ({
    add: document.getElementById("quick-add-repeat")?.disabled ?? null,
    extract: document.getElementById("quick-extract-repeat")?.disabled ?? null,
  }));
}

describe("Basic progress, status and quick actions", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("keeps Repeat Last disabled after a Basic compress in a fresh profile", async () => {
    const output = path.join(ROOT, "repeat", "hello.7z");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.rmSync(output, { force: true });

    await clearBasicInputs();
    await applyIncomingPaths([HELLO_TXT], "compress");
    await setInputValue("#basic-output-path", output);
    await browser.execute(() => {
      document.getElementById("basic-run-compress")?.click();
    });
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: 120_000,
      timeoutMsg: `basic compress did not write ${output}`,
    });
    await waitForArchiveIdle();

    const repeat = await quickRepeatState();
    assert.equal(
      repeat.add,
      true,
      "Repeat Last (add) was enabled with nothing to repeat",
    );
    assert.equal(
      repeat.extract,
      true,
      "Repeat Last (extract) was enabled with nothing to repeat",
    );

    writeEvidence(EVIDENCE_DIR, "audit-basic-repeat-last", {
      scenario: "repeat-last-fresh-profile",
      output,
      repeatAddDisabled: repeat.add,
      repeatExtractDisabled: repeat.extract,
    });
  });

  it("shows a numeric percent, keeps the Compressing label, and ends with the bar at 100", async () => {
    const payload = path.join(ROOT, "progress", "payload.bin");
    const output = path.join(ROOT, "progress", "payload.7z");
    fs.rmSync(output, { force: true });
    // 7-Zip prints a percent only about every 150 ms. A 16 MiB file finishes
    // before a second update, so use 200 MiB to leave mid-run updates.
    writeRandomFile(payload, 200 * 1024 * 1024);

    await clearBasicInputs();
    await applyIncomingPaths([payload], "compress");
    await setInputValue("#basic-output-path", output);
    await startProgressSampler("compress");
    await browser.execute(() => {
      document.getElementById("basic-run-compress")?.click();
    });
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: 180_000,
      timeoutMsg: `basic compress did not write ${output}`,
    });
    await waitForArchiveIdle();
    const samples = await stopProgressSampler();
    const finalBar = await browser.execute(
      () =>
        document
          .querySelector('#basic-compress-progress [role="progressbar"]')
          ?.getAttribute("aria-valuenow") ?? null,
    );
    const completionTitle = await browser.execute(
      () =>
        document.getElementById("basic-compress-completion-title")
          ?.textContent ?? "",
    );

    const live = samples.filter((sample) => sample.active);
    assert.ok(
      live.length > 0,
      "Basic compress never showed its progress panel",
    );
    const labels = [...new Set(live.map((sample) => sample.label))];
    assert.ok(
      live.every((sample) => /^Compressing/.test(sample.label)),
      `the operation label changed during the run: ${JSON.stringify(labels)}`,
    );
    const percents = [
      ...new Set(
        live
          .map((sample) => sample.percent)
          .filter((text) => /^\d{1,2}%$/.test(text)),
      ),
    ];
    assert.ok(
      percents.length > 0,
      `no numeric percent was shown while compressing: ${JSON.stringify(samples)}`,
    );
    assert.equal(finalBar, "100", "the bar did not reach 100 on success");
    assert.equal(completionTitle, "Archive created");

    writeEvidence(EVIDENCE_DIR, "audit-basic-compress-progress", {
      scenario: "compress-percent-and-final-bar",
      output,
      labels,
      percentsSeen: percents,
      finalBarValue: finalBar,
      completionTitle,
      sampleCount: samples.length,
    });
  });

  it("shows a Cancelled confirmation after the Basic extract Cancel button is pressed", async () => {
    const payload = path.join(ROOT, "cancel", "payload.bin");
    const archive = path.join(ROOT, "cancel", "large-bzip2.7z");
    const dest = path.join(ROOT, "cancel", "out");
    fs.rmSync(archive, { force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    // Large, incompressible, slow-to-decode payload so the extract is still
    // running when Cancel is pressed. A 320 MiB archive decodes in about 4.6 s,
    // which the UI poll can overshoot, so use 768 MiB (about 11 s). The archive
    // is built once per run.
    writeRandomFile(payload, 768 * 1024 * 1024);
    run7z(
      sidecar,
      ["a", "-t7z", "-m0=BZip2", "-mx=1", "-bd", "--", archive, payload],
      { timeout: 900_000 },
    );
    fs.rmSync(payload, { force: true });

    await prepareBasicExtract(archive, dest);
    await clickBasicRunExtract();
    // Press Cancel only once a mid-run percent is on screen, so the run is
    // provably still in flight.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const progress = document.getElementById("basic-extract-progress");
          const label = document.getElementById("basic-extract-status");
          const percent =
            progress
              ?.querySelector(".basic-progress__percent")
              ?.textContent?.trim() ?? "";
          const match = /^(\d{1,2})%$/.exec(percent);
          return (
            Boolean(progress?.classList.contains("is-active")) &&
            /^Extracting/.test(label?.textContent?.trim() ?? "") &&
            Boolean(match) &&
            Number(match[1]) >= 1 &&
            Number(match[1]) <= 90
          );
        }),
      {
        timeout: 180_000,
        timeoutMsg:
          "Basic extract never showed a mid-run percent before Cancel was due",
      },
    );
    const readExtractDom = () =>
      browser.execute(() => ({
        status: document.getElementById("basic-extract-status")?.textContent,
        detail: document
          .getElementById("basic-extract-progress")
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
        progressActive:
          document
            .getElementById("basic-extract-progress")
            ?.classList.contains("is-active") ?? null,
        completionTitle: document.getElementById(
          "basic-extract-completion-title",
        )?.textContent,
        completionMessage: document.getElementById(
          "basic-extract-completion-msg",
        )?.textContent,
        runDisabled:
          document.getElementById("basic-run-extract")?.disabled ?? null,
        cancelDisabled:
          document.getElementById("basic-extract-cancel")?.disabled ?? null,
      }));
    // Timeline of distinct DOM states from just before Cancel to the outcome.
    const timeline = [{ t: 0, ...(await readExtractDom()) }];
    await browser.execute(() => {
      document.getElementById("basic-extract-cancel")?.click();
    });
    const clickedAt = Date.now();
    let reachedCancelled = false;
    while (Date.now() - clickedAt < 120_000) {
      const sample = await readExtractDom();
      const { ...previous } = timeline.at(-1);
      delete previous.t;
      if (JSON.stringify(previous) !== JSON.stringify(sample)) {
        timeline.push({ t: Date.now() - clickedAt, ...sample });
      }
      if (sample.completionTitle === "Cancelled") {
        reachedCancelled = true;
        break;
      }
      await browser.pause(250);
    }
    assert.ok(
      reachedCancelled,
      `Basic extract did not show a Cancelled confirmation after Cancel; timeline: ${JSON.stringify(timeline)}`,
    );
    await waitForArchiveIdle();

    const panel = await browser.execute(() => ({
      active:
        document
          .getElementById("basic-extract-completion")
          ?.classList.contains("is-active") ?? false,
      cancelledClass:
        document
          .getElementById("basic-extract-completion")
          ?.classList.contains("basic-completion--cancelled") ?? false,
      message:
        document.getElementById("basic-extract-completion-msg")?.textContent ??
        "",
      runDisabled:
        document.getElementById("basic-run-extract")?.disabled ?? null,
    }));
    assert.equal(panel.active, true, "Cancelled panel is not visible");
    assert.equal(
      panel.cancelledClass,
      true,
      "Cancelled panel does not use the neutral cancelled variant",
    );
    assert.ok(
      panel.message.trim().length > 0,
      "Cancelled panel has no message",
    );
    assert.equal(panel.runDisabled, false, "Run stayed disabled after cancel");

    writeEvidence(EVIDENCE_DIR, "audit-basic-cancel-extract", {
      scenario: "basic-extract-cancelled-message",
      archive,
      destination: dest,
      completionTitle: "Cancelled",
      completionMessage: panel.message,
      runEnabledAfterCancel: panel.runDisabled === false,
    });
  });

  it("starts nothing for Enter during IME composition in the Basic extract destination", async () => {
    const dest = path.join(ROOT, "ime-extract", "out");
    const extracted = path.join(dest, "hello.txt");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    await dismissToasts();
    await prepareBasicExtract(HELLO_7Z, dest);

    const dispatchEnter = (composing) =>
      browser.execute((isComposing) => {
        const field = document.getElementById("basic-extract-path");
        if (!field) throw new Error("missing #basic-extract-path");
        field.focus();
        field.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, composing);

    await dispatchEnter(true);
    await browser.pause(3_000);
    const startedWhileComposing = fs.existsSync(extracted);
    const progressActive = await browser.execute(
      () =>
        document
          .getElementById("basic-extract-progress")
          ?.classList.contains("is-active") ?? false,
    );
    assert.equal(
      startedWhileComposing,
      false,
      "Enter during IME composition started an extraction",
    );
    assert.equal(
      progressActive,
      false,
      "progress panel opened during composition",
    );

    await dispatchEnter(false);
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 120_000,
      timeoutMsg: `plain Enter did not extract ${extracted}`,
    });
    await waitForArchiveIdle();

    writeEvidence(EVIDENCE_DIR, "audit-basic-ime-enter", {
      scenario: "ime-enter-extract-destination",
      startedWhileComposing,
      plainEnterExtracted: fs.existsSync(extracted),
    });
  });
});
