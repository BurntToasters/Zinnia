import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message, ask } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { log, devLog, setStatus } from "./ui";
import { state } from "./state";
import { debugLog, isDebugEnabled } from "./debug-mode";

let pendingUpdate: Update | null = null;
let pendingVersion: string | null = null;
let pendingTarget: string | undefined;
let updateCheckInFlight: Promise<void> | null = null;
let inFlightCheckIsInteractive = false;
let updateGeneration = 0;
/** True while native `update.install()` is live. Timeout must not unlock. */
let installInFlight = false;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;
const UPDATE_INSTALL_WATCHDOG_MS = 180_000;
const UPDATE_RESERVATION_HEARTBEAT_MS = 60_000;

async function touchUpdateReservation(): Promise<void> {
  try {
    await invoke<boolean>("is_7z_running", { mode: "touch_update" });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    devLog(`Unable to refresh update reservation: ${text}`);
  }
}

function clearPendingUpdate(closeResource: boolean): void {
  const update = pendingUpdate;
  pendingUpdate = null;
  pendingVersion = null;
  pendingTarget = undefined;
  if (closeResource && update) {
    const close = (update as Update & { close?: () => Promise<void> }).close;
    if (close) {
      void close.call(update).catch((err) => {
        devLog(`Failed to release pending update resources: ${String(err)}`);
      });
    }
  }
}

/** Discard a downloaded update; no-op mid-install (close would race it). */
export function discardPendingUpdate(): void {
  if (installInFlight) return;
  updateGeneration += 1;
  clearPendingUpdate(true);
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
 * as "still busy"  -  that strands archive ops until restart. */
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
  if (await isPermissionGranted()) {
    sendNotification({ title, body });
  }
}

async function promptInstallAndRestart(
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
  setStatus("Update ready");
  if (await archiveOperationIsRunning()) {
    if (generation !== updateGeneration) return;
    await message(
      `Version ${version} is downloaded. Zinnia will not install it while an archive operation is running. Use Check now after the operation finishes.`,
      { title: "Update deferred", kind: "info" },
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
      await message(
        "An archive operation started before the update could be installed. The update remains ready and can be installed after it finishes.",
        { title: "Update deferred", kind: "info" },
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
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
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
      await update.install();
      clearPendingUpdate(false);
      // Drop archive-operation reservation before requesting process restart.
      // Native exit handling deliberately blocks Quit while the reservation is
      // held, so successful release is required before requesting relaunch.
      await releaseUpdateReservation();
      await relaunch();
    } catch (error) {
      try {
        await releaseUpdateReservation();
      } catch {
        // Already logged; still surface the install failure.
      }
      if (watchdogFired) {
        setStatus("Idle");
      }
      throw error;
    } finally {
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      installInFlight = false;
    }
  } else {
    await notify(
      "Zinnia",
      "Update downloaded and ready to install from Check now.",
    );
    setStatus("Update ready");
  }
}

async function runUpdateCheck(interactive: boolean): Promise<void> {
  let checkedUpdate: Update | null = null;
  let generation = updateGeneration;
  try {
    const isFlatpak = await invoke<boolean>("is_flatpak");
    if (isFlatpak) {
      if (interactive) {
        await message(
          "Flatpak builds update through Flathub or a reinstalled bundle, not the in-app updater.",
          { title: "Updates unavailable" },
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
      if (interactive) {
        await promptInstallAndRestart(
          pendingVersion,
          pendingUpdate,
          generation,
        );
      }
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
        await message("You are running the latest version.", {
          title: "No updates",
        });
        setStatus("Idle");
      }
      return;
    }
    log(`Update available: ${checkedUpdate.version}`);
    if (isDebugEnabled()) {
      debugLog(`Update available: ${checkedUpdate.version}`);
    }
    if (!interactive) {
      await notifyIfAlreadyGranted(
        "Zinnia Update Available",
        `Version ${checkedUpdate.version} is available. Downloading in the background...`,
      );
    }
    setStatus("Downloading update");
    await checkedUpdate.download(undefined, {
      timeout: UPDATE_DOWNLOAD_TIMEOUT_MS,
    });
    if (generation !== updateGeneration) {
      await checkedUpdate.close().catch(() => {});
      return;
    }
    pendingTarget = target;
    log(`Update ${checkedUpdate.version} downloaded and ready to install.`);
    await promptInstallAndRestart(
      checkedUpdate.version,
      checkedUpdate,
      generation,
    );
    checkedUpdate = null;
  } catch (err) {
    if (checkedUpdate && checkedUpdate !== pendingUpdate) {
      await checkedUpdate.close().catch(() => {});
    }
    const messageText = err instanceof Error ? err.message : String(err);
    log(
      `${interactive ? "Updater error" : "Update check failed"}: ${messageText}`,
    );
    if (isDebugEnabled()) debugLog(`Update check failed: ${messageText}`);
    setStatus("Idle");
    if (interactive) {
      await message(`Failed to check for updates.\n\n${messageText}`, {
        title: "Update error",
        kind: "error",
      });
    }
  }
}

function startUpdateCheck(interactive: boolean): Promise<void> {
  if (installInFlight) {
    if (interactive) {
      setStatus("Still installing update");
      return message(
        "An update installation is still running. Archive operations and another update attempt stay blocked until it finishes.",
        { title: "Update in progress", kind: "info" },
      ).then(() => undefined);
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
