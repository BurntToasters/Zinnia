import path from "node:path";
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

/** Dismiss visible toast notifications so later cases see only fresh messages. */
export async function dismissToasts() {
  await browser.execute(() => {
    for (const toast of document.querySelectorAll(".toast")) {
      toast
        .querySelector(".toast-dismiss")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
}

export async function confirmInputModal(value, timeout = 120_000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("input-modal-overlay")?.hidden === false,
      ),
    {
      timeout,
      timeoutMsg: "input modal did not open",
    },
  );
  await browser.execute((next) => {
    const field = document.getElementById("input-modal-field");
    if (!field) throw new Error("missing #input-modal-field");
    field.value = next;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("input-modal-confirm")?.click();
  }, value);
}

export async function cancelInputModal(timeout = 30_000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("input-modal-overlay")?.hidden === false,
      ),
    {
      timeout,
      timeoutMsg: "input modal did not open for cancel",
    },
  );
  await browser.execute(() => {
    document.getElementById("input-modal-cancel")?.click();
  });
}

/** Best-effort cancel for a stuck archive run or open password modal. */
export async function abortArchiveOperationIfBusy() {
  await browser.execute(() => {
    document.getElementById("input-modal-cancel")?.click();
    document.getElementById("extract-cancel")?.click();
    document.getElementById("cancel-action")?.click();
  });
  await waitForArchiveIdle(120_000).catch(() => undefined);
}

export async function isInputModalOpen() {
  return browser.execute(
    () => document.getElementById("input-modal-overlay")?.hidden === false,
  );
}

export async function inputModalLabel() {
  return browser.execute(
    () =>
      document.getElementById("input-modal-label")?.textContent?.trim() ?? "",
  );
}

