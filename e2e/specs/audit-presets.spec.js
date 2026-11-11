import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import { updateE2eSettings } from "../helpers/profile.js";
import {
  applyIncomingPaths,
  clearPowerExtractSession,
  confirmInputModal,
  domText,
  domValue,
  flushPendingSettingsWrites,
  queueDialogResult,
  reloadMainWindow,
  selectPowerPreset,
  setInputValue,
  setSelectValue,
  startPowerCompress,
  switchToBasicWorkspace,
  switchToPowerWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
  waitForToastContaining,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-presets");
const sidecar = requireHostSidecar();
const SOURCE_NAME = "hello.txt";
const PREVIEW_PASSWORD = "ZinniaE2e-Preview-Secret";

function e2eProfileDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("E2E profile home env is missing");
  return path.dirname(home);
}

function listStdout(archive) {
  return run7z(sidecar, ["l", "-slt", "--", archive]).stdout;
}

/** Method of one member record in `7z l -slt` output, or null. */
function memberMethod(listing, member) {
  const block = listing
    .split(/\r?\n\r?\n/)
    .find((record) => record.split(/\r?\n/).includes(`Path = ${member}`));
  if (!block) return null;
  const line = block.split(/\r?\n/).find((row) => row.startsWith("Method = "));
  return line ? line.slice("Method = ".length).trim() : null;
}

async function outputPathValue() {
  return domValue("#output-path");
}

async function waitForOutputPath(expected, timeoutMsg) {
  await browser.waitUntil(async () => (await outputPathValue()) === expected, {
    timeout: 20_000,
    interval: 50,
    timeoutMsg: `${timeoutMsg}: expected ${expected}, saw ${await outputPathValue()}`,
  });
}

async function clickById(id) {
  await browser.execute((target) => {
    const el = document.getElementById(target);
    if (!el) throw new Error(`missing #${target}`);
    el.click();
  }, id);
}

async function waitForFile(file, timeoutMsg) {
  await browser.waitUntil(() => fs.existsSync(file), {
    timeout: 120_000,
    interval: 100,
    timeoutMsg,
  });
}

/**
 * Power compress setup with a Browse-chosen folder: the source is added, then
 * the save dialog answers with `chosen` through the real Browse button.
 */
async function setupBrowsePicked(caseName, chosen) {
  const dir = path.join(ROOT, caseName, "source");
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, SOURCE_NAME);
  fs.writeFileSync(source, PAYLOAD);
  await startPowerCompress(source, path.join(dir, "placeholder.7z"), {
    format: "7z",
    run: false,
  });
  await queueDialogResult(chosen);
  await clickById("choose-output");
  await waitForOutputPath(chosen, "Browse did not set the output path");
}

