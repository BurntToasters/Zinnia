import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunchApp } from "./relaunch";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { log, devLog, setStatus } from "./ui";
import { state } from "./state";
import { debugLog, isDebugEnabled } from "./debug-mode";
import { showToast } from "./toast";
import { compareVersions } from "./version-compare";
import { onWorkspaceModeChange } from "./ui/workspace";

let pendingUpdate: Update | null = null;
let pendingVersion: string | null = null;
let pendingTarget: string | undefined;
let updateCheckInFlight: Promise<void> | null = null;
let inFlightCheckIsInteractive = false;
let updateGeneration = 0;
/** True while native `update.install()` is live. Timeout must not unlock. */
let installInFlight = false;
/** False for a parked background update until the user asks to install it. */
let pendingDownloaded = false;
/** Blocks a second download of the parked update. */
let pendingDownloadInFlight = false;
/** Blocks a second restart prompt, which would race the first install. */
let promptInFlight = false;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 120_000;
const UPDATE_INSTALL_WATCHDOG_MS = 180_000;
const UPDATE_RESERVATION_HEARTBEAT_MS = 60_000;
const STATUS_UPDATE_INDICATOR_ID = "update-ready-indicator";
const BASIC_UPDATE_INDICATOR_ID = "basic-update-indicator";
let indicatorVersion: string | null = null;

type UpdateStage = "check" | "download" | "install";

class UpdateStageError extends Error {
  readonly stage: "download" | "install";

  constructor(stage: "download" | "install", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UpdateStageError";
    this.stage = stage;
  }
}

function failureStage(err: unknown, fallback: UpdateStage): UpdateStage {
  return err instanceof UpdateStageError ? err.stage : fallback;
}

function failureLabel(stage: UpdateStage): string {
  if (stage === "download") return "Update download failed.";
  if (stage === "install") return "Update install failed.";
  return "Failed to check for updates.";
}

function isBasicWorkspaceActive(): boolean {
  return document.getElementById("app")?.dataset.workspaceMode !== "power";
}

async function touchUpdateReservation(): Promise<void> {
  try {
    await invoke<boolean>("is_7z_running", { mode: "touch_update" });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    devLog(`Unable to refresh update reservation: ${text}`);
  }
}

/**
 * Persistent status-bar button. Status text alone is overwritten too easily.
 * The Basic header copy mirrors it, but only while Basic is the workspace.
 */
function renderUpdateReadyIndicator(
  version: string | null,
  downloaded: boolean,
): void {
  indicatorVersion = version;
  const text =
    version === null
      ? ""
      : downloaded
        ? `Update ${version} ready. Restart to install`
        : `Update ${version} available. Click to install`;
  const status = document.getElementById(STATUS_UPDATE_INDICATOR_ID);
  if (status) {
    status.hidden = version === null;
    status.textContent = text;
    status.title = text;
  }
  const basic = document.getElementById(BASIC_UPDATE_INDICATOR_ID);
  if (basic) {
    basic.hidden = version === null || !isBasicWorkspaceActive();
    basic.textContent = text;
    basic.title = text;
  }
}

function refreshBasicUpdateIndicatorVisibility(): void {
  const basic = document.getElementById(BASIC_UPDATE_INDICATOR_ID);
  if (!basic) return;
  basic.hidden = indicatorVersion === null || !isBasicWorkspaceActive();
}

onWorkspaceModeChange(refreshBasicUpdateIndicatorVisibility);

/** Status after a failed entry point. A parked update is still on offer. */
function statusAfterFailure(): string {
  return pendingUpdate && !pendingDownloaded ? "Update available" : "Idle";
}

function clearPendingUpdate(closeResource: boolean): void {
  const update = pendingUpdate;
  pendingUpdate = null;
  pendingVersion = null;
  pendingTarget = undefined;
  pendingDownloaded = false;
  renderUpdateReadyIndicator(null, false);
  if (closeResource && update) {
    const close = (update as Update & { close?: () => Promise<void> }).close;
    if (close) {
      void Promise.resolve(close.call(update)).catch((err) => {
        devLog(`Failed to release pending update resources: ${String(err)}`);
      });
    }
  }
}

/** Discard a downloaded update; no-op mid-install (close would race it). */
export function discardPendingUpdate(): void {
  if (installInFlight) return;
  updateGeneration += 1;
  // A running download closes its own update once it settles.
  clearPendingUpdate(!pendingDownloadInFlight);
}

