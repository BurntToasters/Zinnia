import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
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

async function promptInstallAndRestart(
  version: string,
  install: () => Promise<void>,
) {
  setStatus("Update ready");
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
    setStatus("Installing update");
    await install();
    await relaunch();
  } else {
    await notify(
      "Zinnia",
      "Update downloaded. Install it later from Check now.",
    );
    setStatus("Idle");
  }
}

export async function checkUpdates() {
  try {
    setStatus("Checking updates");
    const target = await getUpdateCheckTarget();
    const update = target ? await check({ target }) : await check();
    if (!update) {
      devLog("No updates available.");
      await message("You are running the latest version.", {
        title: "No updates",
      });
      setStatus("Idle");
      return;
    }
    log(`Update available: ${update.version}`);
    setStatus("Downloading update");
    await update.download();
    log(`Update ${update.version} downloaded and ready to install.`);
    await promptInstallAndRestart(update.version, () => update.install());
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Updater error: ${messageText}`);
    setStatus("Idle");
    await message(`Failed to check for updates.\n\n${messageText}`, {
      title: "Update error",
      kind: "error",
    });
  }
}

export async function autoCheckUpdates() {
  try {
    const target = await getUpdateCheckTarget();
    const update = target ? await check({ target }) : await check();
    if (!update) {
      devLog("Auto-update check: no updates available.");
      return;
    }
    log(`Update available: ${update.version}`);
    await notify(
      "Zinnia Update Available",
      `Version ${update.version} is available. Downloading in the background...`,
    );
    setStatus("Downloading update");
    await update.download();
    log(`Update ${update.version} downloaded and ready to install.`);
    await promptInstallAndRestart(update.version, () => update.install());
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Update check failed: ${messageText}`);
    setStatus("Idle");
  }
}
