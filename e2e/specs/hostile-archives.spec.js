import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  startPowerExtract,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  treeManifest,
  writeEvidence,
} from "../helpers/recovery-harness.js";
import { buildStoredZip, buildUstarTar } from "../helpers/archive-writers.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const ROOT = path.join(process.env.ZINNIA_E2E_WORK, "hostile");
const OUTSIDE = path.join(ROOT, "outside");
const SECRET = path.join(OUTSIDE, "secret.txt");
const SECRET_TEXT = "outside-secret\n";
const PWNED = "pwned\n";

/**
 * Every case must leave the sandbox exactly as it was, create no destination,
 * leave no stage behind, and report a failure in the UI.
 *
 * `blockedBy` records which layer stopped the archive:
 * - "zinnia-preflight": Zinnia's member preflight rejects it with its own
 *   "unsafe" message, named by `expectedFragment`.
 * - "7zip-refusal": 7-Zip's `-slt` listing carries no link field for this
 *   member, so Zinnia's preflight passes it and 7-Zip refuses the write.
 *   See the skipped test at the end of this file.
 */
const CASES = [
  {
    id: "traversal-zip",
    file: "traversal.zip",
    blockedBy: "zinnia-preflight",
    expectedFragment: "escape-traversal.txt",
    bytes: () =>
      buildStoredZip([{ name: "../escape-traversal.txt", data: PWNED }]),
  },
  {
    id: "absolute-zip",
    file: "absolute.zip",
    blockedBy: "zinnia-preflight",
    expectedFragment: "escape-absolute.txt",
    bytes: () =>
      buildStoredZip([
        { name: path.join(OUTSIDE, "escape-absolute.txt"), data: PWNED },
      ]),
  },
  {
    id: "symlink-absolute-zip",
    file: "symlink-absolute.zip",
    blockedBy: "7zip-refusal",
    bytes: () =>
      buildStoredZip([
        { name: "linkdir", symlinkTarget: OUTSIDE },
        { name: "linkdir/escape-symlink.txt", data: PWNED },
      ]),
  },
  {
    id: "symlink-relative-zip",
    file: "symlink-relative.zip",
    blockedBy: "7zip-refusal",
    bytes: () =>
      buildStoredZip([
        { name: "nest/esc", symlinkTarget: "../../../outside" },
        { name: "nest/esc/escape-relative.txt", data: PWNED },
      ]),
  },
  {
    id: "hardlink-absolute-tar",
    file: "hardlink-absolute.tar",
    blockedBy: "zinnia-preflight",
    expectedFragment: "secret.txt",
    bytes: () =>
      buildUstarTar([{ name: "hard", typeflag: "1", linkname: SECRET }]),
  },
  {
    id: "hardlink-relative-tar",
    file: "hardlink-relative.tar",
    blockedBy: "zinnia-preflight",
    expectedFragment: "../../outside/secret.txt",
    bytes: () =>
      buildUstarTar([
        {
          name: "hardrel",
          typeflag: "1",
          linkname: "../../outside/secret.txt",
        },
      ]),
  },
];

// Any failure the UI reports for an attempt, whether Zinnia's or 7-Zip's.
const FAILURE =
  /unsafe|could escape|escape the extract|Operation failed|Dangerous link path|Cannot open output file/i;
const SEVENZIP_REFUSAL =
  /Dangerous link path was ignored|Cannot open output file/;

/** Every visible UI text line: status, toasts, banner, and the full log. */
async function uiLines() {
  return browser.execute(() => [
    document.getElementById("status")?.textContent ?? "",
    ...[...document.querySelectorAll(".toast-message")].map(
      (toast) => toast.textContent ?? "",
    ),
    document.getElementById("startup-recovery-banner-text")?.textContent ?? "",
    ...(document.getElementById("log")?.textContent ?? "").split("\n"),
  ]);
}

/**
 * Failure lines for this attempt only. The log keeps earlier attempts, so a
 * line already on screen before the attempt never counts as this attempt.
 */