/** Wait until the password/input modal is open and its label contains `fragment`. */
export async function waitForInputModalLabel(fragment, timeoutMsg) {
  await browser.waitUntil(
    async () => {
      if (!(await isInputModalOpen())) return false;
      const label = await inputModalLabel();
      return label.includes(fragment);
    },
    { timeout: 120_000, timeoutMsg },
  );
  return inputModalLabel();
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

export async function setSelectValue(selector, value) {
  await browser.execute(
    (target, next) => {
      const select = document.querySelector(target);
      if (!select) throw new Error(`missing ${target}`);
      select.value = next;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    value,
  );
}

export async function setCheckbox(selector, checked) {
  await browser.execute(
    (target, on) => {
      const input = document.querySelector(target);
      if (!input) throw new Error(`missing ${target}`);
      if (input.checked !== on) input.click();
    },
    selector,
    checked,
  );
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

export async function switchToBasicWorkspace() {
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("workspace-mode-basic")?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("app")?.dataset.workspaceMode === "basic",
      ),
    {
      timeout: 10_000,
      timeoutMsg: "Basic workspace did not activate",
    },
  );
}

/** Open an archive in browse mode and wait until `member` appears in the listing. */
export async function openBrowseArchive(archive, member, timeout = 30_000) {
  await switchToPowerWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await applyIncomingPaths([archive], "");
  await browser.waitUntil(
    async () => (await $("#browse-tbody").getText()).includes(member),
    { timeout, timeoutMsg: `browse did not list ${member}` },
  );
  await waitForArchiveIdle();
}

/** Open the selective extract picker after the archive is browsed. */
export async function openSelectiveExtractPicker() {
  await browser.execute(() => {
    document.getElementById("browse-selective")?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("selective-overlay")?.hidden === false,
      ),
    {
      timeout: 30_000,
      timeoutMsg: "selective extract overlay did not open",
    },
  );
}

/** Expand a collapsed folder row in the selective extract tree. */
export async function expandSelectiveFolder(folderPath) {
  await browser.execute((targetPath) => {
    const normalized = targetPath.replace(/\\/g, "/");
    const row = document.querySelector(`[data-member-path="${normalized}"]`);
    const twisty = row?.querySelector(".selective-twisty");
    if (!twisty || twisty.disabled) {
      throw new Error(`missing selective folder row for ${targetPath}`);
    }
    if (twisty.textContent?.includes("\u25b8")) twisty.click();
  }, folderPath);
}

/** Toggle one selective row by archive member path (tree rows use data-member-path). */
export async function toggleSelectiveMember(memberPath) {
  await browser.execute((targetPath) => {
    const row = document.querySelector(
      `[data-member-path="${targetPath.replace(/\\/g, "/")}"]`,
    );
    const checkbox = row?.querySelector('input[type="checkbox"]');
    if (!checkbox) {
      throw new Error(`missing selective row for ${targetPath}`);
    }
    if (!checkbox.checked) checkbox.click();
  }, memberPath);
}

/** Run selective extraction to `dest` from the open picker (overlay must be open). */
export async function confirmSelectiveExtract(dest) {
  await setInputValue("#selective-dest", dest);
  await browser.execute(() => {
    document.getElementById("selective-confirm")?.click();
  });
}

/** Batch-extract multiple archives to one destination folder in Power mode. */
export async function startPowerBatchExtract(archives, dest, options = {}) {
  await switchToPowerWorkspace();
  await $('[data-mode-btn="extract"]').waitForDisplayed({ timeout: 10_000 });
  await waitForArchiveIdle();
  await resetPowerExtractInputs();
  await applyIncomingPaths(archives, "extract");
  if (options.password) {
    await setInputValue("#extract-password", options.password);
  }
  await setInputValue("#extract-path", dest);
  await browser.execute(() => {
    document.getElementById("extract-run")?.click();
  });
}

/** Load an archive into Basic extract mode with a typed destination. */
export async function prepareBasicExtract(archive, dest) {
  await switchToBasicWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
  await applyIncomingPaths([archive], "extract");
  await waitForSingleInputNamed(archive);
  await setInputValue("#basic-extract-path", dest);
}

/** Start extraction through the Basic Run button (password prompt when needed). */
export async function clickBasicRunExtract() {
  await browser.execute(() => {
    document.getElementById("basic-run-extract")?.click();
  });
}

export async function toastTexts() {
  return browser.execute(() =>
    [...document.querySelectorAll(".toast-message")]
      .map((toast) => toast.textContent ?? "")
      .filter((line) => line.trim()),
  );
}

export async function waitForToastContaining(fragment, timeoutMsg) {
  await browser.waitUntil(
    async () => {
      const lines = await toastTexts();
      return lines.some((line) => line.includes(fragment));
    },
    { timeout: 60_000, timeoutMsg },
  );
  return toastTexts();
}

async function inputListItemCount() {
  return browser.execute(
    () => document.querySelectorAll("#input-list .list__item").length,
  );
}

export async function waitForInputListCleared() {
  await browser.waitUntil(async () => (await inputListItemCount()) === 0, {
    timeout: 30_000,
    timeoutMsg: "input list did not clear",
  });
}

async function waitForSingleInputNamed(archive) {
  const leaf = path.basename(archive);
  await browser.waitUntil(
    async () =>
      browser.execute((basename) => {
        const items = [...document.querySelectorAll("#input-list .list__item")];
        return (
          items.length === 1 && (items[0].textContent ?? "").includes(basename)
        );
      }, leaf),
    {
      timeout: 30_000,
      timeoutMsg: `input list did not show only ${leaf}`,
    },
  );
}

async function clickPowerMode(mode) {
  await browser.execute((nextMode) => {
    const btn = document.querySelector(`[data-mode-btn="${nextMode}"]`);
    if (!btn) throw new Error(`missing mode button ${nextMode}`);
    btn.click();
  }, mode);
}

/** Drop stale Power extract inputs (append-mode handoffs keep prior archives). */
export async function clearPowerExtractSession() {
  await switchToPowerWorkspace();
  await waitForArchiveIdle();
  await clickPowerMode("browse");
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
  await clickPowerMode("extract");
  await waitForInputListCleared();
}

async function resetPowerExtractInputs() {
  await clearPowerExtractSession();
}

/** Start an extraction of one archive through the Power extract panel. */
export async function startPowerExtract(archive, dest, options = {}) {
  await switchToPowerWorkspace();
  await $('[data-mode-btn="extract"]').waitForDisplayed({ timeout: 10_000 });
  await waitForArchiveIdle();
  await resetPowerExtractInputs();
  await applyIncomingPaths([archive], "extract");
  await waitForSingleInputNamed(archive);
  if (options.password) {
    await setInputValue("#extract-password", options.password);
  }
  await setInputValue("#extract-path", dest);
  await browser.execute(() => {
    document.getElementById("extract-run")?.click();
  });
}

/** Start a Power compress of one input file to an explicit output path. */
export async function startPowerCompress(input, output, options = {}) {
  await switchToPowerWorkspace();
  await $('[data-mode-btn="add"]').click();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await applyIncomingPaths([input], "compress");
  await setCheckbox("#encrypt-headers", false);
  await setCheckbox("#update-mode", false);
  await browser.execute(() => {
    const password = document.getElementById("password");
    if (password) password.value = "";
    const splitCustom = document.getElementById("split-custom");
    if (splitCustom) splitCustom.value = "";
  });
  if (options.format) await setSelectValue("#format", options.format);
  if (options.level) await setSelectValue("#level", options.level);
  await setSelectValue("#split-size", options.splitSize ?? "");
  if (options.splitCustom) {
    await browser.execute((value) => {
      const input = document.getElementById("split-custom");
      if (!input) throw new Error("missing #split-custom");
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, options.splitCustom);
  }
  if (options.password) await setInputValue("#password", options.password);
  if (options.encryptHeaders) await setCheckbox("#encrypt-headers", true);
  await setInputValue("#output-path", output);
  if (options.run !== false) {
    await browser.execute(() => {
      document.getElementById("run-action")?.click();
    });
  }
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

export async function invokeLoadSettingsRaw() {
  return browser.executeAsync((done) => {
    window.__TAURI__.core
      .invoke("load_settings")
      .then((raw) => done({ raw: raw ?? "{}" }))
      .catch((err) => done({ error: String(err) }));
  });
}

export async function reloadMainWindow(timeout = 60_000) {
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
    { timeout, timeoutMsg: "main window did not finish reloading" },
  );
  await waitForAppShell();
  await waitForE2eHook();
}

export async function isSettingsOverlayOpen() {
  return browser.execute(
    () => document.getElementById("settings-overlay")?.hidden === false,
  );
}

export async function openSettingsModal(timeout = 10_000) {
  await browser.execute(() => {
    document.getElementById("open-settings")?.click();
  });
  await browser.waitUntil(async () => isSettingsOverlayOpen(), {
    timeout,
    timeoutMsg: "settings overlay did not open",
  });
}

export async function closeSettingsModalViaUi(timeout = 10_000) {
  await browser.execute(() => {
    document.getElementById("close-settings")?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("settings-overlay")?.hidden === true,
      ),
    { timeout, timeoutMsg: "settings overlay did not close" },
  );
}

export async function clickSettingsTab(tabId) {
  await browser.execute((id) => {
    document.getElementById(id)?.click();
  }, tabId);
}

export async function clickSettingsSave() {
  await browser.execute(() => {
    document.getElementById("save-settings")?.click();
  });
}

export async function doubleClickSettingsSave() {
  await browser.execute(() => {
    const button = document.getElementById("save-settings");
    if (!button) throw new Error("missing #save-settings");
    button.click();
    button.click();
  });
}

export async function waitForSettingsSavedAndClosed(timeout = 30_000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.getElementById("settings-overlay")?.hidden === true,
      ),
    { timeout, timeoutMsg: "settings overlay stayed open after save" },
  );
}

