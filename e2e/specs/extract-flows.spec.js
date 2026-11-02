import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  abortArchiveOperationIfBusy,
  clearPowerExtractSession,
  clickBasicRunExtract,
  confirmInputModal,
  dismissToasts,
  waitForInputModalLabel,
  confirmSelectiveExtract,
  expandSelectiveFolder,
  isInputModalOpen,
  openBrowseArchive,
  openSelectiveExtractPicker,
  prepareBasicExtract,
  startPowerBatchExtract,
  startPowerExtract,
  toggleSelectiveMember,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
  waitForToastContaining,
} from "../helpers/ui-driver.js";
import { treeManifest, writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "extract-flows");
const sidecar = requireHostSidecar();

const WRONG_PASSWORD_HINT =
  "Wrong or missing password. Enter the archive password and try again.";
const BASIC_WRONG_PASSWORD_TOAST = "Incorrect password. Please try again.";
const POWER_INCORRECT_PASSWORD_MODAL_LABEL =
  "Incorrect password. Enter the archive password:";
const RAW_7Z_MARKERS = [
  "ERROR:",
  "Cannot open encrypted archive",
  "Can not open encrypted archive",
  "7-Zip (",
];

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeFixtureTree(baseDir) {
  const keepDir = path.join(baseDir, "keep");
  const skipDir = path.join(baseDir, "skip");
  fs.mkdirSync(keepDir, { recursive: true });
  fs.mkdirSync(skipDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, "keep-me.txt"), "keep-me\n");
  fs.writeFileSync(path.join(keepDir, "extra.txt"), "extra\n");
  fs.writeFileSync(path.join(skipDir, "skip-me.txt"), "skip-me\n");
  fs.writeFileSync(path.join(skipDir, "only-skip.txt"), "only-skip\n");
}

function buildSelectiveFixtureArchive() {
  const tree = path.join(ROOT, "selective-src");
  fs.rmSync(tree, { recursive: true, force: true });
  writeFixtureTree(tree);
  const archive = path.join(ROOT, "selective.7z");
  run7z(sidecar, ["a", "-t7z", archive, "keep", "skip"], { cwd: tree });
  return archive;
}

function buildBatchArchives() {
  const dir = path.join(ROOT, "batch-src");
  fs.rmSync(dir, { recursive: true, force: true });
  const aDir = path.join(dir, "batch-a");
  const bDir = path.join(dir, "batch-b");
  fs.mkdirSync(aDir, { recursive: true });
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(aDir, "from-a.txt"), "a\n");
  fs.writeFileSync(path.join(bDir, "from-b.txt"), "b\n");
  const archiveA = path.join(ROOT, "batch-a.7z");
  const archiveB = path.join(ROOT, "batch-b.zip");
  run7z(sidecar, ["a", "-t7z", archiveA, "batch-a"], { cwd: dir });
  run7z(sidecar, ["a", "-tzip", archiveB, "batch-b"], { cwd: dir });
  return { archiveA, archiveB };
}

async function collectUserFacingErrorTexts() {
  return browser.execute(() => {
    const texts = [];
    const status = document.getElementById("status")?.textContent?.trim();
    if (status && status !== "Idle") texts.push(status);
    const completion = document.getElementById("basic-extract-completion-msg");
    const completionPanel = document.getElementById("basic-extract-completion");
    if (
      completion?.textContent?.trim() &&
      completionPanel?.classList.contains("is-active")
    ) {
      texts.push(completion.textContent);
    }
    for (const toast of document.querySelectorAll(".toast-message")) {
      const line = toast.textContent?.trim();
      if (line) texts.push(line);
    }
    return texts.map((line) => line.trim()).filter(Boolean);
  });
}

function assertNoRaw7zMarkers(texts, label) {
  const joined = texts.join("\n");
  for (const marker of RAW_7Z_MARKERS) {
    assert.ok(
      !joined.includes(marker),
      `${label} exposed raw 7-Zip marker ${marker}: ${joined}`,
    );
  }
}

function assertDestinationHasNoFiles(dest) {
  const manifest = treeManifest(dest);
  if (manifest === null) return;
  assert.deepEqual(
    manifest.filter((entry) => entry.kind === "file"),
    [],
    `destination leaked files: ${JSON.stringify(manifest)}`,
  );
}

function wrongPasswordGlobal() {
  return "definitely-not-the-archive-password";
}

