import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  awaitStartupRecoveryStatus,
  bannerState,
  queueConfirmResult,
  startPowerExtract,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { treeManifest, writeEvidence } from "../helpers/recovery-harness.js";

const CASE = JSON.parse(process.env.ZINNIA_E2E_CASE ?? "null");
const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const ARCHIVE = process.env.ZINNIA_E2E_HELLO_7Z;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;

async function waitUntilBanner(predicate, description) {
  let last = null;
  await browser.waitUntil(
    async () => {
      last = await bannerState();
      return predicate(last);
    },
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `${description}; last banner: ${JSON.stringify(last)}`,
    },
  );
  return last;
}

async function clickDom(selector) {
  await browser.execute((target) => {
    document.querySelector(target)?.click();
  }, selector);
}

describe("newer-format recovery journal", () => {
  const observed = [];
  before(async () => {
    assert.ok(CASE, "ZINNIA_E2E_CASE is not set");
    assert.ok(
      fs.existsSync(CASE.journal),
      "seeded journal is missing before launch",
    );
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it("shows the newer-version banner and touches no files", async () => {
    const banner = await waitUntilBanner(
      (state) => state.visible && state.acknowledgeVisible,
      "newer-version banner with Accept never appeared",
    );
    assert.match(banner.text, /newer Zinnia version/i);
    const status = await awaitStartupRecoveryStatus();
    assert.match(String(status.value), /newer Zinnia version/);
    assert.deepEqual(
      treeManifest(CASE.root),
      CASE.preManifest,
      "a newer-format journal changed files during startup",
    );
    observed.push({ step: "banner", text: banner.text });
  });

  it("blocks archive jobs while the journal is preserved", async () => {
    const dest = path.join(CASE.root, "blocked-extract");
    await startPowerExtract(ARCHIVE, dest);
    await browser.waitUntil(
      async () =>
        (await uiDiagnostics()).includes("requires recovery") ||
        fs.existsSync(dest),
      {
        timeout: 30_000,
        timeoutMsg: `blocked extraction did not report recovery: ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();
    assert.equal(fs.existsSync(dest), false, "archive job ran while blocked");
    assert.deepEqual(treeManifest(CASE.root), CASE.preManifest);
    observed.push({ step: "blocked-extract", destinationExists: false });
  });

  it("keeps the journal when Accept is declined", async () => {
    await queueConfirmResult(false);
    await clickDom("#startup-recovery-banner-acknowledge");
    await browser.pause(1_000);
    assert.equal(
      fs.existsSync(CASE.journal),
      true,
      "declined Accept cleared the journal",
    );
    const banner = await bannerState();
    assert.equal(
      banner.visible,
      true,
      "banner disappeared after declined Accept",
    );
    observed.push({ step: "accept-declined", journalPresent: true });
  });

  it("accepts the journal, clears it, and lets archive jobs run again", async () => {
    await queueConfirmResult(true);
    await clickDom("#startup-recovery-banner-acknowledge");
    const banner = await waitUntilBanner(
      (state) => /accepted/i.test(state.text),
      "Accept did not report the journal as accepted",
    );
    assert.match(banner.text, /newer Zinnia version/i);
    await browser.waitUntil(() => !fs.existsSync(CASE.journal), {
      timeout: 10_000,
      timeoutMsg: "accepted journal was not cleared",
    });
    assert.deepEqual(
      treeManifest(CASE.root),
      CASE.preManifest,
      "Accept changed files inside the preserved transaction",
    );

    const after = path.join(CASE.root, "after-accept");
    await startPowerExtract(ARCHIVE, after);
    const extracted = path.join(after, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 60_000,
      timeoutMsg: `extraction after Accept did not write ${extracted}`,
    });
    assert.equal(fs.readFileSync(extracted, "utf8"), PAYLOAD);
    await waitForArchiveIdle();
    observed.push({ step: "accepted-and-extracted", journalPresent: false });
    writeEvidence(EVIDENCE_DIR, "newer-journal", {
      scenario: "newer-journal",
      formatVersion: 99,
      observed,
      finalManifestMatchesPreLaunch: true,
    });
  });
});
