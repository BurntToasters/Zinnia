import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  dismissToasts,
  domValue,
  queueDialogResult,
  switchToBasicWorkspace,
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
const ROOT = path.join(WORK, "beta2-basic-destination");
const sidecar = requireHostSidecar();

const RUN_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 30_000;
const BASIC_WINDOW_WIDTH = 500;
const BASIC_WINDOW_HEIGHT = 650;
const SAVE_TO = {
  output: "basic-save-to-path",
  name: "basic-save-to-name",
  label: "basic-save-to-label",
  change: "basic-change-save-location",
  row: "basic-save-to-row",
  run: "basic-run-compress",
};
const EXTRACT_TO = {
  output: "basic-extract-to-path",
  name: "basic-extract-to-name",
  label: "basic-extract-to-label",
  change: "basic-change-extract-folder",
  note: "basic-extract-to-note",
  row: "basic-extract-to-row",
  run: "basic-run-extract",
};

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeSource(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function buildArchive(archive, srcDir, member, content) {
  writeSource(srcDir, member, content);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.rmSync(archive, { force: true });
  run7z(sidecar, ["a", "-t7z", archive, member], { cwd: srcDir });
  return archive;
}

function setBasicFormat(value) {
  return browser.execute((next) => {
    const select = document.getElementById("basic-format");
    if (!select) throw new Error("missing #basic-format");
    select.value = next;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function clearBasicInputs() {
  await switchToBasicWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
  await setBasicFormat("7z");
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
}

async function clickBasicTab(view) {
  await browser.execute((name) => {
    document.getElementById(`basic-tab-${name}`)?.click();
  }, view);
  await waitForBasicView(view);
}

async function waitForBasicView(view) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (name) =>
          document
            .getElementById(`basic-${name}`)
            ?.classList.contains("is-active") ?? false,
        view,
      ),
    {
      timeout: STEP_TIMEOUT_MS,
      timeoutMsg: `Basic ${view} view did not become active`,
    },
  );
}

async function clickById(id) {
  await browser.execute((target) => {
    document.getElementById(target)?.click();
  }, id);
}

function setPowerField(id, value) {
  return browser.execute(
    (target, next) => {
      const field = document.getElementById(target);
      if (!field) throw new Error(`missing #${target}`);
      field.value = next;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    },
    id,
    value,
  );
}

function setPowerSelect(id, value) {
  return browser.execute(
    (target, next) => {
      const select = document.getElementById(target);
      if (!select) throw new Error(`missing #${target}`);
      select.value = next;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    value,
  );
}

function readDestinationRow(ids) {
  return browser.execute((target) => {
    const output = document.getElementById(target.output);
    const label = document.getElementById(target.label);
    const change = document.getElementById(target.change);
    const note = target.note ? document.getElementById(target.note) : null;
    return {
      text: output ? output.textContent : null,
      title: output ? output.getAttribute("title") : null,
      tagName: output ? output.tagName : null,
      labelledBy: output ? output.getAttribute("aria-labelledby") : null,
      labelText: label ? label.textContent.trim() : null,
      changeName: change ? change.getAttribute("aria-label") : null,
      changeDisabled: change ? change.disabled : null,
      noteVisible: note ? !note.hidden : null,
      noteText: note ? note.textContent.trim() : null,
    };
  }, ids);
}

function readHiddenFieldDisplay() {
  return browser.execute(() => {
    const displayOf = (id) => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display : null;
    };
    return {
      nameLocation: displayOf("basic-name-location-section"),
      extractDestination: displayOf("basic-extract-destination-field"),
      extractPassword: displayOf("basic-extract-password-field"),
    };
  });
}

function readLayout(ids) {
  return browser.execute((target) => {
    const rect = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
      };
    };
    const name = document.getElementById(target.name);
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      row: rect(target.row),
      output: rect(target.output),
      run: rect(target.run),
      name: name
        ? {
            text: name.textContent,
            scrollWidth: name.scrollWidth,
            clientWidth: name.clientWidth,
            rect: rect(target.name),
          }
        : null,
    };
  }, ids);
}

