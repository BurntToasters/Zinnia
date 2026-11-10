import { state } from "../state";
import { $ } from "../utils";
import { applyTheme, applySettingsToForm } from "../settings";
import { setWorkspaceMode, setUiDensity, resizeWorkspaceWindow } from "../ui";
import {
  updateCompressionOptionsForFormat,
  onCompressionOptionChange,
} from "../presets";
import { setBasicView, syncBasicWorkspaceFromPower } from "../basic";
import {
  showSetupWizard,
  markSetupComplete,
  type SetupWizardOptions,
} from "../setup-wizard";

export async function runSetupWizardFlow(
  options: SetupWizardOptions = {},
): Promise<void> {
  const previousWorkspaceMode = state.currentSettings.workspaceMode;
  await resizeWorkspaceWindow("power");
  const result = await showSetupWizard(options);
  if (result) {
    state.currentSettings.workspaceMode = result.workspaceMode;
    state.currentSettings.theme = result.theme;
    state.currentSettings.autoCheckUpdates = result.autoCheckUpdates;
    state.currentSettings.updateChannel = result.updateChannel;
    if (typeof result.osIntegrationDismissed === "boolean") {
      state.currentSettings.osIntegrationDismissed =
        result.osIntegrationDismissed;
    }
  }

  let persistError: unknown = null;
  try {
    await markSetupComplete();
  } catch (err) {
    persistError = err;
  }

  applyTheme(state.currentSettings.theme);
  setWorkspaceMode(state.currentSettings.workspaceMode, { persist: false });
  setUiDensity(state.currentSettings.uiDensity, { persist: false });
  applySettingsToForm();
  updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
  onCompressionOptionChange();
  // Same resync as the Settings save path: a re-run that picks Basic must
  // refresh the Basic view from the Power values just applied.
  if (state.currentSettings.workspaceMode === "basic") {
    if (previousWorkspaceMode !== "basic") setBasicView("home");
    syncBasicWorkspaceFromPower();
  }

  if (persistError) {
    throw persistError;
  }
}
