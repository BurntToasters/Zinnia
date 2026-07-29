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

let pendingUpdate: Update | null = null;
let pendingVersion: string | null = null;
let pendingTarget: string | undefined;
let updateCheckInFlight: Promise<void> | null = null;
let inFlightCheckIsInteractive = false;
let updateGeneration = 0;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;
const UPDATE_INSTALL_TIMEOUT_MS = 180_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(timeoutMessage)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

/** Discard a downloaded update when the user changes channel or resets settings. */
export function discardPendingUpdate(): void {
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
    try {
      await withTimeout(
        update.install(),
        UPDATE_INSTALL_TIMEOUT_MS,
        `Update install timed out after ${UPDATE_INSTALL_TIMEOUT_MS / 1000} seconds.`,
      );
      clearPendingUpdate(false);
      await relaunch();
    } catch (error) {
      try {
        await releaseUpdateReservation();
      } catch {
        // Already logged; still surface the install failure.
      }
      throw error;
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
      if (interactive) {
        await message("You are running the latest version.", {
          title: "No updates",
        });
        setStatus("Idle");
      }
      return;
    }
    log(`Update available: ${checkedUpdate.version}`);
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
