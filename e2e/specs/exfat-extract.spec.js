import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  awaitStartupRecoveryStatus,
  bannerState,
  clickBasicRunExtract,
  dismissToasts,
  prepareBasicExtract,
  reloadMainWindow,
  switchToBasicWorkspace,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputListCleared,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK ?? os.tmpdir(), "exfat-extract");
const IMAGE = path.join(ROOT, "zinnia-exfat.sparseimage");
const MOUNT = path.join(ROOT, "volume");
const SOURCE = path.join(ROOT, "source");
const ARCHIVE = path.join(ROOT, "hello.7z");
const DEST = path.join(MOUNT, "extracted");
const HELLO = "hello.txt";
const PAYLOAD = "hello from an exFAT volume\n";
const sidecar = requireHostSidecar();

let mounted = false;

function hdiutil(args, options = {}) {
  return spawnSync("hdiutil", args, {
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
}

function describeFailure(result) {
  return [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function walk(root) {
  const entries = [];
  if (!fs.existsSync(root)) return entries;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    entries.push(full);
    if (entry.isDirectory()) entries.push(...walk(full));
  }
  return entries;
}

describe("exFAT extraction recovery", function () {
  this.timeout(10 * 60_000);

  before(async function () {
    if (process.platform !== "darwin") {
      console.warn(
        "exfat-extract: skipped; hdiutil is only available on macOS",
      );
      this.skip();
    }
    if (!EVIDENCE_DIR) {
      console.warn(
        "exfat-extract: skipped; ZINNIA_E2E_EVIDENCE_DIR is not set",
      );
      this.skip();
    }
    const probe = spawnSync("hdiutil", ["info"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (probe.error || probe.status !== 0) {
      console.warn(
        `exfat-extract: skipped; hdiutil is unavailable (${describeFailure(probe)})`,
      );
      this.skip();
    }

    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(SOURCE, { recursive: true });
    fs.mkdirSync(MOUNT, { recursive: true });
    fs.writeFileSync(path.join(SOURCE, HELLO), PAYLOAD);
    run7z(sidecar, ["a", "-t7z", ARCHIVE, HELLO], { cwd: SOURCE });

    const created = hdiutil([
      "create",
      "-size",
      "2g",
      "-fs",
      "exFAT",
      "-type",
      "SPARSE",
      "-volname",
      "ZinniaExFAT",
      "-ov",
      IMAGE,
    ]);
    if (created.error || created.status !== 0) {
      console.warn(
        `exfat-extract: skipped; could not create the exFAT image (${describeFailure(created)})`,
      );
      this.skip();
    }
    const attached = hdiutil([
      "attach",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      MOUNT,
      IMAGE,
    ]);
    if (attached.error || attached.status !== 0) {
      console.warn(
        `exfat-extract: skipped; could not mount the exFAT image (${describeFailure(attached)})`,
      );
      this.skip();
    }
    mounted = true;

    const filesystem = spawnSync("diskutil", ["info", MOUNT], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (
      filesystem.error ||
      filesystem.status !== 0 ||
      !/exfat/i.test(filesystem.stdout ?? "")
    ) {
      console.warn(
        `exfat-extract: skipped; mounted volume is not exFAT (${describeFailure(filesystem)})`,
      );
      this.skip();
    }
    fs.writeFileSync(path.join(MOUNT, ".write-check"), "ok\n");
    fs.rmSync(path.join(MOUNT, ".write-check"));

    await waitForMainWindow();
    await waitForE2eHook();
  });

  after(async function () {
    if (mounted) {
      let detached = hdiutil(["detach", MOUNT]);
      if (detached.status !== 0) {
        detached = hdiutil(["detach", "-force", MOUNT]);
      }
      if (detached.status !== 0) {
        console.warn(
          `exfat-extract: could not detach ${MOUNT} (${describeFailure(detached)})`,
        );
      }
    }
    mounted = false;
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("extracts onto exFAT without a leftover staging directory or recovery banner", async () => {
    fs.mkdirSync(DEST, { recursive: true });
    await switchToBasicWorkspace();
    await dismissToasts();
    await browser.execute(() => {
      document.getElementById("clear-inputs")?.click();
    });
    await waitForInputListCleared();
    await prepareBasicExtract(ARCHIVE, DEST);
    await clickBasicRunExtract();

    const extracted = path.join(DEST, HELLO);
    try {
      await browser.waitUntil(() => fs.existsSync(extracted), {
        timeout: 120_000,
        interval: 250,
      });
    } catch (error) {
      const basicStatus = await browser.execute(
        () =>
          document.getElementById("basic-extract-status")?.textContent ?? "",
      );
      const pageText = await browser.execute(() =>
        document.body.innerText.slice(0, 1500),
      );
      throw new Error(
        `exFAT extract did not write ${extracted}: ${error.message}; ${await uiDiagnostics()}; basic status: ${basicStatus}; page text: ${pageText}`,
        { cause: error },
      );
    }
    await waitForArchiveIdle();
    assert.equal(fs.readFileSync(extracted, "utf8"), PAYLOAD);

    const leftovers = walk(MOUNT)
      .map((entry) => path.relative(MOUNT, entry))
      .filter((entry) => path.basename(entry).startsWith(".zinnia-"));
    assert.deepEqual(
      leftovers,
      [],
      `exFAT extraction left staging entries behind: ${JSON.stringify(leftovers)}`,
    );

    // A webview relaunch re-runs the startup recovery query, which is what
    // shows the banner after a cold app launch on this profile.
    await reloadMainWindow();
    const recovery = await awaitStartupRecoveryStatus();
    assert.equal(
      recovery.error,
      undefined,
      `startup recovery status failed: ${recovery.error}`,
    );
    assert.equal(
      recovery.value,
      null,
      `exFAT extraction left startup recovery state: ${JSON.stringify(recovery.value)}`,
    );
    await browser.pause(500);
    const banner = await bannerState();
    assert.equal(
      banner.visible,
      false,
      `relaunch showed a recovery banner: ${banner.text}`,
    );

    writeEvidence(EVIDENCE_DIR, "exfat-extract", {
      scenario: "exfat-extract",
      filesystem: "exFAT",
      archive: path.basename(ARCHIVE),
      volume: MOUNT,
      destination: DEST,
      extractedMatchesPayload: true,
      leftoverStagingEntries: leftovers,
      recoveryStatus: recovery.value,
      recoveryBannerVisible: banner.visible,
    });
  });
});
