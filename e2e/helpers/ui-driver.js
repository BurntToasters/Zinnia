import { browser, $ } from "@wdio/globals";

// Shared WebDriver helpers for the recovery and hazard suites. Mirrors the
// patterns in e2e/specs/main.spec.js; kept separate so that spec stays as is.

export async function waitForMainWindow() {
  await $("#app").waitForExist({ timeout: 30_000 });
  await $("#basic-workspace").waitForDisplayed({ timeout: 30_000 });
}

/**
 * Wait for the app shell only. A relaunch on a profile whose crash phase
 * switched to Power has persisted workspaceMode=power, so it must not assume
 * the Basic workspace is the one that appears first.
 */
export async function waitForAppShell() {
  await $("#app").waitForExist({ timeout: 30_000 });
}

export async function waitForE2eHook() {
  await browser.waitUntil(
    async () => browser.execute(() => Boolean(window.__ZINNIA_E2E__)),
    {
      timeout: 30_000,
      timeoutMsg: "window.__ZINNIA_E2E__ was not installed",
    },
  );
}

export async function applyIncomingPaths(paths, mode) {
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

export async function queueDialogResult(result) {
  await waitForE2eHook();
  await browser.execute((next) => {
    window.__ZINNIA_E2E__.queueDialogResult(next);
  }, result);
}

/** Answer the next native yes/no dialog (Replace, Accept, ...) in this E2E build. */
export async function queueConfirmResult(result) {
  await waitForE2eHook();
  await browser.execute((next) => {
    window.__ZINNIA_E2E__.queueConfirmResult(next);
  }, result);
}

export async function domValue(selector) {
  return browser.execute(
    (target) => document.querySelector(target)?.value ?? null,
    selector,
  );
}

export async function domText(selector) {
  return browser.execute(
    (target) => document.querySelector(target)?.textContent ?? null,
    selector,
  );
}

export async function uiDiagnostics() {
  return browser.execute(() =>
    JSON.stringify({
      status: document.getElementById("status")?.textContent ?? null,
      toasts: [...document.querySelectorAll(".toast-message")].map(
        (toast) => toast.textContent,
      ),
      banner:
        document.getElementById("startup-recovery-banner-text")?.textContent ??
        null,
      log: (document.getElementById("log")?.textContent ?? "")
        .split("\n")
        .slice(-15),
    }),
  );
}

export async function waitForDomText(selector, expected, timeoutMsg) {
  await browser.waitUntil(async () => (await domText(selector)) === expected, {
    timeout: 20_000,
    timeoutMsg,
  });
}

export async function setInputValue(selector, value) {
  const el = await $(selector);
  await el.waitForExist({ timeout: 10_000 });
  await el.setValue(value);
}

export async function waitForArchiveIdle(timeout = 60_000) {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const button = document.getElementById("workspace-mode-power");
        return Boolean(button && !button.disabled);
      }),
    {
      timeout,
      timeoutMsg: "Archive operation stayed active",
    },
  );
}

export async function switchToPowerWorkspace() {
  await waitForArchiveIdle();
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

/** Start an extraction of one archive through the Power extract panel. */
export async function startPowerExtract(archive, dest, options = {}) {
  await switchToPowerWorkspace();
  await $('[data-mode-btn="extract"]').waitForDisplayed({ timeout: 10_000 });
  await waitForArchiveIdle();
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

/** Start a Power compress of one input file to an explicit output path. */
export async function startPowerCompress(input, output) {
  await switchToPowerWorkspace();
  await $('[data-mode-btn="add"]').click();
  await waitForArchiveIdle();
  await applyIncomingPaths([input], "compress");
  await setInputValue("#output-path", output);
  await browser.execute(() => {
    document.getElementById("run-action")?.click();
  });
}

/** Resolve when the native startup recovery pass has finished. */
export async function awaitStartupRecoveryStatus() {
  return browser.executeAsync((done) => {
    window.__TAURI__.core
      .invoke("get_startup_recovery_status")
      .then((value) => done({ value: value ?? null }))
      .catch((err) => done({ error: String(err) }));
  });
}

export async function bannerState() {
  return browser.execute(() => {
    const banner = document.getElementById("startup-recovery-banner");
    const text =
      document.getElementById("startup-recovery-banner-text")?.textContent ??
      "";
    const acknowledge = document.getElementById(
      "startup-recovery-banner-acknowledge",
    );
    return {
      visible: Boolean(banner && !banner.hidden),
      text: text.trim(),
      acknowledgeVisible: Boolean(acknowledge && !acknowledge.hidden),
    };
  });
}
