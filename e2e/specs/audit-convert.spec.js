import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  randomBytesFile,
  requireHostSidecar,
  run7z,
} from "../../scripts/archive-fixtures.js";
import {
  confirmDialogTitles,
  dispatchDocumentKey,
  domText,
  openBrowseArchive,
  queueConfirmResult,
  queueDialogResult,
  setCheckbox,
  setInputValue,
  setSelectValue,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-convert");
const sidecar = requireHostSidecar();

const SOURCE_PASSWORD = "ZinniaE2e-Source-7z";
const ZIP_PASSWORD = "ZinniaE2e-Out-zip";
const SEVEN_PASSWORD = "ZinniaE2e-Out-7z";
// Left on the Add tab. Convert must not pick these up.
const ADD_TAB_PASSWORD = "ZinniaE2e-AddTab";
// Small enough to finish in seconds; large enough for 7-Zip to report percent.
const LARGE_BYTES = 16 * 1024 * 1024;
const PROGRESS_BUDGET_MS = 90_000;

/** Encrypted 7z (content only, names visible) with one member, hello.txt. */
function makeEncryptedSource(name) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hello.txt"), PAYLOAD);
  const archive = path.join(dir, "secret.7z");
  run7z(
    sidecar,
    ["a", "-t7z", "-y", `-p${SOURCE_PASSWORD}`, archive, "--", "hello.txt"],
    {
      cwd: dir,
    },
  );
  return archive;
}

/** Same as above with a large stored member, so percent progress has time to show. */
function makeLargeEncryptedSource(name) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  randomBytesFile(path.join(dir, "big.bin"), LARGE_BYTES);
  const archive = path.join(dir, "secret-large.7z");
  run7z(
    sidecar,
    [
      "a",
      "-t7z",
      "-y",
      "-mx=0",
      `-p${SOURCE_PASSWORD}`,
      archive,
      "--",
      "big.bin",
    ],
    { cwd: dir, timeout: 300_000 },
  );
  return archive;
}

function listWithoutPassword(archive) {
  return run7z(sidecar, ["l", "-slt", "--", archive], { allowFailure: true });
}

function listWithPassword(archive, password) {
  return run7z(sidecar, ["l", "-slt", `-p${password}`, "--", archive]).stdout;
}

async function clickBrowseConvert() {
  await browser.execute(() => {
    document.getElementById("browse-convert")?.click();
  });
}

async function isConvertDialogOpen() {
  return browser.execute(
    () => document.getElementById("convert-overlay")?.hidden === false,
  );
}

async function waitForConvertDialog(
  timeoutMsg = "convert dialog did not open",
) {
  await browser.waitUntil(() => isConvertDialogOpen(), {
    timeout: 120_000,
    timeoutMsg,
  });
}

async function waitForConvertDialogClosed() {
  await browser.waitUntil(async () => !(await isConvertDialogOpen()), {
    timeout: 30_000,
    timeoutMsg: "convert dialog stayed open",
  });
}

async function convertDialogState() {
  return browser.execute(() => ({
    format: document.getElementById("convert-format")?.value ?? null,
    password: document.getElementById("convert-password")?.value ?? null,
    output: document.getElementById("convert-output-name")?.textContent ?? "",
    dialogError: document.getElementById("convert-error")?.textContent ?? "",
    errorVisible: Boolean(
      document.getElementById("convert-error") &&
      !document.getElementById("convert-error").hidden,
    ),
  }));
}

async function submitConvertDialog() {
  await browser.execute(() => {
    document.getElementById("convert-submit")?.click();
  });
}

async function waitForSubmitEnabled() {
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("convert-submit")?.disabled === false,
      ),
    { timeout: 60_000, timeoutMsg: "convert submit stayed disabled" },
  );
}

/**
 * Browse the encrypted source, then type the source password into the Browse
 * field and set Add-tab values that Convert must ignore.
 */
