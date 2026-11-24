import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  applyIncomingPaths,
  dismissToasts,
  switchToBasicWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "posix-backslash-names");
// Windows forbids `\` in names, so this only exists on POSIX hosts.
const NAME = "draft\\final.txt";

describe("POSIX file names with a backslash", function () {
  this.timeout(5 * 60_000);

  before(async function () {
    if (process.platform === "win32") this.skip();
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    await waitForMainWindow();
    await waitForE2eHook();
  });

  it("shows a backslash in a macOS file name as part of one name", async () => {
    const file = path.join(ROOT, NAME);
    fs.writeFileSync(file, "backslash name\n");
    assert.equal(fs.readdirSync(ROOT).includes(NAME), true);

    await switchToBasicWorkspace();
    await dismissToasts();
    await waitForArchiveIdle();
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await applyIncomingPaths([file], "compress");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelectorAll("#basic-input-list .basic-file-item")
              .length === 1,
        ),
      {
        timeout: 20_000,
        timeoutMsg: "the backslash file was not listed in Basic Compress",
      },
    );
    const row = await browser.execute(() => {
      const pathEl = document.querySelector(
        "#basic-input-list .basic-file-item__path",
      );
      return {
        shown: pathEl?.textContent ?? "",
        title: pathEl?.getAttribute("title") ?? "",
      };
    });

    assert.equal(
      row.shown,
      NAME,
      `file row showed ${JSON.stringify(row.shown)}`,
    );
    assert.equal(row.title, file, "the row tooltip is not the full path");

    writeEvidence(EVIDENCE_DIR, "posix-backslash-names-file-row", {
      scenario: "posix-name-with-backslash-is-one-name",
      fileName: NAME,
      shown: row.shown,
      title: row.title,
    });
  });
});
