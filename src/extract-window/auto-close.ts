import { closeWindowSafely } from "./fx";

const AUTO_CLOSE_POINTER_SLOP_PX = 4;
const AUTO_CLOSE_IGNORED_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "OS",
  "Shift",
  "Unidentified",
]);
const AUTO_CLOSE_CANCEL_EVENTS = ["keydown", "click"] as const;

export type AutoCloseController = {
  beginAutoClose: () => void;
  cancelAutoClose: (resetLabel?: boolean) => void;
};

export function createAutoCloseController(
  closeBtn: HTMLButtonElement,
  autoCloseDelay: number,
): AutoCloseController {
  let autoCloseInterval: ReturnType<typeof setInterval> | null = null;
  let autoCloseDeadline = 0;
  let autoClosePaused = false;
  let autoCloseListening = false;
  let autoClosePointer: { x: number; y: number } | null = null;
  let autoCloseLastAnnouncedSec = -1;

  const stopAutoCloseTimer = () => {
    if (autoCloseInterval !== null) {
      clearInterval(autoCloseInterval);
      autoCloseInterval = null;
    }
  };

  const renderAutoCloseCountdown = () => {
    const remainingMs = autoCloseDeadline - Date.now();
    if (remainingMs <= 0) {
      cancelAutoClose();
      closeBtn.textContent = "Closing…";
      const statusEl = document.getElementById("extract-status");
      if (statusEl) statusEl.textContent = "Closing…";
      void closeWindowSafely().then(() => {
        closeBtn.textContent = "Close";
      });
      return;
    }
    const sec = Math.ceil(remainingMs / 1000);
    closeBtn.textContent = `Close (${sec}s)`;
    if (sec !== autoCloseLastAnnouncedSec) {
      autoCloseLastAnnouncedSec = sec;
      const statusEl = document.getElementById("extract-status");
      if (statusEl) statusEl.textContent = `Closing in ${sec} s`;
    }
  };

  const startAutoCloseCountdown = () => {
    stopAutoCloseTimer();
    autoClosePaused = false;
    autoCloseLastAnnouncedSec = -1;
    autoCloseDeadline = Date.now() + autoCloseDelay * 1000;
    renderAutoCloseCountdown();
    if (autoCloseListening) {
      autoCloseInterval = setInterval(renderAutoCloseCountdown, 100);
    }
  };

  const pauseAutoClose = () => {
    stopAutoCloseTimer();
    autoClosePaused = true;
    closeBtn.textContent = "Close (paused)";
  };

  const onAutoClosePointerMove = (event: MouseEvent) => {
    const point = { x: event.screenX, y: event.screenY };
    if (!autoClosePointer) {
      autoClosePointer = point;
      return;
    }
    const moved = Math.max(
      Math.abs(point.x - autoClosePointer.x),
      Math.abs(point.y - autoClosePointer.y),
    );
    if (moved < AUTO_CLOSE_POINTER_SLOP_PX) return;
    autoClosePointer = point;
    if (!autoClosePaused) pauseAutoClose();
  };

  const onAutoClosePointerLeave = () => {
    autoClosePointer = null;
    if (autoClosePaused) startAutoCloseCountdown();
  };

  const onAutoCloseCancel = (event: Event) => {
    if (
      event instanceof KeyboardEvent &&
      AUTO_CLOSE_IGNORED_KEYS.has(event.key)
    ) {
      return;
    }
    cancelAutoClose(true);
  };

  const removeAutoCloseListeners = () => {
    if (!autoCloseListening) return;
    window.removeEventListener("mousemove", onAutoClosePointerMove);
    for (const eventName of AUTO_CLOSE_CANCEL_EVENTS) {
      window.removeEventListener(eventName, onAutoCloseCancel);
    }
    document.documentElement.removeEventListener(
      "mouseleave",
      onAutoClosePointerLeave,
    );
    window.removeEventListener("blur", onAutoClosePointerLeave);
    autoCloseListening = false;
  };

  const cancelAutoClose = (resetLabel = false) => {
    const wasActive = autoCloseListening;
    removeAutoCloseListeners();
    stopAutoCloseTimer();
    autoClosePaused = false;
    autoClosePointer = null;
    if (resetLabel && wasActive) closeBtn.textContent = "Close";
  };

  const beginAutoClose = () => {
    autoCloseListening = true;
    window.addEventListener("mousemove", onAutoClosePointerMove);
    for (const eventName of AUTO_CLOSE_CANCEL_EVENTS) {
      window.addEventListener(eventName, onAutoCloseCancel);
    }
    document.documentElement.addEventListener(
      "mouseleave",
      onAutoClosePointerLeave,
    );
    // Alt+Tab away with the pointer resting inside fires no mouseleave.
    window.addEventListener("blur", onAutoClosePointerLeave);
    startAutoCloseCountdown();
  };

  return { beginAutoClose, cancelAutoClose };
}