function freshFailures(lines, before) {
  return lines.filter(
    (line) => line.trim() && FAILURE.test(line) && !before.has(line),
  );
}

describe("hostile archives", () => {
  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(OUTSIDE, { recursive: true });
    fs.writeFileSync(SECRET, SECRET_TEXT);
  });

  for (const testCase of CASES) {
    it(`rejects ${testCase.id} without writing outside its destination`, async () => {
      const archive = path.join(ROOT, testCase.file);
      fs.writeFileSync(archive, testCase.bytes());
      const listing = run7z(
        requireHostSidecar(),
        ["l", "-slt", "--", archive],
        {
          allowFailure: true,
        },
      );
      const caseDir = path.join(ROOT, testCase.id);
      fs.mkdirSync(caseDir, { recursive: true });
      const dest = path.join(caseDir, "out");

      const sandboxBefore = treeManifest(ROOT);
      const linesBefore = new Set(await uiLines());
      await startPowerExtract(archive, dest);
      await browser
        .waitUntil(
          async () =>
            fs.existsSync(dest) ||
            freshFailures(await uiLines(), linesBefore).length > 0,
          { timeout: 60_000, interval: 200 },
        )
        .catch(async () => {
          const newLines = (await uiLines()).filter(
            (line) => line.trim() && !linesBefore.has(line),
          );
          throw new Error(
            `${testCase.id}: neither a failure nor a destination appeared; new UI lines: ${JSON.stringify(newLines.slice(-8))}`,
          );
        });
      await waitForArchiveIdle();
      const failures = freshFailures(await uiLines(), linesBefore);
      const sandboxAfter = treeManifest(ROOT);

      assert.ok(
        failures.length > 0,
        `${testCase.id} produced no new failure line`,
      );
      if (testCase.blockedBy === "zinnia-preflight") {
        assert.ok(
          failures.some((line) => line.includes(testCase.expectedFragment)),
          `${testCase.id} was not rejected by Zinnia's preflight naming ${testCase.expectedFragment}: ${JSON.stringify(failures)}`,
        );
      } else {
        assert.ok(
          failures.some((line) => SEVENZIP_REFUSAL.test(line)),
          `${testCase.id} was not refused by 7-Zip: ${JSON.stringify(failures)}`,
        );
      }
      assert.equal(
        fs.existsSync(dest),
        false,
        `${testCase.id} created its destination`,
      );
      assert.deepEqual(
        sandboxAfter,
        sandboxBefore,
        `${testCase.id} changed the sandbox outside its destination`,
      );
      assert.equal(fs.readFileSync(SECRET, "utf8"), SECRET_TEXT);
      assert.deepEqual(
        findLeftovers(ROOT),
        [],
        `${testCase.id} left stage files`,
      );

      writeEvidence(EVIDENCE_DIR, `hostile-${testCase.id}`, {
        scenario: `hostile-${testCase.id}`,
        archive: testCase.file,
        blockedBy: testCase.blockedBy,
        sidecarListingExit: listing.code,
        listingReportsMembers: /Path = /.test(listing.stdout),
        listingReportsLinkFields: /Symbolic Link =|Hard Link =/.test(
          listing.stdout,
        ),
        failureLines: failures.slice(-4),
        destinationCreated: fs.existsSync(dest),
        sandboxEntriesBefore: sandboxBefore.length,
        sandboxEntriesAfter: sandboxAfter.length,
        leftoverStageFiles: findLeftovers(ROOT),
      });
    });
  }

  // ZIP symlink targets live in member data, so `7z l -slt` shows only a Unix
  // `l` mode in `Attributes` and the listing preflight cannot judge the target.
  // The preflight flags such members as links (keeping link-bearing staging and
  // full scans); the target itself is refused by 7-Zip `-snld10` and the
  // staged-tree validation, which the two symlink cases above prove end to end.
});