async function readCompletionTitle(section) {
  return browser.execute(
    (name) =>
      document
        .getElementById(`basic-${name}-completion-title`)
        ?.textContent?.trim() ?? "",
    section,
  );
}

function fileExists(file) {
  return fs.existsSync(file);
}

function windowInnerSize() {
  return browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

async function setWindowInnerSize(width, height) {
  const error = await browser.executeAsync(
    (nextWidth, nextHeight, done) => {
      window.__TAURI__.core
        .invoke("plugin:window|set_size", {
          value: { Logical: { width: nextWidth, height: nextHeight } },
        })
        .then(() => done(null))
        .catch((err) => done(err instanceof Error ? err.message : String(err)));
    },
    width,
    height,
  );
  if (error) throw new Error(`set_size ${width}x${height} failed: ${error}`);
  try {
    await browser.waitUntil(
      async () => {
        const size = await windowInnerSize();
        return size.width === width && size.height === height;
      },
      { timeout: STEP_TIMEOUT_MS, interval: 100 },
    );
  } catch {
    const actual = await windowInnerSize();
    throw new Error(
      `window inner size is ${actual.width}x${actual.height}, expected ${width}x${height}`,
    );
  }
}

describe("beta 2 Basic destination: Save to and Extract to rows", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await dismissToasts().catch(() => undefined);
  });

  it("Basic Compress shows the derived Save to path and writes the archive exactly there", async () => {
    const started = Date.now();
    const dir = path.join(ROOT, "case-1", "src");
    mkdirFresh(dir);
    const source = writeSource(dir, "report.txt", "report payload\n");
    const expected = path.join(dir, "report.txt.7z");

    await clearBasicInputs();
    await applyIncomingPaths([source], "compress");
    await clickBasicTab("compress");
    const row = await readDestinationRow(SAVE_TO);
    const hiddenDisplay = await readHiddenFieldDisplay();

    assert.equal(row.text, expected, `Save to showed ${row.text}`);
    assert.equal(row.title, expected, "the full path is not in the title");
    assert.equal(row.tagName, "OUTPUT", "the path is not an output element");
    assert.equal(row.labelledBy, SAVE_TO.label);
    assert.equal(row.labelText, "Save to");
    assert.equal(row.changeName, "Change save location");
    assert.equal(row.changeDisabled, false, "Change is disabled with files");
    assert.deepEqual(hiddenDisplay, {
      nameLocation: "none",
      extractDestination: "none",
      extractPassword: "none",
    });

    await clickById(SAVE_TO.run);
    await browser.waitUntil(() => fileExists(expected), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic compress did not write ${expected}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const title = await readCompletionTitle("compress");
    const archivesBeside = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".7z"));

    assert.equal(title, "Archive created");
    assert.deepEqual(archivesBeside, ["report.txt.7z"]);

    writeEvidence(EVIDENCE_DIR, "beta2-basic-destination-compress-save-to", {
      scenario: "compress-save-to-shows-and-writes-derived-path",
      source,
      shownPath: row.text,
      written: expected,
      accessibleLabel: row.labelText,
      changeName: row.changeName,
      hiddenFieldDisplay: hiddenDisplay,
      completionTitle: title,
      durationMs: Date.now() - started,
    });
  });

  it("a stale output path and format typed in Power are not used after switching to Basic", async () => {
    const started = Date.now();
    const dir = path.join(ROOT, "case-2", "src");
    mkdirFresh(dir);
    const source = writeSource(dir, "payload.txt", "stale power payload\n");
    const staleDir = path.join(ROOT, "case-2", "power-typed");
    mkdirFresh(staleDir);
    const stale = path.join(staleDir, "stale.7z");
    const derivedSevenZip = path.join(dir, "payload.txt.7z");
    const expected = path.join(dir, "payload.txt.zip");

    await clearBasicInputs();
    await applyIncomingPaths([source], "compress");
    await clickBasicTab("compress");
    const before = await readDestinationRow(SAVE_TO);

    await switchToPowerWorkspace();
    await setPowerSelect("format", "zip");
    await setPowerField("output-path", stale);
    const powerOutput = await domValue("#output-path");
    await switchToBasicWorkspace();
    await waitForBasicView("compress");
    const after = await readDestinationRow(SAVE_TO);
    const basicFormat = await domValue("#basic-format");

    assert.equal(
      before.text,
      derivedSevenZip,
      "the first derived path is wrong",
    );
    assert.equal(powerOutput, stale, "Power did not hold the typed path");
    assert.equal(basicFormat, "zip", "Basic did not take the Power format");
    assert.equal(
      after.text,
      expected,
      `Save to kept the Power path: ${after.text}`,
    );
    assert.notEqual(after.text, stale, "the stale Power path was shown");

    await clickById(SAVE_TO.run);
    await browser.waitUntil(() => fileExists(expected), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic compress did not write ${expected}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();

    assert.equal(
      fs.existsSync(stale),
      false,
      "the run wrote the stale Power path",
    );
    assert.equal(
      fs.existsSync(derivedSevenZip),
      false,
      "the run wrote the 7z name after the format changed",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-basic-destination-stale-power-path", {
      scenario: "stale-power-output-path-and-format-discarded",
      stalePowerPath: stale,
      shownBeforePower: before.text,
      powerValueBeforeReturn: powerOutput,
      shownAfterReturn: after.text,
      written: expected,
      durationMs: Date.now() - started,
    });
  });

  it("Change save location through the dialog stub updates the line, survives a round trip, and the run writes there", async () => {
    const started = Date.now();
    const dir = path.join(ROOT, "case-3", "src");
    mkdirFresh(dir);
    const source = writeSource(dir, "change.txt", "change payload\n");
    const derived = path.join(dir, "change.txt.7z");
    const picked = path.join(ROOT, "case-3", "picked");
    mkdirFresh(picked);
    const chosen = path.join(picked, "chosen.7z");

    await clearBasicInputs();
    await applyIncomingPaths([source], "compress");
    await clickBasicTab("compress");
    const shownBefore = await readDestinationRow(SAVE_TO);

    await queueDialogResult(chosen);
    await clickById(SAVE_TO.change);
    await browser.waitUntil(
      async () => (await readDestinationRow(SAVE_TO)).text === chosen,
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: `Change did not update Save to; ${await uiDiagnostics()}`,
      },
    );
    const shownAfterChange = await readDestinationRow(SAVE_TO);

    await switchToPowerWorkspace();
    const powerOutput = await domValue("#output-path");
    await switchToBasicWorkspace();
    await waitForBasicView("compress");
    const shownAfterRoundTrip = await readDestinationRow(SAVE_TO);

    assert.equal(shownBefore.text, derived);
    assert.equal(shownAfterChange.title, chosen);
    assert.equal(powerOutput, chosen, "Power did not receive the chosen path");
    assert.equal(
      shownAfterRoundTrip.text,
      chosen,
      "the chosen path did not survive a round trip with the same inputs",
    );

    await clickById(SAVE_TO.run);
    await browser.waitUntil(() => fileExists(chosen), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic compress did not write ${chosen}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    assert.equal(
      fs.existsSync(derived),
      false,
      "the run wrote the derived path",
    );

    const otherDir = path.join(ROOT, "case-3", "other-src");
    mkdirFresh(otherDir);
    const other = writeSource(otherDir, "other.txt", "other payload\n");
    await clearBasicInputs();
    await applyIncomingPaths([other], "compress");
    await clickBasicTab("compress");
    const shownForNewInputs = await readDestinationRow(SAVE_TO);
    const expectedForNewInputs = path.join(otherDir, "other.txt.7z");

    assert.equal(
      shownForNewInputs.text,
      expectedForNewInputs,
      "a change of inputs kept the earlier Change choice",
    );

    writeEvidence(
      EVIDENCE_DIR,
      "beta2-basic-destination-change-save-location",
      {
        scenario: "change-save-location-stub-round-trip-and-input-change",
        derived,
        chosen,
        shownAfterChange: shownAfterChange.text,
        shownAfterRoundTrip: shownAfterRoundTrip.text,
        shownForNewInputs: shownForNewInputs.text,
        changeName: shownAfterChange.changeName,
        durationMs: Date.now() - started,
      },
    );
  });

  it("Basic Extract shows Extract to for one archive, ignores a stale Power destination, and extracts there", async () => {
    const started = Date.now();
    const dir = path.join(ROOT, "case-4", "single");
    const archive = buildArchive(
      path.join(dir, "hello-one.7z"),
      path.join(ROOT, "case-4", "src"),
      "one.txt",
      "one payload\n",
    );
    const derived = path.join(dir, "hello-one");
    const stale = path.join(ROOT, "case-4", "power-extract-stale");

    await clearBasicInputs();
    await switchToPowerWorkspace();
    await setPowerField("extract-path", stale);
    await switchToBasicWorkspace();
    await applyIncomingPaths([archive], "extract");
    await clickBasicTab("extract");
    const row = await readDestinationRow(EXTRACT_TO);
    const hiddenDisplay = await readHiddenFieldDisplay();

    assert.equal(row.text, derived, `Extract to showed ${row.text}`);
    assert.equal(row.title, derived);
    assert.equal(row.tagName, "OUTPUT");
    assert.equal(row.labelledBy, EXTRACT_TO.label);
    assert.equal(row.labelText, "Extract to");
    assert.equal(row.changeName, "Change extract folder");
    assert.equal(row.changeDisabled, false);
    assert.equal(
      row.noteVisible,
      false,
      "the multi-archive note showed for one archive",
    );
    assert.equal(hiddenDisplay.extractDestination, "none");
    assert.equal(hiddenDisplay.extractPassword, "none");

    await clickById(EXTRACT_TO.run);
    const extracted = path.join(derived, "one.txt");
    await browser.waitUntil(() => fileExists(extracted), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic extract did not write ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const title = await readCompletionTitle("extract");

    assert.equal(fs.readFileSync(extracted, "utf8"), "one payload\n");
    assert.equal(title, "Extraction complete");
    assert.equal(
      fileExists(stale),
      false,
      "the extract used the stale Power path",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-basic-destination-extract-one", {
      scenario: "extract-to-shows-and-uses-derived-folder",
      archive,
      shownPath: row.text,
      extracted,
      stalePowerPath: stale,
      completionTitle: title,
      durationMs: Date.now() - started,
    });
  });

  it("Change extract folder through the dialog stub updates the line and the extract writes there", async () => {
    const started = Date.now();
    const dir = path.join(ROOT, "case-4b", "archives");
    const archive = buildArchive(
      path.join(dir, "change-extract.7z"),
      path.join(ROOT, "case-4b", "src"),
      "chosen.txt",
      "chosen payload\n",
    );
    const derived = path.join(dir, "change-extract");
    const picked = path.join(ROOT, "case-4b", "picked");
    mkdirFresh(picked);

    await clearBasicInputs();
    await applyIncomingPaths([archive], "extract");
    await clickBasicTab("extract");
    const shownBefore = await readDestinationRow(EXTRACT_TO);

    await queueDialogResult(picked);
    await clickById(EXTRACT_TO.change);
    await browser.waitUntil(
      async () => (await readDestinationRow(EXTRACT_TO)).text === picked,
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: `Change did not update Extract to; ${await uiDiagnostics()}`,
      },
    );
    const shownAfterChange = await readDestinationRow(EXTRACT_TO);

    await clickById(EXTRACT_TO.run);
    const extracted = path.join(picked, "chosen.txt");
    await browser.waitUntil(() => fileExists(extracted), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic extract did not write ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();

    assert.equal(shownBefore.text, derived);
    assert.equal(shownAfterChange.title, picked);
    assert.equal(
      fileExists(derived),
      false,
      "the extract wrote the derived folder",
    );

    writeEvidence(
      EVIDENCE_DIR,
      "beta2-basic-destination-change-extract-folder",
      {
        scenario: "change-extract-folder-stub-and-run",
        derived,
        picked,
        shownAfterChange: shownAfterChange.text,
        changeName: shownAfterChange.changeName,
        extracted,
        durationMs: Date.now() - started,
      },
    );
  });

  it("Basic Extract with two archives shows the parent and the note, and gives each archive its own folder", async () => {
    const started = Date.now();
    const multi = path.join(ROOT, "case-5", "multi");
    mkdirFresh(multi);
    const alpha = buildArchive(
      path.join(multi, "alpha.7z"),
      path.join(ROOT, "case-5", "src-alpha"),
      "alpha.txt",
      "alpha payload\n",
    );
    const beta = buildArchive(
      path.join(multi, "beta.7z"),
      path.join(ROOT, "case-5", "src-beta"),
      "beta.txt",
      "beta payload\n",
    );

    await clearBasicInputs();
    await applyIncomingPaths([alpha, beta], "extract");
    await clickBasicTab("extract");
    const row = await readDestinationRow(EXTRACT_TO);

    assert.equal(row.text, multi, `Extract to showed ${row.text}`);
    assert.equal(row.noteVisible, true, "the note is hidden for two archives");
    assert.equal(row.noteText, "Each archive gets its own folder.");

    await clickById(EXTRACT_TO.run);
    const alphaOut = path.join(multi, "alpha", "alpha.txt");
    const betaOut = path.join(multi, "beta", "beta.txt");
    await browser.waitUntil(() => fileExists(alphaOut) && fileExists(betaOut), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `batch extract did not write both folders; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const entries = fs.readdirSync(multi).sort();
    const title = await readCompletionTitle("extract");

    assert.deepEqual(entries, ["alpha", "alpha.7z", "beta", "beta.7z"]);
    assert.equal(title, "Extraction complete");

    writeEvidence(EVIDENCE_DIR, "beta2-basic-destination-extract-two", {
      scenario: "two-archives-parent-note-and-own-folders",
      destinationParent: multi,
      shownPath: row.text,
      note: row.noteText,
      entries,
      completionTitle: title,
      durationMs: Date.now() - started,
    });
  });

  it("shows Choose where to save for a protected source and Add files first with no files", async () => {
    const started = Date.now();
    // macOS has no Windows folders; use a read-only system area instead.
    const protectedRoot =
      process.platform === "darwin"
        ? "/System/Library"
        : (process.env.SystemRoot ?? "C:\\Windows");
    const protectedFile = path.join(
      protectedRoot,
      "zinnia-e2e-missing-source",
      "locked.txt",
    );

    await clearBasicInputs();
    await clickBasicTab("compress");
    const noFiles = await readDestinationRow(SAVE_TO);

    assert.equal(noFiles.text, "Add files first");
    assert.equal(
      noFiles.changeDisabled,
      true,
      "Change is enabled with no files",
    );

    await applyIncomingPaths([protectedFile], "compress");
    const protectedRow = await readDestinationRow(SAVE_TO);

    assert.equal(
      protectedRow.text,
      "Choose where to save",
      `a protected source showed ${protectedRow.text}`,
    );
    assert.equal(protectedRow.title, null, "a placeholder has a title");
    assert.equal(
      protectedRow.changeDisabled,
      false,
      "Change is disabled for a protected source",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-basic-destination-placeholders", {
      scenario: "placeholder-when-no-files-and-when-protected",
      noFilesText: noFiles.text,
      noFilesChangeDisabled: noFiles.changeDisabled,
      protectedSource: protectedFile,
      protectedText: protectedRow.text,
      protectedChangeDisabled: protectedRow.changeDisabled,
      durationMs: Date.now() - started,
    });
  });

  it("keeps the primary action button inside the 500x650 window with a long destination", async () => {
    const started = Date.now();
    const longDir = path.join(
      ROOT,
      "case-8",
      "long-destination-folder-for-layout-proof",
      "nested-segment-for-basic-window-check",
    );
    mkdirFresh(longDir);
    const source = writeSource(longDir, "layout-source-file.txt", "layout\n");
    const expectedCompress = path.join(longDir, "layout-source-file.txt.7z");
    const longArchive = buildArchive(
      path.join(longDir, "layout-extract.7z"),
      path.join(ROOT, "case-8", "src-extract"),
      "layout.txt",
      "layout\n",
    );
    const expectedExtract = path.join(longDir, "layout-extract");

    const windowBefore = await windowInnerSize();
    let windowDuring = null;
    let windowRestored = null;
    let compress;
    let compressRow;
    let extract;
    let extractRow;
    try {
      await setWindowInnerSize(BASIC_WINDOW_WIDTH, BASIC_WINDOW_HEIGHT);
      windowDuring = await windowInnerSize();

      await clearBasicInputs();
      await applyIncomingPaths([source], "compress");
      await clickBasicTab("compress");
      await browser.pause(400);
      await browser.waitUntil(
        async () => ((await readLayout(SAVE_TO)).run?.height ?? 0) > 0,
        {
          timeout: STEP_TIMEOUT_MS,
          timeoutMsg: "Compress run button not laid out",
        },
      );
      compress = await readLayout(SAVE_TO);
      compressRow = await readDestinationRow(SAVE_TO);

      await clearBasicInputs();
      await applyIncomingPaths([longArchive], "extract");
      await clickBasicTab("extract");
      await browser.pause(400);
      await browser.waitUntil(
        async () => ((await readLayout(EXTRACT_TO)).run?.height ?? 0) > 0,
        {
          timeout: STEP_TIMEOUT_MS,
          timeoutMsg: "Extract run button not laid out",
        },
      );
      extract = await readLayout(EXTRACT_TO);
      extractRow = await readDestinationRow(EXTRACT_TO);
    } finally {
      await setWindowInnerSize(windowBefore.width, windowBefore.height).catch(
        () => undefined,
      );
      windowRestored = await windowInnerSize();
    }

    assert.deepEqual(
      windowDuring,
      { width: BASIC_WINDOW_WIDTH, height: BASIC_WINDOW_HEIGHT },
      "the window did not take the Basic size",
    );
    assert.equal(compressRow.text, expectedCompress);
    assert.equal(extractRow.text, expectedExtract);

    for (const [label, layout] of [
      ["Compress", compress],
      ["Extract", extract],
    ]) {
      assert.ok(
        layout.viewportWidth === BASIC_WINDOW_WIDTH &&
          layout.viewportHeight === BASIC_WINDOW_HEIGHT,
        `${label} viewport is ${layout.viewportWidth}x${layout.viewportHeight}`,
      );
      assert.ok(layout.run, `${label} run button is missing`);
      assert.ok(
        layout.run.top >= 0 &&
          layout.run.left >= 0 &&
          layout.run.bottom <= layout.viewportHeight &&
          layout.run.right <= layout.viewportWidth,
        `${label} run button is outside the viewport: ${JSON.stringify(layout.run)}`,
      );
      assert.ok(
        layout.row.left >= 0 && layout.row.right <= layout.viewportWidth,
        `${label} destination row is wider than the window`,
      );
      assert.ok(
        layout.output.height <= 24,
        `${label} destination path wraps: ${layout.output.height}px`,
      );
      assert.ok(
        layout.name.scrollWidth <= layout.name.clientWidth + 1,
        `${label} file name is clipped`,
      );
    }
    assert.ok(
      compress.name.text.endsWith(path.basename(expectedCompress)),
      "the compress file name is not visible",
    );
    assert.ok(
      extract.name.text.endsWith(path.basename(expectedExtract)),
      "the extract folder name is not visible",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-basic-destination-layout", {
      scenario: "primary-action-inside-window-with-long-destination",
      pathLength: expectedCompress.length,
      windowBefore,
      windowDuring,
      windowRestored,
      compressViewport: [compress.viewportWidth, compress.viewportHeight],
      compressRun: compress.run,
      compressRow: compress.row,
      compressOutputHeight: compress.output.height,
      compressNameClipped:
        compress.name.scrollWidth > compress.name.clientWidth + 1,
      extractViewport: [extract.viewportWidth, extract.viewportHeight],
      extractRun: extract.run,
      extractRow: extract.row,
      extractOutputHeight: extract.output.height,
      durationMs: Date.now() - started,
    });
  });
});