export async function isSetupWizardVisible() {
  return browser.execute(
    () => document.getElementById("setup-wizard-overlay")?.hidden === false,
  );
}

export async function isShortcutsOverlayOpen() {
  return browser.execute(
    () => document.getElementById("shortcuts-overlay")?.hidden === false,
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Dispatch a keydown from document (global shortcuts and focus traps). */
export async function dispatchDocumentKey(key, options = {}) {
  await browser.execute(
    (nextKey, nextOptions) => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: nextKey,
          code: nextOptions.code ?? nextKey,
          ctrlKey: Boolean(nextOptions.ctrlKey),
          metaKey: Boolean(nextOptions.metaKey),
          shiftKey: Boolean(nextOptions.shiftKey),
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    key,
    options,
  );
}

export async function settingsModalFocusables() {
  return browser.execute((selector) => {
    const modal = document.querySelector("#settings-overlay .modal");
    if (!modal) return [];
    return [...modal.querySelectorAll(selector)]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.id || el.getAttribute("aria-label") || el.tagName);
  }, FOCUSABLE_SELECTOR);
}

export async function activeElementInsideSettingsModal() {
  return browser.execute(() => {
    const modal = document.querySelector("#settings-overlay .modal");
    const active = document.activeElement;
    return Boolean(modal && active && modal.contains(active));
  });
}

export async function preparePowerPresetPanel() {
  await switchToPowerWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.querySelector('[data-mode-btn="add"]')?.click();
  });
  await waitForArchiveIdle();
}

