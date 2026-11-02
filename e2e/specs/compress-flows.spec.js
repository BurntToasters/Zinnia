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
  domText,
  startPowerCompress,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const PAYLOAD = process.env.ZINNIA_E2E_PAYLOAD;
const WORK = process.env.ZINNIA_E2E_WORK;
const JOURNAL = process.env.ZINNIA_E2E_JOURNAL;
const ROOT = path.join(WORK, "compress-flows");
const sidecar = requireHostSidecar();
const ENCRYPT_PASSWORD = "ZinniaE2e-Encrypt-7z";

function writeIncompressibleFile(file, bytes) {
  const handle = fs.openSync(file, "w");
  try {
    const chunk = 4 * 1024 * 1024;
    for (let written = 0; written < bytes; written += chunk) {
      fs.writeSync(
        handle,
        crypto.randomBytes(Math.min(chunk, bytes - written)),
      );
    }
  } finally {
    fs.closeSync(handle);
  }
}

function listStdout(archive, password) {
  const args = ["l", "-slt", "--", archive];
  if (password) args.splice(1, 0, `-p${password}`);
  return run7z(sidecar, args).stdout;
}

async function waitForCompressRunning(timeout = 180_000) {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const power = document.getElementById("workspace-mode-power");
        return Boolean(power?.disabled);
      }),
    {
      timeout,
      interval: 50,
      timeoutMsg: "compress never entered a running state",
    },
  );
}

