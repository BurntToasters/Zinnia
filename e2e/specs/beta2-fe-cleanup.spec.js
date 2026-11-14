import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  clearPowerExtractSession,
  closeSettingsModalViaUi,
  confirmInputModal,
  dismissToasts,
  flushPendingSettingsWrites,
  isInputModalOpen,
  openBasicBrowseForArchive,
  openBasicRecentsMenu,
  openSettingsModal,
  reloadMainWindow,
  setInputValue,
  startPowerExtract,
  switchToBasicWorkspace,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForBasicBrowseStatusIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { treeManifest, writeEvidence } from "../helpers/recovery-harness.js";
import {
  seedE2eSettings,
  settingsDirForProfile,
  updateE2eSettings,
} from "../helpers/profile.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "beta2-fe-cleanup");
const sidecar = requireHostSidecar();

const STEP_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 60_000;

const FIRST_PROMPT_LABEL = "This archive is encrypted. Enter password:";
const PASSWORD_A = "beta2-cleanup-alpha";
const RECENT_KEY = "zinnia.basic.recentArchives";

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeTextFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function buildArchive(archive, sourceDir, entries, password) {
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.rmSync(archive, { force: true });
  const extra = password ? [`-p${password}`, "-mhe=on"] : [];
  run7z(sidecar, ["a", "-t7z", ...extra, archive, ...entries], {
    cwd: sourceDir,
  });
  return archive;
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

function e2eProfileDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("E2E profile home env is missing");
  return path.dirname(home);
}

function settingsDir() {
  return settingsDirForProfile(e2eProfileDir(), process.platform);
}

async function restoreBaselineSettings() {
  try {
    await flushPendingSettingsWrites();
  } catch {
    // A reload can end the session before cleanup runs.
  }
  seedE2eSettings(settingsDir());
  updateE2eSettings(e2eProfileDir(), {
    setupComplete: true,
    workspaceMode: "basic",
    theme: "system",
    customPresets: [],
  });
}

