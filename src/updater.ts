import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message, ask, confirm } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { log, devLog, setStatus } from "./ui";

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

export async function checkUpdates() {
  try {
    setStatus("Checking updates");
    const update = await check();
    if (!update) {
      devLog("No updates available.");
      await message("You are running the latest version.", { title: "No updates" });
      setStatus("Idle");
      return;
    }
    log(`Update available: ${update.version}`);
    const confirmed = await confirm(
      `Version ${update.version} is available. Download and install now?\n\nThe app will restart after installation.`,
      { title: "Update available", kind: "info", okLabel: "Install" }
    );
    if (!confirmed) {
      setStatus("Idle");
      return;
    }
    setStatus("Downloading update");
    await update.downloadAndInstall();
    log("Update installed. Relaunching...");
    await relaunch();
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Updater error: ${messageText}`);
    setStatus("Idle");
    await message(`Failed to check for updates.\n\n${messageText}`, { title: "Update error", kind: "error" });
  }
}

export async function autoCheckUpdates() {
  try {
    const update = await check();
    if (!update) {
      devLog("Auto-update check: no updates available.");
      return;
    }
    log(`Update available: ${update.version}`);
    await notify("Zinnia Update Available", `Version ${update.version} is available. Downloading in the background...`);
    setStatus("Downloading update");
    await update.downloadAndInstall();
    setStatus("Update ready");
    log(`Update ${update.version} downloaded and ready to install.`);
    const restart = await ask(
      `Version ${update.version} has been downloaded and is ready to install.\n\nRestart now to apply the update?`,
      { title: "Update ready", kind: "info", okLabel: "Restart now", cancelLabel: "Later" }
    );
    if (restart) {
      await relaunch();
    } else {
      await notify("Zinnia", "Update will be applied next time you restart.");
      setStatus("Idle");
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    devLog(`Auto-update error: ${messageText}`);
    setStatus("Idle");
  }
}
