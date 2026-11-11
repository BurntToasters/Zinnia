import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  cancelInputModal,
  confirmInputModal,
  dismissToasts,
  queueDialogResult,
  startPowerExtract,
  switchToPowerWorkspace,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForInputModalLabel,
  waitForMainWindow,
  waitForToastContaining,
} from "../helpers/ui-driver.js";
import {
  findLeftovers,
  sha256File,
  writeEvidence,
} from "../helpers/recovery-harness.js";
import { buildStoredZip } from "../helpers/archive-writers.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const ROOT = path.join(process.env.ZINNIA_E2E_WORK, "release-safeguards");
const WINDOWS_MARKER =
  "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.invalid/zinnia-e2e.zip\r\n";
const MACOS_MARKER = "0081;65f0a1b2;Safari;ZINNIA-E2E-0001";
const FILE_ATTRIBUTE_READONLY = 0x1;
const FILE_ATTRIBUTE_SYSTEM = 0x4;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;

function setDownloadMarker(file) {
  if (process.platform === "win32") {
    fs.writeFileSync(`${file}:Zone.Identifier`, WINDOWS_MARKER);
    return WINDOWS_MARKER;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("xattr", [
      "-w",
      "com.apple.quarantine",
      MACOS_MARKER,
      file,
    ]);
    assert.equal(result.status, 0, "could not quarantine the source archive");
    return MACOS_MARKER;
  }
  return null;
}

