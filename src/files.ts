import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { $ } from "./utils";
import { state } from "./state";
import { log, renderInputs } from "./ui";

export async function chooseOutput() {
  const format = $<HTMLSelectElement>("format").value;
  const output = await save({
    title: "Choose output archive",
    defaultPath: `zinnia.${format}`
  });
  if (output) {
    $<HTMLInputElement>("output-path").value = output;
  }
}

export async function chooseExtract() {
  const output = await open({
    title: "Choose destination folder",
    directory: true
  });
  if (output && typeof output === "string") {
    $<HTMLInputElement>("extract-path").value = output;
  }
}

export async function addFiles() {
  const selection = await open({
    title: "Add files",
    multiple: true
  });
  if (!selection) return;
  const newPaths = Array.isArray(selection) ? selection : [selection];
  for (const path of newPaths) {
    if (!state.inputs.includes(path)) {
      state.inputs.push(path);
    }
  }
  renderInputs();
}

export async function addFolder() {
  const selection = await open({
    title: "Add folder",
    directory: true
  });
  if (selection && typeof selection === "string") {
    if (!state.inputs.includes(selection)) {
      state.inputs.push(selection);
    }
    renderInputs();
  }
}

export function setOsIntegrationToggle(enabled: boolean) {
  state.osIntegrationEnabled = enabled;
  const input = document.getElementById("s-os-integration") as HTMLInputElement | null;
  if (input) input.checked = enabled;
}

export async function enableOsIntegration(): Promise<boolean> {
  try {
    if (state.platformName === "windows") {
      await invoke("register_windows_context_menu");
    } else if (state.platformName === "linux") {
      await invoke("register_linux_desktop_integration");
    } else {
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`OS integration registration failed: ${msg}`);
    return false;
  }
}

export async function disableOsIntegration(): Promise<boolean> {
  try {
    if (state.platformName === "windows") {
      await invoke("unregister_windows_context_menu");
    } else if (state.platformName === "linux") {
      await invoke("unregister_linux_desktop_integration");
    } else {
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`OS integration removal failed: ${msg}`);
    return false;
  }
}

export async function toggleOsIntegration() {
  if (!state.appIsPackaged) {
    log("OS integration is disabled in development builds.");
    setOsIntegrationToggle(false);
    return;
  }
  if (state.osIntegrationEnabled) {
    if (await disableOsIntegration()) {
      setOsIntegrationToggle(false);
      log("File manager integration disabled.");
    }
  } else {
    if (await enableOsIntegration()) {
      setOsIntegrationToggle(true);
      log("File manager integration enabled.");
    }
  }
}

export async function probeOsIntegrationStatus(): Promise<boolean> {
  try {
    if (state.platformName === "windows") {
      return await invoke<boolean>("get_windows_context_menu_status");
    } else if (state.platformName === "linux") {
      return await invoke<boolean>("get_linux_desktop_integration_status");
    }
  } catch {
  }
  return false;
}
