import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  hardenFixture7zArgs,
  requireHostSidecar,
  run7z,
} from "../../scripts/archive-fixtures.js";
import {
  openBrowseArchive,
  startPowerExtract,
  toastTexts,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-listing");
const sidecar = requireHostSidecar();

const BROWSE_ENTRIES = 40_000;
// 110,000 entries exposed a pre-existing superlinear slowdown (see failure inventory).
const EXTRACT_ENTRIES = 30_000;

/** Write `count` tiny flat files. Kept to one line of work per file. */
function writeFlatFiles(dir, count, prefix) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    fs.writeFileSync(
      path.join(dir, `${prefix}-${String(index).padStart(6, "0")}.txt`),
      `entry ${index}\n`,
    );
  }
}

/** Store (no compression) keeps fixture generation fast for 100k+ members. */
function createStoredZip(sourceDir, archive) {
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-tzip", "-mx=0", archive, "*"], {
    cwd: sourceDir,
    timeout: 900_000,
  });
}

/** Text of the first-page notice row; empty until the table has rendered. */
async function pageNoticeText() {
  return browser.execute(
    () =>
      document.querySelector("#browse-tbody .browse-empty")?.textContent ?? "",
  );
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
}

describe("archive listing limits", function () {
  this.timeout(30 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("browses a ZIP with 40,000 entries and loads the full listing", async () => {
    const source = path.join(ROOT, "browse-src");
    writeFlatFiles(source, BROWSE_ENTRIES, "browse");
    const archive = path.join(ROOT, "browse-40k.zip");
    createStoredZip(source, archive);

    // The table renders only the first page of rows, so wait for a first-page
    // member and for the summary that reports the full entry count.
    const firstMember = "browse-000001.txt";
    const fullCountText = `of ${BROWSE_ENTRIES.toLocaleString("en-US")} entries`;
    const started = Date.now();
    await openBrowseArchive(archive, firstMember, 240_000);
    await browser.waitUntil(
      async () => (await pageNoticeText()).includes(fullCountText),
      {
        timeout: 240_000,
        interval: 250,
        timeoutMsg: `browse table never reported ${fullCountText}; ${await uiDiagnostics()}`,
      },
    );
    const elapsedMs = Date.now() - started;
    const summary = await $("#browse-summary").getText();
    const pageNotice = await pageNoticeText();

    const toasts = await toastTexts();
    assert.ok(
      !toasts.some(
        (text) =>
          text.includes("too many entries") ||
          text.includes("safe output limit"),
      ),
      `browse reported the listing as too large; ${await uiDiagnostics()}`,
    );

    // run7z keeps spawnSync's 1 MB default buffer, too small for a 40,000-entry listing.
    const listing = spawnSync(
      sidecar,
      hardenFixture7zArgs(["l", "-slt", "-ba", "--", archive]),
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true },
    );
    assert.equal(listing.status, 0, listing.stderr);
    const listed = listing.stdout;
    const memberCount = (listed.match(/^Path = /gm) ?? []).length;
    assert.equal(memberCount, BROWSE_ENTRIES);

    writeEvidence(EVIDENCE_DIR, "audit-listing-browse-40k", {
      scenario: "browse-40k-zip",
      entries: BROWSE_ENTRIES,
      firstMember,
      browseSummary: summary,
      pageNotice,
      browseMs: elapsedMs,
      listingBytes: Buffer.byteLength(listed, "utf8"),
      toastCount: toasts.length,
      listedMemberCount: memberCount,
    });
    await waitForArchiveIdle();
  });

  it("extracts a ZIP with 30,000 small entries end to end", async () => {
    const source = path.join(ROOT, "extract-src");
    writeFlatFiles(source, EXTRACT_ENTRIES, "extract");
    const archive = path.join(ROOT, "extract-30k.zip");
    createStoredZip(source, archive);

    const dest = path.join(ROOT, "extract-30k-out");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const lastFile = `extract-${String(EXTRACT_ENTRIES).padStart(6, "0")}.txt`;

    const started = Date.now();
    await startPowerExtract(archive, dest);
    await browser.waitUntil(() => fs.existsSync(path.join(dest, lastFile)), {
      timeout: 20 * 60_000,
      interval: 500,
      timeoutMsg: `extract did not publish ${lastFile}; ${await uiDiagnostics()}`,
    });
    const extractMs = Date.now() - started;
    await waitForArchiveIdle(10 * 60_000);

    const published = countFiles(dest);
    assert.equal(published, EXTRACT_ENTRIES);

    writeEvidence(EVIDENCE_DIR, "audit-listing-extract-30k", {
      scenario: "extract-30k-zip",
      entries: EXTRACT_ENTRIES,
      publishedFiles: published,
      lastFile,
      extractMs,
    });
  });
});
