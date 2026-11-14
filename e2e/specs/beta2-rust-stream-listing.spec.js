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
const ROOT = path.join(WORK, "beta2-rust-stream-listing");
const sidecar = requireHostSidecar();

const MIB = 1024 * 1024;
const BROWSE_LIST_CAP_BYTES = 64 * MIB;
const LONG_NAME_LENGTH = 200;
const LONG_NAME_ENTRIES = 50_000;
const BROWSE_ENTRIES = 250_000;
const DROPPED_LISTING_KEY =
  /^(?:CRC|Created|Accessed|Host OS|Characteristics|Comment|Offset|Volume Index|Version) = /;

/** A member name of exactly `LONG_NAME_LENGTH` characters. */
function longMemberName(index) {
  const base = `long-${String(index).padStart(6, "0")}-`;
  const padding = "x".repeat(LONG_NAME_LENGTH - base.length - ".txt".length);
  return `${base}${padding}.txt`;
}

/** Write `count` empty files named by `nameFor`. */
function writeEmptyFiles(dir, count, nameFor) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    fs.closeSync(fs.openSync(path.join(dir, nameFor(index)), "w"));
  }
}

/** Store (no compression) keeps fixture generation fast for 50k+ members. */
function createStoredZip(sourceDir, archive) {
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-tzip", "-mx=0", archive, "*"], {
    cwd: sourceDir,
    timeout: 900_000,
  });
}

/** Full `l -slt` listing text. run7z keeps spawnSync's 1 MB default buffer, too small here. */
function listingText(args) {
  const listing = spawnSync(sidecar, hardenFixture7zArgs(args), {
    encoding: "utf8",
    maxBuffer: 512 * MIB,
    windowsHide: true,
  });
  assert.equal(listing.status, 0, listing.stderr);
  return listing.stdout;
}

/** The browse listing with the per-entry keys the frontend never reads removed. */
function filteredListingBytes(listed) {
  let inEntries = false;
  let bytes = 0;
  for (const line of listed.split("\n")) {
    if (!inEntries) {
      if (line.replace(/\r$/, "") === "----------") inEntries = true;
    } else if (DROPPED_LISTING_KEY.test(line)) {
      continue;
    }
    bytes += Buffer.byteLength(`${line}\n`, "utf8");
  }
  return bytes;
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
}

/** Text of the first-page notice row; empty until the table has rendered. */
async function pageNoticeText() {
  return browser.execute(
    () =>
      document.querySelector("#browse-tbody .browse-empty")?.textContent ?? "",
  );
}

describe("beta2 rust streamed listing", function () {
  this.timeout(30 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("extracts a ZIP with 200-character member names and publishes every file", async () => {
    const source = path.join(ROOT, "long-names-src");
    writeEmptyFiles(source, LONG_NAME_ENTRIES, longMemberName);
    const archive = path.join(ROOT, "long-names-50k.zip");
    createStoredZip(source, archive);

    const listingStarted = Date.now();
    const listed = listingText(["l", "-slt", "-ba", "--", archive]);
    const listingMs = Date.now() - listingStarted;
    const listedMembers = (listed.match(/^Path = /gm) ?? []).length;
    assert.equal(listedMembers, LONG_NAME_ENTRIES);
    const longestName = Math.max(
      ...(listed.match(/^Path = .*$/gm) ?? []).map((line) => line.length - 7),
    );
    assert.equal(longestName, LONG_NAME_LENGTH);

    const dest = path.join(ROOT, "long-names-out");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const lastFile = longMemberName(LONG_NAME_ENTRIES);

    const started = Date.now();
    await startPowerExtract(archive, dest);
    await browser.waitUntil(() => fs.existsSync(path.join(dest, lastFile)), {
      timeout: 20 * 60_000,
      interval: 500,
      timeoutMsg: `extract did not publish the last long-name member; ${await uiDiagnostics()}`,
    });
    const extractMs = Date.now() - started;
    await waitForArchiveIdle(10 * 60_000);

    const published = countFiles(dest);
    assert.equal(published, LONG_NAME_ENTRIES);

    writeEvidence(EVIDENCE_DIR, "beta2-rust-stream-listing-long-names", {
      scenario: "extract-zip-200-char-names",
      entries: LONG_NAME_ENTRIES,
      memberNameLength: LONG_NAME_LENGTH,
      listingBytes: Buffer.byteLength(listed, "utf8"),
      listingMs,
      publishedFiles: published,
      lastFile,
      extractMs,
    });
  });

  it("browses an archive whose unfiltered listing exceeds 64 MiB and loads the full listing", async () => {
    const source = path.join(ROOT, "browse-src");
    writeEmptyFiles(
      source,
      BROWSE_ENTRIES,
      (index) => `big-${String(index).padStart(6, "0")}.txt`,
    );
    const archive = path.join(ROOT, "browse-250k.zip");
    createStoredZip(source, archive);

    const browseArgs = ["l", "-slt", "-spd", "--", archive];
    const unfiltered = listingText(browseArgs);
    const unfilteredBytes = Buffer.byteLength(unfiltered, "utf8");
    const filteredBytes = filteredListingBytes(unfiltered);
    assert.ok(
      unfilteredBytes > BROWSE_LIST_CAP_BYTES,
      `unfiltered listing is ${unfilteredBytes} bytes, expected over 64 MiB`,
    );
    assert.ok(
      filteredBytes <= BROWSE_LIST_CAP_BYTES,
      `filtered listing is ${filteredBytes} bytes, expected within 64 MiB`,
    );

    const firstMember = "big-000001.txt";
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
    const browseMs = Date.now() - started;
    const summary = await $("#browse-summary").getText();

    const toasts = await toastTexts();
    assert.ok(
      !toasts.some(
        (text) =>
          text.includes("too many entries") ||
          text.includes("safe output limit"),
      ),
      `browse reported the listing as too large; ${await uiDiagnostics()}`,
    );

    writeEvidence(EVIDENCE_DIR, "beta2-rust-stream-listing-browse-filtered", {
      scenario: "browse-zip-unfiltered-over-64-mib",
      entries: BROWSE_ENTRIES,
      unfilteredBytes,
      filteredBytes,
      browseCapBytes: BROWSE_LIST_CAP_BYTES,
      browseSummary: summary,
      browseMs,
      toastCount: toasts.length,
    });
    await waitForArchiveIdle();
  });
});
