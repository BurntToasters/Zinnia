import { copyTextToClipboard, isKeyHandled, markKeyHandled } from "./utils";

type ToastKind = "success" | "info" | "error";

const DEFAULT_DURATION_MS = 3500;
const REGION_ID = "toast-region";
const MAX_TOAST_CHARS = 4000;
/** Sticky toasts stay until dismissed; keep the newest few so they cannot stack forever. */
const MAX_STICKY_TOASTS = 3;

type ToastRecord = {
  kind: ToastKind;
  text: string;
  dismiss: () => void;
  refresh: () => void;
};

const records = new WeakMap<HTMLElement, ToastRecord>();

function boundToastText(text: string): string {
  if (text.length <= MAX_TOAST_CHARS) return text;
  const omitted = text.length - MAX_TOAST_CHARS;
  return `${text.slice(0, MAX_TOAST_CHARS)}\n\n[truncated ${omitted} chars]`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Icon-only close control. Its name is a label, so the message text stays clean. */
function createDismissButton(): HTMLButtonElement {
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-dismiss";
  close.setAttribute("aria-label", "Dismiss");
  close.title = "Dismiss";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const glyph = document.createElementNS(SVG_NS, "path");
  glyph.setAttribute("d", "M3 3l6 6M9 3l-6 6");
  svg.appendChild(glyph);
  close.appendChild(svg);
  return close;
}

function createCopyButton(text: string): HTMLButtonElement {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn--ghost btn--sm toast-copy";
  copy.textContent = "Copy";
  copy.title = "Copy error message";
  copy.setAttribute("aria-label", "Copy error message");
  copy.addEventListener("click", () => {
    void copyTextToClipboard(text).then((copied) => {
      if (!copied) showToast("Could not copy the error message.", "info");
    });
  });
  return copy;
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

/** Dismiss the oldest sticky toasts that exceed the cap. Fading toasts do not count. */
function trimStickyToasts(region: HTMLElement): void {
  const sticky = Array.from(
    region.querySelectorAll<HTMLElement>(
      '.toast[data-sticky="true"]:not(.toast--leaving)',
    ),
  );
  const excess = sticky.length - MAX_STICKY_TOASTS;
  for (let i = 0; i < excess; i += 1) {
    records.get(sticky[i])?.dismiss();
  }
}

function findVisibleDuplicate(
  region: HTMLElement,
  kind: ToastKind,
  text: string,
): HTMLElement | null {
  const visible = Array.from(
    region.querySelectorAll<HTMLElement>(".toast:not(.toast--leaving)"),
  );
  return (
    visible.find((el) => {
      const record = records.get(el);
      return record?.kind === kind && record.text === text;
    }) ?? null
  );
}

export function showToast(
  text: string,
  kind: ToastKind = "info",
  durationMs = DEFAULT_DURATION_MS,
): void {
  const region = ensureRegion();
  const bounded = boundToastText(text);
  const duplicate = findVisibleDuplicate(region, kind, bounded);
  if (duplicate) {
    records.get(duplicate)?.refresh();
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  if (durationMs <= 0) toast.dataset.sticky = "true";
  const message = document.createElement("span");
  message.className = "toast-message";
  message.textContent = bounded;
  toast.appendChild(message);

  let count = 1;
  let countEl: HTMLSpanElement | null = null;
  const showCount = () => {
    if (!countEl) {
      countEl = document.createElement("span");
      countEl.className = "toast-count";
      message.after(countEl);
    }
    countEl.textContent = `(${count})`;
  };

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
  if (kind === "error") toast.appendChild(createCopyButton(bounded));

  const close = createDismissButton();
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });
  toast.appendChild(close);

  // Esc while focus is in the toast dismisses it. The event is marked so the
  // Basic Esc handler does not also return to Home.
  toast.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || isKeyHandled(event)) return;
    markKeyHandled(event);
    event.preventDefault();
    dismiss();
  });
  region.appendChild(toast);
  if (durationMs <= 0) trimStickyToasts(region);

  let restartTimer = () => {};
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
    restartTimer = () => {
      remainingMs = durationMs;
      if (dismissTimer !== undefined) {
        window.clearTimeout(dismissTimer);
        dismissTimer = undefined;
      }
      if (!hovered && !focused) resume();
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

  records.set(toast, {
    kind,
    text: bounded,
    dismiss,
    refresh: () => {
      count += 1;
      showCount();
      restartTimer();
    },
  });
}