async function prepareConvertFromBrowse(archive) {
  await openBrowseArchive(archive, "hello.txt");
  await setInputValue("#browse-password", SOURCE_PASSWORD);
  await browser.execute((addPassword) => {
    document.getElementById("format").value = "tar";
    document.getElementById("password").value = addPassword;
  }, ADD_TAB_PASSWORD);
}

async function titlesSince(count) {
  return (await confirmDialogTitles()).slice(count);
}

/**
 * Samples the Power progress line until `done()` is true or the budget ends.
 * A failed read is skipped so one slow WebDriver call cannot end the sample.
 */
async function sampleProgressUntil(
  done,
  { budgetMs = PROGRESS_BUDGET_MS, stopAfterPercent = false } = {},
) {
  const seen = new Set();
  const deadline = Date.now() + budgetMs;
  while (!done() && Date.now() < deadline) {
    const text = await domText("#progress").catch(() => null);
    if (text && text.trim()) seen.add(text.trim());
    if (stopAfterPercent && percentLinesOf(seen).length > 0) break;
    await browser.pause(100);
  }
  return seen;
}

function percentLinesOf(seen) {
  return [...seen].filter((line) => /\d+%/.test(line));
}

describe("audit convert and add-files flows", function () {
  this.timeout(15 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  // One failed case must not leave the Convert dialog open for the next one.
  afterEach(async () => {
    const open = await isConvertDialogOpen().catch(() => false);
    if (open) {
      await browser
        .execute(() => {
          document.getElementById("convert-cancel")?.click();
        })
        .catch(() => undefined);
      await browser
        .waitUntil(async () => !(await isConvertDialogOpen()), {
          timeout: 10_000,
          interval: 200,
        })
        .catch(() => undefined);
    }
  });

  it("asks before writing an unencrypted copy, and declining writes nothing", async () => {
    const archive = makeEncryptedSource("decline");
    const dest = path.join(ROOT, "decline", "secret.zip");
    await prepareConvertFromBrowse(archive);
    const titlesBefore = (await confirmDialogTitles()).length;

    await clickBrowseConvert();
    await waitForConvertDialog();
    const opened = await convertDialogState();
    assert.equal(
      opened.format,
      "7z",
      `dialog must default to 7z, not the Add-tab format: ${JSON.stringify(opened)}`,
    );
    assert.equal(opened.password, "", "dialog password must start empty");
    assert.ok(
      opened.output.includes("secret.7z"),
      `default save name should be the source stem with .7z: ${opened.output}`,
    );

    await setSelectValue("#convert-format", "zip");
    const zipState = await convertDialogState();
    assert.ok(
      zipState.output.includes("secret.zip"),
      `save name should follow the chosen format: ${zipState.output}`,
    );
    assert.ok(
      zipState.output.includes("not encrypted"),
      `dialog should state the output is not encrypted: ${zipState.output}`,
    );

    await queueConfirmResult(false);
    await submitConvertDialog();
    await waitForSubmitEnabled();

    const asked = await titlesSince(titlesBefore);
    assert.ok(
      asked.some((title) => /unencrypted/i.test(title)),
      `no unencrypted-copy confirmation was recorded: ${JSON.stringify(asked)}`,
    );
    assert.equal(
      fs.existsSync(dest),
      false,
      "declined convert wrote an archive",
    );
    assert.equal(
      await isConvertDialogOpen(),
      true,
      "declined confirmation should keep the dialog open",
    );
    const kept = await convertDialogState();
    assert.equal(
      kept.format,
      "zip",
      "declined confirmation must keep the format",
    );

    await dispatchDocumentKey("Escape");
    await waitForConvertDialogClosed();
    assert.equal(fs.existsSync(dest), false, "Esc wrote an archive");

    writeEvidence(EVIDENCE_DIR, "audit-convert-decline", {
      scenario: "audit-convert-decline",
      archive,
      dest,
      defaultSaveName: opened.output,
      confirmationTitles: asked,
      outputWritten: fs.existsSync(dest),
      dialogDefaultFormat: opened.format,
    });
  });

  it("accepts the unencrypted copy and writes a ZIP with the same content", async () => {
    const archive = makeEncryptedSource("accept");
    const dest = path.join(ROOT, "accept", "secret.zip");
    await prepareConvertFromBrowse(archive);
    const titlesBefore = (await confirmDialogTitles()).length;

    await clickBrowseConvert();
    await waitForConvertDialog();
    await setSelectValue("#convert-format", "zip");
    await queueConfirmResult(true);
    await queueDialogResult(dest);
    await submitConvertDialog();

    await browser.waitUntil(() => fs.existsSync(dest), {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: `convert did not write ${dest}`,
    });
    await waitForArchiveIdle();
    await waitForConvertDialogClosed();

    const asked = await titlesSince(titlesBefore);
    assert.ok(
      asked.some((title) => /unencrypted/i.test(title)),
      `no unencrypted-copy confirmation was recorded: ${JSON.stringify(asked)}`,
    );

    const listing = listWithoutPassword(dest);
    assert.equal(
      listing.code,
      0,
      `zip without password failed: ${listing.stderr}`,
    );
    assert.match(listing.stdout, /^Type = zip$/m, "output is not a ZIP");
    assert.doesNotMatch(
      listing.stdout,
      /^Encrypted = \+$/m,
      "zip is encrypted",
    );

    const extractRoot = path.join(ROOT, "accept", "extracted");
    fs.rmSync(extractRoot, { recursive: true, force: true });
    run7z(sidecar, ["x", `-o${extractRoot}`, "-y", "--", dest]);
    const restored = fs.readFileSync(
      path.join(extractRoot, "hello.txt"),
      "utf8",
    );
    assert.equal(
      restored,
      PAYLOAD,
      "converted content differs from the source",
    );

    writeEvidence(EVIDENCE_DIR, "audit-convert-accept", {
      scenario: "audit-convert-accept",
      archive,
      dest,
      confirmationTitles: asked,
      zipListsWithoutPassword: listing.code === 0,
      contentMatches: restored === PAYLOAD,
    });
  });

  it("keeps the typed password on a split-size error and writes an encrypted 7z", async () => {
    const archive = makeEncryptedSource("encrypted-out");
    const dest = path.join(ROOT, "encrypted-out", "secret-encrypted.7z");
    await prepareConvertFromBrowse(archive);
    const titlesBefore = (await confirmDialogTitles()).length;

    await clickBrowseConvert();
    await waitForConvertDialog();
    await setInputValue("#convert-password", SEVEN_PASSWORD);
    await setCheckbox("#convert-encrypt-headers", true);
    await setSelectValue("#convert-split-size", "custom");
    await setInputValue("#convert-split-custom", "12q");
    // Diagnostic: Add-tab split fields must not hold the dialog's bad value.
    const beforeSubmit = await browser.execute(() => ({
      addTabSplitSize: document.getElementById("split-size")?.value ?? null,
      addTabSplitCustom: document.getElementById("split-custom")?.value ?? null,
      convertSplitSize:
        document.getElementById("convert-split-size")?.value ?? null,
      convertSplitCustom:
        document.getElementById("convert-split-custom")?.value ?? null,
    }));
    writeEvidence(EVIDENCE_DIR, "audit-convert-split-diag", {
      scenario: "audit-convert-split-diag",
      ...beforeSubmit,
    });
    await submitConvertDialog();
    await waitForSubmitEnabled();

    const invalid = await convertDialogState();
    assert.equal(invalid.errorVisible, true, "split-size error was not shown");
    assert.match(invalid.dialogError, /Invalid split size/);
    assert.equal(
      invalid.password,
      SEVEN_PASSWORD,
      "validation error cleared the password",
    );
    assert.equal(
      fs.existsSync(dest),
      false,
      "invalid split size reached the write phase",
    );

    await setSelectValue("#convert-split-size", "");
    await queueDialogResult(dest);
    await submitConvertDialog();
    await browser.waitUntil(() => fs.existsSync(dest), {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: `encrypted convert did not write ${dest}`,
    });
    await waitForArchiveIdle();
    await waitForConvertDialogClosed();

    const withoutPassword = listWithoutPassword(dest);
    assert.notEqual(
      withoutPassword.code,
      0,
      "encrypted 7z listed without a password",
    );
    const withPassword = listWithPassword(dest, SEVEN_PASSWORD);
    assert.match(
      withPassword,
      /^Path = hello\.txt$/m,
      "password listing lacked hello.txt",
    );
    assert.match(withPassword, /^Encrypted = \+$/m, "member is not encrypted");

    const asked = await titlesSince(titlesBefore);
    assert.deepEqual(
      asked,
      [],
      "an encrypted output should not ask about an unencrypted copy",
    );

    writeEvidence(EVIDENCE_DIR, "audit-convert-encrypted", {
      scenario: "audit-convert-encrypted",
      archive,
      dest,
      invalidSplitError: invalid.dialogError,
      listWithoutPasswordExit: withoutPassword.code,
      listWithPasswordShowsHello: /^Path = hello\.txt$/m.test(withPassword),
      passwordInLog: String(await domText("#log")).includes(SEVEN_PASSWORD),
    });
  });

  it("shows a percent while a large convert runs in Power", async () => {
    const archive = makeLargeEncryptedSource("progress-convert");
    const dest = path.join(ROOT, "progress-convert", "secret-large.zip");
    await openBrowseArchive(archive, "big.bin", 120_000);
    await setInputValue("#browse-password", SOURCE_PASSWORD);

    await clickBrowseConvert();
    await waitForConvertDialog();
    await setSelectValue("#convert-format", "zip");
    await setInputValue("#convert-password", ZIP_PASSWORD);
    await queueDialogResult(dest);
    await submitConvertDialog();

    const seen = await sampleProgressUntil(() => fs.existsSync(dest));
    assert.ok(fs.existsSync(dest), `progress convert did not write ${dest}`);
    await waitForArchiveIdle();
    const percentLines = percentLinesOf(seen);
    assert.ok(
      percentLines.length > 0,
      `no percent shown during convert: ${JSON.stringify([...seen].slice(0, 10))}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-convert-progress", {
      scenario: "audit-convert-progress",
      archive,
      dest,
      percentSamples: percentLines.length,
      sampleLine: percentLines[0] ?? null,
    });
  });

  it("shows a percent while Add files runs in Power", async () => {
    const dir = path.join(ROOT, "progress-add");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hello.txt"), PAYLOAD);
    const archive = path.join(dir, "base.zip");
    run7z(sidecar, ["a", "-tzip", "-y", archive, "--", "hello.txt"], {
      cwd: dir,
    });
    const extra = path.join(dir, "big-add.bin");
    // A 48 MiB add finishes in about a second, faster than the sampler.
    randomBytesFile(extra, 128 * 1024 * 1024);

    await openBrowseArchive(archive, "hello.txt");
    await queueDialogResult([extra]);
    await browser.execute(() => {
      document.getElementById("browse-add-files")?.click();
    });

    const seen = await sampleProgressUntil(() => false, {
      stopAfterPercent: true,
    });
    await waitForArchiveIdle();
    const listing = listWithoutPassword(archive).stdout;
    assert.match(
      listing,
      /big-add\.bin/,
      "Add files did not update the archive",
    );
    const percentLines = percentLinesOf(seen);
    assert.ok(
      percentLines.length > 0,
      `no percent shown during Add files: ${JSON.stringify([...seen].slice(0, 10))}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-add-files-progress", {
      scenario: "audit-add-files-progress",
      archive,
      percentSamples: percentLines.length,
      sampleLine: percentLines[0] ?? null,
    });
  });
});
