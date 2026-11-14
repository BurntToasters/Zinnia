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
import { buildStoredZip } from "../helpers/archive-writers.js";
import {
  applyIncomingPaths,
  hasSelectiveMember,
  openBasicBrowseForArchive,
  openSelectiveExtractPicker,
  setInputValue,
  switchToPowerWorkspace,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-fe-large-listing");
const sidecar = requireHostSidecar();

const BROWSE_FOLDERS = 200;
const FILES_PER_FOLDER = 200;
const FILE_COUNT = BROWSE_FOLDERS * FILES_PER_FOLDER;
const BROWSE_PAGE = 1_000;
const CLICK_BOUND_MS = 1_500;
const FOLDER = "dir-000";
const REMOVE_INDEX = 250;
const INPUT_COUNT = 500;
const PROBE_WINDOW_MS = 5_000;
const RENDER_BOUND_MS = 1_500;

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function folderName(index) {
  return `dir-${pad(index, 3)}`;
}

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeFolderTree(dir) {
  mkdirFresh(dir);
  for (let folder = 0; folder < BROWSE_FOLDERS; folder += 1) {
    const folderDir = path.join(dir, folderName(folder));
    fs.mkdirSync(folderDir, { recursive: true });
    for (let file = 0; file < FILES_PER_FOLDER; file += 1) {
      const index = folder * FILES_PER_FOLDER + file + 1;
      fs.writeFileSync(
        path.join(folderDir, `f-${pad(index, 6)}.txt`),
        `entry ${index}\n`,
      );
    }
  }
}

function buildLargeArchive() {
  const source = path.join(ROOT, "large-src");
  writeFolderTree(source);
  const archive = path.join(ROOT, "large-40k.zip");
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-tzip", "-mx=0", archive, "*"], {
    cwd: source,
    timeout: 900_000,
  });
  return archive;
}

function countListedMembers(archive) {
  const listing = spawnSync(
    sidecar,
    hardenFixture7zArgs(["l", "-slt", "-ba", "--", archive]),
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true },
  );
  assert.equal(listing.status, 0, listing.stderr);
  return (listing.stdout.match(/^Path = /gm) ?? []).length;
}

function writeEmptyZip(file) {
  fs.writeFileSync(file, buildStoredZip([]));
  return file;
}

async function openPowerBrowse(archive, fileCount) {
  await switchToPowerWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
  await applyIncomingPaths([archive], "");
  await browser.waitUntil(
    async () =>
      browser.execute((count) => {
        const pattern = new RegExp(`(^|\\D)${count} files?\\b`);
        const summary = document.getElementById("browse-summary");
        return pattern.test(summary?.textContent ?? "");
      }, fileCount),
    {
      timeout: 240_000,
      interval: 250,
      timeoutMsg: `browse never reported ${fileCount} files; ${await uiDiagnostics()}`,
    },
  );
  await waitForArchiveIdle();
}

async function tableState(tbodyId) {
  return browser.execute((id) => {
    const tbody = document.getElementById(id);
    if (!tbody) return null;
    const rows = Array.from(tbody.children);
    const dataRows = rows.filter((row) => !row.querySelector(".browse-empty"));
    const button = tbody.querySelector("[data-browse-show-more]");
    const notice = tbody.querySelector("[data-browse-notice]");
    const active = document.activeElement;
    return {
      dataRows: dataRows.length,
      notice: notice ? notice.textContent : null,
      buttonExists: Boolean(button),
      buttonHidden: button ? button.hidden : null,
      lastRowIsNotice: Boolean(rows.at(-1)?.querySelector(".browse-empty")),
      unconvertedIcons: tbody.querySelectorAll("i[data-lucide]").length,
      activeTag: active ? active.tagName : null,
      activeTabIndex: active ? active.tabIndex : null,
      activeIsShowMore: Boolean(
        active && active.hasAttribute("data-browse-show-more"),
      ),
    };
  }, tbodyId);
}