async function waitForExtractFailureHint(expectedHint, timeoutMsg) {
  await browser.waitUntil(
    async () => {
      const texts = await collectUserFacingErrorTexts();
      if (texts.some((line) => line.includes(expectedHint))) return true;
      const status = await browser.execute(
        () => document.getElementById("status")?.textContent ?? "",
      );
      if (status === "Done") {
        throw new Error(
          `extract finished successfully instead of failing; ${await uiDiagnostics()}`,
        );
      }
      return false;
    },
    { timeout: 120_000, timeoutMsg },
  );
  return collectUserFacingErrorTexts();
}

describe("extract flows", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("selectively extracts only checked files and folders in Power mode", async () => {
    const archive = buildSelectiveFixtureArchive();
    const dest = path.join(ROOT, "selective-out");
    mkdirFresh(dest);

    await openBrowseArchive(archive, "keep-me.txt");
    await openSelectiveExtractPicker();
    await toggleSelectiveMember("keep");
    await expandSelectiveFolder("skip");
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(
            document.querySelector('[data-member-path="skip/skip-me.txt"]'),
          ),
        ),
      {
        timeout: 10_000,
        timeoutMsg: "selective tree did not show skip/skip-me.txt",
      },
    );
    await toggleSelectiveMember("skip/skip-me.txt");
    await confirmSelectiveExtract(dest);

    await browser.waitUntil(
      () =>
        fs.existsSync(path.join(dest, "keep", "keep-me.txt")) &&
        fs.existsSync(path.join(dest, "keep", "extra.txt")) &&
        fs.existsSync(path.join(dest, "skip", "skip-me.txt")),
      {
        timeout: 120_000,
        timeoutMsg: `selective extract did not publish expected members; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();

    assert.equal(
      fs.existsSync(path.join(dest, "skip", "only-skip.txt")),
      false,
    );
    assert.equal(fs.existsSync(path.join(dest, "skip-me.txt")), false);

    writeEvidence(EVIDENCE_DIR, "selective-extract", {
      scenario: "selective-extract",
      archive,
      destination: dest,
      selected: ["keep/", "skip/skip-me.txt"],
      tree: treeManifest(dest),
    });
  });

  it("batch-extracts multiple archives into per-archive folders", async () => {
    const { archiveA, archiveB } = buildBatchArchives();
    const dest = path.join(ROOT, "batch-out");
    mkdirFresh(dest);

    await startPowerBatchExtract([archiveA, archiveB], dest);
    const outA = path.join(dest, "batch-a", "from-a.txt");
    const outB = path.join(dest, "batch-b", "from-b.txt");
    await browser.waitUntil(() => fs.existsSync(outA) && fs.existsSync(outB), {
      timeout: 120_000,
      timeoutMsg: `batch extract did not write both outputs; a=${fs.existsSync(outA)} b=${fs.existsSync(outB)}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();

    writeEvidence(EVIDENCE_DIR, "batch-extract", {
      scenario: "batch-extract",
      inputs: [archiveA, archiveB],
      destination: dest,
      tree: treeManifest(dest),
    });
    await clearPowerExtractSession();
    await dismissToasts();
  });

  it("shows the friendly wrong-password hint in Power and Basic without raw 7-Zip text", async () => {
    const archive = process.env.ZINNIA_E2E_ENCRYPTED_7Z;
    const goodPassword = process.env.ZINNIA_E2E_PASSWORD;
    const wrongPassword = wrongPasswordGlobal();
    const payload = process.env.ZINNIA_E2E_PAYLOAD;

    await abortArchiveOperationIfBusy();
    const powerDest = path.join(ROOT, "wrong-password-power");
    mkdirFresh(powerDest);
    await dismissToasts();
    await startPowerExtract(archive, powerDest, { password: wrongPassword });
    await waitForInputModalLabel(
      POWER_INCORRECT_PASSWORD_MODAL_LABEL,
      `Power did not show incorrect-password retry modal; ${await uiDiagnostics()}`,
    );
    await confirmInputModal(wrongPassword);
    const powerTexts = await waitForExtractFailureHint(
      WRONG_PASSWORD_HINT,
      `Power wrong-password extract did not show hint after modal retry; ${await uiDiagnostics()}`,
    );
    await waitForArchiveIdle(120_000);
    const powerStatus = await browser.execute(
      () => document.getElementById("status")?.textContent ?? "",
    );
    assert.notEqual(powerStatus, "Running", "Power extract stayed Running");
    assertNoRaw7zMarkers(powerTexts, "Power wrong password");
    assertDestinationHasNoFiles(powerDest);

    const powerOkDest = path.join(ROOT, "wrong-password-power-ok");
    mkdirFresh(powerOkDest);
    await dismissToasts();
    await clearPowerExtractSession();
    await startPowerExtract(archive, powerOkDest, { password: wrongPassword });
    await waitForInputModalLabel(
      POWER_INCORRECT_PASSWORD_MODAL_LABEL,
      `Power success path did not show retry modal; ${await uiDiagnostics()}`,
    );
    await confirmInputModal(goodPassword);
    const powerExtracted = path.join(powerOkDest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(powerExtracted), {
      timeout: 120_000,
      timeoutMsg: `Power modal retry with correct password did not write ${powerExtracted}`,
    });
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(powerExtracted, "utf8"), payload);

    const basicDest = path.join(ROOT, "wrong-password-basic");
    mkdirFresh(basicDest);
    await dismissToasts();
    await prepareBasicExtract(archive, basicDest);
    await clickBasicRunExtract();
    await confirmInputModal(wrongPassword);
    const basicWrongToasts = await waitForToastContaining(
      BASIC_WRONG_PASSWORD_TOAST,
      `Basic did not toast after wrong password; ${await uiDiagnostics()}`,
    );
    await browser.waitUntil(async () => isInputModalOpen(), {
      timeout: 30_000,
      timeoutMsg: "Basic did not re-prompt for password after a wrong attempt",
    });
    await confirmInputModal(goodPassword);
    const extracted = path.join(basicDest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 120_000,
      timeoutMsg: `Basic extract with correct password did not write ${extracted}`,
    });
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);

    await dismissToasts();
    writeEvidence(EVIDENCE_DIR, "wrong-password", {
      scenario: "wrong-password",
      archive,
      wrongPassword,
      power: {
        failDestination: powerDest,
        okDestination: powerOkDest,
        observedTexts: powerTexts,
      },
      basic: {
        destination: basicDest,
        wrongPasswordToasts: basicWrongToasts,
        extractedHello: extracted,
      },
      partialOutputPower: treeManifest(powerDest),
    });
  });

  it("shows a non-password hint for corrupt archives in Power and Basic", async () => {
    const badArchive = path.join(ROOT, "bad.7z");
    fs.writeFileSync(badArchive, "not-a-real-7z-archive-bytes");

    await abortArchiveOperationIfBusy();
    const powerDest = path.join(ROOT, "corrupt-power");
    mkdirFresh(powerDest);
    await dismissToasts();
    await startPowerExtract(badArchive, powerDest);
    await waitForArchiveIdle(120_000);
    let powerTexts = await collectUserFacingErrorTexts();
    await browser.waitUntil(
      async () => {
        powerTexts = await collectUserFacingErrorTexts();
        return (
          powerTexts.some(
            (line) =>
              line.trim().length > 0 && !line.includes(WRONG_PASSWORD_HINT),
          ) &&
          !powerTexts.every((line) => line === "Running" || line === "Idle")
        );
      },
      {
        timeout: 120_000,
        timeoutMsg: `Power corrupt extract did not show a failure hint; ${await uiDiagnostics()}`,
      },
    );
    assertNoRaw7zMarkers(powerTexts, "Power corrupt archive");
    assertDestinationHasNoFiles(powerDest);

    const basicDest = path.join(ROOT, "corrupt-basic");
    mkdirFresh(basicDest);
    await dismissToasts();
    await prepareBasicExtract(badArchive, basicDest);
    await clickBasicRunExtract();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document
              .getElementById("basic-extract-completion")
              ?.classList.contains("is-active") ?? false,
        ),
      {
        timeout: 60_000,
        timeoutMsg: `Basic corrupt extract did not finish; ${await uiDiagnostics()}`,
      },
    );
    assert.equal(
      await isInputModalOpen(),
      false,
      "Basic corrupt extract must not prompt for a password",
    );
    await waitForArchiveIdle(120_000);
    let basicTexts = await collectUserFacingErrorTexts();
    await browser.waitUntil(
      async () => {
        basicTexts = await collectUserFacingErrorTexts();
        return basicTexts.some(
          (line) =>
            line.trim().length > 0 &&
            !line.includes(WRONG_PASSWORD_HINT) &&
            line !== "Running" &&
            line !== "Idle",
        );
      },
      {
        timeout: 120_000,
        timeoutMsg: `Basic corrupt extract did not show a failure hint; ${await uiDiagnostics()}`,
      },
    );
    assertNoRaw7zMarkers(basicTexts, "Basic corrupt archive");

    writeEvidence(EVIDENCE_DIR, "corrupt-archive", {
      scenario: "corrupt-archive",
      archive: badArchive,
      power: { destination: powerDest, observedTexts: powerTexts },
      basic: { destination: basicDest, observedTexts: basicTexts },
    });
  });
});