export async function saveCustomPresetViaUi(name) {
  await browser.execute(() => {
    document.getElementById("save-preset")?.click();
  });
  await confirmInputModal(name);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (value) =>
          [...document.getElementById("preset").options].some(
            (option) => option.value === value,
          ),
        `custom:${name}`,
      ),
    { timeout: 20_000, timeoutMsg: `custom preset ${name} did not appear` },
  );
}

export async function selectPowerPreset(value) {
  await browser.execute((next) => {
    const select = document.getElementById("preset");
    if (!select) throw new Error("missing #preset");
    const values = [...select.options].map((option) => option.value);
    if (!values.includes(next)) {
      throw new Error(
        `preset option ${next} missing (options: ${values.join(", ")})`,
      );
    }
    select.value = next;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await browser.waitUntil(
    async () =>
      browser.execute((expected) => {
        const preset = document.getElementById("preset");
        return preset?.value === expected;
      }, value),
    { timeout: 10_000, timeoutMsg: `preset did not switch to ${value}` },
  );
}

export async function deleteSelectedCustomPreset() {
  await browser.execute(() => {
    document.getElementById("delete-preset")?.click();
  });
}

export async function invokeGetOsIntegrationStatus() {
  return browser.executeAsync((done) => {
    window.__TAURI__.core
      .invoke("get_os_integration_status")
      .then((value) => done({ value: value ?? null }))
      .catch((err) => done({ error: String(err) }));
  });
}

const PLATFORM_LABELS = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** Open Settings on the OS Integration tab and wait for a successful status render. */
export async function openOsIntegrationSettingsTab() {
  await openSettingsModal();
  await clickSettingsTab("tab-os");
  await browser.waitUntil(
    async () => {
      const help = await domText("#os-integration-help");
      if (!help || help === "Checking OS integration status…") return false;
      if (help === "Unable to check OS integration status.") return false;
      const platform = await domText("#os-platform-label");
      return (
        Boolean(platform) &&
        platform !== "Unknown" &&
        platform !== "Unable to check"
      );
    },
    {
      timeout: 30_000,
      timeoutMsg: "OS Integration tab did not render integration status",
    },
  );
}

export async function assertOsIntegrationTabMatchesBackend() {
  const backend = await invokeGetOsIntegrationStatus();
  if (backend.error) {
    throw new Error(`get_os_integration_status failed: ${backend.error}`);
  }
  const status = backend.value;
  const expectedPlatform =
    PLATFORM_LABELS[status.platform] ?? String(status.platform);
  const platform = await domText("#os-platform-label");
  if (platform !== expectedPlatform) {
    throw new Error(
      `OS platform label ${JSON.stringify(platform)} !== backend ${JSON.stringify(expectedPlatform)}`,
    );
  }
  const expectedPackage = status.packaged
    ? "Installed app"
    : "Development build";
  const packageLabel = await domText("#os-package-label");
  if (packageLabel !== expectedPackage) {
    throw new Error(
      `OS package label ${JSON.stringify(packageLabel)} !== backend ${JSON.stringify(expectedPackage)}`,
    );
  }
  const help = String(await domText("#os-integration-help"));
  if (help.includes("Unable to check")) {
    throw new Error(`OS integration help showed an error: ${help}`);
  }
}

export async function enableLocalLoggingViaSettings() {
  await openSettingsModal();
  await clickSettingsTab("tab-general");
  await setCheckbox("#s-local-logging", true);
  await clickSettingsSave();
  await waitForSettingsSavedAndClosed();
}

/** Export diagnostics logs through Settings → Export (queues the native save path). */
export async function exportDiagnosticsLogsTo(exportPath) {
  await openSettingsModal();
  await clickSettingsTab("tab-general");
  await queueDialogResult(exportPath);
  await browser.execute(() => {
    document.getElementById("export-logs")?.click();
  });
  await waitForToastContaining(
    "Logs exported successfully.",
    `diagnostics log export did not succeed; ${await uiDiagnostics()}`,
  );
  await closeSettingsModalViaUi();
}

export async function openBasicRecentsMenu() {
  await switchToBasicWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("header-recent-btn")?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () =>
          document
            .getElementById("header-recent")
            ?.classList.contains("is-open") ?? false,
      ),
    {
      timeout: 10_000,
      timeoutMsg: "Basic recents menu did not open",
    },
  );
}

