import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $, expect } from "@wdio/globals";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";

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

async function queueDialogResult(result) {
  await waitForE2eHook();
  await browser.execute((next) => {
    window.__ZINNIA_E2E__.queueDialogResult(next);
  }, result);
}

async function domValue(selector) {
  return browser.execute(
    (target) => document.querySelector(target)?.value ?? null,
    selector,
  );
}

async function domText(selector) {
  return browser.execute(
    (target) => document.querySelector(target)?.textContent ?? null,
    selector,
  );
}

async function uiDiagnostics() {
  return browser.execute(() =>
    JSON.stringify({
      status: document.getElementById("status")?.textContent ?? null,
      toasts: [...document.querySelectorAll(".toast-message")].map(
        (toast) => toast.textContent,
      ),
      log: (document.getElementById("log")?.textContent ?? "")
        .split("\n")
        .slice(-15),
    }),
  );
}

async function waitForDomText(selector, expected, timeoutMsg) {
  await browser.waitUntil(async () => (await domText(selector)) === expected, {
    timeout: 20_000,
    timeoutMsg,
  });
}

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

async function setInputValue(selector, value) {
  const el = await $(selector);
  await el.waitForExist({ timeout: 10_000 });
  await el.setValue(value);
}

async function waitForArchiveIdle() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const button = document.getElementById("workspace-mode-power");
        return Boolean(button && !button.disabled);
      }),
    {
      timeout: 60_000,
      timeoutMsg: "Archive operation stayed active after its output appeared",
    },
  );
}

async function extractArchiveTo(archive, dest, options = {}) {
  await $('[data-mode-btn="extract"]').waitForDisplayed({ timeout: 10_000 });
  await waitForArchiveIdle();
  // Each case is an independent extraction. Explicit extract handoffs append
  // while the Power extract session is active so Finder/Explorer can deliver
  // one multi-selection in several batches; clear the prior case first.
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await applyIncomingPaths([archive], "extract");
  if (options.password) {
    await setInputValue("#extract-password", options.password);
  }
  await setInputValue("#extract-path", dest);
  await $("#extract-run").click();
}

async function switchToPowerWorkspace() {
  await waitForArchiveIdle();
  // Header controls can sit over native drag regions in WebKit; invoke the
  // same DOM click handler used by a real user while avoiding missed hit tests.
  await browser.execute(() => {
    document.getElementById("workspace-mode-power")?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("app")?.dataset.workspaceMode === "power",
      ),
    {
      timeout: 10_000,
      timeoutMsg: "Power workspace did not activate",
    },
  );
}

