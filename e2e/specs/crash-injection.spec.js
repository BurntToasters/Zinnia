import fs from "node:fs";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  queueConfirmResult,
  startPowerCompress,
  startPowerExtract,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  readJsonIfPresent,
  treeManifest,
  writeEvidence,
} from "../helpers/recovery-harness.js";

const CASE = JSON.parse(process.env.ZINNIA_E2E_CASE ?? "null");
const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;

async function waitForFile(file, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description} never appeared at ${file}`);
}

async function webdriverAlive() {
  try {
    await browser.execute(() => 1);
    return true;
  } catch {
    return false;
  }
}

async function waitForAppExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await webdriverAlive())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("app kept answering WebDriver after its crash point fired");
}

function journalSummary(file) {
  const journal = readJsonIfPresent(file);
  if (!journal) return null;
  return {
    formatVersion: journal.format_version ?? null,
    archive: journal.archive,
    extractPhase: journal.extract_phase ?? null,
    archivePhase: journal.archive_phase ?? null,
    stage: journal.stage ?? null,
  };
}

describe(`crash injection ${CASE?.id ?? "(missing case)"}`, () => {
  before(async () => {
    assert.ok(CASE, "ZINNIA_E2E_CASE is not set");
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it(`crashes at ${CASE.point} during ${CASE.operation}`, async () => {
    assert.equal(
      process.env.ZINNIA_E2E_CRASH_AT,
      CASE.point,
      "crash launch did not receive its crash point",
    );
    assert.equal(
      fs.existsSync(CASE.journal),
      false,
      "journal existed before the operation started",
    );

    if (CASE.operation === "extract") {
      await startPowerExtract(CASE.archive, CASE.destination);
    } else {
      if (CASE.outputMode === "existing") {
        // The Replace confirmation is a native dialog; the E2E queue answers it.
        await queueConfirmResult(true);
      }
      await startPowerCompress(CASE.input, CASE.output);
    }

    // The crash point writes its marker and aborts. Poll the filesystem only:
    // WebDriver calls would race the dying process.
    await waitForFile(CASE.marker, 90_000, `crash marker for ${CASE.point}`);
    const markerPoint = fs.readFileSync(CASE.marker, "utf8").trim();
    assert.equal(markerPoint, CASE.point, "crash marker names another point");

    const journalAtCrash = journalSummary(CASE.journal);
    assert.ok(
      journalAtCrash,
      `no recovery journal survived the ${CASE.point} crash`,
    );
    assert.equal(journalAtCrash.archive, CASE.operation === "create");

    await waitForAppExit(30_000);
    globalThis.__ZINNIA_E2E_APP_CLOSED_BY_SPEC__ = true;

    const destinationRoot =
      CASE.operation === "extract" ? CASE.destination : CASE.output;
    const atCrash = {
      destination: treeManifest(destinationRoot),
      leftovers: findLeftovers(CASE.root),
    };
    writeEvidence(EVIDENCE_DIR, `${CASE.id}.crash`, {
      scenario: CASE.id,
      phase: "crash",
      operation: CASE.operation,
      crashPoint: CASE.point,
      marker: markerPoint,
      appExited: true,
      journalAtCrash,
      atCrash,
      preManifest: readJsonIfPresent(CASE.preManifestFile),
    });
  });
});
