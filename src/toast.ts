export type ToastKind = "success" | "info" | "error";

const DEFAULT_DURATION_MS = 3500;
const REGION_ID = "toast-region";
const MAX_TOAST_CHARS = 4000;

function boundToastText(text: string): string {
  if (text.length <= MAX_TOAST_CHARS) return text;
  const omitted = text.length - MAX_TOAST_CHARS;
  return `${text.slice(0, MAX_TOAST_CHARS)}\n\n[truncated ${omitted} chars]`;
}

function ensureRegion(): HTMLElement {
  let region = document.getElementById(REGION_ID);
  if (!region) {
    region = document.createElement("div");
    region.id = REGION_ID;
    region.className = "toast-region";
    document.body.appendChild(region);
  }
  return region;
}

export function showToast(
  text: string,
  kind: ToastKind = "info",
  durationMs = DEFAULT_DURATION_MS,
): void {
  const region = ensureRegion();

  const toast = document.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  const message = document.createElement("span");
  message.className = "toast-message";
  message.textContent = boundToastText(text);
  toast.appendChild(message);

  let dismissed = false;
  let dismissTimer: number | undefined;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    window.clearTimeout(dismissTimer);
    toast.classList.add("toast--leaving");
    window.setTimeout(() => toast.remove(), 200);
  };

  toast.tabIndex = 0;
  toast.addEventListener("click", dismiss);
  if (durationMs <= 0) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "Dismiss";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      dismiss();
    });
    toast.appendChild(close);
    toast.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    });
  }
  region.appendChild(toast);

  if (durationMs > 0) {
    let remainingMs = durationMs;
    let timerStartedAt = 0;
    let hovered = false;
    let focused = false;
    const pause = () => {
      if (dismissTimer === undefined) return;
      window.clearTimeout(dismissTimer);
      dismissTimer = undefined;
      remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
    };
    const resume = () => {
      if (dismissed || dismissTimer !== undefined) return;
      timerStartedAt = Date.now();
      dismissTimer = window.setTimeout(dismiss, remainingMs);
    };
    toast.addEventListener("mouseenter", () => {
      hovered = true;
      pause();
    });
    toast.addEventListener("mouseleave", () => {
      hovered = false;
      if (!focused) resume();
    });
    toast.addEventListener("focusin", () => {
      focused = true;
      pause();
    });
    toast.addEventListener("focusout", () => {
      focused = false;
      if (!hovered) resume();
    });
    resume();
  }
}
