import { MAX_LOG_LINES, redactSensitiveText } from "./utils";
import { showToast } from "./toast";
import { sanitizeCommandArgsForPreview } from "./archive/command-sanitize";

let debugEnabled = false;
let consoleControlsWired = false;

function consolePanel(): HTMLElement | null {
  return document.getElementById("debug-console");
}

function consoleLogEl(): HTMLElement | null {
  return document.getElementById("debug-console-log");
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function setDebugConsoleVisible(visible: boolean): void {
  const panel = consolePanel();
  if (!panel) return;
  panel.hidden = !visible;
}

export function isDebugConsoleVisible(): boolean {
  const panel = consolePanel();
  return Boolean(panel && !panel.hidden);
}

function trimDebugLog(logEl: HTMLElement): void {
  const text = logEl.textContent || "";
  const lines = text.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    logEl.textContent = lines.slice(lines.length - MAX_LOG_LINES).join("\n");
  }
}

/** Append a line only when debug mode is on. Prefer thunks for expensive work. */
export function debugLog(message: string | (() => string)): void {
  if (!debugEnabled) return;

  const raw = typeof message === "function" ? message() : message;
  const logEl = consoleLogEl();
  if (!logEl) return;

  // Close only hides the panel; new output re-opens it so dumps aren't lost.
  const panel = consolePanel();
  if (panel?.hidden) panel.hidden = false;

  const sanitized = redactSensitiveText(raw);
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${stamp}] ${sanitized}\n`;
  trimDebugLog(logEl);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Log a redacted 7z command line when debug mode is on. */
export function debugLogCommand(args: string[]): void {
  if (!debugEnabled) return;
  debugLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
}

export function clearDebugConsole(): void {
  const logEl = consoleLogEl();
  if (logEl) logEl.textContent = "";
}

export async function copyDebugConsole(): Promise<void> {
  const logEl = consoleLogEl();
  const text = logEl?.textContent ?? "";
  if (!text.trim()) {
    showToast("Debug console is empty.", "info");
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard API unavailable");
    }
    await navigator.clipboard.writeText(text);
    showToast("Debug console copied.", "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Could not copy debug console: ${msg}`, "error");
  }
}

/**
 * Sync the module flag and console visibility.
 * When enabling, shows the console; when disabling, hides and clears it.
 */
export function setDebugEnabled(
  enabled: boolean,
  options: { banner?: boolean } = {},
): void {
  const wasEnabled = debugEnabled;
  debugEnabled = enabled;

  if (!enabled) {
    setDebugConsoleVisible(false);
    clearDebugConsole();
    return;
  }

  setDebugConsoleVisible(true);
  if (options.banner !== false && (!wasEnabled || options.banner === true)) {
    debugLog("Debug mode enabled.");
  }
}

export function wireDebugConsoleControls(): void {
  if (consoleControlsWired) return;
  consoleControlsWired = true;

  const clearBtn = document.getElementById("debug-console-clear");
  const copyBtn = document.getElementById("debug-console-copy");
  const closeBtn = document.getElementById("debug-console-close");

  clearBtn?.addEventListener("click", () => clearDebugConsole());
  copyBtn?.addEventListener("click", () => {
    void copyDebugConsole();
  });
  closeBtn?.addEventListener("click", () => {
    // Hide only; disable remains via About logo toggle.
    setDebugConsoleVisible(false);
  });
}
