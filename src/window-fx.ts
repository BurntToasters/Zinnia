import { invoke } from "@tauri-apps/api/core";
import { isE2eFrontend } from "./e2e-env";
import { state } from "./state";

/** Native Basic glass on macOS/Windows; Linux and Power stay visually opaque. */
export async function syncWorkspaceWindowFx(): Promise<void> {
  if (isE2eFrontend()) {
    document.documentElement.dataset.windowFx = "opaque";
    return;
  }
  let supports = false;
  try {
    supports = await invoke<boolean>("supports_workspace_window_fx");
  } catch {
    supports = false;
  }

  const workspaceMode =
    document.getElementById("app")?.dataset.workspaceMode === "basic"
      ? "basic"
      : "power";
  const enabled =
    supports &&
    workspaceMode === "basic" &&
    state.currentSettings.basicWindowEffects;

  document.documentElement.dataset.windowFx = enabled ? "basic" : "opaque";
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  try {
    await invoke("set_workspace_window_fx", { enabled, dark });
  } catch {
    // Appearance remains correct via CSS even if the native effect is unavailable.
  }
}