async function clickShowMore(tbodyId) {
  return browser.execute((id) => {
    const button = document.querySelector(`#${id} [data-browse-show-more]`);
    if (!(button instanceof HTMLButtonElement)) {
      return { found: false, focusedBefore: false };
    }
    button.focus();
    const focusedBefore = document.activeElement === button;
    button.click();
    return { found: true, focusedBefore };
  }, tbodyId);
}

async function selectiveEmptyText() {
  return browser.execute(
    () =>
      document.querySelector("#selective-list .selective-empty")?.textContent ??
      "",
  );
}

async function closePicker() {
  await browser.execute(() => {
    document.getElementById("selective-cancel")?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("selective-overlay")?.hidden === true,
      ),
    { timeout: 10_000, timeoutMsg: "selective overlay did not close" },
  );
}

async function waitForInputsResolved(expectedCount) {
  await browser.waitUntil(
    async () =>
      browser.execute((count) => {
        const items = document.querySelectorAll("#input-list .list__item");
        const unknown = document.querySelectorAll(
          "#input-list .list__item-badge--unknown",
        );
        return items.length === count && unknown.length === 0;
      }, expectedCount),
    {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: `inputs did not resolve to ${expectedCount}; ${await uiDiagnostics()}`,
    },
  );
}

describe("beta2 fe large listing", function () {
  this.timeout(30 * 60_000);

  let largeArchive;
  let largeMemberCount;
  let folderArchive;
  let emptyArchive;
  let inputDir;
  let inputPaths;

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    mkdirFresh(ROOT);
    largeArchive = buildLargeArchive();
    largeMemberCount = countListedMembers(largeArchive);
    assert.equal(largeMemberCount >= FILE_COUNT, true);

    folderArchive = path.join(ROOT, "folder-flag.zip");
    fs.writeFileSync(
      folderArchive,
      buildStoredZip([
        { name: "lacking/", data: "", dosAttributes: 0x20 },
        { name: "plain.txt", data: "plain\n" },
      ]),
    );

    emptyArchive = writeEmptyZip(path.join(ROOT, "empty.zip"));

    inputDir = path.join(ROOT, "inputs");
    mkdirFresh(inputDir);
    inputPaths = [];
    for (let index = 1; index <= INPUT_COUNT; index += 1) {
      const file = path.join(inputDir, `input-${pad(index, 4)}.zip`);
      writeEmptyZip(file);
      inputPaths.push(file);
    }
  });

  after(async () => {
    await browser
      .execute(() => {
        document.getElementById("selective-cancel")?.click();
        document.getElementById("clear-inputs")?.click();
      })
      .catch(() => undefined);
    await Promise.resolve()
      .then(() => fs.rmSync(ROOT, { recursive: true, force: true }))
      .catch(() => undefined);
  });

  it("keeps a folder checkbox click and Select all under the bound on 40,200 entries", async () => {
    await openPowerBrowse(largeArchive, FILE_COUNT);
    await openSelectiveExtractPicker();
    await browser.waitUntil(() => hasSelectiveMember(FOLDER), {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: `picker never showed ${FOLDER}; ${await uiDiagnostics()}`,
    });

    const folderClick = await browser.execute((memberPath) => {
      const target = memberPath.replace(/\\/g, "/");
      const row = Array.from(
        document.querySelectorAll("[data-member-path]"),
      ).find(
        (candidate) =>
          candidate.dataset.memberPath.replace(/\\/g, "/") === target,
      );
      const box = row?.querySelector('input[type="checkbox"]');
      if (!(box instanceof HTMLInputElement)) {
        return {
          found: false,
          elapsedMs: -1,
          checked: false,
          indeterminate: true,
        };
      }
      const started = performance.now();
      box.click();
      const elapsedMs = performance.now() - started;
      return {
        found: true,
        elapsedMs,
        checked: box.checked,
        indeterminate: box.indeterminate,
      };
    }, FOLDER);
    assert.equal(folderClick.found, true, `missing picker row for ${FOLDER}`);
    assert.equal(folderClick.checked, true, "folder checkbox did not check");
    assert.equal(folderClick.indeterminate, false);
    assert.ok(
      folderClick.elapsedMs < CLICK_BOUND_MS,
      `folder click took ${folderClick.elapsedMs} ms (bound ${CLICK_BOUND_MS} ms)`,
    );

    const selectAll = await browser.execute(() => {
      const button = document.getElementById("selective-select-all");
      if (!(button instanceof HTMLButtonElement)) {
        return { found: false, elapsedMs: -1, selected: -1, summary: "" };
      }
      const started = performance.now();
      button.click();
      const elapsedMs = performance.now() - started;
      const summary =
        document.getElementById("selective-summary")?.textContent ?? "";
      const match = summary.match(/^(\d+) selected/);
      return {
        found: true,
        elapsedMs,
        selected: match ? Number(match[1]) : -1,
        summary,
      };
    });
    assert.equal(selectAll.found, true, "Select all button missing");
    assert.ok(
      selectAll.elapsedMs < CLICK_BOUND_MS,
      `Select all took ${selectAll.elapsedMs} ms (bound ${CLICK_BOUND_MS} ms)`,
    );
    assert.equal(
      selectAll.selected,
      largeMemberCount,
      `Select all selected ${selectAll.selected}, listing has ${largeMemberCount}; ${selectAll.summary}`,
    );

    const folderAfterSelectAll = await browser.execute((memberPath) => {
      const target = memberPath.replace(/\\/g, "/");
      const row = Array.from(
        document.querySelectorAll("[data-member-path]"),
      ).find(
        (candidate) =>
          candidate.dataset.memberPath.replace(/\\/g, "/") === target,
      );
      const box = row?.querySelector('input[type="checkbox"]');
      return box instanceof HTMLInputElement
        ? { checked: box.checked, indeterminate: box.indeterminate }
        : null;
    }, FOLDER);
    assert.deepEqual(folderAfterSelectAll, {
      checked: true,
      indeterminate: false,
    });

    const selectNone = await browser.execute(() => {
      const button = document.getElementById("selective-clear");
      const started = performance.now();
      button?.click();
      const elapsedMs = performance.now() - started;
      const summary =
        document.getElementById("selective-summary")?.textContent ?? "";
      return { elapsedMs, summary };
    });
    assert.ok(selectNone.summary.startsWith("0 selected"), selectNone.summary);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-large-listing-picker-timing", {
      scenario: "picker-folder-click-and-select-all",
      entries: largeMemberCount,
      folders: BROWSE_FOLDERS,
      boundMs: CLICK_BOUND_MS,
      folderClickMs: Number(folderClick.elapsedMs.toFixed(2)),
      selectAllMs: Number(selectAll.elapsedMs.toFixed(2)),
      selectNoneMs: Number(selectNone.elapsedMs.toFixed(2)),
      selectedAfterSelectAll: selectAll.selected,
      folderCheckedAfterSelectAll: folderAfterSelectAll.checked,
    });

    await closePicker();
  });

  it("appends 1,000 rows per Show 1,000 more click in Power Browse", async () => {
    await openPowerBrowse(largeArchive, FILE_COUNT);
    const total = largeMemberCount.toLocaleString("en-US");

    const initial = await tableState("browse-tbody");
    assert.equal(initial.dataRows, BROWSE_PAGE);
    assert.equal(
      initial.notice,
      `Showing the first 1,000 of ${total} entries. Use selective extraction search to find other entries.`,
    );
    assert.equal(initial.buttonHidden, false);
    assert.equal(initial.lastRowIsNotice, true);

    const firstClick = await clickShowMore("browse-tbody");
    assert.equal(firstClick.found, true, "Show 1,000 more button missing");
    assert.equal(firstClick.focusedBefore, true, "button did not take focus");
    const second = await tableState("browse-tbody");
    assert.equal(second.dataRows, 2 * BROWSE_PAGE);
    assert.equal(
      second.notice,
      `Showing the first 2,000 of ${total} entries. Use selective extraction search to find other entries.`,
    );
    assert.equal(second.activeIsShowMore, true, "focus left the button");
    assert.equal(second.lastRowIsNotice, true);
    assert.equal(second.unconvertedIcons, 0);

    await browser.execute(() => {
      const button = document.querySelector(
        "#browse-tbody [data-browse-show-more]",
      );
      for (let step = 0; step < 100 && button && !button.hidden; step += 1) {
        button.click();
      }
    });
    const final = await tableState("browse-tbody");
    assert.equal(
      final.dataRows,
      largeMemberCount,
      "not every row was appended",
    );
    assert.equal(final.buttonHidden, true);
    assert.equal(final.notice, `Showing all ${total} entries.`);
    assert.equal(final.unconvertedIcons, 0);
    assert.equal(final.activeTag, "TR", "focus did not move to a new row");
    assert.equal(final.activeTabIndex, -1);
    assert.equal(final.lastRowIsNotice, true);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-large-listing-show-more-power", {
      scenario: "power-show-1000-more",
      entries: largeMemberCount,
      pageSize: BROWSE_PAGE,
      rowsAfterFirstClick: second.dataRows,
      noticeAfterFirstClick: second.notice,
      rowsAtEnd: final.dataRows,
      noticeAtEnd: final.notice,
      focusAfterFirstClick: second.activeTag,
      focusAtEnd: final.activeTag,
    });
  });

  it("appends 1,000 rows per Show 1,000 more click in Basic Browse", async () => {
    await openBasicBrowseForArchive(largeArchive);
    await browser.waitUntil(
      async () => Boolean((await tableState("basic-browse-tbody"))?.notice),
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: `basic browse notice never rendered; ${await uiDiagnostics()}`,
      },
    );
    const total = largeMemberCount.toLocaleString("en-US");

    const initial = await tableState("basic-browse-tbody");
    assert.equal(initial.dataRows, BROWSE_PAGE);
    assert.equal(
      initial.notice,
      `Showing the first 1,000 of ${total} entries.`,
    );

    const click = await clickShowMore("basic-browse-tbody");
    assert.equal(click.found, true, "Basic Show 1,000 more button missing");
    const after = await tableState("basic-browse-tbody");
    assert.equal(after.dataRows, 2 * BROWSE_PAGE);
    assert.equal(after.notice, `Showing the first 2,000 of ${total} entries.`);
    assert.equal(after.lastRowIsNotice, true);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-large-listing-show-more-basic", {
      scenario: "basic-show-1000-more",
      entries: largeMemberCount,
      rowsAfterClick: after.dataRows,
      noticeAfterClick: after.notice,
    });
  });

  it("shows a ZIP folder without the directory bit as a folder in Browse and the picker", async () => {
    await openPowerBrowse(folderArchive, 1);

    const browseRow = await browser.execute(() => {
      const row = Array.from(
        document.querySelectorAll("#browse-tbody tr"),
      ).find((candidate) => candidate.textContent.includes("lacking"));
      return row ? { className: row.className } : null;
    });
    assert.ok(browseRow, "Browse did not list the folder entry");
    assert.ok(
      browseRow.className.includes("is-folder"),
      `folder entry rendered as a file: ${browseRow.className}`,
    );
    const noButton = await tableState("browse-tbody");
    assert.equal(
      noButton.buttonExists,
      false,
      "small listing must not show the button",
    );

    await openSelectiveExtractPicker();
    await browser.waitUntil(() => hasSelectiveMember("lacking"), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "picker did not show the lacking folder",
    });
    const pickerMeta = await browser.execute(() => {
      const row = Array.from(
        document.querySelectorAll("[data-member-path]"),
      ).find((candidate) => candidate.dataset.memberPath === "lacking");
      return row?.querySelector(".selective-row__meta")?.textContent ?? null;
    });
    assert.equal(pickerMeta, "Folder");

    writeEvidence(EVIDENCE_DIR, "beta2-fe-large-listing-folder-flag", {
      scenario: "zip-folder-without-dir-bit",
      browseClassName: browseRow.className,
      pickerMeta,
      buttonExists: noButton.buttonExists,
    });
    await closePicker();
  });

  it("shows the matching picker message for an empty search and an empty archive", async () => {
    await openPowerBrowse(largeArchive, FILE_COUNT);
    await openSelectiveExtractPicker();
    await setInputValue("#selective-search", "no-such-entry-zz");
    await browser.waitUntil(
      async () =>
        (await selectiveEmptyText()) === "No entries match your search.",
      {
        timeout: 20_000,
        interval: 200,
        timeoutMsg: `search message was "${await selectiveEmptyText()}"`,
      },
    );
    const searchMessage = await selectiveEmptyText();
    await closePicker();

    await openPowerBrowse(emptyArchive, 0);
    const emptyBrowse = await browser.execute(
      () =>
        document.querySelector("#browse-tbody .browse-empty")?.textContent ??
        "",
    );
    assert.equal(emptyBrowse, "Archive is empty.");
    await openSelectiveExtractPicker();
    await browser.waitUntil(
      async () =>
        (await selectiveEmptyText()) === "This archive has no entries.",
      {
        timeout: 20_000,
        interval: 200,
        timeoutMsg: `archive message was "${await selectiveEmptyText()}"`,
      },
    );
    const archiveMessage = await selectiveEmptyText();
    await closePicker();

    writeEvidence(EVIDENCE_DIR, "beta2-fe-large-listing-picker-empty", {
      scenario: "picker-empty-messages",
      searchMessage,
      archiveMessage,
    });
  });

  it("removes one of 500 extract inputs without rebuilding the list after a validation round trip", async () => {
    await switchToPowerWorkspace();
    await waitForArchiveIdle();
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await applyIncomingPaths(inputPaths, "extract");
    await waitForInputsResolved(INPUT_COUNT);

    const removal = await browser.execute((index) => {
      const button = document.querySelectorAll(
        "#input-list [data-input-remove]",
      )[index];
      if (!(button instanceof HTMLButtonElement)) {
        return { removed: false, renderMs: -1, items: -1 };
      }
      const started = performance.now();
      button.click();
      const renderMs = performance.now() - started;
      document
        .querySelector("#input-list .list__item")
        ?.setAttribute("data-beta2-probe", "");
      return {
        removed: true,
        renderMs,
        items: document.querySelectorAll("#input-list .list__item").length,
      };
    }, REMOVE_INDEX);
    assert.equal(removal.removed, true, "remove button missing");
    assert.equal(removal.items, INPUT_COUNT - 1);
    assert.ok(
      removal.renderMs < RENDER_BOUND_MS,
      `removal render took ${removal.renderMs} ms (bound ${RENDER_BOUND_MS} ms)`,
    );

    await browser.pause(PROBE_WINDOW_MS);
    const settled = await browser.execute(() => ({
      markerSurvived:
        document.querySelector("#input-list [data-beta2-probe]") !== null,
      items: document.querySelectorAll("#input-list .list__item").length,
      unresolved: document.querySelectorAll(
        "#input-list .list__item-badge--unknown",
      ).length,
    }));
    assert.equal(
      settled.markerSurvived,
      true,
      `input list was rebuilt within ${PROBE_WINDOW_MS} ms of the removal; a validation round trip re-rendered it`,
    );
    assert.equal(settled.items, INPUT_COUNT - 1);
    assert.equal(settled.unresolved, 0, "a remaining input shows Checking");

    const extra = writeEmptyZip(path.join(inputDir, "input-extra.zip"));
    const addOneStarted = Date.now();
    await applyIncomingPaths([extra], "extract");
    await waitForInputsResolved(INPUT_COUNT);
    const addOneSettleMs = Date.now() - addOneStarted;

    writeEvidence(EVIDENCE_DIR, "beta2-fe-large-listing-input-removal", {
      scenario: "remove-one-of-500-inputs",
      inputs: INPUT_COUNT,
      removedIndex: REMOVE_INDEX,
      removeRenderMs: Number(removal.renderMs.toFixed(2)),
      renderBoundMs: RENDER_BOUND_MS,
      validationWindowMs: PROBE_WINDOW_MS,
      listRebuiltWithinWindow: !settled.markerSurvived,
      itemsAfterWindow: settled.items,
      unresolvedBadgesAfterWindow: settled.unresolved,
      addOneSettleMs,
      priorCodeExpectedRevalidatedPaths: INPUT_COUNT - 1,
    });
  });
});
