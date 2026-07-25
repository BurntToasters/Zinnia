import { $, trapFocus, releaseFocusTrap } from "./utils";

let shortcutsTrigger: HTMLElement | null = null;

export function openShortcutsModal(): void {
  shortcutsTrigger = document.activeElement as HTMLElement | null;
  const overlay = $("shortcuts-overlay");
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
  $("close-shortcuts").addEventListener("click", closeShortcutsModal);
  $("close-shortcuts-footer").addEventListener("click", closeShortcutsModal);
  $("shortcuts-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeShortcutsModal();
  });
}
