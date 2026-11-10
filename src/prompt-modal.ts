import {
  isImeComposing,
  markKeyHandled,
  releaseFocusTrap,
  trapFocus,
} from "./utils";

export interface PromptOptions {
  title: string;
  label: string;
  password?: boolean;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  signal?: AbortSignal;
}

export type PasswordPromptOutcome =
  { kind: "submit"; value: string } | { kind: "skip" } | { kind: "cancel" };

export interface PasswordPromptOptions {
  title: string;
  label: string;
  confirmLabel?: string;
  /** Batch callers only. Adds "Skip this archive" next to Cancel. */
  allowSkip?: boolean;
  signal?: AbortSignal;
}

interface PromptMode {
  /** Reveal toggle, empty-submit validation, and the password field type. */
  passwordControls: boolean;
  allowSkip: boolean;
}

const PASSWORD_ERROR_ID = "input-modal-error";
const PASSWORD_TOGGLE_ID = "input-modal-password-toggle";
const SKIP_BUTTON_ID = "input-modal-skip";
const EMPTY_PASSWORD_MESSAGE = "Enter a password, or choose Cancel.";

let promptOpen = false;

function createPasswordToggle(field: HTMLInputElement): HTMLButtonElement {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = PASSWORD_TOGGLE_ID;
  toggle.className = "btn btn--ghost btn--sm";
  toggle.style.marginTop = "8px";
  toggle.setAttribute("aria-controls", field.id);
  return toggle;
}

function openPrompt(
  options: PromptOptions,
  mode: PromptMode,
): Promise<PasswordPromptOutcome> {
  if (promptOpen) return Promise.resolve({ kind: "cancel" });
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
    return Promise.resolve({ kind: "cancel" });
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

  // Controls below are created for this prompt only and removed in cleanup.
  // The toggle and message sit beside the field's label, not inside it, so
  // "Show" never becomes part of the input's accessible name.
  const anchor = field.closest("label") ?? field;
  let toggleBtn: HTMLButtonElement | null = null;
  let errorEl: HTMLParagraphElement | null = null;
  let skipBtn: HTMLButtonElement | null = null;
  const setRevealed = (revealed: boolean) => {
    field.type = revealed ? "text" : "password";
    if (!toggleBtn) return;
    toggleBtn.textContent = revealed ? "Hide" : "Show";
    toggleBtn.setAttribute(
      "aria-label",
      revealed ? "Hide password" : "Show password",
    );
    toggleBtn.setAttribute("aria-pressed", String(revealed));
  };
  if (mode.passwordControls) {
    toggleBtn = createPasswordToggle(field);
    anchor.insertAdjacentElement("afterend", toggleBtn);
    errorEl = document.createElement("p");
    errorEl.id = PASSWORD_ERROR_ID;
    errorEl.setAttribute("role", "alert");
    errorEl.style.margin = "6px 0 0";
    errorEl.style.color = "var(--danger-fg)";
    errorEl.hidden = true;
    anchor.insertAdjacentElement("afterend", errorEl);
    setRevealed(false);
  }
  if (mode.allowSkip) {
    skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.id = SKIP_BUTTON_ID;
    skipBtn.className = "btn btn--ghost btn--sm";
    skipBtn.textContent = "Skip this archive";
    cancelBtn.insertAdjacentElement("beforebegin", skipBtn);
  }

  return new Promise((resolve) => {
    let settled = false;

    const showEmptyError = () => {
      if (!errorEl) return;
      errorEl.textContent = EMPTY_PASSWORD_MESSAGE;
      errorEl.hidden = false;
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", PASSWORD_ERROR_ID);
      field.focus();
    };
    const clearEmptyError = () => {
      if (!errorEl || errorEl.hidden) return;
      errorEl.hidden = true;
      errorEl.textContent = "";
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-describedby");
    };

    const cleanup = () => {
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      cancelX?.removeEventListener("click", onCancel);
      skipBtn?.removeEventListener("click", onSkip);
      toggleBtn?.removeEventListener("click", onToggle);
      field.removeEventListener("input", onFieldInput);
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onOverlayClick);
      options.signal?.removeEventListener("abort", onAbort);
      if (modal) releaseFocusTrap(modal);
      // Passwords must not remain in a hidden DOM field after the prompt ends.
      field.value = "";
      field.type = "text";
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-describedby");
      toggleBtn?.remove();
      errorEl?.remove();
      skipBtn?.remove();
      overlay.hidden = true;
      promptOpen = false;
      trigger?.focus();
    };

    const finish = (outcome: PasswordPromptOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const submit = () => {
      if (mode.passwordControls && field.value === "") {
        showEmptyError();
        return;
      }
      finish({ kind: "submit", value: field.value });
    };
    const onConfirm = () => submit();
    const onCancel = () => finish({ kind: "cancel" });
    const onSkip = () => finish({ kind: "skip" });
    const onToggle = () => setRevealed(field.type === "password");
    const onFieldInput = () => clearEmptyError();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        // IME confirmation of a composed name must not submit the prompt.
        if (isImeComposing(e)) return;
        // Enter on the reveal toggle keeps the button's native click.
        if (toggleBtn && e.target === toggleBtn) return;
        e.preventDefault();
        const target = e.target;
        if (target === cancelBtn || target === cancelX) {
          finish({ kind: "cancel" });
        } else if (skipBtn && target === skipBtn) {
          finish({ kind: "skip" });
        } else {
          submit();
        }
      } else if (e.key === "Escape") {
        markKeyHandled(e);
        e.preventDefault();
        finish({ kind: "cancel" });
      }
    };
    const onOverlayClick = (e: MouseEvent) => {
      if (options.password) return;
      if (e.target === overlay) finish({ kind: "cancel" });
    };

    const onAbort = () => finish({ kind: "cancel" });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      finish({ kind: "cancel" });
      return;
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    cancelX?.addEventListener("click", onCancel);
    skipBtn?.addEventListener("click", onSkip);
    toggleBtn?.addEventListener("click", onToggle);
    field.addEventListener("input", onFieldInput);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onOverlayClick);

    overlay.hidden = false;
    if (modal) trapFocus(modal);
    field.focus();
    field.select();
  });
}

// In-app replacement for window.prompt (which WebKitGTK disables). Resolves to
// the entered string, or null if cancelled.
export function promptInput(options: PromptOptions): Promise<string | null> {
  return openPrompt(options, {
    passwordControls: false,
    allowSkip: false,
  }).then((outcome) => (outcome.kind === "submit" ? outcome.value : null));
}

/**
 * Password prompt for archive retries. It stays open until a password is
 * submitted or the user cancels (or skips, when `allowSkip` is set). An empty
 * submit shows a message and keeps the prompt open.
 */
export function promptPassword(
  options: PasswordPromptOptions,
): Promise<PasswordPromptOutcome> {
  return openPrompt(
    {
      title: options.title,
      label: options.label,
      confirmLabel: options.confirmLabel,
      password: true,
      signal: options.signal,
    },
    {
      passwordControls: true,
      allowSkip: options.allowSkip === true,
    },
  );
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
        if (isImeComposing(e)) return;
        e.preventDefault();
        const target = e.target;
        finish(target !== cancelBtn && target !== cancelX);
      } else if (e.key === "Escape") {
        markKeyHandled(e);
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
