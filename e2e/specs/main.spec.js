import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $, expect } from "@wdio/globals";

async function waitForMainWindow() {
  await $("#app").waitForExist({ timeout: 30_000 });
  await $("#basic-workspace").waitForDisplayed({ timeout: 30_000 });
}

async function waitForE2eHook() {
  await browser.waitUntil(
    async () => browser.execute(() => Boolean(window.__ZINNIA_E2E__)),
    {
      timeout: 30_000,
      timeoutMsg: "window.__ZINNIA_E2E__ was not installed",
    },
  );
}

async function applyIncomingPaths(paths, mode) {
  await waitForE2eHook();
  const error = await browser.executeAsync(
    (nextPaths, nextMode, done) => {
      window.__ZINNIA_E2E__
        .applyIncomingPaths(nextPaths, nextMode)
        .then(() => done(null))
        .catch((err) => done(err instanceof Error ? err.message : String(err)));
    },
    paths,
    mode,
  );
  if (error) throw new Error(String(error));
}

async function setInputValue(selector, value) {
  const el = await $(selector);
  await el.waitForExist({ timeout: 10_000 });
  await el.setValue(value);
}

async function extractArchiveTo(archive, dest, options = {}) {
  await $('[data-mode-btn="extract"]').waitForDisplayed({ timeout: 10_000 });
  await applyIncomingPaths([archive], "extract");
  if (options.password) {
    await setInputValue("#extract-password", options.password);
  }
  await setInputValue("#extract-path", dest);
  await $("#extract-run").click();
}

describe("Zinnia main window", () => {
  before(async () => {
    await waitForMainWindow();
  });

  it("shows the Basic workspace after launch", async () => {
    await expect($("#basic-workspace")).toBeDisplayed();
    await expect($("#setup-wizard-overlay")).not.toBeDisplayed();
  });

  it("opens and closes Settings", async () => {
    // Titlebar/header buttons sit on a drag region. WKWebView WebDriver
    // clicks can miss them; a DOM click still fires the production listener.
    await browser.execute(() => {
      document.getElementById("open-settings")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.getElementById("settings-overlay")?.hidden === false,
        ),
      {
        timeout: 10_000,
        timeoutMsg: "Settings overlay stayed hidden",
      },
    );
    await browser.execute(() => {
      document.getElementById("tab-general")?.click();
    });
    await browser.execute(() => {
      document.getElementById("close-settings")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.getElementById("settings-overlay")?.hidden === true,
        ),
      {
        timeout: 10_000,
        timeoutMsg: "Settings overlay stayed open",
      },
    );
  });

  it("extracts hello.7z from Power using a typed destination", async () => {
    const archive = process.env.ZINNIA_E2E_HELLO_7Z;
    const dest = process.env.ZINNIA_E2E_EXTRACT_OUT;
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    await $("#workspace-mode-power").click();
    await extractArchiveTo(archive, dest);
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 60_000,
      timeoutMsg: `extract did not write ${extracted}`,
    });
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);
  });

  it("extracts hello.zip from Power using a typed destination", async () => {
    const archive = process.env.ZINNIA_E2E_HELLO_ZIP;
    const dest = process.env.ZINNIA_E2E_EXTRACT_OUT_ZIP;
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    await extractArchiveTo(archive, dest);
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 60_000,
      timeoutMsg: `zip extract did not write ${extracted}`,
    });
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);
  });

  it("extracts nested.zip preserving the nested member path", async () => {
    const archive = process.env.ZINNIA_E2E_NESTED_ZIP;
    const dest = process.env.ZINNIA_E2E_EXTRACT_OUT_NESTED;
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    await extractArchiveTo(archive, dest);
    const extracted = path.join(dest, "nested", "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 60_000,
      timeoutMsg: `nested extract did not write ${extracted}`,
    });
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);
  });

  it("extracts encrypted.7z when the password field is set", async () => {
    const archive = process.env.ZINNIA_E2E_ENCRYPTED_7Z;
    const dest = process.env.ZINNIA_E2E_EXTRACT_OUT_ENCRYPTED;
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    const password = process.env.ZINNIA_E2E_PASSWORD;
    await extractArchiveTo(archive, dest, { password });
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 60_000,
      timeoutMsg: `encrypted extract did not write ${extracted}`,
    });
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);
  });

  it("creates a 7z from hello.txt using a typed output path", async () => {
    const input = process.env.ZINNIA_E2E_HELLO_TXT;
    const output = process.env.ZINNIA_E2E_COMPRESS_OUT;
    await $('[data-mode-btn="add"]').click();
    await applyIncomingPaths([input], "compress");
    await setInputValue("#output-path", output);
    await $("#run-action").click();
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: 60_000,
      timeoutMsg: `compress did not write ${output}`,
    });
    assert.ok(fs.statSync(output).size > 0);
  });

  it("lists hello.txt when browsing hello.7z", async () => {
    const archive = process.env.ZINNIA_E2E_HELLO_7Z;
    await applyIncomingPaths([archive], "");
    const tbody = await $("#browse-tbody");
    await tbody.waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(
      async () => (await tbody.getText()).includes("hello.txt"),
      {
        timeout: 20_000,
        timeoutMsg: "browse listing did not include hello.txt",
      },
    );
  });

  it("lists nested/hello.txt when browsing nested.zip", async () => {
    const archive = process.env.ZINNIA_E2E_NESTED_ZIP;
    await applyIncomingPaths([archive], "");
    const tbody = await $("#browse-tbody");
    await tbody.waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(
      async () => (await tbody.getText()).includes("hello.txt"),
      {
        timeout: 20_000,
        timeoutMsg: "nested zip browse listing did not include hello.txt",
      },
    );
  });
});