function readDownloadMarker(file) {
  if (process.platform === "win32") {
    try {
      return fs.readFileSync(`${file}:Zone.Identifier`, "utf8");
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("xattr", ["-p", "com.apple.quarantine", file], {
      encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : null;
  }
  return null;
}

function windowsAttributes(target) {
  const literal = target.replace(/'/g, "''");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[int](Get-Item -LiteralPath '${literal}' -Force).Attributes`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `could not read attributes of ${target}: ${result.stderr}`,
  );
  return Number.parseInt(result.stdout.trim(), 10);
}

function listArchive(archive, password) {
  return run7z(requireHostSidecar(), [
    "l",
    "-slt",
    "-ba",
    ...(password ? [`-p${password}`] : []),
    "--",
    archive,
  ]).stdout;
}

function memberMethods(listing) {
  const methods = new Map();
  let current = null;
  for (const line of listing.split(/\r?\n/)) {
    const pathMatch = line.match(/^Path = (.+)$/);
    if (pathMatch) current = pathMatch[1];
    const methodMatch = line.match(/^Method = (.+)$/);
    if (methodMatch && current) methods.set(current, methodMatch[1]);
  }
  return methods;
}

/** Per-member `Encrypted` and `Method` from a `-slt` listing. */
function memberRecords(listing) {
  const records = new Map();
  let current = null;
  for (const line of listing.split(/\r?\n/)) {
    const pathMatch = line.match(/^Path = (.+)$/);
    if (pathMatch) {
      current = { encrypted: null, method: "" };
      records.set(pathMatch[1], current);
      continue;
    }
    if (!current) continue;
    const encrypted = line.match(/^Encrypted = (.*)$/);
    if (encrypted) current.encrypted = encrypted[1].trim();
    const method = line.match(/^Method = (.*)$/);
    if (method) current.method = method[1].trim();
  }
  return records;
}

function memberRecordsForName(listing, name) {
  const records = [];
  let current = null;
  const flush = () => {
    if (current?.path === name) records.push(current);
  };
  for (const line of listing.split(/\r?\n/)) {
    const pathMatch = line.match(/^Path = (.+)$/);
    if (pathMatch) {
      flush();
      current = { path: pathMatch[1], encrypted: null, method: "" };
      continue;
    }
    if (!current) continue;
    const encrypted = line.match(/^Encrypted = (.*)$/);
    if (encrypted) current.encrypted = encrypted[1].trim();
    const method = line.match(/^Method = (.*)$/);
    if (method) current.method = method[1].trim();
  }
  flush();
  return records;
}

/** True when 7-Zip can extract `member` from `archive` with `password`. */
function memberReadableWith(archive, member, password) {
  const result = spawnSync(
    requireHostSidecar(),
    ["e", "-so", `-p${password}`, "--", archive, member],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

/** Call `run_7z` over IPC; resolve to `{ result }` or `{ error }` instead of throwing. */
async function invokeRun7zUpdate(archive, args) {
  const token = await browser.execute(
    (target) =>
      window.__TAURI_INTERNALS__.invoke("archive_output_selection_token", {
        path: target,
      }),
    archive,
  );
  assert.ok(token && token !== "absent", "no output token for the archive");
  // A rejected invoke surfaces as a WebDriver error on this side, not in the page.
  try {
    const result = await browser.execute(
      (requestJson) =>
        window.__TAURI_INTERNALS__.invoke("run_7z", { requestJson }),
      JSON.stringify({ args, expectedArchiveIdentity: token }),
    );
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function clickBrowseAddFiles(files) {
  await queueDialogResult(files);
  await browser.execute(() => {
    document.getElementById("browse-add-files")?.click();
  });
}

async function openInBrowse(archive, member) {
  await switchToPowerWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await applyIncomingPaths([archive], "");
  await browser.waitUntil(
    async () => (await $("#browse-tbody").getText()).includes(member),
    { timeout: 30_000, timeoutMsg: `browse did not list ${member}` },
  );
  await waitForArchiveIdle();
}

describe("beta.5 release safeguards", () => {
  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("marks a converted archive with the source download marker before publishing it", async function () {
    const hello = path.join(ROOT, "hello.txt");
    fs.writeFileSync(hello, PAYLOAD);
    const source = path.join(ROOT, "downloaded.zip");
    run7z(requireHostSidecar(), ["a", "-tzip", source, "--", "hello.txt"], {
      cwd: ROOT,
    });
    const marker = setDownloadMarker(source);
    if (marker === null) {
      writeEvidence(EVIDENCE_DIR, "convert-download-marker", {
        scenario: "convert-download-marker",
        platform: process.platform,
        skipped: "platform has no download marker",
      });
      this.skip();
    }
    const dest = path.join(ROOT, "converted.7z");

    await openInBrowse(source, "hello.txt");
    await browser.execute(() => {
      const select = document.getElementById("format");
      select.value = "7z";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await queueDialogResult(dest);
    await browser.execute(() => {
      document.getElementById("browse-convert")?.click();
    });
    // Convert opens its own dialog first. Accept the 7z default and submit.
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.getElementById("convert-overlay")?.hidden === false,
        ),
      { timeout: 60_000, timeoutMsg: "convert dialog did not open" },
    );
    await browser.execute(() => {
      document.getElementById("convert-submit")?.click();
    });
    await browser.waitUntil(() => fs.existsSync(dest), {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "conversion did not publish converted.7z",
    });
    await waitForArchiveIdle();

    const destMarker = readDownloadMarker(dest);
    assert.ok(destMarker, "converted archive has no download marker");
    assert.equal(destMarker.trim(), marker.trim());
    const members = [...listArchive(dest).matchAll(/^Path = (.+)$/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(members, ["hello.txt"]);
    assert.deepEqual(
      findLeftovers(ROOT).filter((name) => name.startsWith(".zinnia-")),
      [],
      "conversion left stage files",
    );

    writeEvidence(EVIDENCE_DIR, "convert-download-marker", {
      scenario: "convert-download-marker",
      platform: process.platform,
      sourceMarked: true,
      convertedMarker: destMarker,
      markerMatches: destMarker.trim() === marker.trim(),
      convertedSha256: sha256File(dest),
      members,
    });
  });

  it("keeps the download marker on files extracted from a downloaded archive", async function () {
    if (process.platform !== "darwin") {
      writeEvidence(EVIDENCE_DIR, "extract-download-marker", {
        scenario: "extract-download-marker",
        platform: process.platform,
        skipped: "macOS-only quarantine download marker",
      });
      this.skip();
    }
    const treeSource = path.join(ROOT, "download-tree-src");
    fs.mkdirSync(path.join(treeSource, "inner"), { recursive: true });
    fs.writeFileSync(path.join(treeSource, "inner", "hello.txt"), PAYLOAD);
    fs.writeFileSync(path.join(treeSource, "top.txt"), "top level\n");
    const archive = path.join(ROOT, "download-tree.zip");
    run7z(
      requireHostSidecar(),
      ["a", "-tzip", archive, "--", "inner/hello.txt", "top.txt"],
      { cwd: treeSource },
    );
    const marker = setDownloadMarker(archive);
    const dest = path.join(ROOT, "download-tree-out");
    const nestedFile = path.join(dest, "inner", "hello.txt");

    await startPowerExtract(archive, dest);
    await browser.waitUntil(() => fs.existsSync(nestedFile), {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "extraction did not publish inner/hello.txt",
    });
    await waitForArchiveIdle();

    const targets = {
      ".": dest,
      inner: path.join(dest, "inner"),
      "top.txt": path.join(dest, "top.txt"),
      "inner/hello.txt": nestedFile,
    };
    const markers = Object.fromEntries(
      Object.entries(targets).map(([relative, target]) => [
        relative,
        readDownloadMarker(target)?.trim() ?? null,
      ]),
    );
    const markersMatch = Object.values(markers).every(
      (value) => value !== null && value === marker.trim(),
    );
    for (const [relative, value] of Object.entries(markers)) {
      assert.ok(value, `${relative} has no download marker`);
      assert.equal(value, marker.trim(), `${relative} marker differs`);
    }
    assert.deepEqual(
      findLeftovers(ROOT).filter((name) => name.startsWith(".zinnia-")),
      [],
      "extraction left stage files",
    );

    writeEvidence(EVIDENCE_DIR, "extract-download-marker", {
      scenario: "extract-download-marker",
      platform: process.platform,
      archiveMarker: marker.trim(),
      markers,
      markersMatch,
    });
  });

  it("encrypts files added over IPC with a password to a ZIP without a .zip name using AES-256", async () => {
    const hello = path.join(ROOT, "legacy-hello.txt");
    fs.writeFileSync(hello, PAYLOAD);
    const archive = path.join(ROOT, "legacy.bin");
    run7z(
      requireHostSidecar(),
      ["a", "-tzip", archive, "--", "legacy-hello.txt"],
      { cwd: ROOT },
    );
    const added = path.join(ROOT, "secret-added.txt");
    fs.writeFileSync(added, "added with a password\n");
    const password = "Zinnia-E2E-Secret-5";

    await waitForArchiveIdle();
    const token = await browser.execute(
      (target) =>
        window.__TAURI_INTERNALS__.invoke("archive_output_selection_token", {
          path: target,
        }),
      archive,
    );
    assert.ok(token && token !== "absent", "no output token for the archive");
    const result = await browser.execute(
      (requestJson) =>
        window.__TAURI_INTERNALS__.invoke("run_7z", { requestJson }),
      JSON.stringify({
        args: [
          "u",
          "-sse",
          "-snl",
          "-snh",
          "-spd",
          `-p${password}`,
          archive,
          "--",
          added,
        ],
        expectedArchiveIdentity: token,
      }),
    );
    assert.equal(result.code, 0, `run_7z update failed: ${result.stderr}`);
    assert.ok(
      listArchive(archive).includes("secret-added.txt"),
      "update did not add secret-added.txt",
    );

    const methods = memberMethods(listArchive(archive, password));
    const method = methods.get("secret-added.txt") ?? "";
    assert.match(method, /AES-256/, `added member method is ${method}`);
    assert.doesNotMatch(method, /ZipCrypto/);

    const check = path.join(ROOT, "legacy-check");
    fs.mkdirSync(check, { recursive: true });
    run7z(requireHostSidecar(), [
      "x",
      "-y",
      `-p${password}`,
      `-o${check}`,
      "--",
      archive,
    ]);
    assert.equal(
      fs.readFileSync(path.join(check, "secret-added.txt"), "utf8"),
      "added with a password\n",
    );
    assert.equal(
      fs.readFileSync(path.join(check, "legacy-hello.txt"), "utf8"),
      PAYLOAD,
    );

    writeEvidence(EVIDENCE_DIR, "password-zip-update-aes", {
      scenario: "password-zip-update-aes",
      archive: path.basename(archive),
      addedMemberMethod: method,
      existingMemberMethod: methods.get("legacy-hello.txt") ?? null,
    });
  });

  it("asks for the password before adding files to an encrypted 7z, and encrypts the added file", async function () {
    this.timeout(300_000);
    const work = path.join(ROOT, "enc-7z");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "old.txt"), PAYLOAD);
    const archive = path.join(ROOT, "encrypted.7z");
    const password = "Zinnia-E2E-7z-Secret";
    run7z(
      requireHostSidecar(),
      ["a", "-t7z", `-p${password}`, archive, "--", "old.txt"],
      { cwd: work },
    );
    const added = path.join(ROOT, "enc-7z-added.txt");
    fs.writeFileSync(added, "must stay encrypted\n");
    const before = sha256File(archive);

    await openInBrowse(archive, "old.txt");
    await dismissToasts();
    await clickBrowseAddFiles([added]);
    const promptLabel = await waitForInputModalLabel(
      "encrypted",
      "adding to an encrypted 7z without a password did not ask for it",
    );
    await cancelInputModal();
    await waitForArchiveIdle();
    assert.equal(
      sha256File(archive),
      before,
      "a cancelled password prompt still changed the archive",
    );

    await clickBrowseAddFiles([added]);
    await waitForInputModalLabel(
      "encrypted",
      "second add attempt did not ask for the password",
    );
    await confirmInputModal(password);
    await browser.waitUntil(
      () => listArchive(archive, password).includes("enc-7z-added.txt"),
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "add files with the password did not publish the file",
      },
    );
    await waitForArchiveIdle();

    const records = memberRecords(listArchive(archive, password));
    const addedRecord = records.get("enc-7z-added.txt");
    assert.equal(
      addedRecord?.encrypted,
      "+",
      "added 7z member is not encrypted",
    );
    assert.equal(records.get("old.txt")?.encrypted, "+");
    assert.equal(
      memberReadableWith(archive, "enc-7z-added.txt", "wrong-password"),
      false,
      "added 7z member is readable with a wrong password",
    );
    assert.equal(
      memberReadableWith(archive, "enc-7z-added.txt", password),
      true,
    );

    writeEvidence(EVIDENCE_DIR, "encrypted-7z-add-requires-password", {
      scenario: "encrypted-7z-add-requires-password",
      promptLabel,
      cancelledArchiveUnchanged: true,
      addedMember: addedRecord,
      existingMember: records.get("old.txt") ?? null,
    });
  });

  it("refuses an IPC update of an encrypted ZIP without the right password and leaves it unchanged", async () => {
    const work = path.join(ROOT, "enc-zip");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "old.txt"), PAYLOAD);
    const archive = path.join(ROOT, "encrypted-aes.zip");
    const password = "Zinnia-E2E-Zip-Secret";
    run7z(
      requireHostSidecar(),
      ["a", "-tzip", `-p${password}`, "-mem=AES256", archive, "--", "old.txt"],
      { cwd: work },
    );
    const added = path.join(ROOT, "enc-zip-added.txt");
    fs.writeFileSync(added, "must stay encrypted\n");
    const before = sha256File(archive);
    const update = ["u", "-sse", "-snl", "-snh", "-spd"];

    await waitForArchiveIdle();
    const missing = await invokeRun7zUpdate(archive, [
      ...update,
      archive,
      "--",
      added,
    ]);
    assert.ok(
      missing.error || missing.result?.code !== 0,
      "update of an encrypted ZIP without a password succeeded",
    );
    const missingText = missing.error ?? missing.result?.stderr ?? "";
    assert.match(missingText, /password/i);
    assert.equal(sha256File(archive), before, "archive changed (no password)");

    const wrong = await invokeRun7zUpdate(archive, [
      ...update,
      "-pnot-the-password",
      archive,
      "--",
      added,
    ]);
    assert.ok(
      wrong.error || wrong.result?.code !== 0,
      "update of an encrypted ZIP with a wrong password succeeded",
    );
    const wrongText = wrong.error ?? wrong.result?.stderr ?? "";
    assert.match(wrongText, /wrong password/i);
    assert.doesNotMatch(wrongText, /not-the-password/);
    assert.equal(
      sha256File(archive),
      before,
      "archive changed (wrong password)",
    );

    const right = await invokeRun7zUpdate(archive, [
      ...update,
      `-p${password}`,
      archive,
      "--",
      added,
    ]);
    assert.equal(right.error, undefined, `update failed: ${right.error}`);
    assert.equal(right.result.code, 0, `update failed: ${right.result.stderr}`);
    const records = memberRecords(listArchive(archive, password));
    assert.equal(records.get("enc-zip-added.txt")?.encrypted, "+");
    assert.match(records.get("enc-zip-added.txt")?.method ?? "", /AES-256/);
    assert.equal(
      memberReadableWith(archive, "enc-zip-added.txt", "wrong-password"),
      false,
    );

    writeEvidence(EVIDENCE_DIR, "encrypted-zip-update-password-policy", {
      scenario: "encrypted-zip-update-password-policy",
      missingPasswordRefused: missingText.slice(0, 200),
      wrongPasswordRefused: wrongText.slice(0, 200),
      addedMember: records.get("enc-zip-added.txt") ?? null,
    });
  });

  it("requires encrypted-data proof when listed member names are lossy or ambiguous", async function () {
    this.timeout(300_000);
    if (process.platform === "win32") {
      writeEvidence(EVIDENCE_DIR, "encrypted-member-name-preflight", {
        scenario: "encrypted-member-name-preflight",
        platform: process.platform,
        skipped: "POSIX newline member names are unsupported on Windows",
      });
      this.skip();
    }

    const password = "Zinnia-E2E-Original-Password";
    const wrongPassword = "Zinnia-E2E-Wrong-Password";
    for (const format of ["7z", "zip"]) {
      for (const scenario of [
        "case-normalized-alias",
        "lossy-name",
        "normalized-alias",
      ]) {
        const aliasName =
          scenario === "case-normalized-alias"
            ? "TINY_SECRET.TXT"
            : "tiny_secret.txt";
        const work = path.join(ROOT, `password-proof-${format}-${scenario}`);
        fs.mkdirSync(work, { recursive: true });
        fs.writeFileSync(
          path.join(work, "tiny\nsecret.txt"),
          "encrypted tiny\n",
        );
        fs.writeFileSync(
          path.join(work, "large.txt"),
          "encrypted larger payload\n".repeat(40),
        );
        const archive = path.join(
          ROOT,
          `password-proof-${format}-${scenario}.${format}`,
        );
        const createArgs = [
          "a",
          `-t${format}`,
          `-p${password}`,
          ...(format === "7z" ? ["-ms=off"] : ["-mem=AES256"]),
          archive,
          "--",
          "tiny\nsecret.txt",
          "large.txt",
        ];
        run7z(requireHostSidecar(), createArgs, { cwd: work });

        if (scenario !== "lossy-name") {
          fs.writeFileSync(path.join(work, aliasName), "plaintext alias\n");
          run7z(requireHostSidecar(), ["u", "-spd", archive, "--", aliasName], {
            cwd: work,
          });
        }

        const listed = listArchive(archive, password);
        const selectedNameMembers = memberRecordsForName(
          listed,
          "tiny_secret.txt",
        );
        const aliasMembers =
          scenario === "case-normalized-alias"
            ? memberRecordsForName(listed, aliasName)
            : [];
        const displayedMembers = [...selectedNameMembers, ...aliasMembers];
        assert.equal(
          displayedMembers.length,
          scenario === "lossy-name" ? 1 : 2,
          "fixture does not contain the expected lossy display name/alias",
        );
        if (scenario !== "lossy-name") {
          assert.deepEqual(
            displayedMembers.map((record) => record.encrypted).sort(),
            ["+", "-"],
            "fixture alias must pair encrypted newline data with a plaintext literal name",
          );
        } else {
          assert.equal(displayedMembers[0]?.encrypted, "+");
        }
        if (scenario === "case-normalized-alias") {
          const insensitive = run7z(
            requireHostSidecar(),
            [
              "t",
              "-ssc-",
              `-p${wrongPassword}`,
              "--",
              archive,
              "tiny_secret.txt",
            ],
            { allowFailure: true },
          );
          const sensitive = run7z(
            requireHostSidecar(),
            [
              "t",
              "-ssc",
              `-p${wrongPassword}`,
              "--",
              archive,
              "tiny_secret.txt",
            ],
            { allowFailure: true },
          );
          assert.equal(insensitive.code, 0);
          assert.doesNotMatch(insensitive.stdout, /No files to process/i);
          assert.match(insensitive.stdout, /Size:\s*[1-9]\d*/);
          assert.equal(sensitive.code, 0);
          assert.match(sensitive.stdout, /No files to process/i);
          writeEvidence(
            EVIDENCE_DIR,
            `password-proof-${format}-${scenario}-selector-control`,
            {
              scenario: `password-proof-${format}-${scenario}-selector-control`,
              caseInsensitiveSelectorAcceptedPlaintextAlias: true,
              caseSensitiveSelectorReportedNoFiles: true,
            },
          );
        }

        const addedName = `added-${format}-${scenario}.txt`;
        const added = path.join(ROOT, addedName);
        fs.writeFileSync(added, "new data must retain the original password\n");
        const before = sha256File(archive);
        const update = ["u", "-sse", "-snl", "-snh", "-spd"];
        await waitForArchiveIdle();

        const wrong = await invokeRun7zUpdate(archive, [
          ...update,
          `-p${wrongPassword}`,
          archive,
          "--",
          added,
        ]);
        const wrongText = wrong.error ?? wrong.result?.stderr ?? "";
        writeEvidence(
          EVIDENCE_DIR,
          `password-proof-${format}-${scenario}-wrong`,
          {
            scenario: `password-proof-${format}-${scenario}-wrong`,
            wrongPasswordRefused: Boolean(
              wrong.error || wrong.result?.code !== 0,
            ),
            error: wrongText.slice(0, 240),
            archiveUnchanged: sha256File(archive) === before,
            displayedMembers,
          },
        );
        assert.ok(
          wrong.error || wrong.result?.code !== 0,
          `${format} ${scenario} update accepted a wrong password`,
        );
        assert.match(wrongText, /wrong password/i);
        assert.doesNotMatch(wrongText, new RegExp(wrongPassword));
        assert.equal(
          sha256File(archive),
          before,
          "wrong-password update changed the archive",
        );

        const right = await invokeRun7zUpdate(archive, [
          ...update,
          `-p${password}`,
          archive,
          "--",
          added,
        ]);
        assert.equal(
          right.error,
          undefined,
          `${format} ${scenario} update failed: ${right.error}`,
        );
        assert.equal(
          right.result.code,
          0,
          `${format} ${scenario} update failed: ${right.result.stderr}`,
        );
        assert.equal(
          memberReadableWith(archive, addedName, password),
          true,
          "new member cannot be decrypted with the original password",
        );
        assert.equal(
          memberReadableWith(archive, addedName, wrongPassword),
          false,
          "new member is readable with the wrong password",
        );
        writeEvidence(
          EVIDENCE_DIR,
          `password-proof-${format}-${scenario}-right`,
          {
            scenario: `password-proof-${format}-${scenario}-right`,
            correctPasswordUpdateSucceeded: true,
            addedMemberReadableWithOriginal: true,
            addedMemberReadableWithWrongPassword: false,
            archiveSha256: sha256File(archive),
          },
        );
      }
    }
  });

  it("still adds files to a plaintext 7z without asking for a password", async () => {
    const work = path.join(ROOT, "plain-7z");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "old.txt"), PAYLOAD);
    const archive = path.join(ROOT, "plain.7z");
    run7z(requireHostSidecar(), ["a", "-t7z", archive, "--", "old.txt"], {
      cwd: work,
    });
    const added = path.join(ROOT, "plain-added.txt");
    fs.writeFileSync(added, "plain\n");

    await waitForArchiveIdle();
    const outcome = await invokeRun7zUpdate(archive, [
      "u",
      "-sse",
      "-snl",
      "-snh",
      "-spd",
      archive,
      "--",
      added,
    ]);
    assert.equal(outcome.error, undefined, `update failed: ${outcome.error}`);
    assert.equal(outcome.result.code, 0, outcome.result.stderr);
    const records = memberRecords(listArchive(archive));
    assert.equal(records.get("plain-added.txt")?.encrypted, "-");

    writeEvidence(EVIDENCE_DIR, "plaintext-7z-update-unchanged", {
      scenario: "plaintext-7z-update-unchanged",
      addedMember: records.get("plain-added.txt") ?? null,
    });
  });

  it("refuses to add files to a ZIP with ZipCrypto members, from the UI and over IPC", async () => {
    const work = path.join(ROOT, "zipcrypto");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "old.txt"), PAYLOAD);
    const archive = path.join(ROOT, "zipcrypto.zip");
    const password = "Zinnia-E2E-ZipCrypto";
    run7z(
      requireHostSidecar(),
      [
        "a",
        "-tzip",
        `-p${password}`,
        "-mem=ZipCrypto",
        archive,
        "--",
        "old.txt",
      ],
      { cwd: work },
    );
    assert.match(
      memberRecords(listArchive(archive, password)).get("old.txt")?.method ??
        "",
      /ZipCrypto/,
      "fixture is not ZipCrypto; the test proves nothing",
    );
    const added = path.join(ROOT, "zipcrypto-added.txt");
    fs.writeFileSync(added, "should not be added\n");
    const before = sha256File(archive);

    await openInBrowse(archive, "old.txt");
    await dismissToasts();
    await browser.execute((value) => {
      const field = document.getElementById("browse-password");
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, password);
    await clickBrowseAddFiles([added]);
    await waitForToastContaining(
      "ZipCrypto",
      "UI add to a ZipCrypto ZIP did not show the ZipCrypto refusal",
    );
    await waitForArchiveIdle();
    assert.equal(
      sha256File(archive),
      before,
      "UI add changed the ZipCrypto ZIP",
    );

    const ipc = await invokeRun7zUpdate(archive, [
      "u",
      "-sse",
      "-snl",
      "-snh",
      "-spd",
      `-p${password}`,
      archive,
      "--",
      added,
    ]);
    assert.ok(
      ipc.error || ipc.result?.code !== 0,
      "IPC update of a ZipCrypto ZIP succeeded",
    );
    assert.match(ipc.error ?? ipc.result?.stderr ?? "", /ZipCrypto/);
    assert.equal(
      sha256File(archive),
      before,
      "IPC update changed the ZipCrypto ZIP",
    );

    writeEvidence(EVIDENCE_DIR, "zipcrypto-update-refused", {
      scenario: "zipcrypto-update-refused",
      uiRefused: true,
      ipcRefused: (ipc.error ?? ipc.result?.stderr ?? "").slice(0, 200),
    });
  });

  it("does not keep read-only or system attributes on extracted Windows folders", async function () {
    if (process.platform !== "win32") {
      writeEvidence(EVIDENCE_DIR, "windows-folder-attributes", {
        scenario: "windows-folder-attributes",
        platform: process.platform,
        skipped: "Windows-only folder attributes",
      });
      this.skip();
    }
    const archive = path.join(ROOT, "desktop-ini.zip");
    fs.writeFileSync(
      archive,
      buildStoredZip([
        {
          name: "trap/",
          dosAttributes:
            FILE_ATTRIBUTE_DIRECTORY |
            FILE_ATTRIBUTE_READONLY |
            FILE_ATTRIBUTE_SYSTEM,
        },
        {
          name: "trap/desktop.ini",
          data: "[.ShellClassInfo]\r\nIconResource=\\\\example.invalid\\share\\icon.ico,0\r\n",
          dosAttributes: 0x2 | FILE_ATTRIBUTE_SYSTEM,
        },
      ]),
    );

    const control = path.join(ROOT, "desktop-ini-control");
    run7z(requireHostSidecar(), ["x", "-y", `-o${control}`, "--", archive]);
    const controlAttributes = windowsAttributes(path.join(control, "trap"));
    assert.ok(
      controlAttributes & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM),
      `7-Zip did not apply the folder attributes (${controlAttributes}); the fixture proves nothing`,
    );

    const dest = path.join(ROOT, "desktop-ini-out");
    await startPowerExtract(archive, dest);
    const ini = path.join(dest, "trap", "desktop.ini");
    await browser.waitUntil(() => fs.existsSync(ini), {
      timeout: 60_000,
      interval: 200,
      timeoutMsg: "extraction did not publish trap/desktop.ini",
    });
    await waitForArchiveIdle();

    const folderAttributes = windowsAttributes(path.join(dest, "trap"));
    assert.equal(
      folderAttributes & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM),
      0,
      `extracted folder kept attributes ${folderAttributes}`,
    );
    const iniAttributes = windowsAttributes(ini);
    assert.ok(
      iniAttributes & FILE_ATTRIBUTE_SYSTEM,
      `file attributes were cleared too (${iniAttributes})`,
    );
    assert.deepEqual(
      findLeftovers(ROOT).filter((name) => name.startsWith(".zinnia-")),
      [],
    );

    writeEvidence(EVIDENCE_DIR, "windows-folder-attributes", {
      scenario: "windows-folder-attributes",
      platform: process.platform,
      controlFolderAttributes: controlAttributes,
      zinniaFolderAttributes: folderAttributes,
      desktopIniAttributes: iniAttributes,
    });
  });
});
