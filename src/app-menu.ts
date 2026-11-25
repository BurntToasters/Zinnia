import { openSettingsModal } from "./settings";
import { openShortcutsModal } from "./power-shortcuts";
import { openLicensesModal } from "./licenses";
import { checkUpdates } from "./updater";
import { openExternalUrl } from "./external-links";
import { isBlockingModalOpen } from "./power-helpers";

/**
 * Runs one native menu action. Settings, Shortcuts and Licenses wait while a
 * blocking modal is open, the same rule the keyboard shortcuts follow.
 */
export function handleAppMenuAction(action: string): void {
  switch (action) {
    case "menu-settings":
      if (!isBlockingModalOpen("settings-overlay")) openSettingsModal();
      break;
    case "menu-check-updates":
      void checkUpdates();
      break;
    case "menu-shortcuts":
      if (!isBlockingModalOpen()) openShortcutsModal();
      break;
    case "menu-licenses":
      if (!isBlockingModalOpen()) openLicensesModal();
      break;
    case "menu-support":
      void openExternalUrl("https://rosie.run/support");
      break;
    default:
      break;
  }
}
