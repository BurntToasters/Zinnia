import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  activityLogText,
  applyIncomingPaths,
  clearPowerExtractSession,
  clickBasicRunExtract,
  confirmInputModal,
  dismissToasts,
  isInputModalOpen,
  openBasicBrowseForArchive,
  startPowerBatchExtract,
  startPowerExtract,
  switchToBasicWorkspace,
  toastTexts,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForBasicBrowseStatusIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
  waitForToastContaining,
} from "../helpers/ui-driver.js";
import { treeManifest, writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-fe-password-batch");
const sidecar = requireHostSidecar();

const STEP_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 60_000;

const FIRST_PROMPT_LABEL = "This archive is encrypted. Enter password:";
const RETRY_PROMPT_LABEL = "Incorrect password. Enter the archive password:";
const RAW_7Z_MARKERS = ["ERROR:", "Cannot open", "Can not open", "7-Zip ("];
const PASSWORD_A = "beta2-pass-alpha";
const PASSWORD_B = "beta2-pass-bravo";
const WRONG_ONE = "beta2-wrong-one";
const WRONG_TWO = "beta2-wrong-two";

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeTextFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function buildArchive(archive, sourceDir, entries, options = {}) {
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.rmSync(archive, { force: true });
  const format = options.format ?? "7z";
  const extra = options.password
    ? [
        `-p${options.password}`,
        options.headerEncrypted === false ? "-mhe=off" : "-mhe=on",
      ]
    : [];
  run7z(
    sidecar,
    [
      "a",
      `-t${format}`,
      ...(options.switches ?? []),
      ...extra,
      archive,
      ...entries,
    ],
    { cwd: sourceDir },
  );
  return archive;
}

function buildCorruptPackedArchive(archive, sourceDir, entries) {
  buildArchive(archive, sourceDir, entries, { switches: ["-m0=Copy"] });
  const bytes = fs.readFileSync(archive);
  bytes[34] ^= 0xff;
  fs.writeFileSync(archive, bytes);
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

async function installPromptOpenCounter() {
  await browser.execute(() => {
    const overlay = document.getElementById("input-modal-overlay");
    if (!overlay) throw new Error("missing #input-modal-overlay");
    window.__beta2PromptOpens = 0;
    window.__beta2PromptObserver?.disconnect();
    const observer = new MutationObserver(() => {
      if (!overlay.hidden) window.__beta2PromptOpens += 1;
    });
    observer.observe(overlay, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    window.__beta2PromptObserver = observer;
  });
}

async function promptOpenCount() {
  return browser.execute(() => window.__beta2PromptOpens ?? 0);
}

async function waitForPromptOpenCount(count, timeoutMsg) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (wanted) =>
          (window.__beta2PromptOpens ?? 0) >= wanted &&
          document.getElementById("input-modal-overlay")?.hidden === false,
        count,
      ),
    {
      timeout: STEP_TIMEOUT_MS,
      timeoutMsg: `${timeoutMsg}; ${await uiDiagnostics()}`,
    },
  );
}

async function promptLabel() {
  return browser.execute(
    () =>
      document.getElementById("input-modal-label")?.textContent?.trim() ?? "",
  );
}

async function waitForPromptLabel(fragment, timeoutMsg) {
  await browser.waitUntil(
    async () => {
      if (!(await isInputModalOpen())) return false;
      return (await promptLabel()).includes(fragment);
    },
    {
      timeout: STEP_TIMEOUT_MS,
      timeoutMsg: `${timeoutMsg}; ${await uiDiagnostics()}`,
    },
  );
  return promptLabel();
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

async function waitForListingMember(member, timeoutMsg) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (wanted) =>
          (document.getElementById("browse-tbody")?.textContent ?? "").includes(
            wanted,
          ),
        member,
      ),
    {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `${timeoutMsg}; ${await uiDiagnostics()}`,
    },
  );
}

async function returnToIdle(timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let observed = null;
  while (Date.now() < deadline) {
    observed = await browser.execute(() => {
      const overlayOpen =
        document.getElementById("input-modal-overlay")?.hidden === false;
      if (overlayOpen) {
        document.getElementById("input-modal-cancel")?.click();
      }
      document.getElementById("cancel-action")?.click();
      const power = document.getElementById("workspace-mode-power");
      return { overlayOpen, powerLocked: !power || power.disabled };
    });
    if (!observed.overlayOpen && !observed.powerLocked) {
      await dismissToasts();
      return;
    }
    await browser.pause(500);
  }
  throw new Error(
    `app stayed busy (${JSON.stringify(observed)}); ${await uiDiagnostics()}`,
  );
}

