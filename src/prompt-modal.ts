import { trapFocus, releaseFocusTrap } from "./utils";

export interface PromptOptions {
  title: string;
  label: string;
  password?: boolean;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
}

// In-app replacement for window.prompt (which WebKitGTK disables). Resolves to
// the entered string, or null if cancelled.
export function promptInput(options: PromptOptions): Promise<string | null> {
  const overlay = document.getElementById("input-modal-overlay");
  const field = document.getElementById(
    "input-modal-field",
  ) as HTMLInputElement | null;
  const labelEl = document.getElementById("input-modal-label");
  const titleEl = document.getElementById("input-modal-title");
  const confirmBtn = document.getElementById("input-modal-confirm");
  const cancelBtn = document.getElementById("input-modal-cancel");
  const cancelX = document.getElementById("input-modal-cancel-x");

  if (!overlay || !field || !confirmBtn || !cancelBtn) {
    return Promise.resolve(null);
  }

  const modal = overlay.querySelector<HTMLElement>(".modal");
  const trigger = document.activeElement as HTMLElement | null;

  if (titleEl) titleEl.textContent = options.title;
  if (labelEl) labelEl.textContent = options.label;
  field.type = options.password ? "password" : "text";
  field.placeholder = options.placeholder ?? "";
  field.value = options.defaultValue ?? "";
  confirmBtn.textContent = options.confirmLabel ?? "OK";

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      cancelX?.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onOverlayClick);
      if (modal) releaseFocusTrap(modal);
      // Passwords must not remain in a hidden DOM field after the prompt ends.
      field.value = "";
      field.type = "text";
      overlay.hidden = true;
      trigger?.focus();
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onConfirm = () => finish(field.value);
    const onCancel = () => finish(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(field.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };
    const onOverlayClick = (e: MouseEvent) => {
      if (e.target === overlay) finish(null);
    };

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    cancelX?.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onOverlayClick);

    overlay.hidden = false;
    if (modal) trapFocus(modal);
    field.focus();
    field.select();
  });
}