describe("beta2 frontend cleanup regressions", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  afterEach(async () => {
    await returnToIdle().catch(() => undefined);
  });

  it("P1 opens the password prompt for a header-encrypted archive with no password", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "p1");
    writeTextFile(path.join(scenario, "src", "header.txt"), "header payload\n");
    const archive = buildArchive(
      path.join(scenario, "header-locked.7z"),
      path.join(scenario, "src"),
      ["header.txt"],
      PASSWORD_A,
    );
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);

    await resetForScenario();
    await startPowerExtract(archive, dest);
    const promptLabel = await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "header-encrypted archive with an empty password did not open the password prompt",
    );
    await confirmInputModal(PASSWORD_A);

    const extracted = path.join(dest, "header.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `the correct password did not extract ${extracted}; ${await uiDiagnostics()}`,
    });
    await waitForIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), "header payload\n");
    assert.equal(await isInputModalOpen(), false);

    writeEvidence(EVIDENCE_DIR, "beta2-fe-cleanup-p1-header-encrypted-power", {
      scenario: "power-header-encrypted-empty-password",
      archive,
      promptLabel,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("B1 Basic Extract all completes after the password for a replaced encrypted archive", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "b1");
    const archive = path.join(scenario, "changed-basic.7z");
    writeTextFile(path.join(scenario, "src", "basic-a.txt"), "basic a\n");
    buildArchive(
      archive,
      path.join(scenario, "src"),
      ["basic-a.txt"],
      PASSWORD_A,
    );
    const dest = path.join(scenario, "out");
    mkdirFresh(dest);
    const extracted = path.join(dest, "basic-a.txt");

    await resetForScenario();
    const noticesBefore = await countEncryptedListingNotices();
    await openBasicBrowseForArchive(archive);
    await browser.waitUntil(
      async () => (await countEncryptedListingNotices()) > noticesBefore,
      {
        timeout: EXTRACT_TIMEOUT_MS,
        timeoutMsg: `Basic auto-browse never reported the encrypted listing; ${await uiDiagnostics()}`,
      },
    );
    await waitForBasicBrowseStatusIdle(
      "Basic browse did not settle before the password",
    );
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

    writeTextFile(
      path.join(scenario, "changed", "basic-a.txt"),
      "basic changed\n",
    );
    buildArchive(
      archive,
      path.join(scenario, "changed"),
      ["basic-a.txt"],
      PASSWORD_A,
    );
    await browser.execute((target) => {
      const field = document.getElementById("basic-extract-path");
      if (field) field.value = target;
    }, dest);

    await browser.execute(() => {
      document.getElementById("basic-browse-extract-all")?.click();
    });
    await browser.waitUntil(async () => isInputModalOpen(), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `Basic Extract all did not ask for the password; ${await uiDiagnostics()}`,
    });
    const promptLabel = await waitForPromptLabel(
      FIRST_PROMPT_LABEL,
      "Basic Extract all did not show the first-attempt password prompt",
    );
    await confirmInputModal(PASSWORD_A);

    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `Basic run did not write ${extracted} after the password; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), "basic changed\n");

    writeEvidence(EVIDENCE_DIR, "beta2-fe-cleanup-b1-basic-changed-archive", {
      scenario: "basic-browse-replaced-encrypted-archive-extract-all",
      archive,
      promptLabel,
      destination: dest,
      tree: treeManifest(dest),
      durationMs: Date.now() - started,
    });
  });

  it("R1 lists same-named recents with their folders and opens the chosen one in Basic Browse", async function () {
    const started = Date.now();
    const scenario = path.join(ROOT, "r1");
    writeTextFile(path.join(scenario, "src-one", "from-one.txt"), "one\n");
    writeTextFile(path.join(scenario, "src-two", "from-two.txt"), "two\n");
    const one = buildArchive(
      path.join(scenario, "one", "same.7z"),
      path.join(scenario, "src-one"),
      ["from-one.txt"],
      null,
    );
    const two = buildArchive(
      path.join(scenario, "two", "same.7z"),
      path.join(scenario, "src-two"),
      ["from-two.txt"],
      null,
    );

    await resetForScenario();
    await browser.execute(
      (key, paths) => {
        sessionStorage.setItem(key, JSON.stringify(paths));
      },
      RECENT_KEY,
      [one, two],
    );
    await reloadMainWindow();
    await openBasicRecentsMenu();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelectorAll(
              "#header-recent-menu .header-recent__item",
            ).length,
        )) === 2,
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: `recent menu did not list two archives; ${await uiDiagnostics()}`,
      },
    );

    const items = await browser.execute(() =>
      [
        ...document.querySelectorAll(
          "#header-recent-menu .header-recent__item",
        ),
      ].map((item) => ({
        title: item.title,
        name: item.querySelector(".header-recent__name")?.textContent ?? "",
        folder: item.querySelector(".header-recent__folder")?.textContent ?? "",
      })),
    );
    assert.equal(items[0].name, "same.7z");
    assert.equal(items[1].name, "same.7z");
    assert.equal(items[0].title, one);
    assert.equal(items[1].title, two);
    assert.notEqual(
      items[0].folder,
      items[1].folder,
      "two same-named recents showed the same folder text",
    );
    assert.ok(items[0].folder.includes("one"), items[0].folder);
    assert.ok(items[1].folder.includes("two"), items[1].folder);

    try {
      await browser.execute(() => {
        const items = [
          ...document.querySelectorAll(
            "#header-recent-menu .header-recent__item",
          ),
        ];
        items[1]?.click();
      });
      await browser.waitUntil(
        () =>
          browser.execute(
            (wanted) =>
              (
                document.getElementById("browse-tbody")?.textContent ?? ""
              ).includes(wanted),
            "from-two.txt",
          ),
        {
          timeout: EXTRACT_TIMEOUT_MS,
          timeoutMsg: `Recent did not open the chosen archive in Basic Browse; ${await uiDiagnostics()}`,
        },
      );
      const browsed = await browser.execute(
        () => document.getElementById("browse-tbody")?.textContent ?? "",
      );
      assert.equal(browsed.includes("from-one.txt"), false);
      await waitForArchiveIdle();
    } finally {
      await browser.execute((key) => {
        sessionStorage.removeItem(key);
      }, RECENT_KEY);
    }

    writeEvidence(EVIDENCE_DIR, "beta2-fe-cleanup-r1-recent-same-name", {
      scenario: "recent-same-name-folders-and-browse-view",
      items,
      durationMs: Date.now() - started,
    });
  });

  it("C1 keeps the file name visible in the Basic completion path and gives it a full-path title", async function () {
    const started = Date.now();
    const scenario = path.join(
      ROOT,
      "c1",
      "a-long-parent-folder-name-that-pushes-the-completion-path-past-the-panel",
    );
    const input = path.join(scenario, "input-c1.txt");
    writeTextFile(input, "completion\n");
    const output = path.join(scenario, "completion-output-c1.7z");
    fs.rmSync(output, { force: true });

    await resetForScenario();
    await switchToBasicWorkspace();
    await waitForArchiveIdle();
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await applyIncomingPaths([input], "compress");
    await setInputValue("#basic-output-path", output);
    await browser.execute(() => {
      document.getElementById("basic-run-compress")?.click();
    });
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: EXTRACT_TIMEOUT_MS,
      timeoutMsg: `Basic compress did not write ${output}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .getElementById("basic-compress-completion")
              ?.classList.contains("is-active") ?? false,
        ),
      {
        timeout: STEP_TIMEOUT_MS,
        timeoutMsg: `Basic completion panel did not open; ${await uiDiagnostics()}`,
      },
    );

    const panel = await browser.execute(() => {
      const el = document.getElementById("basic-compress-completion-path");
      return {
        text: el?.textContent ?? "",
        title: el?.title ?? "",
        hidden: el?.hidden ?? true,
      };
    });
    assert.equal(panel.hidden, false, "completion path row stayed hidden");
    assert.equal(
      panel.title,
      output,
      "completion path title is not the full path",
    );
    assert.ok(
      panel.text.endsWith("completion-output-c1.7z"),
      `completion path hid the file name: ${panel.text}`,
    );

    await dismissToasts();
    writeEvidence(EVIDENCE_DIR, "beta2-fe-cleanup-c1-completion-path", {
      scenario: "basic-compress-long-path-completion",
      output,
      displayed: panel.text,
      title: panel.title,
      truncated: panel.text !== output,
      durationMs: Date.now() - started,
    });
  });

  it("S1 loads a saved ppmd method as the default method after a reload", async function () {
    const started = Date.now();
    await resetForScenario();
    try {
      seedE2eSettings(settingsDir());
      updateE2eSettings(e2eProfileDir(), {
        format: "7z",
        method: "ppmd",
      });
      await reloadMainWindow();

      await openSettingsModal();
      const selected = await browser.execute(() => {
        const select = document.getElementById("s-method");
        return {
          value: select?.value ?? null,
          options: [...(select?.options ?? [])].map((option) => option.value),
        };
      });
      await closeSettingsModalViaUi();

      assert.equal(
        selected.value,
        "lzma2",
        `saved ppmd method did not load as the default; options ${JSON.stringify(selected.options)}`,
      );

      writeEvidence(EVIDENCE_DIR, "beta2-fe-cleanup-s1-saved-ppmd-method", {
        scenario: "saved-ppmd-loads-default",
        savedMethod: "ppmd",
        loadedMethod: selected.value,
        methodOptions: selected.options,
        durationMs: Date.now() - started,
      });
    } finally {
      await restoreBaselineSettings();
      await reloadMainWindow().catch(() => undefined);
    }
  });
});
