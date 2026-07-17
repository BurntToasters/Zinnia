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

let cachedUpdaterTargetBase: string | null = null;
let pendingUpdate: Update | null = null;
let pendingVersion: string | null = null;
let pendingTarget: string | undefined;
let updateCheckInFlight: Promise<void> | null = null;
let inFlightCheckIsInteractive = false;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;

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
  clearPendingUpdate(true);
}

async function archiveOperationIsRunning(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_7z_running");
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Failing closed is deliberate: an updater must never terminate an archive
    // operation merely because the status query is unavailable.
    log(`Unable to confirm archive idle state: ${text}`, "error");
    return true;
  }
}

async function getUpdaterTargetBase(): Promise<string> {
  if (cachedUpdaterTargetBase) {
    return cachedUpdaterTargetBase;
  }
  const platform = await invoke<string>("get_platform_info");
  if (platform === "win32" || platform === "windows") {
    cachedUpdaterTargetBase = "windows";
  } else if (platform === "macos") {
    cachedUpdaterTargetBase = "darwin";
  } else {
    cachedUpdaterTargetBase = platform;
  }
  return cachedUpdaterTargetBase;
}

async function getUpdateCheckTarget(): Promise<string | undefined> {
  const channel = state.currentSettings.updateChannel;
  if (channel === "stable") {
    return undefined;
  }
  if (channel === "beta") {
    const base = await getUpdaterTargetBase();
    return `${base}-beta`;
  }
  // auto: follow the installed version — beta if version contains a pre-release tag
  const version = await getVersion();
  const isBeta = /-(beta|alpha|rc)/i.test(version);
  if (!isBeta) return undefined;
  const base = await getUpdaterTargetBase();
  return `${base}-beta`;
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

async function promptInstallAndRestart(version: string, update: Update) {
  pendingUpdate = update;
  pendingVersion = version;
  setStatus("Update ready");
  if (await archiveOperationIsRunning()) {
    await message(
      `Version ${version} is downloaded. Zinnia will not install it while an archive operation is running. Use Check now after the operation finishes.`,
      { title: "Update deferred", kind: "info" },
    );
    setStatus("Update ready");
    return;
  }
  const restart = await ask(
    `Version ${version} has been downloaded and is ready to install.\n\nRestart now to apply the update?`,
    {
      title: "Update ready",
      kind: "info",
      okLabel: "Restart now",
      cancelLabel: "Later",
    },
  );
  if (restart) {
    if (await archiveOperationIsRunning()) {
      await message(
        "An archive operation started before the update could be installed. The update remains ready and can be installed after it finishes.",
        { title: "Update deferred", kind: "info" },
      );
      setStatus("Update ready");
      return;
    }
    setStatus("Installing update");
    await update.install();
    clearPendingUpdate(false);
    await relaunch();
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
  try {
    const target = await getUpdateCheckTarget();
    if (pendingUpdate && pendingTarget !== target) discardPendingUpdate();
    if (pendingUpdate && pendingVersion) {
      if (interactive) {
        await promptInstallAndRestart(pendingVersion, pendingUpdate);
      }
      return;
    }
    if (interactive) setStatus("Checking updates");
    checkedUpdate = await check({
      ...(target ? { target } : {}),
      timeout: UPDATE_CHECK_TIMEOUT_MS,
    });
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
    pendingTarget = target;
    log(`Update ${checkedUpdate.version} downloaded and ready to install.`);
    await promptInstallAndRestart(checkedUpdate.version, checkedUpdate);
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
