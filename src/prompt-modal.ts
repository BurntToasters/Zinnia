import { trapFocus, releaseFocusTrap } from "./utils";

export interface PromptOptions {
  title: string;
  label: string;
  password?: boolean;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
}

let promptOpen = false;

// In-app replacement for window.prompt (which WebKitGTK disables). Resolves to
// the entered string, or null if cancelled.
export function promptInput(options: PromptOptions): Promise<string | null> {
  if (promptOpen) return Promise.resolve(null);
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
  promptOpen = true;

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
      promptOpen = false;
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
        const target = e.target;
        finish(target === cancelBtn || target === cancelX ? null : field.value);
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

export interface ConfirmChoiceOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * In-app yes/no dialog. Native plugin-dialog windows sit outside the webview
 * and cannot be dismissed by WebDriver or headless CI.
 */
export function confirmChoice(options: ConfirmChoiceOptions): Promise<boolean> {
  if (promptOpen) return Promise.resolve(false);
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
    return Promise.resolve(false);
  }
  promptOpen = true;

  const modal = overlay.querySelector<HTMLElement>(".modal");
  const trigger = document.activeElement as HTMLElement | null;
  const previousConfirm = confirmBtn.textContent;
  const previousCancel = cancelBtn.textContent;
  const previousFieldHidden = field.hidden;

  if (titleEl) titleEl.textContent = options.title;
  if (labelEl) labelEl.textContent = options.message;
  field.hidden = true;
  confirmBtn.textContent = options.confirmLabel ?? "OK";
  cancelBtn.textContent = options.cancelLabel ?? "Cancel";

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      cancelX?.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onOverlayClick);
      if (modal) releaseFocusTrap(modal);
      field.hidden = previousFieldHidden;
      confirmBtn.textContent = previousConfirm;
      cancelBtn.textContent = previousCancel;
      overlay.hidden = true;
      promptOpen = false;
      trigger?.focus();
    };

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const target = e.target;
        finish(target !== cancelBtn && target !== cancelX);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const onOverlayClick = (e: MouseEvent) => {
      if (e.target === overlay) finish(false);
    };

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    cancelX?.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onOverlayClick);

    overlay.hidden = false;
    if (modal) trapFocus(modal);
    confirmBtn.focus();
  });
}
