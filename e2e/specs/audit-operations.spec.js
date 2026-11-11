import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  listingHasMember,
  requireHostSidecar,
  run7z,
} from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  confirmDialogTitles,
  abortArchiveOperationIfBusy,
  confirmInputModal,
  domText,
  domValue,
  flushPendingSettingsWrites,
  isInputModalOpen,
  openBasicBrowseForArchive,
  queueConfirmResult,
  queueDialogResult,
  setCheckbox,
  setInputValue,
  setSelectValue,
  startPowerCompress,
  switchToBasicWorkspace,
  switchToPowerWorkspace,
  toastTexts,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForInputModalLabel,
  waitForMainWindow,
  waitForToastContaining,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-operations");
const sidecar = requireHostSidecar();
const PASSWORD = "ZinniaE2e-Audit-7z";

function freshDir(name) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeInput(dir, name = "hello.txt", content = PAYLOAD) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** Build a 7z fixture with `run7z`; header encryption is opt-in. */
function makeArchive(dir, name, files, options = {}) {
  const names = Object.keys(files);
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  const archive = path.join(dir, name);
  const args = ["a", "-t7z", "-bd"];
  if (options.password) args.push(`-p${options.password}`);
  if (options.headers) args.push("-mhe=on");
  args.push("--", archive, ...names);
  run7z(sidecar, args, { cwd: dir });
  return archive;
}

