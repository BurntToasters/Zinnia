import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import { writeEvidence } from "../helpers/recovery-harness.js";
import {
  confirmInputModal,
  inputModalLabel,
  isInputModalOpen,
} from "../helpers/ui-driver.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const ARCHIVE = process.env.ZINNIA_E2E_HEADER_ENCRYPTED_7Z;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
// Member and destination folder come from the archive name set by test-e2e.js.
const MEMBER = "hello.txt";
const DEST = path.join(path.dirname(ARCHIVE), "encrypted-headers", MEMBER);
const FIRST_LABEL = "This archive is encrypted";
const RETRY_LABEL = "Incorrect password";
const WRONG_PASSWORD = "wrong";
const RIGHT_PASSWORD = "secret";
const STEP_TIMEOUT_MS = 60_000;

async function failureDetail() {
  return browser.execute(() => {
    const box = document.getElementById("extract-error");
    if (!box || box.hidden) return "";
    return (
      document.getElementById("error-detail")?.textContent?.trim() ||
      "(no detail)"
    );
  });
}

async function assertNoFailure(step) {
  const detail = await failureDetail();
  assert.equal(detail, "", `${step}: extraction failed: ${detail}`);
}

/** Waits for the password prompt with `fragment`; fails fast if an error shows. */
async function waitForPrompt(fragment, step) {
  await browser.waitUntil(
    async () => {
      if ((await failureDetail()) !== "") return true;
      if (!(await isInputModalOpen())) return false;
      return (await inputModalLabel()).includes(fragment);
    },
    {
      timeout: STEP_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: `${step}: password prompt "${fragment}" never appeared`,
    },
  );
  await assertNoFailure(step);
  return inputModalLabel();
}

describe("Zinnia extract window with a header-encrypted 7z", () => {
  it("asks for the password, rejects a wrong one, then extracts with the right one", async () => {
    assert.ok(ARCHIVE, "ZINNIA_E2E_HEADER_ENCRYPTED_7Z is not set");
    assert.ok(EVIDENCE_DIR, "ZINNIA_E2E_EVIDENCE_DIR is not set");
    await $("#extract-app").waitForExist({ timeout: 30_000 });

    const firstLabel = await waitForPrompt(FIRST_LABEL, "first prompt");
    assert.ok(
      firstLabel.includes(FIRST_LABEL),
      `first prompt label was "${firstLabel}"`,
    );

    await confirmInputModal(WRONG_PASSWORD);
    const retryLabel = await waitForPrompt(RETRY_LABEL, "retry prompt");
    assert.ok(
      retryLabel.includes(RETRY_LABEL),
      `retry prompt label was "${retryLabel}"`,
    );

    await confirmInputModal(RIGHT_PASSWORD);
    await browser.waitUntil(
      async () => {
        if (fs.existsSync(DEST)) return true;
        return (await failureDetail()) !== "";
      },
      {
        timeout: STEP_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `extract with the right password did not write ${DEST}`,
      },
    );
    await assertNoFailure("after the right password");
    const extracted = fs.readFileSync(DEST, "utf8");
    assert.equal(extracted, PAYLOAD, "extracted content differs from payload");

    writeEvidence(EVIDENCE_DIR, "extract-window-encrypted-headers", {
      scenario: "extract-window-encrypted-headers",
      archive: path.basename(ARCHIVE),
      promptLabels: [firstLabel, retryLabel],
      wrongPasswordRejected: true,
      member: MEMBER,
      extractedMatchesPayload: extracted === PAYLOAD,
      extractedBytes: Buffer.byteLength(extracted),
    });
  });
});
