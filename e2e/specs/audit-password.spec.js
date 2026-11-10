import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  activityLogText,
  cancelInputModal,
  clearPowerExtractSession,
  confirmInputModal,
  dismissToasts,
  isInputModalOpen,
  startPowerBatchExtract,
  startPowerExtract,
  uiDiagnostics,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { treeManifest, writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-password");
const sidecar = requireHostSidecar();

// Per-step limits. The whole spec must finish inside the runner's 900 s cap,
// so a stuck step fails in tens of seconds, not in the default two minutes.
const STEP_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 60_000;

const FIRST_PROMPT_LABEL = "This archive is encrypted. Enter password:";
const RETRY_PROMPT_LABEL = "Incorrect password. Enter the archive password:";
const NOT_ARCHIVE_HINT =
  "The file is not a supported archive or is corrupted. Try testing the archive first.";
const RAW_7Z_MARKERS = ["ERROR:", "Cannot open", "Can not open", "7-Zip ("];
const PASSWORD_A = "audit-pass-alpha";
const PASSWORD_B = "audit-pass-bravo";
const WRONG_ONE = "audit-wrong-one";
const WRONG_TWO = "audit-wrong-two";

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function buildEncryptedArchive(name, password, payloadName, payload) {
  const dir = path.join(ROOT, `${name}-src`);
  mkdirFresh(dir);
  fs.writeFileSync(path.join(dir, payloadName), payload);
  const archive = path.join(ROOT, `${name}.7z`);
  fs.rmSync(archive, { force: true });
  run7z(
    sidecar,
    ["a", "-t7z", `-p${password}`, "-mhe=off", archive, payloadName],
    { cwd: dir },
  );
  return archive;
}

async function collectUserFacingTexts() {
  return browser.execute(() => {
    const texts = [];
    const status = document.getElementById("status")?.textContent?.trim();
    if (status) texts.push(status);
    for (const toast of document.querySelectorAll(".toast-message")) {
      const line = toast.textContent?.trim();
      if (line) texts.push(line);
    }
    return texts;
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

/**
 * Counts every time the input modal opens. A retry that reopens the same
 * prompt with the same label is otherwise indistinguishable from the old one.
 */
async function installPromptOpenCounter() {
  await browser.execute(() => {
    const overlay = document.getElementById("input-modal-overlay");
    if (!overlay) throw new Error("missing #input-modal-overlay");
    window.__auditPromptOpens = 0;
    window.__auditPromptObserver?.disconnect();
    const observer = new MutationObserver(() => {
      if (!overlay.hidden) window.__auditPromptOpens += 1;
    });
    observer.observe(overlay, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    window.__auditPromptObserver = observer;
  });
}

async function waitForPromptOpenCount(count, timeoutMsg) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (wanted) =>
          (window.__auditPromptOpens ?? 0) >= wanted &&
          document.getElementById("input-modal-overlay")?.hidden === false,
        count,
      ),
    { timeout: STEP_TIMEOUT_MS, timeoutMsg },
  );
}

async function waitForPromptLabel(fragment, timeoutMsg) {
  await browser.waitUntil(
    async () => {
      if (!(await isInputModalOpen())) return false;
      const label = await browser.execute(
        () =>
          document.getElementById("input-modal-label")?.textContent?.trim() ??
          "",
      );
      return label.includes(fragment);
    },
    {
      timeout: STEP_TIMEOUT_MS,
      timeoutMsg: `${timeoutMsg}; ${await uiDiagnostics()}`,
    },
  );
  return browser.execute(
    () =>
      document.getElementById("input-modal-label")?.textContent?.trim() ?? "",
  );
}

async function waitForIdle(timeout = STEP_TIMEOUT_MS) {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const button = document.getElementById("workspace-mode-power");
        return Boolean(button && !button.disabled);
      }),
    { timeout, timeoutMsg: "Archive operation stayed active" },
  );
}

async function waitForExtractHint(hint, timeoutMsg) {
  await browser.waitUntil(
    async () => {
      const texts = await collectUserFacingTexts();
      return texts.some((line) => line.includes(hint));
    },
    {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `${timeoutMsg}; ${await uiDiagnostics()}`,
    },
  );
  return collectUserFacingTexts();
}

/** Close any open prompt, cancel a running operation, and wait briefly for idle. */
async function stopOpenPromptAndOperation() {
  await browser.execute(() => {
    if (document.getElementById("input-modal-overlay")?.hidden === false) {
      document.getElementById("input-modal-cancel")?.click();
    }
    document.getElementById("cancel-action")?.click();
  });
  await waitForIdle(20_000).catch(() => undefined);
  await dismissToasts();
}

/** Start from a clean app: nothing open, empty Power inputs, no toasts. */
async function resetForScenario() {
  await stopOpenPromptAndOperation();
  await clearPowerExtractSession();
}

