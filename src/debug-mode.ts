import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MAX_LOG_LINES, redactSensitiveText } from "./utils";
import { showToast } from "./toast";
import { sanitizeCommandArgsForPreview } from "./archive/command-sanitize";
import { state } from "./state";
import { persistSettingsImmediately } from "./ui/workspace";
import { setNativeWebviewContextMenuAllowed } from "./webview-context-menu";

let debugEnabled = false;
let consoleControlsWired = false;
let poppedOut = false;
let lineBuffer: string[] = [];
let bridgeReady: Promise<void> | null = null;
let seedInFlight = false;
let reseedRequested = false;
let pendingRelayLines: string[] = [];

function persistPopOutPreference(next: boolean): Promise<void> {
  if (state.currentSettings.debugConsolePoppedOut === next) {
    return Promise.resolve();
  }
  state.currentSettings = {
    ...state.currentSettings,
    debugConsolePoppedOut: next,
  };
  return persistSettingsImmediately(
    state.currentSettings,
    state.settingsExtras,
  ).catch(() => undefined);
}

function consolePanel(): HTMLElement | null {
  return document.getElementById("debug-console");
}

function consoleLogEl(): HTMLElement | null {
  return document.getElementById("debug-console-log");
}

function popOutBtn(): HTMLButtonElement | null {
  return document.getElementById(
    "debug-console-popout",
  ) as HTMLButtonElement | null;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function isDebugConsolePoppedOut(): boolean {
  return poppedOut;
}

export function setDebugConsoleVisible(visible: boolean): void {
  const panel = consolePanel();
  if (!panel) return;
  // While popped out, keep the docked panel hidden.
  panel.hidden = poppedOut ? true : !visible;
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

function pushBufferedLine(line: string): void {
  lineBuffer.push(line);
  if (lineBuffer.length > MAX_LOG_LINES) {
    lineBuffer = lineBuffer.slice(lineBuffer.length - MAX_LOG_LINES);
  }
}

function renderDockedFromBuffer(): void {
  const logEl = consoleLogEl();
  if (!logEl) return;
  logEl.textContent = lineBuffer.length ? `${lineBuffer.join("\n")}\n` : "";
  logEl.scrollTop = logEl.scrollHeight;
}

function flushPendingRelays(): void {
  if (pendingRelayLines.length === 0) return;
  const queued = pendingRelayLines;
  pendingRelayLines = [];
  for (const line of queued) {
    void invoke("relay_debug_console_line", { line }).catch(() => undefined);
  }
}

function relayLine(line: string): void {
  if (!poppedOut) return;
  if (seedInFlight) {
    pendingRelayLines.push(line);
    return;
  }
  void invoke("relay_debug_console_line", { line }).catch(() => {
    // Window may have closed between checks.
  });
}

function updatePopOutButtonLabel(): void {
  const btn = popOutBtn();
  if (!btn) return;
  btn.textContent = poppedOut ? "Focus" : "Pop out";
  btn.setAttribute(
    "aria-label",
    poppedOut ? "Focus debug console window" : "Pop out debug console",
  );
}

async function seedPoppedOutConsole(): Promise<void> {
  if (!poppedOut) return;
  if (seedInFlight) {
    // ready often arrives while the optimistic post-open seed is in flight;
    // that first emit can be lost if listeners are not attached yet.
    reseedRequested = true;
    return;
  }
  seedInFlight = true;
  reseedRequested = false;
  // Keep any lines queued while a prior open was settling; they are flushed
  // after this seed replaces the pop-out buffer.
  try {
    await invoke("relay_debug_console_seed", { lines: [...lineBuffer] });
  } catch {
    // Window may have closed before seed completed.
  } finally {
    seedInFlight = false;
    if (!poppedOut) {
      pendingRelayLines = [];
      reseedRequested = false;
      return;
    }
    if (reseedRequested) {
      void seedPoppedOutConsole();
      return;
    }
    flushPendingRelays();
  }
}

function ensurePopOutBridge(): Promise<void> {
  bridgeReady ??= (async () => {
    await listen("zinnia-debug-console-ready", () => {
      if (!debugEnabled) return;
      poppedOut = true;
      setDebugConsoleVisible(false);
      updatePopOutButtonLabel();
      // Always seed on ready: listeners are attached in the pop-out page
      // immediately before this event, so history is not lost on first paint
      // or after a webview reload.
      void seedPoppedOutConsole();
    });

    await listen("zinnia-debug-console-closed", () => {
      if (!poppedOut) return;
      poppedOut = false;
      seedInFlight = false;
      reseedRequested = false;
      pendingRelayLines = [];
      // Do not clear debugConsolePoppedOut here: Destroyed also fires on app
      // quit, and wiping the preference would prevent restore on next launch.
      updatePopOutButtonLabel();
      if (debugEnabled) {
        setDebugConsoleVisible(true);
        renderDockedFromBuffer();
      }
    });

    await listen("zinnia-debug-console-dock-request", () => {
      if (!debugEnabled) return;
      void persistPopOutPreference(false);
    });

    await listen("zinnia-debug-console-clear-request", () => {
      if (!debugEnabled) return;
      clearDebugConsole();
    });
  })();
  return bridgeReady;
}

/** Append a line only when debug mode is on. Prefer thunks for expensive work. */
export function debugLog(message: string | (() => string)): void {
  if (!debugEnabled) return;

  const raw = typeof message === "function" ? message() : message;
  const sanitized = redactSensitiveText(raw);
  const stamp = new Date().toLocaleTimeString();
  const line = `[${stamp}] ${sanitized}`;
  pushBufferedLine(line);

  if (poppedOut) {
    relayLine(line);
    return;
  }

  const logEl = consoleLogEl();
  if (!logEl) return;

  // Close only hides the panel; new output re-opens it so dumps aren't lost.
  const panel = consolePanel();
  if (panel?.hidden) panel.hidden = false;

  logEl.textContent += `${line}\n`;
  trimDebugLog(logEl);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Log a redacted 7z command line when debug mode is on. */
export function debugLogCommand(args: string[]): void {
  if (!debugEnabled) return;
  debugLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
}

export function clearDebugConsole(): void {
  lineBuffer = [];
  pendingRelayLines = [];
  const logEl = consoleLogEl();
  if (logEl) logEl.textContent = "";
  if (poppedOut) {
    void invoke("relay_debug_console_clear").catch(() => undefined);
  }
}

export async function copyDebugConsole(): Promise<void> {
  const text = lineBuffer.length
    ? `${lineBuffer.join("\n")}\n`
    : (consoleLogEl()?.textContent ?? "");
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

export async function popOutDebugConsole(): Promise<void> {
  if (!debugEnabled) return;
  await ensurePopOutBridge();
  try {
    const alreadyOpen = await invoke<boolean>("debug_console_window_open");
    await invoke("open_debug_console_window");
    // Optimistic: hide docked panel; ready event confirms + seeds once the
    // pop-out page has attached its listeners. Re-seed immediately only when
    // focusing an already-open window (no new ready event).
    poppedOut = true;
    await persistPopOutPreference(true);
    setDebugConsoleVisible(false);
    updatePopOutButtonLabel();
    if (alreadyOpen) await seedPoppedOutConsole();
  } catch (err) {
    poppedOut = false;
    seedInFlight = false;
    reseedRequested = false;
    pendingRelayLines = [];
    await persistPopOutPreference(false);
    updatePopOutButtonLabel();
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Could not pop out debug console: ${msg}`, "error");
  }
}

/** Re-open the popped-out console after settings load when the preference is set. */
export async function restoreDebugConsolePopOutIfNeeded(): Promise<void> {
  if (!debugEnabled || !state.currentSettings.debugConsolePoppedOut) return;
  if (poppedOut) return;
  await popOutDebugConsole();
}

export async function focusOrPopOutDebugConsole(): Promise<void> {
  if (!debugEnabled) return;
  if (poppedOut) {
    try {
      await invoke("open_debug_console_window");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Could not focus debug console: ${msg}`, "error");
    }
    return;
  }
  await popOutDebugConsole();
}

async function closePoppedOutWindow(
  options: { persist?: boolean } = {},
): Promise<void> {
  if (!poppedOut) return;
  poppedOut = false;
  seedInFlight = false;
  reseedRequested = false;
  pendingRelayLines = [];
  if (options.persist !== false) await persistPopOutPreference(false);
  updatePopOutButtonLabel();
  try {
    await invoke("close_debug_console_window");
  } catch {
    // Already closed.
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
  setNativeWebviewContextMenuAllowed(enabled);

  if (!enabled) {
    // Keep the pop-out preference so re-enabling debug later can restore it;
    // only Dock / close clears the preference.
    void closePoppedOutWindow({ persist: false });
    setDebugConsoleVisible(false);
    clearDebugConsole();
    return;
  }

  if (!poppedOut) setDebugConsoleVisible(true);
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
  const popBtn = popOutBtn();

  clearBtn?.addEventListener("click", () => clearDebugConsole());
  copyBtn?.addEventListener("click", () => {
    void copyDebugConsole();
  });
  closeBtn?.addEventListener("click", () => {
    // Hide only; disable remains via About logo toggle.
    if (poppedOut) {
      void closePoppedOutWindow().then(() => {
        setDebugConsoleVisible(false);
      });
      return;
    }
    setDebugConsoleVisible(false);
  });
  popBtn?.addEventListener("click", () => {
    void focusOrPopOutDebugConsole();
  });

  void ensurePopOutBridge();
}
