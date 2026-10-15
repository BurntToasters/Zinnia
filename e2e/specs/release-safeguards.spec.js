import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