export async function clickBasicRecentArchive(archivePath) {
  const leaf = path.basename(archivePath);
  await browser.execute((basename) => {
    const items = [
      ...document.querySelectorAll("#header-recent-menu .header-recent__item"),
    ];
    const match = items.find((item) => item.textContent?.includes(basename));
    if (!match) {
      throw new Error(`recent menu missing ${basename}`);
    }
    match.click();
  }, leaf);
}

export async function openBasicBrowseForArchive(archive) {
  await switchToBasicWorkspace();
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await waitForInputListCleared();
  await applyIncomingPaths([archive], "");
  const leaf = path.basename(archive);
  await browser.waitUntil(
    async () => {
      const name = await domText("#basic-browse-archive-name");
      return typeof name === "string" && name.includes(leaf);
    },
    {
      timeout: 60_000,
      timeoutMsg: `Basic browse did not open for ${archive}`,
    },
  );
}

export async function invokeGetLogDir() {
  return browser.executeAsync((done) => {
    window.__TAURI__.core
      .invoke("get_log_dir")
      .then((value) => done({ value: value ?? null }))
      .catch((err) => done({ error: String(err) }));
  });
}

/** Log directory path shown under Settings → Diagnostics (from get_log_dir). */
export async function waitForSettingsLogDirectory(timeoutMsg) {
  await openSettingsModal();
  await clickSettingsTab("tab-general");
  await browser.waitUntil(
    async () => {
      const shown = await domText("#s-log-dir");
      if (
        !shown ||
        shown === "Detecting log directory…" ||
        shown === "Unavailable"
      ) {
        return false;
      }
      const backend = await invokeGetLogDir();
      if (backend.error) return false;
      return shown === backend.value;
    },
    { timeout: 30_000, timeoutMsg },
  );
  const logDir = await domText("#s-log-dir");
  await closeSettingsModalViaUi();
  return logDir;
}

export async function basicBrowseStatusState() {
  const raw = await browser.execute(() => {
    const el = document.getElementById("basic-browse-status");
    return JSON.stringify({
      text: el?.textContent?.trim() ?? "",
      loading: el?.classList.contains("is-loading") ? 1 : 0,
      error: el?.classList.contains("is-error") ? 1 : 0,
      busy: el?.getAttribute("aria-busy") === "true" ? 1 : 0,
    });
  });
  return JSON.parse(raw);
}

export async function waitForBasicBrowseStatusIdle(timeoutMsg) {
  await browser.waitUntil(
    async () => {
      const state = await basicBrowseStatusState();
      return state.busy === 0 && state.loading === 0 ? "idle" : false;
    },
    { timeout: 120_000, timeoutMsg },
  );
  return basicBrowseStatusState();
}

export async function powerExtractPasswordToggleState() {
  return browser.execute(() => {
    const input = document.getElementById("extract-password");
    const toggle = document.getElementById("toggle-extract-password");
    return {
      inputType: input?.getAttribute("type") ?? null,
      ariaLabel: toggle?.getAttribute("aria-label") ?? null,
      pressed: toggle?.getAttribute("aria-pressed") ?? null,
    };
  });
}

export async function clickPowerExtractPasswordToggle() {
  await browser.execute(() => {
    document.getElementById("toggle-extract-password")?.click();
  });
}
