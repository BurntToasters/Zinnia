import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  bannerState,
  startPowerExtract,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  sha256File,
  writeEvidence,
} from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const JOURNAL = process.env.ZINNIA_E2E_JOURNAL;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "cancel");
// Large enough that a stored (-mx=0) extraction is still writing when Cancel
// is clicked, on any host this suite runs on.
const BIG_BYTES = 1024 * 1024 * 1024;
const BIG_NAME = "big.bin";

function writeZeroFile(file, bytes) {
  const handle = fs.openSync(file, "w");
  try {
    const chunk = Buffer.alloc(8 * 1024 * 1024, 0);
    for (let written = 0; written < bytes; written += chunk.length) {
      fs.writeSync(handle, chunk, 0, Math.min(chunk.length, bytes - written));
    }
  } finally {
    fs.closeSync(handle);
  }
}

function stageWritingBytes(root, minBytes) {
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith(".zinnia-extract-")) continue;
    const candidate = path.join(root, name, BIG_NAME);
    try {
      if (fs.statSync(candidate).size >= minBytes) return candidate;
    } catch {
      // Not written yet.
    }
  }
  return null;
}

// Writes and hashes 1 GiB twice, so it needs more than the suite-wide 120 s.
describe("cancel mid-extract", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("cancels a large extraction, leaves no output, and reruns to completion", async () => {
    const source = path.join(ROOT, BIG_NAME);
    const archive = path.join(ROOT, "big.7z");
    writeZeroFile(source, BIG_BYTES);
    const sourceSha = sha256File(source);
    run7z(
      requireHostSidecar(),
      ["a", "-t7z", "-mx=0", archive, "--", BIG_NAME],
      {
        cwd: ROOT,
        timeout: 600_000,
      },
    );
    fs.rmSync(source, { force: true });

    const dest = path.join(ROOT, "cancelled-out");
    await startPowerExtract(archive, dest);

    // Wait for real bytes in the sibling stage before cancelling. Waiting on
    // the UI alone could cancel before any work and prove nothing.
    await browser.waitUntil(
      () => stageWritingBytes(ROOT, 64 * 1024 * 1024) !== null,
      {
        timeout: 120_000,
        interval: 50,
        timeoutMsg: "extraction never wrote 64 MiB into its stage",
      },
    );
    const bytesAtCancel = fs.statSync(
      stageWritingBytes(ROOT, 64 * 1024 * 1024),
    ).size;
    await browser.execute(() => {
      document.getElementById("extract-cancel")?.click();
    });
    await waitForArchiveIdle(180_000);

    assert.equal(
      fs.existsSync(dest),
      false,
      `cancelled extraction published ${dest}; status: ${await uiDiagnostics()}`,
    );
    assert.deepEqual(
      findLeftovers(ROOT).filter((name) => name.startsWith(".zinnia-")),
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

    // Rerun to completion on the same archive and destination.
    await startPowerExtract(archive, dest);
    const extracted = path.join(dest, BIG_NAME);
    await browser.waitUntil(
      () =>
        fs.existsSync(extracted) && fs.statSync(extracted).size === BIG_BYTES,
      {
        timeout: 300_000,
        interval: 250,
        timeoutMsg: `rerun did not finish writing ${extracted}`,
      },
    );
    await waitForArchiveIdle(180_000);
    const rerunSha = sha256File(extracted);
    assert.equal(rerunSha, sourceSha, "rerun extraction is not byte-identical");
    assert.deepEqual(
      findLeftovers(ROOT).filter((name) => name.startsWith(".zinnia-")),
      [],
    );

    writeEvidence(EVIDENCE_DIR, "cancel-extract", {
      scenario: "cancel-extract",
      archiveBytes: BIG_BYTES,
      bytesWrittenAtCancel: bytesAtCancel,
      cancelled: true,
      destinationAfterCancel: null,
      rerunSha256: rerunSha,
      sourceSha256: sourceSha,
      matched: rerunSha === sourceSha,
    });
  });
});
