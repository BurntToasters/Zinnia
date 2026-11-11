import { ask } from "@tauri-apps/plugin-dialog";
import { state } from "../state";
import {
  persistSettingsImmediately,
  awaitInFlightSettingsPersistence,
  isSettingsPersistSupersededError,
} from "../ui";
import {
  isDebugEnabled,
  setDebugEnabled,
  setDebugConsoleVisible,
  restoreDebugConsolePopOutIfNeeded,
} from "../debug-mode";
import { showToast } from "../toast";
import { confirmWithE2eQueue } from "../e2e-dialog";

/** Same superseded-write handling as the Settings save path (see presets.ts). */
async function persistDebugSetting(
  snapshot: typeof state.currentSettings,
): Promise<void> {
  try {
    await persistSettingsImmediately(snapshot, state.settingsExtras);
  } catch (err) {
    if (!isSettingsPersistSupersededError(err)) throw err;
    await awaitInFlightSettingsPersistence();
    await persistSettingsImmediately(snapshot, state.settingsExtras);
  }
}

export async function promptAndToggleDebugMode(): Promise<void> {
  const enabling = !isDebugEnabled();
  const confirmed = await confirmWithE2eQueue(() =>
    ask(
      enabling
        ? "Enable debug mode? This shows a Debug Console with verbose process output."
        : "Disable debug mode and hide the Debug Console?",
      {
        title: enabling ? "Enable debug mode" : "Disable debug mode",
        kind: "info",
        okLabel: enabling ? "Enable" : "Disable",
        cancelLabel: "Cancel",
      },
    ),
  );
  if (!confirmed) return;

  const previousSettings = state.currentSettings;
  const nextSettings = { ...previousSettings, debug: enabling };
  try {
    await persistDebugSetting(nextSettings);
  } catch (err) {
    state.currentSettings = previousSettings;
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Could not save debug setting: ${msg}`, "error");
    return;
  }

  state.currentSettings = nextSettings;
  setDebugEnabled(enabling);
  if (enabling) {
    setDebugConsoleVisible(true);
    showToast("Debug mode enabled.", "info");
    void restoreDebugConsolePopOutIfNeeded();
  } else {
    showToast("Debug mode disabled.", "info");
  }
}