function passwordToggleState() {
  return browser.execute(() => {
    const toggle = document.getElementById("input-modal-password-toggle");
    const field = document.getElementById("input-modal-field");
    return {
      present: Boolean(toggle),
      label: toggle?.getAttribute("aria-label") ?? null,
      pressed: toggle?.getAttribute("aria-pressed") ?? null,
      fieldType: field?.type ?? null,
    };
  });
}

describe("archive password retry and error hints", function () {
  this.timeout(5 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  // A failed step must not leave a prompt or a running operation behind,
  // or every later scenario stalls on it.
  afterEach(async () => {
    await stopOpenPromptAndOperation().catch(() => undefined);
  });

  it("re-prompts after each wrong password until the right one extracts", async function () {
    const started = Date.now();
    const archive = buildEncryptedArchive(
      "retry-power",
      PASSWORD_A,
      "retry.txt",
      "retry payload\n",
    );
    await resetForScenario();
    const dest = path.join(ROOT, "retry-power-out");
    mkdirFresh(dest);
    await installPromptOpenCounter();

    await startPowerExtract(archive, dest);
    await waitForPromptLabel(FIRST_PROMPT_LABEL, "no first password prompt");
    await confirmInputModal(WRONG_ONE);

    await waitForPromptOpenCount(
      2,
      "prompt did not reopen after the first wrong password",
    );
    const secondLabel = await waitForPromptLabel(
      RETRY_PROMPT_LABEL,
      "second prompt did not say the password was incorrect",
    );
    await confirmInputModal(WRONG_TWO);

    await waitForPromptOpenCount(
      3,
      "prompt did not reopen after the second wrong password",
    );
    const thirdLabel = await waitForPromptLabel(
      RETRY_PROMPT_LABEL,
      "third prompt did not say the password was incorrect",
    );
    await confirmInputModal(PASSWORD_A);

    const extracted = path.join(dest, "retry.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `correct password did not extract ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), "retry payload\n");
    assert.equal(await isInputModalOpen(), false);

    writeEvidence(EVIDENCE_DIR, "audit-password-retry-power", {
      scenario: "retry-power",
      archive,
      promptLabels: [FIRST_PROMPT_LABEL, secondLabel, thirdLabel],
      promptOpens: 3,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("skips an encrypted archive in a batch and extracts the next one", async function () {
    const started = Date.now();
    const archiveA = buildEncryptedArchive(
      "skip-a",
      PASSWORD_A,
      "from-a.txt",
      "a payload\n",
    );
    const archiveB = buildEncryptedArchive(
      "skip-b",
      PASSWORD_B,
      "from-b.txt",
      "b payload\n",
    );
    await resetForScenario();
    const dest = path.join(ROOT, "skip-batch-out");
    mkdirFresh(dest);
    await installPromptOpenCounter();

    await startPowerBatchExtract([archiveA, archiveB], dest);
    await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "batch did not prompt for the first archive",
    );
    await browser.execute(() => {
      document.getElementById("input-modal-skip")?.click();
    });

    await waitForPromptOpenCount(
      2,
      "batch did not move on to the second archive after Skip",
    );
    await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "second archive did not prompt for its own password",
    );
    await confirmInputModal(PASSWORD_B);

    // Payloads sit at the archive root, so each one lands directly in dest.
    const extracted = path.join(dest, "from-b.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `batch did not extract ${extracted} after Skip; ${await uiDiagnostics()}`,
    });
    await waitForIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), "b payload\n");
    assert.equal(
      fs.existsSync(path.join(dest, "from-a.txt")),
      false,
      "the skipped archive must not be extracted",
    );

    const log = await activityLogText();
    assert.match(
      log,
      /skip-a\.7z/,
      "activity log must name the skipped archive",
    );
    const summary = (await collectUserFacingTexts()).join("\n");
    assert.match(
      summary,
      /\b1 skipped\b/,
      `batch summary did not report the skip: ${summary}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-password-skip-batch", {
      scenario: "skip-batch",
      inputs: [archiveA, archiveB],
      destination: dest,
      tree: treeManifest(dest),
      summary,
      durationMs: Date.now() - started,
    });
  });

  it("prompts again for the second archive when the first password was carried", async function () {
    const started = Date.now();
    const archiveA = buildEncryptedArchive(
      "pair-a",
      PASSWORD_A,
      "pair-a.txt",
      "pair a\n",
    );
    const archiveB = buildEncryptedArchive(
      "pair-b",
      PASSWORD_B,
      "pair-b.txt",
      "pair b\n",
    );
    await resetForScenario();
    const dest = path.join(ROOT, "pair-batch-out");
    mkdirFresh(dest);
    await installPromptOpenCounter();

    await startPowerBatchExtract([archiveA, archiveB], dest);
    await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "batch did not prompt for the first archive",
    );
    await confirmInputModal(PASSWORD_A);

    // The first password is carried into the batch, so B's first attempt fails.
    await waitForPromptOpenCount(
      2,
      "batch did not prompt for the second archive",
    );
    const secondLabel = await waitForPromptLabel(
      RETRY_PROMPT_LABEL,
      "second archive did not say the carried password was incorrect",
    );
    await confirmInputModal(PASSWORD_B);

    const outA = path.join(dest, "pair-a.txt");
    const outB = path.join(dest, "pair-b.txt");
    await browser.waitUntil(() => fs.existsSync(outA) && fs.existsSync(outB), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `batch did not extract both archives; a=${fs.existsSync(outA)} b=${fs.existsSync(outB)}; ${await uiDiagnostics()}`,
    });
    await waitForIdle();

    writeEvidence(EVIDENCE_DIR, "audit-password-batch-carry", {
      scenario: "batch-carry",
      inputs: [archiveA, archiveB],
      secondPromptLabel: secondLabel,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("toggles password visibility in the prompt", async function () {
    const started = Date.now();
    const archive = buildEncryptedArchive(
      "toggle",
      PASSWORD_A,
      "toggle.txt",
      "toggle payload\n",
    );
    await resetForScenario();
    const dest = path.join(ROOT, "toggle-out");
    mkdirFresh(dest);

    await startPowerExtract(archive, dest);
    await waitForPromptLabel(FIRST_PROMPT_LABEL, "toggle prompt did not open");
    const hidden = await passwordToggleState();
    assert.equal(hidden.present, true, "prompt has no show/hide toggle");
    assert.equal(hidden.fieldType, "password");
    assert.equal(hidden.label, "Show password");
    assert.equal(hidden.pressed, "false");

    await browser.execute(() => {
      document.getElementById("input-modal-password-toggle")?.click();
    });
    const shown = await passwordToggleState();
    assert.equal(shown.fieldType, "text", "toggle did not reveal the field");
    assert.equal(shown.label, "Hide password");
    assert.equal(shown.pressed, "true");

    await browser.execute(() => {
      document.getElementById("input-modal-password-toggle")?.click();
    });
    const rehidden = await passwordToggleState();
    assert.equal(rehidden.fieldType, "password", "toggle did not mask again");
    assert.equal(rehidden.pressed, "false");

    await cancelInputModal();
    await waitForIdle();
    const afterClose = await passwordToggleState();
    assert.equal(afterClose.present, false, "toggle must be removed on close");

    writeEvidence(EVIDENCE_DIR, "audit-password-toggle", {
      scenario: "toggle",
      archive,
      states: { hidden, shown, rehidden },
      durationMs: Date.now() - started,
    });
  });

  it("keeps the prompt open when submitted empty", async function () {
    const started = Date.now();
    const archive = buildEncryptedArchive(
      "empty",
      PASSWORD_A,
      "empty.txt",
      "empty payload\n",
    );
    await resetForScenario();
    const dest = path.join(ROOT, "empty-out");
    mkdirFresh(dest);
    await installPromptOpenCounter();

    await startPowerExtract(archive, dest);
    await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "empty-submit prompt did not open",
    );
    await confirmInputModal("");

    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            (
              document.getElementById("input-modal-error")?.textContent ?? ""
            ).trim().length > 0,
        ),
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: "empty submit did not show a validation message",
      },
    );
    await browser.pause(1_000);
    assert.equal(
      await isInputModalOpen(),
      true,
      "empty submit closed the prompt",
    );
    assert.equal(
      await browser.execute(() => window.__auditPromptOpens ?? 0),
      1,
      "empty submit reopened the prompt instead of keeping it open",
    );
    const message = await browser.execute(
      () =>
        document.getElementById("input-modal-error")?.textContent?.trim() ?? "",
    );
    assert.ok(message.length > 0, "validation message is empty");

    await confirmInputModal(PASSWORD_A);
    await browser.waitUntil(() => fs.existsSync(path.join(dest, "empty.txt")), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `password entered after empty submit did not extract; ${await uiDiagnostics()}`,
    });
    await waitForIdle();

    writeEvidence(EVIDENCE_DIR, "audit-password-empty-submit", {
      scenario: "empty-submit",
      archive,
      validationMessage: message,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("shows the not-an-archive hint for a non-archive file", async function () {
    const started = Date.now();
    const notArchive = path.join(ROOT, "not-an-archive.7z");
    // The 7z signature gets the file past the Rust extension/header check, so
    // 7-Zip itself reports that it cannot open the file as an archive.
    fs.writeFileSync(
      notArchive,
      Buffer.concat([
        Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
        Buffer.from("junk body that is not a real archive\n"),
      ]),
    );

    await resetForScenario();
    const dest = path.join(ROOT, "not-archive-out");
    mkdirFresh(dest);

    await startPowerExtract(notArchive, dest);
    const texts = await waitForExtractHint(
      NOT_ARCHIVE_HINT,
      "Power did not show the not-an-archive hint",
    );
    await waitForIdle();
    assertNoRaw7zMarkers(texts, "Power non-archive");
    assert.equal(
      texts.some((line) => line.includes("Wrong or missing password")),
      false,
      "a non-archive file must not be reported as a password problem",
    );

    writeEvidence(EVIDENCE_DIR, "audit-password-not-archive", {
      scenario: "not-archive",
      archive: notArchive,
      destination: dest,
      observedTexts: texts,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });
});