async function resetForScenario() {
  await returnToIdle();
  await clearPowerExtractSession();
}

async function countEncryptedListingNotices() {
  return browser.execute(
    () =>
      (document.getElementById("log")?.textContent ?? "").split(
        "Archive appears to be encrypted",
      ).length - 1,
  );
}

async function startTimelineRecording() {
  await browser.execute(() => {
    window.__e3Timeline = [];
    const note = (what) =>
      window.__e3Timeline.push(`${Date.now() % 100000} ${what}`);
    const lastLine = (el) =>
      (el?.textContent ?? "").trim().split("\n").slice(-1)[0].slice(0, 160);
    const logEl = document.getElementById("log");
    const statusEl = document.getElementById("status");
    const overlay = document.getElementById("input-modal-overlay");
    const toastRegion = document.getElementById("toast-region");
    new MutationObserver(() => note(`log: ${lastLine(logEl)}`)).observe(logEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    new MutationObserver(() =>
      note(`status: ${statusEl?.textContent}`),
    ).observe(statusEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    new MutationObserver(() =>
      note(`overlay hidden=${overlay?.hidden}`),
    ).observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
    new MutationObserver(() => note("toast added")).observe(toastRegion, {
      childList: true,
      subtree: true,
    });
  });
}

async function recordTimeline(what) {
  await browser.execute((text) => {
    window.__e3Timeline?.push(`${Date.now() % 100000} ${text}`);
  }, what);
}

async function applyBrowseWithoutWaiting(archive) {
  await waitForE2eHook();
  await browser.execute((target) => {
    window.__beta2Apply = { settled: false, error: null };
    window.__ZINNIA_E2E__
      .applyIncomingPaths([target], "")
      .then(() => {
        window.__beta2Apply.settled = true;
      })
      .catch((err) => {
        window.__beta2Apply.error =
          err instanceof Error ? err.message : String(err);
      });
  }, archive);
}

async function setBasicInputsTo(archives, dest) {
  await switchToBasicWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
  await applyIncomingPaths(archives, "extract");
  await browser.execute((target) => {
    const field = document.getElementById("basic-extract-path");
    if (field) field.value = target;
  }, dest);
}

describe("beta2 frontend password retry and batch extract", function () {
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
    await returnToIdle().catch(() => undefined);
  });

  it("E1 retries a header-encrypted archive after two wrong passwords (M4)", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e1");
    writeTextFile(
      path.join(scenario, "src", "retry-header.txt"),
      "retry header\n",
    );
    const archive = buildArchive(
      path.join(scenario, "retry-header.7z"),
      path.join(scenario, "src"),
      ["retry-header.txt"],
      { password: PASSWORD_A },
    );

    await resetForScenario();
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);
    await installPromptOpenCounter();

    await startPowerExtract(archive, dest, { password: WRONG_ONE });
    const firstLabel = await waitForPromptLabel(
      RETRY_PROMPT_LABEL,
      "the wrong password typed in Power did not open the retry prompt",
    );
    await confirmInputModal(WRONG_TWO);

    await waitForPromptOpenCount(
      2,
      "prompt did not reopen after the retried wrong password; the retry aborted",
    );
    const secondLabel = await waitForPromptLabel(
      RETRY_PROMPT_LABEL,
      "reopened prompt did not say the password was incorrect",
    );
    await confirmInputModal(PASSWORD_A);

    const extracted = path.join(dest, "retry-header.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `correct password did not extract ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), "retry header\n");
    assert.equal(await isInputModalOpen(), false);
    const texts = await collectUserFacingTexts();
    assertNoRaw7zMarkers(texts, "E1 final status");

    writeEvidence(EVIDENCE_DIR, "beta2-fe-password-batch-e1-header-retry", {
      scenario: "header-encrypted-wrong-retry-then-right",
      archive,
      promptLabels: [firstLabel, secondLabel],
      promptOpens: await promptOpenCount(),
      observedTexts: texts,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("E2 does not reuse a browse password for a different encrypted archive", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e2");
    writeTextFile(path.join(scenario, "src-a", "browse-a.txt"), "a\n");
    writeTextFile(path.join(scenario, "src-b", "browse-b.txt"), "b\n");
    const archiveA = buildArchive(
      path.join(scenario, "browse-a.7z"),
      path.join(scenario, "src-a"),
      ["browse-a.txt"],
      { password: PASSWORD_A },
    );
    const archiveB = buildArchive(
      path.join(scenario, "browse-b.7z"),
      path.join(scenario, "src-b"),
      ["browse-b.txt"],
      { password: PASSWORD_B },
    );

    await resetForScenario();
    await installPromptOpenCounter();

    await applyBrowseWithoutWaiting(archiveA);
    await waitForPromptLabel(FIRST_PROMPT_LABEL, "browse of A did not prompt");
    await confirmInputModal(PASSWORD_A);
    await waitForListingMember(
      "browse-a.txt",
      "browse of A did not list its members",
    );
    await waitForArchiveIdle();
    const opensAfterA = await promptOpenCount();

    await applyBrowseWithoutWaiting(archiveB);
    await waitForPromptOpenCount(
      opensAfterA + 1,
      "browse of B did not ask for its own password",
    );
    const labelForB = await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "browse of B sent the password for A instead of asking",
    );
    await confirmInputModal(PASSWORD_B);
    await waitForListingMember(
      "browse-b.txt",
      "browse of B did not list its members",
    );
    await waitForArchiveIdle();

    writeEvidence(
      EVIDENCE_DIR,
      "beta2-fe-password-batch-e2-browse-not-reused",
      {
        scenario: "browse-a-then-browse-b",
        archives: [archiveA, archiveB],
        promptOpensAfterA: opensAfterA,
        promptOpensTotal: await promptOpenCount(),
        labelForB,
        durationMs: Date.now() - started,
      },
    );
  });

  it("E3 Basic Extract all asks for the password again after the archive file changes (M5)", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e3");
    const archive = path.join(scenario, "locked-basic.7z");
    writeTextFile(path.join(scenario, "src", "basic-a.txt"), "basic a\n");
    buildArchive(archive, path.join(scenario, "src"), ["basic-a.txt"], {
      password: PASSWORD_A,
    });
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);
    const extracted = path.join(dest, "basic-a.txt");

    await resetForScenario();
    await startTimelineRecording();
    const noticesBefore = await countEncryptedListingNotices();
    await openBasicBrowseForArchive(archive);
    await browser.waitUntil(
      async () => (await countEncryptedListingNotices()) > noticesBefore,
      {
        timeout: EXTRACT_TIMEOUT_MS,
        timeoutMsg: `Basic auto-browse never reported the encrypted listing; ${await uiDiagnostics()}`,
      },
    );
    await recordTimeline("auto-browse notice seen");
    await waitForBasicBrowseStatusIdle(
      "Basic browse did not settle before the password",
    );
    await recordTimeline("basic browse idle before password");
    await recordTimeline("typed password and Enter");
    await browser.execute((password) => {
      const field = document.getElementById("basic-browse-password");
      if (!field) throw new Error("missing #basic-browse-password");
      field.value = password;
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    }, PASSWORD_A);
    await waitForListingMember(
      "basic-a.txt",
      "Basic browse with the password did not list members",
    );
    await waitForBasicBrowseStatusIdle("Basic browse did not finish listing");
    await recordTimeline("password listing finished");
    writeTextFile(
      path.join(scenario, "changed", "basic-a.txt"),
      "basic changed\n",
    );
    await recordTimeline("file replaced");
    buildArchive(archive, path.join(scenario, "changed"), ["basic-a.txt"], {
      password: PASSWORD_A,
    });
    await browser.execute((target) => {
      const field = document.getElementById("basic-extract-path");
      if (field) field.value = target;
    }, dest);

    await recordTimeline("extract-all click");
    await browser.execute(() => {
      document.getElementById("basic-browse-extract-all")?.click();
    });
    await browser.waitUntil(
      async () => (await isInputModalOpen()) || fs.existsSync(extracted),
      {
        timeout: EXTRACT_TIMEOUT_MS,
        timeoutMsg: `Basic Extract all neither asked for a password nor extracted; ${await uiDiagnostics()}`,
      },
    );
    const askedAgain = await isInputModalOpen();
    assert.equal(
      askedAgain,
      true,
      `Basic Extract all reused the browsed password without asking; ${await uiDiagnostics()}`,
    );
    const label = await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "Basic Extract all did not show the first-attempt password prompt",
    );
    await browser.execute(() => {
      document.getElementById("input-modal-cancel")?.click();
    });
    await browser.waitUntil(async () => !(await isInputModalOpen()), {
      timeout: STEP_TIMEOUT_MS,
      timeoutMsg: `password prompt stayed open after cancel; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    assert.equal(
      fs.existsSync(extracted),
      false,
      "cancelling the prompt for a changed archive still extracted it",
    );

    writeEvidence(
      EVIDENCE_DIR,
      "beta2-fe-password-batch-e3-basic-extract-all",
      {
        scenario: "basic-browse-file-changed-then-extract-all-cancelled",
        archive,
        promptLabel: label,
        destination: dest,
        tree: treeManifest(dest),
        durationMs: Date.now() - started,
      },
    );
  });

  it("E4 gives each archive in a batch its own folder when member names overlap", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e4");
    const names = ["alpha", "bravo", "charlie"];
    const archives = names.map((name) => {
      const source = path.join(scenario, "src", name);
      writeTextFile(
        path.join(source, "shared", "readme.txt"),
        `${name} copy\n`,
      );
      return buildArchive(path.join(scenario, `${name}.7z`), source, [
        "shared",
      ]);
    });
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);

    await resetForScenario();
    await startPowerBatchExtract(archives, dest);
    const outputs = names.map((name) =>
      path.join(dest, name, "shared", "readme.txt"),
    );
    await browser.waitUntil(
      () => outputs.every((file) => fs.existsSync(file)),
      {
        timeout: EXTRACT_TIMEOUT_MS,
        timeoutMsg: `batch did not write every per-archive copy; ${outputs.map((file) => fs.existsSync(file)).join(",")}; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();
    for (const [index, name] of names.entries()) {
      assert.equal(
        fs.readFileSync(outputs[index], "utf8"),
        `${name} copy\n`,
        `${name} copy was merged into another archive's folder`,
      );
    }

    writeEvidence(
      EVIDENCE_DIR,
      "beta2-fe-password-batch-e4-overlapping-members",
      {
        scenario: "three-archives-same-member",
        inputs: archives,
        destination: dest,
        tree: treeManifest(dest),
        durationMs: Date.now() - started,
      },
    );
  });

  it("E5 gives unique folders to two archives with the same base name", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e5");
    writeTextFile(path.join(scenario, "src-a", "one.txt"), "one\n");
    writeTextFile(path.join(scenario, "src-b", "two.txt"), "two\n");
    const archiveA = buildArchive(
      path.join(scenario, "a", "data.7z"),
      path.join(scenario, "src-a"),
      ["one.txt"],
    );
    const archiveB = buildArchive(
      path.join(scenario, "b", "data.zip"),
      path.join(scenario, "src-b"),
      ["two.txt"],
      { format: "zip" },
    );
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);

    await resetForScenario();
    await startPowerBatchExtract([archiveA, archiveB], dest);
    const outA = path.join(dest, "data", "one.txt");
    const outB = path.join(dest, "data (2)", "two.txt");
    await browser.waitUntil(() => fs.existsSync(outA) && fs.existsSync(outB), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `batch did not write ${outA} and ${outB}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(outA, "utf8"), "one\n");
    assert.equal(fs.readFileSync(outB, "utf8"), "two\n");

    writeEvidence(EVIDENCE_DIR, "beta2-fe-password-batch-e5-same-base-name", {
      scenario: "same-base-name-different-folders",
      inputs: [archiveA, archiveB],
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("E6 names the corrupt archive in a batch summary (M13)", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e6");
    writeTextFile(path.join(scenario, "src", "good.txt"), "good\n");
    const good = buildArchive(
      path.join(scenario, "good.7z"),
      path.join(scenario, "src"),
      ["good.txt"],
    );
    writeTextFile(
      path.join(scenario, "src-corrupt", "corrupt.txt"),
      "corrupt payload bytes for the batch test\n",
    );
    const corrupt = buildCorruptPackedArchive(
      path.join(scenario, "corrupt.7z"),
      path.join(scenario, "src-corrupt"),
      ["corrupt.txt"],
    );
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);

    await resetForScenario();
    await startPowerBatchExtract([good, corrupt], dest);
    await browser.waitUntil(
      () => fs.existsSync(path.join(dest, "good", "good.txt")),
      {
        timeout: EXTRACT_TIMEOUT_MS,
        timeoutMsg: `batch did not extract the good archive; ${await uiDiagnostics()}`,
      },
    );
    await waitForToastContaining(
      "corrupt.7z",
      `batch summary did not name the corrupt archive; ${await uiDiagnostics()}`,
    );
    await waitForArchiveIdle();
    const toasts = await toastTexts();
    const summary = toasts.find((line) => line.includes("corrupt.7z")) ?? "";
    assert.match(
      summary,
      /1 failed/,
      `summary did not count the failure: ${summary}`,
    );
    const log = await activityLogText();
    assert.match(
      log,
      /corrupt\.7z/,
      "activity log must name the corrupt archive",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-password-batch-e6-corrupt-named", {
      scenario: "batch-with-one-corrupt-archive",
      inputs: [good, corrupt],
      summary,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("E7 does not open the password loop for a member named like a password prompt", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e7");
    writeTextFile(
      path.join(scenario, "src", "wrong password.txt"),
      "plain one\n",
    );
    writeTextFile(
      path.join(scenario, "src", "enter password.md"),
      "plain two\n",
    );
    const archive = buildArchive(
      path.join(scenario, "plain.7z"),
      path.join(scenario, "src"),
      ["wrong password.txt", "enter password.md"],
    );
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);

    await resetForScenario();
    await installPromptOpenCounter();
    await startPowerExtract(archive, dest);
    const outputs = [
      path.join(dest, "wrong password.txt"),
      path.join(dest, "enter password.md"),
    ];
    await browser.waitUntil(
      () => outputs.every((file) => fs.existsSync(file)),
      {
        timeout: EXTRACT_TIMEOUT_MS,
        timeoutMsg: `plain archive did not extract its members; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();
    assert.equal(
      await promptOpenCount(),
      0,
      "a member named like a password prompt opened the password modal",
    );
    assert.equal(await isInputModalOpen(), false);

    writeEvidence(
      EVIDENCE_DIR,
      "beta2-fe-password-batch-e7-member-name-no-prompt",
      {
        scenario: "plain-archive-with-password-like-member-names",
        archive,
        promptOpens: 0,
        destination: dest,
        tree: treeManifest(dest),
        durationMs: Date.now() - started,
      },
    );
  });

  it("E8 shows a partial Basic completion that names a skipped archive (M13)", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "e8");
    writeTextFile(path.join(scenario, "src-first", "first.txt"), "first\n");
    writeTextFile(path.join(scenario, "src-locked", "second.txt"), "second\n");
    const first = buildArchive(
      path.join(scenario, "first.7z"),
      path.join(scenario, "src-first"),
      ["first.txt"],
    );
    const locked = buildArchive(
      path.join(scenario, "locked.7z"),
      path.join(scenario, "src-locked"),
      ["second.txt"],
      { password: PASSWORD_B, headerEncrypted: false },
    );
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);

    await resetForScenario();
    await setBasicInputsTo([first, locked], dest);
    await installPromptOpenCounter();
    await clickBasicRunExtract();
    await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "Basic batch did not prompt for the locked archive",
    );
    await browser.execute(() => {
      document.getElementById("input-modal-skip")?.click();
    });

    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .getElementById("basic-extract-completion")
              ?.classList.contains("is-active") &&
            document.getElementById("basic-extract-completion-title")
              ?.textContent === "Extraction incomplete",
        ),
      {
        timeout: EXTRACT_TIMEOUT_MS,
        timeoutMsg: `Basic batch did not show the partial completion; ${await uiDiagnostics()}`,
      },
    );
    const panel = await browser.execute(() => ({
      message:
        document.getElementById("basic-extract-completion-msg")?.textContent ??
        "",
      openFolderHidden:
        document.getElementById("basic-extract-open-dest")?.hidden ?? null,
      secondary:
        document.getElementById("basic-extract-another")?.textContent ?? "",
      secondaryAction:
        document.getElementById("basic-extract-another")?.dataset
          .completionAction ?? "",
      successVariant:
        document
          .getElementById("basic-extract-completion")
          ?.classList.contains("basic-completion--success") ?? false,
    }));
    await waitForArchiveIdle();

    assert.match(
      panel.message,
      /locked\.7z/,
      `partial completion did not name the skipped archive: ${panel.message}`,
    );
    assert.equal(panel.successVariant, false, "partial batch shown as success");
    assert.equal(
      panel.openFolderHidden,
      false,
      "Open folder hidden for a partial batch",
    );
    assert.equal(panel.secondary, "Close");
    assert.equal(panel.secondaryAction, "dismiss");
    assert.equal(fs.existsSync(path.join(dest, "first", "first.txt")), true);
    assert.equal(
      fs.existsSync(path.join(dest, "locked", "second.txt")),
      false,
      "the skipped archive must not be extracted",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-password-batch-e8-basic-partial", {
      scenario: "basic-batch-with-skipped-archive",
      inputs: [first, locked],
      completionMessage: panel.message,
      openFolderVisible: panel.openFolderHidden === false,
      secondaryLabel: panel.secondary,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });
});
