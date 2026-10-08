import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  queueDialogResult,
  startPowerExtract,
  switchToPowerWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  sha256File,
  writeEvidence,
} from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const ROOT = path.join(process.env.ZINNIA_E2E_WORK, "split-update");
const ADDED_NAME = "added-by-e2e.txt";
const ADDED_TEXT = "added during update\n";

// -ba drops the container record, so only real members appear as Path = lines.
function listArchive(archive) {
  return run7z(requireHostSidecar(), ["l", "-slt", "-ba", "--", archive])
    .stdout;
}

describe("split volumes and in-place update", () => {
  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("extracts a multi-volume .7z.001 set through the UI", async () => {
    const source = path.join(ROOT, "split-src.bin");
    fs.writeFileSync(source, crypto.randomBytes(300 * 1024));
    const sourceSha = sha256File(source);
    const base = path.join(ROOT, "split.7z");
    run7z(
      requireHostSidecar(),
      ["a", "-t7z", "-mx=0", "-v100k", base, "--", "split-src.bin"],
      {
        cwd: ROOT,
      },
    );
    const volumes = fs
      .readdirSync(ROOT)
      .filter((name) => /^split\.7z\.\d{3}$/.test(name))
      .sort();
    assert.ok(
      volumes.length >= 3,
      `expected several volumes, got ${volumes.join(", ")}`,
    );
    fs.rmSync(source, { force: true });

    const dest = path.join(ROOT, "split-out");
    await startPowerExtract(path.join(ROOT, volumes[0]), dest);
    const extracted = path.join(dest, "split-src.bin");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 120_000,
      timeoutMsg: `split extraction did not write ${extracted}`,
    });
    await waitForArchiveIdle();
    assert.equal(
      sha256File(extracted),
      sourceSha,
      "split extraction is not byte-identical",
    );
    assert.deepEqual(findLeftovers(ROOT), []);
    writeEvidence(EVIDENCE_DIR, "split-volumes", {
      scenario: "split-volumes",
      volumes,
      sourceSha256: sourceSha,
      extractedSha256: sha256File(extracted),
    });
  });

  it("adds a file to an existing .7z through the update path and keeps the old members", async () => {
    const hello = path.join(ROOT, "hello.txt");
    fs.writeFileSync(hello, PAYLOAD);
    const archive = path.join(ROOT, "update.7z");
    run7z(requireHostSidecar(), ["a", "-t7z", archive, "--", "hello.txt"], {
      cwd: ROOT,
    });
    const helloSha = sha256File(hello);
    const addedFile = path.join(ROOT, ADDED_NAME);
    fs.writeFileSync(addedFile, ADDED_TEXT);

    await switchToPowerWorkspace();
    await applyIncomingPaths([archive], "");
    await browser.waitUntil(
      async () => (await $("#browse-tbody").getText()).includes("hello.txt"),
      { timeout: 30_000, timeoutMsg: "browse did not list hello.txt" },
    );
    await waitForArchiveIdle();
    // The picker is native; the E2E queue supplies the file the user chose.
    await queueDialogResult([addedFile]);
    await browser.execute(() => {
      document.getElementById("browse-add-files")?.click();
    });
    await browser.waitUntil(() => listArchive(archive).includes(ADDED_NAME), {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "update did not add the chosen file to the archive",
    });
    await waitForArchiveIdle();

    const listing = listArchive(archive);
    const members = [...listing.matchAll(/^Path = (.+)$/gm)].map((m) => m[1]);
    assert.ok(members.includes("hello.txt"), "update dropped hello.txt");
    assert.ok(members.includes(ADDED_NAME), "update lacks the added file");

    const check = path.join(ROOT, "update-check");
    fs.mkdirSync(check, { recursive: true });
    run7z(requireHostSidecar(), ["x", "-y", `-o${check}`, "--", archive], {
      cwd: ROOT,
    });
    assert.equal(sha256File(path.join(check, "hello.txt")), helloSha);
    assert.equal(
      fs.readFileSync(path.join(check, ADDED_NAME), "utf8"),
      ADDED_TEXT,
    );
    assert.deepEqual(
      findLeftovers(ROOT).filter((name) => name.startsWith(".zinnia-")),
      [],
      "update left stage or backup files",
    );

    writeEvidence(EVIDENCE_DIR, "split-update", {
      scenario: "update-add-file",
      members,
      helloSha256Unchanged:
        sha256File(path.join(check, "hello.txt")) === helloSha,
      addedSha256: sha256File(path.join(check, ADDED_NAME)),
      leftovers: findLeftovers(ROOT),
    });
  });
});
