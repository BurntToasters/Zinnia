import { wireSessionEvents } from "./power-events/session";
import { wireSelectiveModalEvents } from "./power-events/selective-modal";
import { wirePresetAndCompressionEvents } from "./power-events/presets";
import { wireWorkspaceChromeEvents } from "./power-events/chrome";
import { wireSettingsEvents } from "./power-events/settings";
import { wireAboutAndToolsEvents } from "./power-events/about-tools";
import { wireGlobalKeyboardEvents } from "./power-events/keyboard";

export { openShortcutsModal } from "./power-shortcuts";
export { promptAndToggleDebugMode } from "./power-events/debug-toggle";
export { runSetupWizardFlow } from "./power-events/setup-wizard-flow";

let eventsWired = false;

export function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;

  wireSessionEvents();
  wireSelectiveModalEvents();
  wirePresetAndCompressionEvents();
  wireWorkspaceChromeEvents();
  wireSettingsEvents();
  wireAboutAndToolsEvents();
  wireGlobalKeyboardEvents();
}
