import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  startPowerExtract,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  sha256File,
  treeManifest,
  writeEvidence,
} from "../helpers/recovery-harness.js";

const CASE = JSON.parse(process.env.ZINNIA_E2E_CASE ?? "null");
const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const PRESERVED_COPY = /^pending-stages\.corrupt-[0-9a-f]{32}\.json$/;

function preservedCopies() {
  return fs
    .readdirSync(CASE.cacheDir)
    .filter((name) => PRESERVED_COPY.test(name))
    .sort();
}

describe("unreadable pending-stage registry", () => {
  const observed = [];
  before(async () => {
    assert.ok(CASE, "ZINNIA_E2E_CASE is not set");
    // The app has already started by this hook and consumed the seeded
    // registry, so the seed is proven by the preserved copy's digest below.
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it("preserves the unreadable bytes once, drops the registry, and leaves the leaked stage alone", async () => {
    // The app writes the preserved copy before it rewrites the registry, so
    // the registry disappearing is the signal that the pass has finished.
    await browser.waitUntil(
      () => !fs.existsSync(CASE.registry) && preservedCopies().length > 0,
      {
        timeout: 60_000,
        interval: 200,
        timeoutMsg: `startup did not rewrite the registry; preserved copies: ${JSON.stringify(preservedCopies())}`,
      },
    );
    const copies = preservedCopies();
    assert.equal(
      copies.length,
      1,
      `expected exactly one preserved copy, found ${JSON.stringify(copies)}`,
    );
    const copySha = sha256File(path.join(CASE.cacheDir, copies[0]));
    assert.equal(
      copySha,
      CASE.registrySha256,
      "preserved copy bytes differ from the seeded registry",
    );
    assert.deepEqual(
      treeManifest(CASE.stage),
      CASE.stageManifest,
      "startup changed the leaked stage directory",
    );
    observed.push({
      step: "startup",
      preservedCopy: copies[0],
      registryPresent: false,
      leakedStageUntouched: true,
    });
  });

  it("runs a normal Power extract without adding a second preserved copy", async () => {
    const copiesBefore = preservedCopies();
    await startPowerExtract(CASE.archive, CASE.destination);
    const extracted = path.join(CASE.destination, CASE.payloadFile);
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 90_000,
      interval: 250,
      timeoutMsg: `extract did not write ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), PAYLOAD);
    assert.deepEqual(
      preservedCopies(),
      copiesBefore,
      "a later registry read added a preserved copy",
    );
    assert.equal(
      fs.existsSync(CASE.registry),
      false,
      "registry reappeared after a successful extract",
    );
    // Only the leaked stage may remain; the extract's own stage must be gone.
    assert.deepEqual(findLeftovers(CASE.root), [path.basename(CASE.stage)]);
    assert.deepEqual(treeManifest(CASE.stage), CASE.stageManifest);
    observed.push({ step: "extract-after-startup", payloadMatched: true });
    writeEvidence(EVIDENCE_DIR, "pending-registry", {
      scenario: "pending-registry",
      registrySha256: CASE.registrySha256,
      preservedCopies: preservedCopies(),
      observed,
      // The runner launches each scenario spec once, so a relaunch on this
      // profile is not exercised. Stability is checked within the session.
      relaunchCovered: false,
    });
  });
});