describe("Zinnia main window", () => {
  before(async () => {
    await waitForMainWindow();
    // The static HTML appears before app-init finishes wiring handlers.
    // Wait for its E2E hook so the first interaction cannot race bootstrap.
    await waitForE2eHook();
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

  it("extracts hello.7z from Basic using a typed destination", async () => {
    const archive = process.env.ZINNIA_E2E_HELLO_7Z;
    const work = process.env.ZINNIA_E2E_WORK;
    const dest = path.join(work, "basic-extract");
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    fs.mkdirSync(dest, { recursive: true });
    await applyIncomingPaths([archive], "extract");
    await setInputValue("#basic-extract-path", dest);
    await $("#basic-run-extract").click();
    const extracted = path.join(dest, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 60_000,
      timeoutMsg: `basic extract did not write ${extracted}`,
    });
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);
  });

  it("compresses hello.txt from Basic using a typed destination", async () => {
    const input = process.env.ZINNIA_E2E_HELLO_TXT;
    const output = path.join(process.env.ZINNIA_E2E_WORK, "basic-compress.7z");
    await waitForArchiveIdle();
    await applyIncomingPaths([input], "compress");
    await setInputValue("#basic-output-path", output);
    await $("#basic-run-compress").click();
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: 60_000,
      timeoutMsg: `basic compress did not write ${output}`,
    });
  });

  it("replaces the Basic extract archive from its archive card", async () => {
    const first = process.env.ZINNIA_E2E_HELLO_7Z;
    const second = process.env.ZINNIA_E2E_NESTED_ZIP;
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    await waitForArchiveIdle();
    // Start from an automatic destination, not the typed one from earlier.
    await browser.execute(() => {
      for (const id of ["extract-path", "basic-extract-path"]) {
        const input = document.getElementById(id);
        if (input) input.value = "";
      }
    });
    await applyIncomingPaths([first], "extract");
    await waitForDomText(
      "#basic-extract-archive-name",
      "hello.7z",
      "Basic extract did not show the first archive",
    );
    assert.equal(
      await domValue("#basic-extract-path"),
      path.join(path.dirname(first), "hello"),
    );

    await queueDialogResult(second);
    await browser.execute(() => {
      document.getElementById("basic-extract-archive-info")?.click();
    });
    await waitForDomText(
      "#basic-extract-archive-name",
      "nested.zip",
      "Basic extract header still names the replaced archive",
    );
    assert.equal(
      await domValue("#basic-extract-path"),
      path.join(path.dirname(second), "nested"),
      "automatic Basic destination must follow the new archive",
    );

    // A typed destination is the user's choice and survives a replacement.
    const typed = path.join(process.env.ZINNIA_E2E_WORK, "basic-replaced");
    fs.mkdirSync(typed, { recursive: true });
    await setInputValue("#basic-extract-path", typed);
    await queueDialogResult(first);
    await browser.execute(() => {
      document.getElementById("basic-extract-archive-info")?.click();
    });
    await waitForDomText(
      "#basic-extract-archive-name",
      "hello.7z",
      "Basic extract header did not follow the second replacement",
    );
    assert.equal(await domValue("#basic-extract-path"), typed);
    await $("#basic-run-extract").click();
    const extracted = path.join(typed, "hello.txt");
    await browser.waitUntil(() => fs.existsSync(extracted), {
      timeout: 60_000,
      timeoutMsg: `replaced archive did not extract to ${extracted}`,
    });
    assert.equal(fs.readFileSync(extracted, "utf8"), payload);
    await waitForArchiveIdle();
  });

  it("replaces the Basic browse archive from its archive card", async () => {
    await waitForArchiveIdle();
    await applyIncomingPaths([process.env.ZINNIA_E2E_HELLO_7Z], "");
    await waitForDomText(
      "#basic-browse-archive-name",
      "hello.7z",
      "Basic browse did not show the first archive",
    );
    await waitForArchiveIdle();
    await queueDialogResult(process.env.ZINNIA_E2E_NESTED_ZIP);
    await browser.execute(() => {
      document.getElementById("basic-browse-archive-info")?.click();
    });
    await waitForDomText(
      "#basic-browse-archive-name",
      "nested.zip",
      "Basic browse header still names the replaced archive",
    );
    await browser
      .waitUntil(
        async () =>
          String(await domText("#basic-browse-tbody"))
            .replaceAll("\\", "/")
            .includes("nested/hello.txt"),
        { timeout: 20_000 },
      )
      .catch(async () => {
        throw new Error(
          `Basic browse did not list the replacement archive: ${await uiDiagnostics()}`,
        );
      });
    await waitForArchiveIdle();
  });

  it("locks Basic compression fields until the archive is written", async () => {
    const work = process.env.ZINNIA_E2E_WORK;
    const input = path.join(work, "incompressible.bin");
    const output = path.join(work, "basic-locked.7z");
    writeIncompressibleFile(input, 96 * 1024 * 1024);
    await waitForArchiveIdle();
    await applyIncomingPaths([input], "compress");
    await setInputValue("#basic-output-path", output);
    await browser.execute(() => {
      document.getElementById("basic-run-compress")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.getElementById("basic-output-path")?.disabled === true,
        ),
      {
        timeout: 10_000,
        interval: 20,
        timeoutMsg: "Basic output path stayed editable during compression",
      },
    );
    const lockedWhileRunning = await browser.execute(() =>
      [
        "basic-output-path",
        "basic-archive-name",
        "basic-format",
        "basic-split-size",
        "basic-password",
      ].every((id) => {
        const control = document.getElementById(id);
        return !control || control.disabled === true;
      }),
    );
    assert.equal(lockedWhileRunning, true);
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: 120_000,
      timeoutMsg: `locked compress did not write ${output}`,
    });
    await waitForArchiveIdle();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.getElementById("basic-output-path")?.disabled === false,
        ),
      {
        timeout: 10_000,
        timeoutMsg: "Basic output path stayed locked after compression",
      },
    );
    assert.equal(await domText("#basic-compress-completion-path"), output);
    fs.rmSync(input, { force: true });
  });

  it("extracts hello.7z from Power using a typed destination", async () => {
    const archive = process.env.ZINNIA_E2E_HELLO_7Z;
    const dest = process.env.ZINNIA_E2E_EXTRACT_OUT;
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    await switchToPowerWorkspace();
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

  for (const [format, extension] of [
    ["bzip2", "bz2"],
    ["xz", "xz"],
  ]) {
    it(`extracts a single-stream ${format} file that stores no member name`, async () => {
      const work = path.join(process.env.ZINNIA_E2E_WORK, `stream-${format}`);
      const dest = path.join(work, "out");
      const payload = process.env.ZINNIA_E2E_PAYLOAD;
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(
        process.env.ZINNIA_E2E_HELLO_TXT,
        path.join(work, "hello.txt"),
      );
      const archive = path.join(work, `hello.txt.${extension}`);
      run7z(requireHostSidecar(), ["a", `-t${format}`, archive, "hello.txt"], {
        cwd: work,
      });
      await extractArchiveTo(archive, dest);
      const extracted = path.join(dest, "hello.txt");
      await browser.waitUntil(() => fs.existsSync(extracted), {
        timeout: 60_000,
        timeoutMsg: `${format} extract did not write ${extracted}`,
      });
      assert.equal(fs.readFileSync(extracted, "utf8"), payload);
    });
  }

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
    await waitForArchiveIdle();
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
    await waitForArchiveIdle();
    await applyIncomingPaths([archive], "");
    const tbody = await $("#browse-tbody");
    await tbody.waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(
      async () =>
        (await tbody.getText())
          .replaceAll("\\", "/")
          .includes("nested/hello.txt"),
      {
        timeout: 20_000,
        timeoutMsg:
          "nested zip browse listing did not include nested/hello.txt",
      },
    );
  });

  it("keeps a ZIP custom preset after the window reloads", async () => {
    const name = "E2E ZIP preset";
    await waitForArchiveIdle();
    await $('[data-mode-btn="add"]').click();
    await browser.execute(() => {
      const format = document.getElementById("format");
      format.value = "zip";
      format.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("save-preset")?.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.getElementById("input-modal-overlay")?.hidden === false,
        ),
      { timeout: 10_000, timeoutMsg: "Save preset prompt did not open" },
    );
    await setInputValue("#input-modal-field", name);
    await browser.execute(() => {
      document.getElementById("input-modal-confirm")?.click();
    });
    await waitForDomText(
      "#status",
      `Preset "${name}" saved`,
      "Preset save did not finish",
    );
    // Reload after this WebDriver call returns: WebView2 never answers a
    // synchronous execute that navigates away. The marker proves a new page.
    await browser.execute(() => {
      window.__zinniaBeforeReload = true;
      window.setTimeout(() => window.location.reload(), 50);
    });
    await browser.waitUntil(
      async () =>
        browser
          .execute(
            () =>
              !window.__zinniaBeforeReload &&
              Boolean(window.__ZINNIA_E2E__) &&
              Boolean(document.getElementById("app")),
          )
          .catch(() => false),
      {
        timeout: 30_000,
        timeoutMsg: "Window did not finish reloading",
      },
    );
    await browser.waitUntil(
      async () =>
        browser.execute(
          (value) =>
            [...document.getElementById("preset").options].some(
              (option) => option.value === value,
            ),
          `custom:${name}`,
        ),
      {
        timeout: 20_000,
        timeoutMsg: "ZIP custom preset disappeared after reload",
      },
    );
  });
});
