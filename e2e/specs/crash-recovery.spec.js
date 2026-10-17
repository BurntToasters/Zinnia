import crypto from "node:crypto";
import fs from "node:fs";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  awaitStartupRecoveryStatus,
  bannerState,
  startPowerCompress,
  startPowerExtract,
  waitForArchiveIdle,
  waitForAppShell,
  waitForE2eHook,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  readJsonIfPresent,
  treeManifest,
  writeEvidence,
} from "../helpers/recovery-harness.js";

const CASE = JSON.parse(process.env.ZINNIA_E2E_CASE ?? "null");
const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Subtree of a manifest rooted at one top-level name (`out`, `src`, ...). */
function subtree(manifest, name) {
  if (!manifest) return null;
  const matches = manifest.filter(
    (entry) => entry.path === name || entry.path.startsWith(`${name}/`),
  );
  // An absent name must read as null, not as an empty list: the two mean
  // "nothing created" and "created but empty" respectively.
  return matches.length > 0 ? matches : null;
}

function fileEntry(manifest, relative) {
  return manifest?.find((entry) => entry.path === relative) ?? null;
}

function assertInputsUnchanged(preManifest, currentManifest) {
  for (const name of ["src", "in", "old"]) {
    const before = subtree(preManifest, name);
    if (before === null) continue;
    assert.deepEqual(
      subtree(currentManifest, name),
      before,
      `input directory ${name}/ changed during recovery`,
    );
  }
}

function assertDestinationState(preManifest, currentManifest) {
  if (CASE.operation === "extract") {
    if (CASE.expect === "committed") {
      const hello = fileEntry(currentManifest, "out/hello.txt");
      assert.ok(hello, "committed extraction is missing hello.txt");
      assert.equal(
        hello.sha256,
        sha256Text(CASE.payloadText),
        "committed extraction has wrong hello.txt contents",
      );
      return;
    }
    if (CASE.destinationMode === "absent") {
      assert.equal(
        subtree(currentManifest, "out"),
        null,
        "rolled-back extraction left a destination behind",
      );
      return;
    }
    assert.deepEqual(
      subtree(currentManifest, "out"),
      subtree(preManifest, "out"),
      "rolled-back extraction changed the pre-existing destination",
    );
    return;
  }

  const output = fileEntry(currentManifest, "out/archive.7z");
  const before = fileEntry(preManifest, "out/archive.7z");
  if (CASE.expect === "committed") {
    assert.ok(output, "committed archive output is missing");
    assert.notEqual(
      output.sha256,
      before?.sha256 ?? null,
      "committed archive still matches the previous archive",
    );
    verifyArchiveHasHello(CASE.output);
    return;
  }
  if (CASE.outputMode === "absent") {
    assert.equal(output, null, "rolled-back create left an output archive");
    return;
  }
  assert.ok(output, "rolled-back create removed the previous archive");
  assert.equal(
    output.sha256,
    before.sha256,
    "rolled-back create did not restore the previous archive byte-for-byte",
  );
}

function verifyArchiveHasHello(archive) {
  const sidecar = requireHostSidecar();
  run7z(sidecar, ["t", "--", archive]);
  const listing = run7z(sidecar, ["l", "-slt", "--", archive]).stdout;
  assert.match(
    listing,
    /Path = hello\.txt/,
    "committed archive lacks hello.txt",
  );
  assert.doesNotMatch(
    listing,
    /Path = old\.txt/,
    "archive still contains old.txt",
  );
}

describe(`crash recovery ${CASE?.id ?? "(missing case)"}`, () => {
  before(async () => {
    assert.ok(CASE, "ZINNIA_E2E_CASE is not set");
    await waitForAppShell();
    await waitForE2eHook();
  });

  it(`recovers after the ${CASE.point} crash (expect ${CASE.expect})`, async () => {
    assert.equal(
      process.env.ZINNIA_E2E_CRASH_AT ?? "",
      "",
      "recovery launch inherited a crash point",
    );
    // Startup recovery runs on a background thread. Wait for its one-shot
    // result instead of racing it with disk checks.
    const status = await awaitStartupRecoveryStatus();
    assert.equal(
      status.error,
      undefined,
      `status call failed: ${status.error}`,
    );
    assert.equal(
      status.value,
      null,
      `startup recovery reported an error: ${status.value}`,
    );
    const banner = await bannerState();
    assert.equal(
      banner.visible,
      false,
      `startup banner shown after recovery: ${banner.text}`,
    );

    assert.equal(
      fs.existsSync(CASE.journal),
      false,
      "recovery journal survived startup recovery",
    );

    const currentManifest = treeManifest(CASE.root);
    const preManifest = readJsonIfPresent(CASE.preManifestFile);
    const leftovers = findLeftovers(CASE.root);
    assert.deepEqual(leftovers, [], "recovery left stage or sidecar files");
    assertInputsUnchanged(preManifest, currentManifest);
    assertDestinationState(preManifest, currentManifest);

    writeEvidence(EVIDENCE_DIR, `${CASE.id}.recovery`, {
      scenario: CASE.id,
      phase: "recovery",
      operation: CASE.operation,
      crashPoint: CASE.point,
      expect: CASE.expect,
      startupRecoveryError: status.value,
      banner: banner.visible ? banner.text : null,
      journalPresent: false,
      leftovers,
      destination: subtree(currentManifest, "out"),
      preDestination: subtree(preManifest, "out"),
      inputsUnchanged: true,
    });
  });

  it("completes a new operation on the recovered state", async () => {
    await waitForArchiveIdle();
    if (CASE.operation === "extract") {
      await startPowerExtract(CASE.archive, CASE.afterOperation);
      const extracted = `${CASE.afterOperation}/hello.txt`;
      await browser.waitUntil(() => fs.existsSync(extracted), {
        timeout: 60_000,
        timeoutMsg: `post-recovery extraction did not write ${extracted}`,
      });
      assert.equal(fs.readFileSync(extracted, "utf8"), CASE.payloadText);
    } else {
      await startPowerCompress(CASE.input, CASE.afterOperation);
      await browser.waitUntil(() => fs.existsSync(CASE.afterOperation), {
        timeout: 60_000,
        timeoutMsg: `post-recovery compress did not write ${CASE.afterOperation}`,
      });
      verifyArchiveHasHello(CASE.afterOperation);
    }
    await waitForArchiveIdle();
    assert.deepEqual(
      findLeftovers(CASE.root),
      [],
      "new operation left stage files",
    );
    const producedFile =
      CASE.operation === "extract"
        ? `${CASE.afterOperation}/hello.txt`
        : CASE.afterOperation;
    writeEvidence(EVIDENCE_DIR, `${CASE.id}.after`, {
      scenario: CASE.id,
      phase: "post-recovery-operation",
      operation: CASE.operation,
      output: producedFile,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(producedFile))
        .digest("hex"),
    });
  });
});
