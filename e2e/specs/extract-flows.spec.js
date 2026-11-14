import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  abortArchiveOperationIfBusy,
  clearPowerExtractSession,
  cancelInputModal,
  clickBasicRunExtract,
  confirmInputModal,
  dismissToasts,
  waitForInputModalLabel,
  confirmSelectiveExtract,
  expandSelectiveFolder,
  hasSelectiveMember,
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
} from "../helpers/ui-driver.js";
import { treeManifest, writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "extract-flows");
const sidecar = requireHostSidecar();

const WRONG_PASSWORD_HINT =
  "Wrong or missing password. Enter the archive password and try again.";
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

describe("extract flows", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("selectively extracts members whose names start with a dash", async () => {
    const tree = path.join(ROOT, "dash-src");
    fs.rmSync(tree, { recursive: true, force: true });
    fs.mkdirSync(path.join(tree, "-dir"), { recursive: true });
    fs.writeFileSync(path.join(tree, "-dash.txt"), "dash\n");
    fs.writeFileSync(path.join(tree, "normal.txt"), "normal\n");
    fs.writeFileSync(path.join(tree, "-dir", "inner.txt"), "inner\n");
    fs.writeFileSync(path.join(tree, "skipped.txt"), "skipped\n");
    const archive = path.join(ROOT, "dash.7z");
    fs.rmSync(archive, { force: true });
    run7z(
      sidecar,
      [
        "a",
        "-t7z",
        archive,
        "--",
        "./-dash.txt",
        "normal.txt",
        "./-dir",
        "skipped.txt",
      ],
      { cwd: tree },
    );
    const dest = path.join(ROOT, "dash-out");
    mkdirFresh(dest);

    await openBrowseArchive(archive, "normal.txt");
    await openSelectiveExtractPicker();
    await toggleSelectiveMember("-dash.txt");
    await toggleSelectiveMember("-dir");
    await toggleSelectiveMember("normal.txt");
    await confirmSelectiveExtract(dest);

    await browser.waitUntil(
      () => fs.existsSync(path.join(dest, "normal.txt")),
      {
        timeout: 120_000,
        timeoutMsg: `selective extract did not publish normal.txt; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();

    assert.equal(
      fs.readFileSync(path.join(dest, "-dash.txt"), "utf8"),
      "dash\n",
      "member -dash.txt was silently skipped",
    );
    assert.equal(
      fs.readFileSync(path.join(dest, "-dir", "inner.txt"), "utf8"),
      "inner\n",
      "folder -dir was silently skipped",
    );
    assert.equal(fs.existsSync(path.join(dest, "skipped.txt")), false);

    writeEvidence(EVIDENCE_DIR, "selective-extract-dash-members", {
      scenario: "selective-extract-dash-members",
      archive,
      destination: dest,
      selected: ["-dash.txt", "-dir/", "normal.txt"],
      tree: treeManifest(dest),
    });
  });

  it("selectively extracts only checked files and folders in Power mode", async () => {
    const archive = buildSelectiveFixtureArchive();
    const dest = path.join(ROOT, "selective-out");
    mkdirFresh(dest);

    await openBrowseArchive(archive, "keep-me.txt");
    await openSelectiveExtractPicker();
    await toggleSelectiveMember("keep");
    await expandSelectiveFolder("skip");
    await browser.waitUntil(() => hasSelectiveMember("skip/skip-me.txt"), {
      timeout: 10_000,
      timeoutMsg: "selective tree did not show skip/skip-me.txt",
    });
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
    const outA = path.join(dest, "batch-a", "batch-a", "from-a.txt");
    const outB = path.join(dest, "batch-b", "batch-b", "from-b.txt");
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

  it("reopens the incorrect-password prompt in Power after a wrong password and cancels cleanly", async () => {
    const archive = process.env.ZINNIA_E2E_ENCRYPTED_7Z;
    const wrongPassword = wrongPasswordGlobal();
    const visibleUiTexts = () =>
      browser.execute(() => {
        const texts = [];
        const status = document.getElementById("status")?.textContent?.trim();
        if (status) texts.push(status);
        for (const toast of document.querySelectorAll(".toast-message")) {
          const line = toast.textContent?.trim();
          if (line) texts.push(line);
        }
        const banner = document
          .getElementById("startup-recovery-banner-text")
          ?.textContent?.trim();
        if (banner) texts.push(banner);
        const overlay = document.getElementById("input-modal-overlay");
        if (overlay && overlay.hidden === false) {
          const prompt = overlay.textContent?.replace(/\s+/g, " ").trim();
          if (prompt) texts.push(prompt);
        }
        return texts;
      });

    await abortArchiveOperationIfBusy();
    const powerDest = path.join(ROOT, "wrong-password-power");
    mkdirFresh(powerDest);
    await dismissToasts();
    await startPowerExtract(archive, powerDest, { password: wrongPassword });
    await waitForInputModalLabel(
      POWER_INCORRECT_PASSWORD_MODAL_LABEL,
      `Power did not show incorrect-password retry modal; ${await uiDiagnostics()}`,
    );
    await browser.execute(() => {
      window.__extractFlowsPromptObserver?.disconnect();
      window.__extractFlowsPromptOpens = 0;
      const overlay = document.getElementById("input-modal-overlay");
      if (!overlay) throw new Error("missing #input-modal-overlay");
      const observer = new MutationObserver(() => {
        if (!overlay.hidden) window.__extractFlowsPromptOpens += 1;
      });
      observer.observe(overlay, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
      window.__extractFlowsPromptObserver = observer;
    });
    await confirmInputModal(wrongPassword);
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (window.__extractFlowsPromptOpens ?? 0) >= 1 &&
            document.getElementById("input-modal-overlay")?.hidden === false,
        ),
      {
        timeout: 120_000,
        timeoutMsg: `Power did not reopen the prompt after the retried wrong password; ${await uiDiagnostics()}`,
      },
    );
    const reopenedLabel = await waitForInputModalLabel(
      POWER_INCORRECT_PASSWORD_MODAL_LABEL,
      `Power reopened prompt lost the incorrect-password label; ${await uiDiagnostics()}`,
    );
    const promptTexts = await visibleUiTexts();
    assertNoRaw7zMarkers(promptTexts, "Power reopened wrong-password prompt");

    await cancelInputModal();
    let cancelledStatus = "";
    await browser.waitUntil(
      async () => {
        cancelledStatus = await browser.execute(
          () => document.getElementById("status")?.textContent ?? "",
        );
        return cancelledStatus === "Cancelled";
      },
      {
        timeout: 120_000,
        interval: 100,
        timeoutMsg: `Power did not end Cancelled after the prompt was cancelled; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle(120_000);
    assert.equal(
      await isInputModalOpen(),
      false,
      "prompt stayed open after cancel",
    );
    const cancelledTexts = await visibleUiTexts();
    assertNoRaw7zMarkers(cancelledTexts, "Power cancelled wrong-password run");
    assertDestinationHasNoFiles(powerDest);

    await dismissToasts();
    writeEvidence(EVIDENCE_DIR, "wrong-password", {
      scenario: "wrong-password-reopen-then-cancel",
      archive,
      wrongPassword,
      reopenedPromptLabel: reopenedLabel,
      promptOpensAfterRetry: await browser.execute(
        () => window.__extractFlowsPromptOpens ?? 0,
      ),
      observedTextsWhilePrompting: promptTexts,
      cancelledStatus,
      observedTextsAfterCancel: cancelledTexts,
      destination: powerDest,
      tree: treeManifest(powerDest),
    });
  });

  it("re-prompts Basic extract with the incorrect-password label after a wrong password", async () => {
    const archive = process.env.ZINNIA_E2E_ENCRYPTED_7Z;
    const goodPassword = process.env.ZINNIA_E2E_PASSWORD;
    const wrongPassword = wrongPasswordGlobal();
    const payload = process.env.ZINNIA_E2E_PAYLOAD;

    await abortArchiveOperationIfBusy();
    await dismissToasts();
    const basicDest = path.join(ROOT, "wrong-password-basic");
    mkdirFresh(basicDest);
    await prepareBasicExtract(archive, basicDest);
    await clickBasicRunExtract();
    await confirmInputModal(wrongPassword);
    await waitForInputModalLabel(
      POWER_INCORRECT_PASSWORD_MODAL_LABEL,
      `Basic did not show the incorrect-password retry prompt; ${await uiDiagnostics()}`,
    );
    assertDestinationHasNoFiles(basicDest);
    await confirmInputModal(goodPassword);
    const extracted = path.join(basicDest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 120_000,
      timeoutMsg: `Basic extract with correct password did not write ${extracted}`,
    });
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);

    await dismissToasts();
    writeEvidence(EVIDENCE_DIR, "wrong-password-basic", {
      scenario: "wrong-password-basic",
      archive,
      wrongPassword,
      destination: basicDest,
      extractedHello: extracted,
      tree: treeManifest(basicDest),
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