async function archiveOperationIsRunning(
  mode: "check" | "reserve_update" = "check",
): Promise<boolean> {
  try {
    return mode === "check"
      ? await invoke<boolean>("is_7z_running")
      : await invoke<boolean>("is_7z_running", { mode });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Failing closed is deliberate: an updater must never terminate an archive
    // operation merely because the status query is unavailable.
    log(`Unable to confirm archive idle state: ${text}`, "error");
    if (mode === "reserve_update") {
      // The response may be lost after the backend reserved; release is a
      // owner-scoped no-op when unreserved.
      void invoke("is_7z_running", { mode: "release_update" }).catch(() => {});
    }
    return true;
  }
}

/** Drop the update prepare lock. Unlike check/reserve, never treat IPC failure
 * as "still busy"; that strands archive ops until restart. */
async function releaseUpdateReservation(): Promise<void> {
  try {
    await invoke<boolean>("is_7z_running", { mode: "release_update" });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    log(`Unable to release update reservation: ${text}`, "error");
    throw err instanceof Error ? err : new Error(text);
  }
}

async function getUpdateCheckTarget(): Promise<string | undefined> {
  const channel = state.currentSettings.updateChannel;
  if (channel === "stable") {
    return undefined;
  }
  if (channel === "beta") {
    return invoke<string>("get_beta_updater_target");
  }
  // auto: follow the installed version; beta if version contains a pre-release tag
  const version = await getVersion();
  const isBeta = /-(beta|alpha|rc)/i.test(version);
  if (!isBeta) return undefined;
  return invoke<string>("get_beta_updater_target");
}

async function checkUpdateFeed(
  target: string | undefined,
): Promise<Update | null> {
  const options = {
    ...(target ? { target } : {}),
    timeout: UPDATE_CHECK_TIMEOUT_MS,
  };
  try {
    const update = await check(options);
    // Beta manifests are swapped onto the stable release through two adjacent
    // GitHub asset renames. A second lookup masks that irreducible short window
    // and also avoids treating the current-version fallback as a definitive miss.
    if (!update && target) return await check(options);
    return update;
  } catch (error) {
    if (!target) throw error;
    return await check(options);
  }
}

export async function notify(title: string, body: string) {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  if (granted) {
    sendNotification({ title, body });
  }
}