function outputDirListing(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

function zinniaStagingNames(dir) {
  return outputDirListing(dir).filter(
    (name) => name.includes("zinnia") || name.endsWith(".zinnia"),
  );
}

describe("Power compress flows", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("creates zip and gzip archives that list hello.txt", async () => {
    const hello = path.join(ROOT, "formats", "hello.txt");
    fs.mkdirSync(path.dirname(hello), { recursive: true });
    fs.writeFileSync(hello, PAYLOAD);

    const zipOut = path.join(ROOT, "formats", "hello.zip");
    await startPowerCompress(hello, zipOut, { format: "zip" });
    await browser.waitUntil(() => fs.existsSync(zipOut), {
      timeout: 120_000,
      timeoutMsg: `zip compress did not write ${zipOut}`,
    });
    await waitForArchiveIdle();
    const zipListing = listStdout(zipOut);
    assert.ok(
      listingHasMember(zipListing, "hello.txt"),
      `zip listing lacked hello.txt: ${zipListing}`,
    );

    const gzipOut = path.join(ROOT, "formats", "hello.txt.gz");
    await startPowerCompress(hello, gzipOut, { format: "gzip" });
    await browser.waitUntil(() => fs.existsSync(gzipOut), {
      timeout: 120_000,
      timeoutMsg: `gzip compress did not write ${gzipOut}`,
    });
    await waitForArchiveIdle();
    const gzipListing = listStdout(gzipOut);
    assert.ok(
      listingHasMember(gzipListing, "hello.txt"),
      `gzip listing lacked hello.txt: ${gzipListing}`,
    );

    writeEvidence(EVIDENCE_DIR, "compress-formats", {
      scenario: "compress-formats",
      input: hello,
      outputs: { zip: zipOut, gzip: gzipOut },
      uiFormatForGzip: "gzip",
      zipListsHello: listingHasMember(zipListing, "hello.txt"),
      gzipListsHello: listingHasMember(gzipListing, "hello.txt"),
    });
  });

  it("creates an encrypted 7z with hidden headers and no password in the log", async () => {
    const hello = path.join(ROOT, "encrypted", "hello.txt");
    fs.mkdirSync(path.dirname(hello), { recursive: true });
    fs.writeFileSync(hello, PAYLOAD);
    const archive = path.join(ROOT, "encrypted", "secret.7z");

    await startPowerCompress(hello, archive, {
      format: "7z",
      password: ENCRYPT_PASSWORD,
      encryptHeaders: true,
    });
    await browser.waitUntil(() => fs.existsSync(archive), {
      timeout: 120_000,
      timeoutMsg: `encrypted compress did not write ${archive}`,
    });
    await waitForArchiveIdle();

    const withoutPassword = run7z(sidecar, ["l", "-slt", "--", archive], {
      allowFailure: true,
    });
    const leakedWithoutPassword = listingHasMember(
      withoutPassword.stdout,
      "hello.txt",
    );
    assert.ok(
      withoutPassword.code !== 0 || !leakedWithoutPassword,
      `7z listed hello.txt without password: ${withoutPassword.stdout}`,
    );

    const withPassword = listStdout(archive, ENCRYPT_PASSWORD);
    assert.ok(
      listingHasMember(withPassword, "hello.txt"),
      `encrypted archive did not list hello.txt with password: ${withPassword}`,
    );

    const logText = String(await domText("#log"));
    assert.ok(
      !logText.includes(ENCRYPT_PASSWORD),
      `activity log leaked the archive password: ${logText.slice(-500)}`,
    );

    writeEvidence(EVIDENCE_DIR, "compress-encrypted", {
      scenario: "compress-encrypted",
      archive,
      listWithoutPasswordExit: withoutPassword.code,
      listWithoutPasswordShowsHello: leakedWithoutPassword,
      listWithPasswordShowsHello: listingHasMember(withPassword, "hello.txt"),
      passwordInLog: logText.includes(ENCRYPT_PASSWORD),
    });
  });

  it("creates split 7z volumes when the input exceeds the volume size", async () => {
    const dir = path.join(ROOT, "split");
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, "big.bin");
    writeIncompressibleFile(input, 3 * 1024 * 1024);
    const base = path.join(dir, "split.7z");

    await startPowerCompress(input, base, {
      format: "7z",
      level: "0",
      splitSize: "custom",
      splitCustom: "1m",
    });
    await browser.waitUntil(
      () =>
        fs.existsSync(path.join(dir, "split.7z.001")) &&
        fs.existsSync(path.join(dir, "split.7z.002")),
      {
        timeout: 180_000,
        timeoutMsg: `split compress did not write multiple volumes in ${dir}; saw ${outputDirListing(dir).join(", ")}; ${await uiDiagnostics()}`,
      },
    );
    await waitForArchiveIdle();

    const vol001 = path.join(dir, "split.7z.001");
    const vol002 = path.join(dir, "split.7z.002");
    assert.ok(fs.existsSync(vol001));
    assert.ok(fs.existsSync(vol002));

    writeEvidence(EVIDENCE_DIR, "compress-split", {
      scenario: "compress-split",
      inputBytes: fs.statSync(input).size,
      splitCustom: "1m",
      volumes: outputDirListing(dir).filter((name) =>
        /^split\.7z\.\d{3}$/.test(name),
      ),
    });
  });

  it("cancels a large compress cleanly and stays responsive", async function () {
    this.timeout(10 * 60_000);
    const dir = path.join(ROOT, "cancel");
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, "large.bin");
    const output = path.join(dir, "cancelled.7z");
    writeIncompressibleFile(input, 220 * 1024 * 1024);

    await startPowerCompress(input, output, {
      format: "7z",
      level: "9",
      run: false,
    });
    await browser.execute(() => {
      document.getElementById("run-action")?.click();
    });

    await waitForCompressRunning();
    await browser.waitUntil(() => fs.existsSync(JOURNAL), {
      timeout: 180_000,
      interval: 50,
      timeoutMsg: `compress never opened a recovery journal; ${await uiDiagnostics()}`,
    });
    const bytesAtCancel = fs.existsSync(output) ? fs.statSync(output).size : 0;

    await browser.execute(() => {
      document.getElementById("cancel-action")?.click();
    });

    const pingStart = Date.now();
    await browser.execute(() => Date.now());
    const pingMs = Date.now() - pingStart;
    assert.ok(
      pingMs < 1500,
      `main thread blocked during cancel (${pingMs} ms); ${await uiDiagnostics()}`,
    );

    await waitForArchiveIdle(180_000);

    assert.equal(
      fs.existsSync(output),
      false,
      `cancelled compress left ${output}; dir=${outputDirListing(dir).join(", ")}`,
    );
    assert.deepEqual(
      zinniaStagingNames(dir),
      [],
      `cancel left staging files: ${outputDirListing(dir).join(", ")}`,
    );

    writeEvidence(EVIDENCE_DIR, "compress-cancel", {
      scenario: "compress-cancel",
      inputBytes: 220 * 1024 * 1024,
      bytesWrittenAtCancel: bytesAtCancel,
      cancelPingMs: pingMs,
      outputExistsAfterCancel: fs.existsSync(output),
      outputDir: outputDirListing(dir),
      stagingNames: zinniaStagingNames(dir),
    });
  });
});
