import { invoke } from "@tauri-apps/api/core";
import { parseSettingsRaw } from "../settings-model";

export async function closeWindowSafely(): Promise<void> {
  try {
    await invoke("close_extract_window");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const errorBox = document.getElementById("extract-error");
    if (errorBox) errorBox.hidden = false;
    const title = errorBox?.querySelector<HTMLElement>(".extract-error-title");
    if (title) title.textContent = "Could not close safely";
    const detailBox = document.getElementById("error-detail");
    if (detailBox) detailBox.textContent = detail;
    const status = document.getElementById("extract-status");
    if (status) status.textContent = "Waiting for cleanup";
  }
}

/** Match main-window Basic glass when the user has effects enabled. */
export async function syncExtractWindowFx(): Promise<void> {
  let supports = false;
  try {
    supports = await invoke<boolean>("supports_workspace_window_fx");
  } catch {
    supports = false;
  }

  let effectsEnabled = true;
  let themePref = "system";
  try {
    const raw = await invoke<string>("load_settings");
    const { settings } = parseSettingsRaw(raw);
    effectsEnabled = settings.basicWindowEffects;
    themePref = settings.theme;
  } catch {
    // Defaults match SETTING_DEFAULTS (effects on, system theme).
  }

  const dark =
    themePref === "dark" ||
    (themePref !== "light" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

  const enabled = supports && effectsEnabled;
  document.documentElement.dataset.windowFx = enabled ? "basic" : "opaque";
  try {
    await invoke("set_workspace_window_fx", { enabled, dark });
  } catch {
    // CSS still paints correctly if native vibrancy is unavailable.
  }
}