async function notifyIfAlreadyGranted(title: string, body: string) {
  try {
    if (await isPermissionGranted()) {
      sendNotification({ title, body });
    }
  } catch (err) {
    // Notifications are an optional update hint. A platform permission query
    // must never turn a successful background update check into an updater
    // failure or prevent the update from downloading.
    devLog(
      `Unable to send update notification: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function promptInstallAndRestart(
  version: string,
  update: Update,
  generation: number,
) {
  // Only the open prompt owns the pending update, so a stray entry leaves it alone.
  if (promptInFlight) {
    if (update !== pendingUpdate) await update.close().catch(() => {});
    return;
  }
  promptInFlight = true;
  try {
    await runInstallPrompt(version, update, generation);
  } catch (err) {
    throw err instanceof UpdateStageError
      ? err
      : new UpdateStageError("install", err);
  } finally {
    promptInFlight = false;
  }
}

async function runInstallPrompt(
  version: string,
  update: Update,
  generation: number,
) {
  if (generation !== updateGeneration) {
    await update.close().catch(() => {});
    return;
  }
  pendingUpdate = update;
  pendingVersion = version;
  pendingDownloaded = true;
  renderUpdateReadyIndicator(version, true);
  setStatus("Update ready");
  if (await archiveOperationIsRunning()) {
    if (generation !== updateGeneration) return;
    showToast(
      `Version ${version} is downloaded. Zinnia will not install it while an archive operation is running. Use Check now after the operation finishes.`,
      "info",
      7000,
    );
    if (generation !== updateGeneration) return;
    setStatus("Update ready");
    return;
  }
  if (generation !== updateGeneration) return;
  const restart = await ask(
    `Version ${version} has been downloaded and is ready to install.\n\nRestart now to apply the update?`,
    {
      title: "Update ready",
      kind: "info",
      okLabel: "Restart now",
      cancelLabel: "Later",
    },
  );
  if (generation !== updateGeneration) return;
  if (restart) {
    if (generation !== updateGeneration) return;
    if (await archiveOperationIsRunning("reserve_update")) {
      if (generation !== updateGeneration) return;
      showToast(
        "An archive operation started before the update could be installed. The update remains ready and can be installed after it finishes.",
        "info",
        7000,
      );
      setStatus("Update ready");
      return;
    }
    if (generation !== updateGeneration) {
      await releaseUpdateReservation().catch(() => {});
      return;
    }
    setStatus("Installing update");
    installInFlight = true;
    const watchdog = setTimeout(() => {
      // Native install (pkexec / AppleScript auth) cannot be cancelled. Keep the
      // archive-operation reservation and only surface a still-installing state.
      setStatus("Still installing update");
      log(
        `Update install still running after ${UPDATE_INSTALL_WATCHDOG_MS / 1000} seconds; waiting for native installer to finish.`,
      );
      void notifyIfAlreadyGranted(
        "Zinnia",
        "Update installation is still in progress. Archive operations stay blocked until it finishes.",
      );
    }, UPDATE_INSTALL_WATCHDOG_MS);
    const heartbeat = setInterval(() => {
      void touchUpdateReservation();
    }, UPDATE_RESERVATION_HEARTBEAT_MS);
    try {
      try {
        await update.install();
      } catch (error) {
        try {
          await releaseUpdateReservation();
        } catch {
          // Already logged; still surface the install failure.
        }
        throw new UpdateStageError("install", error);
      }
      // The new version is on disk from here on, so no failure below is an install failure.
      clearPendingUpdate(false);
      // Drop archive-operation reservation before requesting process restart.
      // Native exit handling deliberately blocks Quit while the reservation is
      // held, so release is attempted first; a failed release must not block relaunch.
      // releaseUpdateReservation logs its own failure; remember it for the toast.
      let needsManualRestart = false;
      try {
        await releaseUpdateReservation();
      } catch {
        needsManualRestart = true;
      }
      try {
        await relaunchApp();
      } catch (relaunchError) {
        needsManualRestart = true;
        const messageText =
          relaunchError instanceof Error
            ? relaunchError.message
            : String(relaunchError);
        log(`Update installed but relaunch failed: ${messageText}`, "error");
      }
      // A deferred exit leaves the app open, so the user must be told once.
      if (needsManualRestart) {
        setStatus("Update installed");
        showToast(
          "Update installed. Quit and reopen Zinnia to finish.",
          "info",
          0,
        );
      }
    } finally {
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      installInFlight = false;
    }
  } else {
    // Later must not prompt for notification permission.
    await notifyIfAlreadyGranted(
      "Zinnia",
      "Update downloaded and ready to install from Check now.",
    );
    setStatus("Update ready");
  }
}

/**
 * Background checks only announce a newer version. The installer is downloaded
 * once the user asks, so it is not held in memory unasked.
 */
function holdAvailableUpdate(
  version: string,
  update: Update,
  target: string | undefined,
  generation: number,
): boolean {
  if (generation !== updateGeneration) {
    void update.close().catch(() => {});
    return false;
  }
  pendingUpdate = update;
  pendingVersion = version;
  pendingTarget = target;
  pendingDownloaded = false;
  renderUpdateReadyIndicator(version, false);
  setStatus("Update available");
  return true;
}

/** Downloads a parked update. Resolves false when it was discarded meanwhile. */
async function downloadParkedUpdate(
  update: Update,
  version: string,
  generation: number,
): Promise<boolean> {
  if (pendingDownloadInFlight) return false;
  pendingDownloadInFlight = true;
  setStatus("Downloading update");
  try {
    await update.download(undefined, {
      timeout: UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
    });
  } catch (error) {
    // Discard skipped the close while this download ran, so close it here.
    if (generation !== updateGeneration) {
      await update.close().catch(() => {});
    }
    throw new UpdateStageError("download", error);
  } finally {
    pendingDownloadInFlight = false;
  }
  if (generation !== updateGeneration) {
    await update.close().catch(() => {});
    return false;
  }
  pendingDownloaded = true;
  renderUpdateReadyIndicator(version, true);
  log(`Update ${version} downloaded and ready to install.`);
  return true;
}

/** User asked to install: download the parked update if needed, then prompt. */
async function installParkedUpdate(): Promise<void> {
  if (promptInFlight || installInFlight) return;
  const update = pendingUpdate;
  const version = pendingVersion;
  if (!update || !version) return;
  const generation = updateGeneration;
  if (!pendingDownloaded) {
    if (!(await downloadParkedUpdate(update, version, generation))) return;
  }
  await promptInstallAndRestart(version, update, generation);
}

/** Indicator click. Failures keep the update parked so a later click retries. */
async function installPendingUpdateFromIndicator(): Promise<void> {
  try {
    await installParkedUpdate();
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    const stage = failureStage(err, "install");
    log(`Updater error: ${messageText}`, "error");
    setStatus(failureStatusText(stage));
    showToast(`${failureLabel(stage)} ${messageText}`, "error", 0);
  }
}

function failureStatusText(stage: UpdateStage): string {
  return stage === "check" ? statusAfterFailure() : failureLabel(stage);
}

for (const id of [STATUS_UPDATE_INDICATOR_ID, BASIC_UPDATE_INDICATOR_ID]) {
  document.getElementById(id)?.addEventListener("click", () => {
    void installPendingUpdateFromIndicator();
  });
}

async function runUpdateCheck(interactive: boolean): Promise<void> {
  let checkedUpdate: Update | null = null;
  let generation = updateGeneration;
  try {
    const isFlatpak = await invoke<boolean>("is_flatpak");
    if (isFlatpak) {
      if (interactive) {
        showToast(
          "Flatpak builds update through Flathub or a reinstalled bundle, not the in-app updater.",
          "info",
          7000,
        );
      }
      return;
    }
    const target = await getUpdateCheckTarget();
    if (generation !== updateGeneration) return;
    if (pendingUpdate && pendingTarget !== target) {
      discardPendingUpdate();
      generation = updateGeneration;
    }
    if (pendingUpdate && pendingVersion) {
      if (interactive) await installParkedUpdate();
      return;
    }
    if (interactive) setStatus("Checking updates");
    if (isDebugEnabled()) {
      debugLog(
        `Update check started (interactive=${interactive}, target=${target ?? "default"}).`,
      );
    }
    checkedUpdate = await checkUpdateFeed(target);
    if (generation !== updateGeneration) {
      await checkedUpdate?.close().catch(() => {});
      return;
    }
    if (!checkedUpdate) {
      devLog(
        interactive
          ? "No updates available."
          : "Auto-update check: no updates available.",
      );
      if (isDebugEnabled()) debugLog("Update check: no updates available.");
      if (interactive) {
        showToast("You are running the latest version.", "success");
        setStatus("Idle");
      }
      return;
    }
    log(`Update available: ${checkedUpdate.version}`);
    if (isDebugEnabled()) {
      debugLog(`Update available: ${checkedUpdate.version}`);
    }
    // Defence in depth: the vendored plugin already refuses downgrades, but
    // never install a manifest version at or below the installed version.
    const candidate = checkedUpdate;
    try {
      const current = await getVersion();
      if (compareVersions(candidate.version, current) <= 0) {
        devLog(
          `Ignoring update ${candidate.version}: not newer than installed ${current}.`,
        );
        await candidate.close().catch(() => {});
        checkedUpdate = null;
        if (interactive) {
          showToast("You are running the latest version.", "success");
          setStatus("Idle");
        }
        return;
      }
    } catch (err) {
      devLog(
        `Version comparison failed; deferring to plugin policy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!interactive) {
      if (
        !holdAvailableUpdate(candidate.version, candidate, target, generation)
      ) {
        return;
      }
      checkedUpdate = null;
      await notifyIfAlreadyGranted(
        "Zinnia Update Available",
        `Version ${candidate.version} is available. Use the update button in the status bar to install.`,
      );
      return;
    }
    setStatus("Downloading update");
    try {
      await candidate.download(undefined, {
        timeout: UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
      });
    } catch (error) {
      throw new UpdateStageError("download", error);
    }
    if (generation !== updateGeneration) {
      await candidate.close().catch(() => {});
      return;
    }
    pendingTarget = target;
    log(`Update ${candidate.version} downloaded and ready to install.`);
    await promptInstallAndRestart(candidate.version, candidate, generation);
    checkedUpdate = null;
  } catch (err) {
    if (checkedUpdate && checkedUpdate !== pendingUpdate) {
      await checkedUpdate.close().catch(() => {});
    }
    const messageText = err instanceof Error ? err.message : String(err);
    const stage = failureStage(err, "check");
    log(
      `${interactive ? "Updater error" : "Update check failed"}: ${messageText}`,
    );
    if (isDebugEnabled()) debugLog(`Update check failed: ${messageText}`);
    setStatus(failureStatusText(stage));
    if (interactive) {
      showToast(`${failureLabel(stage)} ${messageText}`, "error", 0);
    }
  }
}

function startUpdateCheck(interactive: boolean): Promise<void> {
  if (installInFlight) {
    if (interactive) {
      setStatus("Still installing update");
      showToast(
        "An update installation is still running. Archive operations and another update attempt stay blocked until it finishes.",
        "info",
        7000,
      );
      return Promise.resolve();
    }
    return Promise.resolve();
  }
  if (updateCheckInFlight) {
    if (interactive && !inFlightCheckIsInteractive) {
      return updateCheckInFlight.then(() => startUpdateCheck(true));
    }
    return updateCheckInFlight;
  }
  inFlightCheckIsInteractive = interactive;
  updateCheckInFlight = runUpdateCheck(interactive).finally(() => {
    updateCheckInFlight = null;
    inFlightCheckIsInteractive = false;
  });
  return updateCheckInFlight;
}

export function checkUpdates(): Promise<void> {
  return startUpdateCheck(true);
}

export function autoCheckUpdates(): Promise<void> {
  return startUpdateCheck(false);
}
