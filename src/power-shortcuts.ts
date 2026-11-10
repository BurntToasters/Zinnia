import { $, trapFocus, releaseFocusTrap } from "./utils";
import { renderShortcuts } from "./shortcuts";

let shortcutsTrigger: HTMLElement | null = null;

/** Any other visible dialog. Esc closes one dialog at a time, so Shortcuts waits. */
const OPEN_DIALOG_SELECTOR =
  ".modal-overlay:not([hidden]), #setup-wizard-overlay:not([hidden])";

export function openShortcutsModal(): void {
  const overlay = $("shortcuts-overlay");
  if (!overlay.hidden) return;
  if (document.querySelector(OPEN_DIALOG_SELECTOR)) return;
  shortcutsTrigger = document.activeElement as HTMLElement | null;
  overlay.hidden = false;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) trapFocus(modal);
  $("close-shortcuts").focus();
}

export function closeShortcutsModal(): void {
  const overlay = $("shortcuts-overlay");
  if (overlay.hidden) return;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
  overlay.hidden = true;
  shortcutsTrigger?.focus();
  shortcutsTrigger = null;
}

export function wireShortcutsEvents(): void {
  renderShortcuts();
  $("close-shortcuts").addEventListener("click", closeShortcutsModal);
  $("close-shortcuts-footer").addEventListener("click", closeShortcutsModal);
  $("shortcuts-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeShortcutsModal();
  });
}