describe("audit presets", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  after(async () => {
    await flushPendingSettingsWrites().catch(() => undefined);
    updateE2eSettings(e2eProfileDir(), { customPresets: [] });
    await reloadMainWindow().catch(() => undefined);
  });

  it("writes Store preset ZIP entries as Method = Store and round-trips the bytes", async () => {
    const dir = path.join(ROOT, "store");
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, "store-source.txt");
    fs.writeFileSync(source, PAYLOAD);
    const out = path.join(dir, "store.zip");

    await startPowerCompress(source, out, { format: "zip", run: false });
    await selectPowerPreset("store");
    await clickById("run-action");
    await waitForFile(out, `Store preset did not write ${out}`);
    await waitForArchiveIdle();

    const method = memberMethod(listStdout(out), "store-source.txt");
    assert.equal(method, "Store", `Store preset wrote Method = ${method}`);

    const extractDir = path.join(dir, "extracted");
    run7z(sidecar, ["x", "-y", `-o${extractDir}`, "--", out]);
    const roundTrip = fs.readFileSync(
      path.join(extractDir, "store-source.txt"),
      "utf8",
    );
    assert.equal(roundTrip, PAYLOAD, "Store round trip changed the bytes");

    writeEvidence(EVIDENCE_DIR, "audit-presets-store-zip", {
      scenario: "store-preset-zip-method",
      archive: out,
      memberMethod: method,
      roundTripBytesMatch: roundTrip === PAYLOAD,
    });
  });

  it("keeps a Browse-chosen folder when the archive name is typed", async () => {
    const picked = path.join(ROOT, "browse-keep", "picked");
    fs.mkdirSync(picked, { recursive: true });
    await setupBrowsePicked("browse-keep", path.join(picked, "first.7z"));

    await setInputValue("#archive-name", "renamed");
    const expected = path.join(picked, "renamed.7z");
    await waitForOutputPath(expected, "typed name dropped the picked folder");

    writeEvidence(EVIDENCE_DIR, "audit-presets-browse-keeps-folder", {
      scenario: "browse-keeps-folder",
      pickedFolder: picked,
      outputPath: await outputPathValue(),
    });
  });

  it("gives photos.7z for the typed name photos.7z with format 7z", async () => {
    const picked = path.join(ROOT, "duplicate-ext", "picked");
    fs.mkdirSync(picked, { recursive: true });
    await setupBrowsePicked("duplicate-ext", path.join(picked, "first.7z"));

    await setInputValue("#archive-name", "photos.7z");
    const expected = path.join(picked, "photos.7z");
    await waitForOutputPath(expected, "duplicate extension was not stripped");
    assert.ok(!(await outputPathValue()).endsWith(".7z.7z"));

    writeEvidence(EVIDENCE_DIR, "audit-presets-duplicate-extension", {
      scenario: "typed-duplicate-extension",
      outputPath: await outputPathValue(),
    });
  });

  it("renames a manually chosen output extension when the format changes", async () => {
    const dir = path.join(ROOT, "format-swap");
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, SOURCE_NAME);
    fs.writeFileSync(source, PAYLOAD);
    const chosen = path.join(dir, "manual.7z");

    await startPowerCompress(source, chosen, { format: "7z", run: false });
    await setSelectValue("#format", "zip");
    const expected = path.join(dir, "manual.zip");
    await waitForOutputPath(expected, "format change kept .7z");

    await clickById("run-action");
    await waitForFile(expected, `zip run did not write ${expected}`);
    await waitForArchiveIdle();
    const head = fs.readFileSync(expected).subarray(0, 4).toString("latin1");
    assert.equal(head, "PK\u0003\u0004", "output is not a ZIP container");

    writeEvidence(EVIDENCE_DIR, "audit-presets-format-swap", {
      scenario: "format-change-swaps-extension",
      outputPath: expected,
      zipSignature: head === "PK\u0003\u0004",
    });
  });

  it("defaults the extract folder for a.7z.001 to a", async () => {
    const dir = path.join(ROOT, "split-default");
    const srcDir = path.join(dir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const payload = path.join(srcDir, "payload.bin");
    const handle = fs.openSync(payload, "w");
    fs.writeSync(handle, crypto.randomBytes(2_500_000));
    fs.closeSync(handle);
    run7z(sidecar, [
      "a",
      "-v1m",
      "-t7z",
      "--",
      path.join(dir, "a.7z"),
      payload,
    ]);
    const volume = path.join(dir, "a.7z.001");
    assert.ok(fs.existsSync(volume), "split fixture did not produce a.7z.001");

    await switchToPowerWorkspace();
    await clearPowerExtractSession();
    await $('[data-mode-btn="extract"]').click();
    await waitForArchiveIdle();
    await applyIncomingPaths([volume], "extract");
    const expected = path.join(dir, "a");
    await browser.waitUntil(
      async () => (await domValue("#extract-path")) === expected,
      {
        timeout: 20_000,
        interval: 50,
        timeoutMsg: `extract folder was ${await domValue("#extract-path")}`,
      },
    );

    writeEvidence(EVIDENCE_DIR, "audit-presets-split-extract-folder", {
      scenario: "split-volume-extract-folder",
      volume,
      extractFolder: expected,
    });
  });

  it("saves custom presets named like Object keys and rejects names over 64 characters", async () => {
    await switchToPowerWorkspace();
    await clickById("save-preset");
    await confirmInputModal("toString");
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("#preset option")].some(
            (option) => option.value === "custom:toString",
          ),
        ),
      { timeout: 20_000, timeoutMsg: "toString preset was not saved" },
    );

    const tooLong = "x".repeat(65);
    await clickById("save-preset");
    await confirmInputModal(tooLong);
    await waitForToastContaining(
      "64",
      "long preset name gave no visible limit",
    );

    writeEvidence(EVIDENCE_DIR, "audit-presets-custom-names", {
      scenario: "custom-preset-names",
      toStringSaved: true,
      longNameLength: tooLong.length,
    });
  });

  it("keeps a Browse-chosen folder in Basic when the archive name is typed", async () => {
    const dir = path.join(ROOT, "basic-browse-keep");
    const picked = path.join(dir, "picked");
    fs.mkdirSync(picked, { recursive: true });
    fs.mkdirSync(path.join(dir, "source"), { recursive: true });
    const source = path.join(dir, "source", SOURCE_NAME);
    fs.writeFileSync(source, PAYLOAD);

    await switchToBasicWorkspace();
    await clickById("basic-action-compress");
    await applyIncomingPaths([source], "compress");
    await setSelectValue("#basic-format", "7z");
    await queueDialogResult(path.join(picked, "first.7z"));
    await clickById("basic-choose-output");
    await browser.waitUntil(
      async () =>
        (await domValue("#basic-output-path")) ===
        path.join(picked, "first.7z"),
      { timeout: 20_000, timeoutMsg: "Basic Browse did not set the output" },
    );

    await browser.execute(() => {
      const field = document.getElementById("basic-archive-name");
      if (!field) throw new Error("missing #basic-archive-name");
      field.value = "renamed";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const expected = path.join(picked, "renamed.7z");
    await browser.waitUntil(
      async () => (await domValue("#basic-output-path")) === expected,
      { timeout: 20_000, timeoutMsg: "Basic name dropped the picked folder" },
    );

    writeEvidence(EVIDENCE_DIR, "audit-presets-basic-browse-keeps-folder", {
      scenario: "basic-browse-keeps-folder",
      pickedFolder: picked,
      outputPath: await domValue("#basic-output-path"),
    });
  });

  it("copies a command preview whose paths are quoted and whose password is masked", async () => {
    const dir = path.join(ROOT, "preview quoting");
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, "hello world.txt");
    fs.writeFileSync(source, PAYLOAD);
    const out = path.join(dir, "preview out.7z");

    await startPowerCompress(source, out, {
      format: "7z",
      password: PREVIEW_PASSWORD,
      run: false,
    });
    await clickById("show-command");
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !document.getElementById("command-preview-overlay")?.hidden,
        ),
      { timeout: 20_000, timeoutMsg: "command preview did not open" },
    );
    const text = String(await domText("#command-preview-text"));
    const quote = (value) =>
      process.platform === "win32" ? `"${value}"` : `'${value}'`;
    assert.ok(text.includes(quote(source)), `source not quoted: ${text}`);
    assert.ok(text.includes(quote(out)), `output not quoted: ${text}`);
    assert.ok(text.includes("-p***"), `password not masked: ${text}`);
    assert.ok(!text.includes(PREVIEW_PASSWORD), `password leaked: ${text}`);
    await clickById("close-command-preview");

    writeEvidence(EVIDENCE_DIR, "audit-presets-command-preview", {
      scenario: "command-preview-quoting",
      quotedStyle: process.platform === "win32" ? "double" : "single",
      passwordMasked: text.includes("-p***"),
      passwordLeaked: text.includes(PREVIEW_PASSWORD),
    });
  });
});
