import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  flushPendingSettingsWrites,
  expandSelectiveFolder,
  confirmSelectiveExtract,
  hasSelectiveMember,
  openBrowseArchive,
  openSelectiveExtractPicker,
  reloadMainWindow,
  setInputValue,
  toggleSelectiveMember,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { updateE2eSettings } from "../helpers/profile.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-picker");
const sidecar = requireHostSidecar();

// Matches MAX_LOG_LINES in src/utils.ts.
const ACTIVITY_LOG_CAP = 1000;
const LOG_PROBE_CALLS = 5_500;
const LOG_PROBE_CHUNK = 500;

const BIG_ITEM_COUNT = 3000;
const BIG_FOLDER_COUNT = 30;
const BULK_FILE_COUNT = 2000;
const BULK_FOLDER_COUNT = 20;
const OTHER_FILE_COUNT = 500;

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function e2eProfileDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("E2E profile home env is missing");
  return path.dirname(home);
}

function listFilesRecursive(root, base = root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

/** 3,000 files in 30 nested folders, plus a small folder for sort order. */
function buildBigArchive() {
  const tree = path.join(ROOT, "big-src");
  mkdirFresh(tree);
  for (let i = 0; i < BIG_ITEM_COUNT; i += 1) {
    const dir = path.join(tree, "lib", `g${pad(i % BIG_FOLDER_COUNT, 2)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `item-${pad(i, 4)}.txt`), `item ${i}\n`);
  }
  const sortDir = path.join(tree, "sort");
  fs.mkdirSync(sortDir, { recursive: true });
  for (const name of ["file10.txt", "file2.txt", "file1.txt"]) {
    fs.writeFileSync(path.join(sortDir, name), `${name}\n`);
  }
  const archive = path.join(ROOT, "big.7z");
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-t7z", archive, "lib", "sort"], { cwd: tree });
  return archive;
}

/** 2,000 files under `bulk/` and 500 unrelated files under `other/`. */
function buildBulkArchive() {
  const tree = path.join(ROOT, "bulk-src");
  mkdirFresh(tree);
  for (let i = 0; i < BULK_FILE_COUNT; i += 1) {
    const dir = path.join(
      tree,
      "bulk",
      `part-${pad(i % BULK_FOLDER_COUNT, 2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f-${pad(i, 4)}.txt`), `bulk ${i}\n`);
  }
  const otherDir = path.join(tree, "other");
  fs.mkdirSync(otherDir, { recursive: true });
  for (let i = 0; i < OTHER_FILE_COUNT; i += 1) {
    fs.writeFileSync(path.join(otherDir, `o-${pad(i, 4)}.txt`), `other ${i}\n`);
  }
  const archive = path.join(ROOT, "bulk.7z");
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-t7z", archive, "bulk", "other"], { cwd: tree });
  return archive;
}

async function flatRowExists(memberPath) {
  return browser.execute((target) => {
    const normalized = target.replace(/\\/g, "/");
    return Array.from(document.querySelectorAll("[data-member-path]")).some(
      (candidate) =>
        candidate.dataset.memberPath.replace(/\\/g, "/") === normalized,
    );
  }, memberPath);
}

describe("audit picker", function () {
  this.timeout(10 * 60_000);

  let bigArchive;
  let bulkArchive;

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
    bigArchive = buildBigArchive();
    bulkArchive = buildBulkArchive();
  });

  after(async () => {
    await flushPendingSettingsWrites().catch(() => undefined);
    updateE2eSettings(e2eProfileDir(), { logVerbosity: "info" });
    await browser
      .execute(() => {
        document.getElementById("clear-inputs")?.click();
      })
      .catch(() => undefined);
    await reloadMainWindow().catch(() => undefined);
  });

  it("keeps focus on the same search result after toggling it", async () => {
    const target = "lib/g04/item-1234.txt";
    await openBrowseArchive(bigArchive, "item-0000.txt");
    await openSelectiveExtractPicker();
    await setInputValue("#selective-search", "item-1234");
    await browser.waitUntil(() => flatRowExists(target), {
      timeout: 10_000,
      timeoutMsg: `search did not show ${target}; ${await uiDiagnostics()}`,
    });

    // Local macOS runs are backgrounded, so the window never gets OS key
    // events (hasFocus() is false). Focus the row by script and toggle it with
    // the checkbox's own click, which runs the same change handler as Space.
    await browser.execute((memberPath) => {
      const row = Array.from(
        document.querySelectorAll("[data-member-path]"),
      ).find(
        (candidate) =>
          candidate.dataset.memberPath.replace(/\\/g, "/") ===
          memberPath.replace(/\\/g, "/"),
      );
      const box = row?.querySelector('input[type="checkbox"]');
      box?.focus();
      box?.click();
    }, target);

    // Check the toggle itself first, so a failure here means the change was
    // not applied rather than a focus problem.
    const toggled = await browser.waitUntil(
      () =>
        browser.execute((memberPath) => {
          const row = Array.from(
            document.querySelectorAll("[data-member-path]"),
          ).find(
            (candidate) =>
              candidate.dataset.memberPath.replace(/\\/g, "/") ===
              memberPath.replace(/\\/g, "/"),
          );
          const box = row?.querySelector('input[type="checkbox"]');
          return box instanceof HTMLInputElement && box.checked ? true : null;
        }, target),
      {
        timeout: 10_000,
        interval: 200,
        timeoutMsg: `toggle did not apply to ${target}; ${await browser.execute(() => JSON.stringify({ hasFocus: document.hasFocus(), active: document.activeElement?.tagName ?? null }))}`,
      },
    );
    assert.equal(toggled, true);
    // Give any deferred re-render a chance to run before reading focus.
    await browser.pause(300);

    const focus = await browser.execute(() => {
      const active = document.activeElement;
      const row = active?.closest("[data-member-path]");
      return {
        tag: active?.tagName ?? null,
        checked: active instanceof HTMLInputElement ? active.checked : null,
        memberPath: row?.dataset.memberPath ?? null,
      };
    });
    assert.equal(
      focus.memberPath?.replace(/\\/g, "/") ?? null,
      target,
      `focus left the toggled row; ${JSON.stringify(focus)}`,
    );
    assert.equal(focus.tag, "INPUT", "focus must stay on the row checkbox");
    assert.equal(focus.checked, true);

    writeEvidence(EVIDENCE_DIR, "audit-picker-search-focus", {
      scenario: "audit-picker-search-focus",
      archive: bigArchive,
      searchQuery: "item-1234",
      toggled: target,
      focus,
      listedFiles: BIG_ITEM_COUNT,
    });

    await browser.execute(() => {
      document.getElementById("selective-cancel")?.click();
    });
  });

  it("extracts exactly the files under a folder toggled while collapsed", async () => {
    const dest = path.join(ROOT, "bulk-out");
    mkdirFresh(dest);
    await openBrowseArchive(bulkArchive, "f-0000.txt");
    await openSelectiveExtractPicker();
    await toggleSelectiveMember("bulk");
    await confirmSelectiveExtract(dest);

    await browser.waitUntil(
      () => listFilesRecursive(dest).length >= BULK_FILE_COUNT,
      {
        timeout: 180_000,
        timeoutMsg: `bulk extract did not publish ${BULK_FILE_COUNT} files; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();

    const files = listFilesRecursive(dest);
    const expected = [];
    for (let i = 0; i < BULK_FILE_COUNT; i += 1) {
      expected.push(
        `bulk/part-${pad(i % BULK_FOLDER_COUNT, 2)}/f-${pad(i, 4)}.txt`,
      );
    }
    assert.deepEqual(files, expected.sort());
    assert.equal(
      fs.existsSync(path.join(dest, "other")),
      false,
      "unselected folder other/ was extracted",
    );

    writeEvidence(EVIDENCE_DIR, "audit-picker-folder-extract", {
      scenario: "audit-picker-folder-extract",
      archive: bulkArchive,
      selected: ["bulk/"],
      extractedFileCount: files.length,
      destination: dest,
    });
  });

  it("sorts numbered names naturally so file2.txt comes before file10.txt", async () => {
    await openBrowseArchive(bigArchive, "item-0000.txt");
    await openSelectiveExtractPicker();
    await expandSelectiveFolder("sort");
    await browser.waitUntil(() => hasSelectiveMember("sort/file1.txt"), {
      timeout: 10_000,
      timeoutMsg: "selective tree did not show sort/file1.txt",
    });

    const order = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-member-path]"))
        .map((row) => row.dataset.memberPath.replace(/\\/g, "/"))
        .filter((memberPath) => memberPath.startsWith("sort/")),
    );
    assert.deepEqual(order, [
      "sort/file1.txt",
      "sort/file2.txt",
      "sort/file10.txt",
    ]);

    writeEvidence(EVIDENCE_DIR, "audit-picker-natural-sort", {
      scenario: "audit-picker-natural-sort",
      archive: bigArchive,
      order,
    });

    await browser.execute(() => {
      document.getElementById("selective-cancel")?.click();
    });
  });

  it("keeps the activity log working past 5,000 lines and caps it", async () => {
    const profileDir = e2eProfileDir();
    await flushPendingSettingsWrites();
    // Debug verbosity makes each probe write one activity line through devLog.
    updateE2eSettings(profileDir, { logVerbosity: "debug" });
    await reloadMainWindow();
    await waitForE2eHook();

    // Each compress handoff of an already-listed path logs one debug line and
    // renders a one-item input list, so the probe stays cheap.
    const chunks = LOG_PROBE_CALLS / LOG_PROBE_CHUNK;
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const error = await browser.executeAsync((count, done) => {
        (async () => {
          for (let i = 0; i < count; i += 1) {
            await window.__ZINNIA_E2E__.applyIncomingPaths(
              ["e2e-log-probe"],
              "compress",
            );
          }
        })().then(
          () => done(null),
          (err) => done(err instanceof Error ? err.message : String(err)),
        );
      }, LOG_PROBE_CHUNK);
      assert.equal(error, null, `log probe chunk ${chunk} failed: ${error}`);
    }

    // A distinct final line proves the log still accepts writes after the cap.
    const finalError = await browser.executeAsync((done) => {
      window.__ZINNIA_E2E__
        .applyIncomingPaths(
          ["e2e-log-probe", "e2e-log-probe-2", "e2e-log-probe-3"],
          "compress",
        )
        .then(
          () => done(null),
          (err) => done(err instanceof Error ? err.message : String(err)),
        );
    });
    assert.equal(finalError, null, `final log probe failed: ${finalError}`);

    const lines = await browser.execute(() =>
      (document.getElementById("log")?.textContent ?? "")
        .split("\n")
        .filter((line) => line.length > 0),
    );
    assert.equal(
      lines.length,
      ACTIVITY_LOG_CAP,
      `activity log must hold exactly ${ACTIVITY_LOG_CAP} lines after ${LOG_PROBE_CALLS} writes`,
    );
    assert.match(lines.at(-1), /Received 3 path\(s\) from e2e\./);
    assert.match(lines[0], /Received \d+ path\(s\) from e2e\./);

    writeEvidence(EVIDENCE_DIR, "audit-picker-log-cap", {
      scenario: "audit-picker-log-cap",
      probeWrites: LOG_PROBE_CALLS + 1,
      visibleLines: lines.length,
      cap: ACTIVITY_LOG_CAP,
      lastLine: lines.at(-1),
    });
  });
});