function listArchive(archive, password) {
  const args = ["l", "-slt", "--", archive];
  if (password) args.splice(1, 0, `-p${password}`);
  return run7z(sidecar, args, { allowFailure: true });
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

async function clickId(id) {
  await browser.execute((target) => {
    const el = document.getElementById(target);
    if (!el) throw new Error(`missing #${target}`);
    el.click();
  }, id);
}

async function confirmTitleCount() {
  return (await confirmDialogTitles()).length;
}

async function waitForLogText(fragment, timeoutMsg) {
  await browser.waitUntil(
    async () => String(await domText("#log")).includes(fragment),
    { timeout: 60_000, timeoutMsg },
  );
}

/**
 * Hand paths to the app without awaiting the browse. A browse that prompts
 * for a password only finishes after the test answers the prompt, so the
 * blocking applyIncomingPaths helper would never return.
 */
async function startIncomingPaths(paths, mode) {
  await waitForE2eHook();
  await browser.execute(
    (nextPaths, nextMode) => {
      window.__ZINNIA_E2E__
        .applyIncomingPaths(nextPaths, nextMode)
        .catch(() => undefined);
    },
    paths,
    mode,
  );
}

async function enterBasicCompress(input) {
  await switchToBasicWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
  await applyIncomingPaths([input], "compress");
  await setSelectValue("#basic-format", "7z");
}

describe("Archive operation flows", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  // A failed prompt scenario must not leave a modal or busy state behind.
  afterEach(async () => {
    await abortArchiveOperationIfBusy().catch(() => undefined);
  });

  after(async () => {
    await flushPendingSettingsWrites().catch(() => undefined);
  });

  it("keeps the Power password after a wrong output extension, then encrypts on the fixed name", async () => {
    const dir = freshDir("power-wrong-extension");
    const input = writeInput(dir);
    const wrong = path.join(dir, "wrong-name.zip");
    const fixed = path.join(dir, "fixed.7z");

    await startPowerCompress(input, wrong, {
      format: "7z",
      password: PASSWORD,
      encryptHeaders: true,
    });
    await waitForLogText(
      "Output filename must end in",
      "Power compress did not report the output extension error",
    );
    await waitForArchiveIdle();
    assert.ok(
      !fs.existsSync(wrong),
      "a rejected run must not write an archive",
    );
    const keptAfterError = await domValue("#password");
    assert.equal(
      keptAfterError,
      PASSWORD,
      "a pre-run validation error erased the password field",
    );

    await setInputValue("#output-path", fixed);
    await clickId("run-action");
    await browser.waitUntil(() => fs.existsSync(fixed), {
      timeout: 120_000,
      timeoutMsg: `fixed compress did not write ${fixed}`,
    });
    await waitForArchiveIdle();

    const withoutPassword = listArchive(fixed);
    const leakedWithoutPassword = listingHasMember(
      withoutPassword.stdout,
      "hello.txt",
    );
    assert.ok(
      withoutPassword.code !== 0 || !leakedWithoutPassword,
      `archive listed hello.txt without a password: ${withoutPassword.stdout}`,
    );
    const withPassword = listArchive(fixed, PASSWORD);
    assert.ok(
      listingHasMember(withPassword.stdout, "hello.txt"),
      `archive did not list hello.txt with the password: ${withPassword.stdout}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-power-wrong-extension", {
      scenario: "power-wrong-extension",
      rejectedArchiveExists: fs.existsSync(wrong),
      passwordKeptAfterError: keptAfterError === PASSWORD,
      listWithoutPasswordExit: withoutPassword.code,
      listWithoutPasswordShowsHello: leakedWithoutPassword,
      listWithPasswordShowsHello: listingHasMember(
        withPassword.stdout,
        "hello.txt",
      ),
    });
  });

  it("keeps the Power password when Replace archive is declined", async () => {
    const dir = freshDir("power-declined-replace");
    const input = writeInput(dir);
    const existing = makeArchive(dir, "existing.7z", {
      "old.txt": "previous contents",
    });
    const hashBefore = sha256(existing);
    const titlesBefore = await confirmTitleCount();

    await queueConfirmResult(false);
    await startPowerCompress(input, existing, {
      format: "7z",
      password: PASSWORD,
    });
    await browser.waitUntil(
      async () => (await confirmTitleCount()) > titlesBefore,
      {
        timeout: 60_000,
        timeoutMsg: "Power compress never asked about replacing the archive",
      },
    );
    await waitForArchiveIdle();

    const titles = (await confirmDialogTitles()).slice(titlesBefore);
    assert.ok(
      titles.includes("Replace archive"),
      `unexpected confirm titles: ${titles.join(", ")}`,
    );
    assert.equal(
      await domValue("#password"),
      PASSWORD,
      "declining Replace archive erased the password field",
    );
    assert.equal(
      sha256(existing),
      hashBefore,
      "declined run changed the archive",
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-power-declined-replace", {
      scenario: "power-declined-replace",
      confirmTitles: titles,
      passwordKept: true,
      archiveUnchanged: true,
    });
  });

  it("keeps the Basic password after a wrong output extension, then encrypts on the fixed name", async () => {
    const dir = freshDir("basic-wrong-extension");
    const input = writeInput(dir);
    const wrong = path.join(dir, "wrong-name.zip");
    const fixed = path.join(dir, "fixed.7z");

    await enterBasicCompress(input);
    await setInputValue("#basic-password", PASSWORD);
    await setInputValue("#basic-output-path", wrong);
    await clickId("basic-run-compress");
    await waitForLogText(
      "Output filename must end in",
      "Basic compress did not report the output extension error",
    );
    await waitForArchiveIdle();
    assert.ok(
      !fs.existsSync(wrong),
      "a rejected Basic run must not write an archive",
    );
    assert.equal(
      await domValue("#basic-password"),
      PASSWORD,
      "a Basic pre-run validation error erased the password field",
    );

    await setInputValue("#basic-output-path", fixed);
    await clickId("basic-run-compress");
    await browser.waitUntil(() => fs.existsSync(fixed), {
      timeout: 120_000,
      timeoutMsg: `fixed Basic compress did not write ${fixed}`,
    });
    await waitForArchiveIdle();

    // Basic leaves header encryption off, so names list without a password.
    // The data itself must be AES-encrypted, and a test needs the password.
    const plainListing = listArchive(fixed);
    assert.ok(
      /7zAES/.test(plainListing.stdout),
      `Basic archive data is not encrypted: ${plainListing.stdout}`,
    );
    run7z(sidecar, ["t", `-p${PASSWORD}`, "--", fixed]);

    writeEvidence(EVIDENCE_DIR, "audit-operations-basic-wrong-extension", {
      scenario: "basic-wrong-extension",
      rejectedArchiveExists: fs.existsSync(wrong),
      passwordKeptAfterError: true,
      dataEncryptedAes: /7zAES/.test(plainListing.stdout),
      testWithPasswordPasses: true,
    });
  });

  it("keeps the Basic password when a typed destination's Replace is declined", async () => {
    const dir = freshDir("basic-declined-replace");
    const input = writeInput(dir);
    const existing = makeArchive(dir, "existing.7z", {
      "old.txt": "previous contents",
    });
    const hashBefore = sha256(existing);
    const titlesBefore = await confirmTitleCount();

    await enterBasicCompress(input);
    await setInputValue("#basic-password", PASSWORD);
    await setInputValue("#basic-output-path", existing);
    await queueConfirmResult(false);
    await clickId("basic-run-compress");
    await browser.waitUntil(
      async () => (await confirmTitleCount()) > titlesBefore,
      {
        timeout: 60_000,
        timeoutMsg:
          "typed Basic destination did not keep Zinnia's Replace confirm",
      },
    );
    await waitForArchiveIdle();

    assert.equal(
      await domValue("#basic-password"),
      PASSWORD,
      "declining Replace in Basic erased the password field",
    );
    assert.equal(
      sha256(existing),
      hashBefore,
      "declined Basic run changed the archive",
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-basic-declined-replace", {
      scenario: "basic-declined-replace",
      confirmTitles: (await confirmDialogTitles()).slice(titlesBefore),
      passwordKept: true,
      archiveUnchanged: true,
    });
  });

  it("does not confirm a second time when the native save dialog chose the archive", async () => {
    const dir = freshDir("basic-native-save");
    const input = writeInput(dir);
    const existing = makeArchive(dir, "existing.7z", {
      "old.txt": "previous contents",
    });
    const titlesBefore = await confirmTitleCount();

    await enterBasicCompress(input);
    await setInputValue("#basic-output-path", "");
    await queueDialogResult(existing);
    await clickId("basic-run-compress");
    await browser.waitUntil(
      () => listingHasMember(listArchive(existing).stdout, "hello.txt"),
      {
        timeout: 120_000,
        timeoutMsg: "native save path did not finish the Basic compress",
      },
    );
    await waitForArchiveIdle();

    assert.equal(
      await confirmTitleCount(),
      titlesBefore,
      "Zinnia asked to replace an archive the native save dialog already confirmed",
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-basic-native-save", {
      scenario: "basic-native-save",
      secondConfirmAsked: (await confirmTitleCount()) > titlesBefore,
      archiveListsHello: listingHasMember(
        listArchive(existing).stdout,
        "hello.txt",
      ),
    });
  });

  it("titles a Basic validation error Check your choices", async () => {
    await switchToBasicWorkspace();
    await waitForArchiveIdle();
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await clickId("basic-run-compress");

    await browser.waitUntil(
      async () =>
        (await domText("#basic-compress-completion-title")) ===
        "Check your choices",
      {
        timeout: 30_000,
        timeoutMsg:
          "Basic validation error did not use the Check your choices title",
      },
    );
    const message = await domText("#basic-compress-completion-msg");
    assert.ok(
      String(message).includes("Add at least one input."),
      `unexpected Basic validation message: ${message}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-basic-validation-title", {
      scenario: "basic-validation-title",
      title: "Check your choices",
      message,
    });
  });

  it("prompts for the password when Power browses a header-encrypted 7z", async () => {
    const dir = freshDir("power-browse-prompt");
    const archive = makeArchive(
      dir,
      "secret-headers.7z",
      { "hello.txt": PAYLOAD },
      { password: PASSWORD, headers: true },
    );

    await switchToPowerWorkspace();
    await waitForArchiveIdle();
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await startIncomingPaths([archive], "");

    await waitForInputModalLabel(
      "encrypted",
      "Power browse did not prompt for the header-encrypted archive password",
    );
    await confirmInputModal(PASSWORD);

    await browser.waitUntil(
      async () => (await domText("#browse-tbody")).includes("hello.txt"),
      {
        timeout: 60_000,
        timeoutMsg: "Power browse did not list hello.txt after the password",
      },
    );
    const toasts = await toastTexts();
    assert.ok(
      !toasts.some((line) => line.includes("Failed to list archive contents")),
      `browse still raised the sticky listing error: ${toasts.join(" | ")}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-power-browse-prompt", {
      scenario: "power-browse-prompt",
      archive,
      listedAfterPrompt: true,
    });
  });

  it("reuses the Basic browse password for Extract all without asking again", async () => {
    const dir = freshDir("basic-browse-extract-all");
    const archive = makeArchive(
      dir,
      "secret-headers.7z",
      { "hello.txt": PAYLOAD },
      { password: PASSWORD, headers: true },
    );
    const dest = path.join(dir, "extracted");
    fs.mkdirSync(dest, { recursive: true });

    await openBasicBrowseForArchive(archive);
    // Basic keeps its own browse password field: the failed listing reveals it.
    await clickId("basic-browse-contents");
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const field = document.getElementById("basic-browse-password-field");
          return field !== null && !field.hidden;
        }),
      {
        timeout: 60_000,
        timeoutMsg: "Basic browse did not reveal the password field",
      },
    );
    await waitForArchiveIdle();
    await setInputValue("#basic-browse-password", PASSWORD);
    // Earlier browses leave rows in these tables; clear them so the wait below
    // only passes for the listing this click starts.
    await browser.execute(() => {
      for (const id of ["basic-browse-tbody", "browse-tbody"]) {
        document.getElementById(id)?.replaceChildren();
      }
    });
    // The Browse button hides and clears this field; Enter browses with it.
    await browser.execute(() => {
      document
        .getElementById("basic-browse-password")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
    });
    try {
      await browser.waitUntil(
        async () =>
          (await domText("#basic-browse-tbody")).includes("hello.txt"),
        { timeout: 60_000, timeoutMsg: "basic browse rows never appeared" },
      );
    } catch (err) {
      const status = await domText("#basic-browse-status");
      const globalStatus = await domText("#status");
      const toasts = await toastTexts();
      const pwLength = await domValue("#basic-browse-password");
      throw new Error(
        `Basic browse did not list hello.txt after the password: ${err.message}; ` +
          `basic status=${JSON.stringify(status)}; status=${JSON.stringify(globalStatus)}; ` +
          `toasts=${JSON.stringify(toasts)}; passwordLength=${String(pwLength ?? "").length}`,
      );
    }
    await waitForArchiveIdle();

    // Power extract-path feeds Basic's destination on the Extract view.
    await setInputValue("#extract-path", dest);
    await clickId("basic-browse-extract-all");

    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(
      async () => fs.existsSync(extracted) || (await isInputModalOpen()),
      {
        timeout: 120_000,
        timeoutMsg:
          "Extract all neither wrote the file nor asked for a password",
      },
    );
    if (!fs.existsSync(extracted)) {
      const label = await domText("#input-modal-label");
      const activity = String(await domText("#log")).slice(-800);
      throw new Error(
        `Extract all asked again for a password (${label}). Activity tail: ${activity}`,
      );
    }
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), PAYLOAD);
    assert.equal(
      await isInputModalOpen(),
      false,
      "Extract all asked for the password again",
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-basic-browse-extract-all", {
      scenario: "basic-browse-extract-all",
      archive,
      extractedHello: fs.readFileSync(extracted, "utf8") === PAYLOAD,
      secondPrompt: false,
    });
  });

  it("asks to add to the archive in Update mode and reports Archive updated", async () => {
    const dir = freshDir("power-update-mode");
    const base = makeArchive(dir, "base.7z", { "old.txt": "previous" });
    const extra = writeInput(dir, "extra.txt", "added contents");
    const titlesBefore = await confirmTitleCount();

    await startPowerCompress(extra, base, { format: "7z", run: false });
    await setCheckbox("#update-mode", true);
    await queueConfirmResult(true);
    await clickId("run-action");

    await browser.waitUntil(
      async () => (await confirmTitleCount()) > titlesBefore,
      {
        timeout: 60_000,
        timeoutMsg: "Update mode did not ask before changing the archive",
      },
    );
    const titles = (await confirmDialogTitles()).slice(titlesBefore);
    assert.ok(
      titles.includes("Add to existing archive?"),
      `Update mode confirm title was: ${titles.join(", ")}`,
    );
    await waitForToastContaining(
      "Archive updated.",
      "Update mode did not report Archive updated.",
    );
    await waitForArchiveIdle();

    const listing = listArchive(base).stdout;
    assert.ok(
      listingHasMember(listing, "extra.txt"),
      `update lacked extra.txt: ${listing}`,
    );
    assert.ok(
      listingHasMember(listing, "old.txt"),
      `update lost old.txt: ${listing}`,
    );

    writeEvidence(EVIDENCE_DIR, "audit-operations-update-mode", {
      scenario: "update-mode",
      confirmTitles: titles,
      successToast: "Archive updated.",
      listsExtra: listingHasMember(listing, "extra.txt"),
    });
  });
});
