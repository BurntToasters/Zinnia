import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  activityLogText,
  bannerState,
  cancelDuringPause,
  startPowerExtract,
  toastTexts,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
  waitForPauseMarker,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  sevenZipProcesses,
  writeEvidence,
} from "../helpers/recovery-harness.js";

const CASE = JSON.parse(process.env.ZINNIA_E2E_CASE ?? "null");
const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const JOURNAL = process.env.ZINNIA_E2E_JOURNAL;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
// Allowed time after the pause ends for the cancelled run to unwind.
const CANCEL_MARGIN_MS = 15_000;
const CANCELLED_LINE = "Operation cancelled by user";

async function waitForNoChildren(timeout) {
  await browser.waitUntil(() => sevenZipProcesses().length === 0, {
    timeout,
    interval: 200,
    timeoutMsg: `7-Zip still running after cancel: ${sevenZipProcesses().join("; ")}`,
  });
}

describe(`cancel during the ${CASE?.point ?? "(missing)"} pause`, function () {
  this.timeout(10 * 60_000);

  before(async () => {
    assert.ok(CASE, "ZINNIA_E2E_CASE is not set");
    assert.equal(
      process.env.ZINNIA_E2E_PAUSE_AT,
      CASE.point,
      "launch did not receive its pause point",
    );
    assert.equal(
      fs.existsSync(CASE.marker),
      false,
      "pause marker existed before launch",
    );
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it("cancels inside the pause window, publishes nothing, and reruns cleanly", async () => {
    await startPowerExtract(CASE.archive, CASE.destination);
    const markerSeenAt = await waitForPauseMarker(CASE.marker, CASE.point);
    // Recorded, not required: the member listing can exit before the pause ends.
    const childrenAtPause = sevenZipProcesses();
    const clickedAt = await cancelDuringPause();
    const clickOffsetMs = clickedAt - markerSeenAt;
    assert.ok(
      clickOffsetMs < CASE.pauseMs,
      `Cancel landed ${clickOffsetMs} ms after the pause began, outside the ${CASE.pauseMs} ms window`,
    );

    const deadline = markerSeenAt + CASE.pauseMs + CANCEL_MARGIN_MS;
    try {
      await waitForArchiveIdle(Math.max(deadline - Date.now(), 1_000));
    } catch {
      throw new Error(
        `cancelled run did not end within ${CASE.pauseMs} + ${CANCEL_MARGIN_MS} ms: ${await uiDiagnostics()}`,
      );
    }
    const idleAt = Date.now();
    await browser.waitUntil(
      async () => (await activityLogText()).includes(CANCELLED_LINE),
      {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: `run ended without logging "${CANCELLED_LINE}": ${await uiDiagnostics()}`,
      },
    );
    await waitForNoChildren(10_000);

    const toasts = await toastTexts();
    assert.equal(
      toasts.some((line) => line.includes("Extraction complete.")),
      false,
      `cancelled extraction reported success; toasts ${JSON.stringify(toasts)}`,
    );
    assert.equal(
      fs.existsSync(CASE.destination),
      false,
      `cancelled extraction published ${CASE.destination}`,
    );
    assert.deepEqual(
      findLeftovers(CASE.root).filter((name) => name.startsWith(".zinnia-")),
      [],
      "cancel left a stage behind",
    );
    assert.equal(
      fs.existsSync(JOURNAL),
      false,
      "cancel left the recovery journal behind",
    );
    const banner = await bannerState();
    assert.equal(
      banner.visible,
      false,
      `cancel left a recovery banner: ${banner.text}`,
    );

    await startPowerExtract(CASE.archive, CASE.rerunDestination);
    const extracted = path.join(CASE.rerunDestination, CASE.payloadFile);
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: `rerun did not write ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), PAYLOAD);

    writeEvidence(EVIDENCE_DIR, CASE.id, {
      scenario: CASE.id,
      pausePoint: CASE.point,
      pauseMs: CASE.pauseMs,
      archiveSha256: CASE.archiveSha256,
      sevenZipAtPause: childrenAtPause.length,
      cancelClickOffsetMs: clickOffsetMs,
      idleAfterMarkerMs: idleAt - markerSeenAt,
      boundMs: CASE.pauseMs + CANCEL_MARGIN_MS,
      childrenAfterCancel: sevenZipProcesses().length,
      destinationExistsAfterCancel: fs.existsSync(CASE.destination),
      leftoverStages: findLeftovers(CASE.root).filter((name) =>
        name.startsWith(".zinnia-"),
      ),
      rerunPayloadMatched: true,
    });
  });
});
