import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  clickSettingsSave,
  confirmInputModal,
  dismissToasts,
  dispatchDocumentKey,
  isInputModalOpen,
  isShortcutsOverlayOpen,
  openBasicBrowseForArchive,
  openSettingsModal,
  prepareBasicExtract,
  setInputValue,
  setSelectValue,
  switchToBasicWorkspace,
  switchToPowerWorkspace,
  toastTexts,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
  waitForSettingsSavedAndClosed,
  waitForToastContaining,
} from "../helpers/ui-driver.js";
import { treeManifest, writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-fe-basic-sync");
const HELLO_TXT = process.env.ZINNIA_E2E_HELLO_TXT;
const HELLO_7Z = process.env.ZINNIA_E2E_HELLO_7Z;
const sidecar = requireHostSidecar();

const PASSWORD = "beta2-basic-alpha";
const WRONG_PASSWORD = "beta2-basic-wrong";
const STEP_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;
const PROMPT_FRAGMENT = "This archive is encrypted";

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function buildEncryptedArchive(
  name,
  password,
  { encryptHeaders = false } = {},
) {
  const dir = path.join(ROOT, `${name}-src`);
  mkdirFresh(dir);
  const payloadName = `${name}.txt`;
  const payload = `${name} payload\n`;
  fs.writeFileSync(path.join(dir, payloadName), payload);
  const archive = path.join(ROOT, `${name}.7z`);
  fs.rmSync(archive, { force: true });
  run7z(
    sidecar,
    [
      "a",
      "-t7z",
      `-p${password}`,
      encryptHeaders ? "-mhe=on" : "-mhe=off",
      archive,
      payloadName,
    ],
    { cwd: dir },
  );
  return { archive, payloadName, payload };
}

function proveEncrypted(archive) {
  const listing = run7z(sidecar, ["l", "-slt", "--", archive]).stdout;
  const wrong = run7z(sidecar, ["t", `-p${WRONG_PASSWORD}`, "--", archive], {
    allowFailure: true,
  });
  const right = run7z(sidecar, ["t", `-p${PASSWORD}`, "--", archive], {
    allowFailure: true,
  });
  return {
    encryptedFlag: /^Encrypted = \+\r?$/m.test(listing),
    wrongPasswordExit: wrong.code,
    rightPasswordExit: right.code,
  };
}

function fieldValue(id) {
  return browser.execute(
    (fieldId) => document.getElementById(fieldId)?.value ?? null,
    id,
  );
}

function basicViewActive(view) {
  return browser.execute(
    (name) =>
      document
        .getElementById(`basic-${name}`)
        ?.classList.contains("is-active") ?? false,
    view,
  );
}

async function waitForBasicView(view) {
  await browser.waitUntil(() => basicViewActive(view), {
    timeout: STEP_TIMEOUT_MS,
    timeoutMsg: `Basic ${view} view did not become active`,
  });
}

function runEnabled(section) {
  return browser.execute((name) => {
    const button = document.getElementById(`basic-run-${name}`);
    return Boolean(button) && !button.disabled;
  }, section);
}

function anyProgressActive() {
  return browser.execute(() =>
    ["basic-compress-progress", "basic-extract-progress"].some(
      (id) =>
        document.getElementById(id)?.classList.contains("is-active") ?? false,
    ),
  );
}

function readCompletion(section) {
  return browser.execute((name) => {
    const panel = document.getElementById(`basic-${name}-completion`);
    const variant =
      ["success", "error", "cancelled"].find((kind) =>
        panel?.classList.contains(`basic-completion--${kind}`),
      ) ?? "";
    return {
      active: panel?.classList.contains("is-active") ?? false,
      variant,
      title:
        document
          .getElementById(`basic-${name}-completion-title`)
          ?.textContent?.trim() ?? "",
      body:
        document
          .getElementById(`basic-${name}-completion-msg`)
          ?.textContent?.trim() ?? "",
    };
  }, section);
}

async function waitForCompletion(section, timeoutMsg) {
  await browser.waitUntil(async () => (await readCompletion(section)).active, {
    timeout: RUN_TIMEOUT_MS,
    timeoutMsg,
  });
  return readCompletion(section);
}

async function clickRun(section) {
  await browser.execute((name) => {
    document.getElementById(`basic-run-${name}`)?.click();
  }, section);
}

async function clickBasicTab(view) {
  await browser.execute((name) => {
    document.getElementById(`basic-tab-${name}`)?.click();
  }, view);
  await waitForBasicView(view);
}

async function dispatchKeyOnField(id, key, ctrlKey) {
  await browser.execute(
    (fieldId, nextKey, ctrl) => {
      const field = document.getElementById(fieldId);
      if (!field) throw new Error(`missing #${fieldId}`);
      field.focus();
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: nextKey,
          ctrlKey: ctrl,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    id,
    key,
    ctrlKey,
  );
}

async function watchProgressPanel(section) {
  await browser.execute((name) => {
    const panel = document.getElementById(`basic-${name}-progress`);
    if (!panel) throw new Error(`missing basic-${name}-progress`);
    window.__beta2ProgressObserver?.disconnect();
    window.__beta2ProgressSeen = false;
    const observer = new MutationObserver(() => {
      if (panel.classList.contains("is-active")) {
        window.__beta2ProgressSeen = true;
      }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["class"] });
    window.__beta2ProgressObserver = observer;
  }, section);
}

async function stopProgressWatch() {
  return browser.execute(() => {
    window.__beta2ProgressObserver?.disconnect();
    delete window.__beta2ProgressObserver;
    const seen = window.__beta2ProgressSeen === true;
    delete window.__beta2ProgressSeen;
    return seen;
  });
}

async function watchPromptOpens() {
  await browser.execute(() => {
    const overlay = document.getElementById("input-modal-overlay");
    if (!overlay) throw new Error("missing #input-modal-overlay");
    window.__beta2PromptObserver?.disconnect();
    window.__beta2PromptOpens = 0;
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

async function stopPromptWatch() {
  return browser.execute(() => {
    window.__beta2PromptObserver?.disconnect();
    delete window.__beta2PromptObserver;
    const opens = window.__beta2PromptOpens ?? 0;
    delete window.__beta2PromptOpens;
    return opens;
  });
}

async function closeTransientOverlays() {
  await browser.execute(() => {
    const convert = document.getElementById("convert-overlay");
    if (convert) convert.hidden = true;
    const shortcuts = document.getElementById("shortcuts-overlay");
    if (shortcuts) shortcuts.hidden = true;
    if (document.getElementById("input-modal-overlay")?.hidden === false) {
      document.getElementById("input-modal-cancel")?.click();
    }
    if (document.getElementById("settings-overlay")?.hidden === false) {
      document.getElementById("close-settings")?.click();
    }
  });
}

async function resetBasicInputs() {
  await switchToBasicWorkspace();
  await dismissToasts();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
}

async function openBasicCompress(inputs) {
  await resetBasicInputs();
  if (inputs.length > 0) await applyIncomingPaths(inputs, "compress");
  await clickBasicTab("compress");
}

async function openBasicExtract(archive, dest) {
  await prepareBasicExtract(archive, dest);
  await clickBasicTab("extract");
}

async function clearPowerInputs() {
  await switchToPowerWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
}

describe("beta 2 Basic sync, Basic run keys and Basic failure panels", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  afterEach(async () => {
    await closeTransientOverlays().catch(() => undefined);
    await dismissToasts().catch(() => undefined);
  });

  it("keeps a typed Basic Compress password through Settings, a workspace round trip and re-entering Compress", async function () {
    const started = Date.now();
    const output = path.join(ROOT, "compress-password", "secret.7z");
    mkdirFresh(path.dirname(output));

    await openBasicCompress([HELLO_TXT]);
    await setSelectValue("#basic-format", "7z");
    await setInputValue("#basic-output-path", output);
    await setInputValue("#basic-password", PASSWORD);
    const powerAfterTyping = await fieldValue("password");

    await openSettingsModal();
    await clickSettingsSave();
    await waitForSettingsSavedAndClosed();
    const basicAfterSettings = await fieldValue("basic-password");

    await switchToPowerWorkspace();
    const powerInPower = await fieldValue("password");
    await switchToBasicWorkspace();
    await waitForBasicView("compress");
    const basicAfterToggle = await fieldValue("basic-password");

    await clickBasicTab("compress");
    const basicAfterReenter = await fieldValue("basic-password");

    assert.equal(
      powerAfterTyping === PASSWORD,
      true,
      "typing in Basic did not reach Power #password",
    );
    assert.equal(
      basicAfterSettings === PASSWORD,
      true,
      "saving Settings in Basic replaced the Basic password",
    );
    assert.equal(
      powerInPower === PASSWORD,
      true,
      "Power #password lost the Basic password before the toggle",
    );
    assert.equal(
      basicAfterToggle === PASSWORD,
      true,
      "the workspace round trip replaced the Basic password",
    );
    assert.equal(
      basicAfterReenter === PASSWORD,
      true,
      "re-entering Compress replaced the Basic password",
    );

    await clickRun("compress");
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic compress did not write ${output}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const completion = await readCompletion("compress");
    const proof = proveEncrypted(output);

    assert.equal(completion.title, "Archive created", completion.body);
    assert.equal(
      proof.encryptedFlag,
      true,
      "Basic Compress wrote an archive whose entries are not encrypted",
    );
    assert.equal(
      proof.rightPasswordExit,
      0,
      "the archive did not open with the typed password",
    );
    assert.notEqual(
      proof.wrongPasswordExit,
      0,
      "the archive opened with a wrong password",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-compress-password", {
      scenario: "compress-password-survives-settings-and-workspace-round-trip",
      output,
      mirroredToPowerAfterTyping: powerAfterTyping === PASSWORD,
      basicKeptAfterSettings: basicAfterSettings === PASSWORD,
      powerHeldBeforeToggle: powerInPower === PASSWORD,
      basicKeptAfterToggle: basicAfterToggle === PASSWORD,
      basicKeptAfterReenter: basicAfterReenter === PASSWORD,
      completionTitle: completion.title,
      encryptedFlag: proof.encryptedFlag,
      rightPasswordExit: proof.rightPasswordExit,
      wrongPasswordExit: proof.wrongPasswordExit,
      durationMs: Date.now() - started,
    });
  });

  it("keeps a typed Basic Extract password through a workspace round trip and extracts the encrypted archive", async function () {
    const started = Date.now();
    const { archive, payloadName, payload } = buildEncryptedArchive(
      "basic-extract-secret",
      PASSWORD,
    );
    const dest = path.join(ROOT, "extract-password-out");
    mkdirFresh(dest);

    await openBasicExtract(archive, dest);
    await setInputValue("#basic-extract-password", PASSWORD);
    const powerAfterTyping = await fieldValue("extract-password");

    await switchToPowerWorkspace();
    const powerInPower = await fieldValue("extract-password");
    await switchToBasicWorkspace();
    await waitForBasicView("extract");
    const basicAfterToggle = await fieldValue("basic-extract-password");

    assert.equal(
      powerAfterTyping === PASSWORD,
      true,
      "typing in Basic Extract did not reach Power #extract-password",
    );
    assert.equal(
      powerInPower === PASSWORD,
      true,
      "Power #extract-password lost the Basic password before the toggle",
    );
    assert.equal(
      basicAfterToggle === PASSWORD,
      true,
      "the workspace round trip replaced the Basic extract password",
    );

    await clickRun("extract");
    const extracted = path.join(dest, payloadName);
    await browser.waitUntil(
      async () => fs.existsSync(extracted) || (await isInputModalOpen()),
      {
        timeout: RUN_TIMEOUT_MS,
        timeoutMsg: `Basic extract neither wrote ${extracted} nor asked for a password; ${await uiDiagnostics()}`,
      },
    );
    const promptShown = !fs.existsSync(extracted) && (await isInputModalOpen());
    if (promptShown) {
      const label = await browser.execute(
        () =>
          document.getElementById("input-modal-label")?.textContent?.trim() ??
          "",
      );
      assert.ok(label.includes(PROMPT_FRAGMENT), `unexpected prompt: ${label}`);
      await confirmInputModal(PASSWORD);
    }
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Basic extract did not write ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const completion = await readCompletion("extract");

    assert.equal(
      fs.readFileSync(extracted, "utf8"),
      payload,
      "the extracted payload differs",
    );
    assert.equal(completion.title, "Extraction complete", completion.body);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-extract-password", {
      scenario: "extract-password-survives-workspace-round-trip",
      archive,
      destination: dest,
      mirroredToPowerAfterTyping: powerAfterTyping === PASSWORD,
      powerHeldBeforeToggle: powerInPower === PASSWORD,
      basicKeptAfterToggle: basicAfterToggle === PASSWORD,
      promptShown,
      completionTitle: completion.title,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("does nothing for Ctrl+Enter on Basic Home, even with Power inputs and an output path set", async function () {
    const started = Date.now();
    const sentinel = path.join(ROOT, "ctrl-home", "power-should-not-run.7z");
    mkdirFresh(path.dirname(sentinel));

    await clearPowerInputs();
    await applyIncomingPaths([HELLO_TXT], "compress");
    await setInputValue("#output-path", sentinel);
    await switchToBasicWorkspace();
    await clickBasicTab("home");
    await dispatchDocumentKey("Enter", { ctrlKey: true });
    await browser.pause(5_000);

    const sentinelWritten = fs.existsSync(sentinel);
    const progressActive = await anyProgressActive();

    assert.equal(
      sentinelWritten,
      false,
      "Ctrl+Enter on Basic Home started a Power compress",
    );
    assert.equal(
      progressActive,
      false,
      "Ctrl+Enter on Basic Home opened a progress panel",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-ctrl-enter-home", {
      scenario: "ctrl-enter-basic-home-noop",
      sentinel,
      sentinelWritten,
      progressActive,
      durationMs: Date.now() - started,
    });
  });

  it("runs the Basic compress flow for Ctrl+Enter typed in the Basic output field", async function () {
    const started = Date.now();
    const output = path.join(ROOT, "ctrl-compress", "keys.7z");
    mkdirFresh(path.dirname(output));

    await openBasicCompress([HELLO_TXT]);
    await setInputValue("#basic-output-path", output);
    await watchProgressPanel("compress");
    await dispatchKeyOnField("basic-output-path", "Enter", true);
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Ctrl+Enter in Basic Compress did not write ${output}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const progressSeen = await stopProgressWatch();
    const completion = await readCompletion("compress");
    const toasts = await toastTexts();

    assert.equal(
      progressSeen,
      true,
      "Ctrl+Enter in Basic Compress never opened the Basic progress panel",
    );
    assert.equal(completion.title, "Archive created", completion.body);
    assert.equal(
      completion.variant,
      "success",
      "the Basic completion is not the success variant",
    );
    assert.equal(
      toasts.some((line) => line.includes("already running")),
      false,
      "the shortcut started a second operation",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-ctrl-enter-compress", {
      scenario: "ctrl-enter-basic-compress-runs-basic-flow",
      output,
      progressSeen,
      completionTitle: completion.title,
      durationMs: Date.now() - started,
    });
  });

  it("shows the Basic failure panel for Ctrl+Enter in Basic Compress with no inputs", async function () {
    const started = Date.now();
    const output = path.join(ROOT, "ctrl-empty", "never.7z");
    mkdirFresh(path.dirname(output));

    await openBasicCompress([]);
    await setInputValue("#basic-output-path", output);
    await dispatchKeyOnField("basic-output-path", "Enter", true);
    const completion = await waitForCompletion(
      "compress",
      "Ctrl+Enter with no inputs did not show the Basic failure panel",
    );

    assert.equal(
      completion.variant,
      "error",
      "the panel is not the error variant",
    );
    assert.equal(completion.title, "Check your choices");
    assert.equal(completion.body, "Add at least one input.");
    assert.equal(fs.existsSync(output), false, "an archive was written");

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-ctrl-enter-empty", {
      scenario: "ctrl-enter-basic-compress-no-inputs",
      output,
      completionTitle: completion.title,
      completionMessage: completion.body,
      durationMs: Date.now() - started,
    });
  });

  it("runs the Basic extract flow for Ctrl+Enter in the Basic Extract view", async function () {
    const started = Date.now();
    const dest = path.join(ROOT, "ctrl-extract", "out");
    mkdirFresh(dest);

    await openBasicExtract(HELLO_7Z, dest);
    await watchProgressPanel("extract");
    await dispatchDocumentKey("Enter", { ctrlKey: true });
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Ctrl+Enter in Basic Extract did not write ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const progressSeen = await stopProgressWatch();
    const completion = await readCompletion("extract");

    assert.equal(
      progressSeen,
      true,
      "Ctrl+Enter in Basic Extract never opened the Basic progress panel",
    );
    assert.equal(completion.title, "Extraction complete", completion.body);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-ctrl-enter-extract", {
      scenario: "ctrl-enter-basic-extract-runs-basic-flow",
      destination: dest,
      progressSeen,
      completionTitle: completion.title,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("runs Extract all for Ctrl+Enter in the Basic Browse view", async function () {
    const started = Date.now();
    const dest = path.join(ROOT, "ctrl-browse", "out");
    mkdirFresh(dest);

    await openBasicBrowseForArchive(HELLO_7Z);
    await waitForArchiveIdle();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const button = document.getElementById("basic-browse-extract-all");
          return Boolean(button) && !button.disabled;
        }),
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: "Basic Browse Extract all stayed disabled",
      },
    );
    await browser.execute((value) => {
      const field = document.getElementById("basic-extract-path");
      if (!field) throw new Error("missing #basic-extract-path");
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, dest);
    await dispatchDocumentKey("Enter", { ctrlKey: true });
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Ctrl+Enter in Basic Browse did not extract ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const completion = await readCompletion("extract");

    assert.equal(completion.title, "Extraction complete", completion.body);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-ctrl-enter-browse", {
      scenario: "ctrl-enter-basic-browse-extract-all",
      destination: dest,
      completionTitle: completion.title,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("extracts an encrypted archive from Basic Browse with the browse password and no second prompt", async function () {
    const started = Date.now();
    const { archive, payloadName, payload } = buildEncryptedArchive(
      "browse-extract-handoff",
      PASSWORD,
      { encryptHeaders: true },
    );
    const dest = path.join(ROOT, "browse-extract-handoff", "out");
    mkdirFresh(dest);

    await openBasicBrowseForArchive(archive, { waitForIdle: false });
    await browser.waitUntil(() => isInputModalOpen(), {
      timeout: STEP_TIMEOUT_MS,
      timeoutMsg: `Basic Browse did not open the password prompt; ${await uiDiagnostics()}`,
    });
    await browser.execute(() => {
      document.getElementById("input-modal-cancel")?.click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.getElementById("basic-browse-password-field")?.hidden ===
            false,
        ),
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: `Basic Browse did not reveal the inline password field after cancel; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();
    await setInputValue("#basic-browse-password", PASSWORD);
    await dispatchKeyOnField("basic-browse-password", "Enter", false);
    await browser.waitUntil(
      () =>
        browser.execute(
          (name) =>
            (
              document.getElementById("basic-browse-tbody")?.textContent ?? ""
            ).includes(name),
          payloadName,
        ),
      {
        timeout: RUN_TIMEOUT_MS,
        timeoutMsg: `Basic Browse with the password did not list ${payloadName}; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const button = document.getElementById("basic-browse-extract-all");
          return Boolean(button) && !button.disabled;
        }),
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: "Basic Browse Extract all stayed disabled",
      },
    );
    await browser.execute((value) => {
      const field = document.getElementById("basic-extract-path");
      if (!field) throw new Error("missing #basic-extract-path");
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, dest);

    await watchPromptOpens();
    await browser.execute(() => {
      document.getElementById("basic-browse-extract-all")?.click();
    });
    const extracted = path.join(dest, payloadName);
    let promptOpens;
    try {
      await browser.waitUntil(
        async () => fs.existsSync(extracted) || (await isInputModalOpen()),
        {
          timeout: RUN_TIMEOUT_MS,
          timeoutMsg: `Extract all neither wrote ${extracted} nor finished; ${await uiDiagnostics()}`,
        },
      );
    } finally {
      promptOpens = await stopPromptWatch();
    }
    const promptShown = promptOpens > 0 || (await isInputModalOpen());
    assert.equal(
      promptShown,
      false,
      "Extract all asked for the password that Basic Browse already used",
    );
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: RUN_TIMEOUT_MS,
      timeoutMsg: `Extract all did not write ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    const completion = await readCompletion("extract");

    assert.equal(
      fs.readFileSync(extracted, "utf8"),
      payload,
      "the extracted payload differs",
    );
    assert.equal(completion.title, "Extraction complete", completion.body);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-browse-extract-handoff", {
      scenario: "browse-password-handed-to-extract-all-without-second-prompt",
      archive,
      destination: dest,
      promptOpensDuringExtractAll: promptOpens,
      promptShown,
      completionTitle: completion.title,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("returning from Power keeps the Basic Compress and Extract views, and Extract with no archives goes Home", async function () {
    const started = Date.now();
    const dest = path.join(ROOT, "views", "out");
    mkdirFresh(dest);

    await openBasicCompress([HELLO_TXT]);
    await switchToPowerWorkspace();
    await switchToBasicWorkspace();
    await waitForBasicView("compress");
    const compressKept = await basicViewActive("compress");

    await openBasicExtract(HELLO_7Z, dest);
    await switchToPowerWorkspace();
    await switchToBasicWorkspace();
    await waitForBasicView("extract");
    const extractKept = await basicViewActive("extract");

    await clearPowerInputs();
    await switchToBasicWorkspace();
    await waitForBasicView("home");
    const homeWhenEmpty = await basicViewActive("home");

    assert.equal(compressKept, true, "Compress was not kept after Power");
    assert.equal(extractKept, true, "Extract was not kept after Power");
    assert.equal(
      homeWhenEmpty,
      true,
      "Extract with no archives did not go Home after Power",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-views-after-power", {
      scenario: "basic-view-kept-after-power",
      compressKept,
      extractKept,
      homeWhenEmpty,
      durationMs: Date.now() - started,
    });
  });

  it("shows the Basic Extract validation failure panel when the archive vanished before Run", async function () {
    const started = Date.now();
    const dir = path.join(ROOT, "vanished");
    mkdirFresh(dir);
    const archive = path.join(dir, "vanished.7z");
    fs.copyFileSync(HELLO_7Z, archive);
    const dest = path.join(dir, "out");
    mkdirFresh(dest);

    await openBasicExtract(archive, dest);
    fs.rmSync(archive, { force: true });
    await clickRun("extract");
    const completion = await waitForCompletion(
      "extract",
      "Basic Extract did not show a failure panel for the missing archive",
    );
    const runStillEnabled = await runEnabled("extract");

    assert.equal(
      completion.variant,
      "error",
      "the panel is not the error variant",
    );
    assert.ok(
      ["Check your choices", "Operation failed"].includes(completion.title),
      `unexpected failure title ${completion.title}`,
    );
    assert.match(
      completion.body,
      /does not exist/i,
      "the failure panel does not name the missing archive",
    );
    assert.equal(
      runStillEnabled,
      true,
      "Run stayed disabled after the failure",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-validation-panel", {
      scenario: "basic-extract-validation-failure-panel",
      archive,
      completionTitle: completion.title,
      completionMessage: completion.body,
      runEnabledAfterFailure: runStillEnabled,
      durationMs: Date.now() - started,
    });
  });

  it("keeps ? and Ctrl+Enter inert while the convert dialog is open", async function () {
    const started = Date.now();
    const output = path.join(ROOT, "overlay", "blocked.7z");
    mkdirFresh(path.dirname(output));

    await openBasicCompress([HELLO_TXT]);
    await setInputValue("#basic-output-path", output);
    await browser.execute(() => {
      const overlay = document.getElementById("convert-overlay");
      if (!overlay) throw new Error("missing #convert-overlay");
      overlay.hidden = false;
    });
    let shortcutsOpened = false;
    let runStarted = false;
    try {
      await dispatchDocumentKey("?");
      await browser.pause(1_000);
      shortcutsOpened = await isShortcutsOverlayOpen();
      await dispatchKeyOnField("basic-output-path", "Enter", true);
      await browser.pause(5_000);
      runStarted = fs.existsSync(output) || (await anyProgressActive());
    } finally {
      await closeTransientOverlays();
    }

    assert.equal(
      shortcutsOpened,
      false,
      "? opened the shortcuts sheet above the convert dialog",
    );
    assert.equal(
      runStarted,
      false,
      "Ctrl+Enter started a run while the convert dialog was open",
    );

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-convert-guard", {
      scenario: "overlay-guards-convert-dialog",
      output,
      shortcutsOpened,
      runStarted,
      durationMs: Date.now() - started,
    });
  });

  it("shows a plain-words error toast when the Open folder call fails", async function () {
    const started = Date.now();
    const output = path.join(ROOT, "open-folder", "sample.7z");
    mkdirFresh(path.dirname(output));

    await openBasicCompress([HELLO_TXT]);
    await setInputValue("#basic-output-path", output);
    await browser.execute(() => {
      document.getElementById("basic-compress-open-dest")?.click();
    });
    const texts = await waitForToastContaining(
      "Could not open the folder:",
      "Open folder failure did not show a toast",
    );
    const line = texts.find((text) =>
      text.includes("Could not open the folder:"),
    );

    assert.ok(line, `no open-folder toast in ${JSON.stringify(texts)}`);
    assert.match(line, /Could not open the folder: \S/);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-basic-sync-open-folder-toast", {
      scenario: "open-folder-failure-toast",
      folder: path.dirname(output),
      toast: line,
      durationMs: Date.now() - started,
    });
  });
});
