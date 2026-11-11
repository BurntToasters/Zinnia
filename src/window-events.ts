import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import { confirmWithE2eQueue } from "./e2e-dialog";
import { SETTING_DEFAULTS } from "./settings-model";
import { showToast } from "./toast";

/**
 * Emitted by the backend before it cancels a run that this window owns. The
 * payload is "close" or "quit". Keep in sync with main.rs.
 */
export const OPERATION_STOP_REQUEST_EVENT = "operation-stop-request";

export const OPERATION_CONFIRM_TITLE = "Operation in progress";

export type OperationStopRequest = "close" | "quit";

const STOP_POLL_MS = 100;
const STOP_POLL_ATTEMPTS = 150;

let stopPromptOpen = false;
let detectedCpuCount: number | null = null;

function currentWindowLabel(): string | null {
  try {
    return getCurrentWebviewWindow().label || null;
  } catch {
    return null;
  }
}

export function listenToOwnWindow<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  const label = currentWindowLabel();
  // Production WebviewWindows always resolve a label, so progress stays
  // window-scoped. The global fallback only executes outside Tauri (vitest),
  // where no cross-window leak is possible.
  if (!label) return listen<T>(event, handler);
  return listen<T>(event, handler, {
    target: { kind: "WebviewWindow", label },
  });
}

/** Records the CPU count read at startup. Defaults never change at runtime. */
export function setDetectedCpuCount(count: number): void {
  if (Number.isInteger(count) && count >= 1) detectedCpuCount = count;
}

/**
 * Thread default for a compression form: the detected CPU count, or the static
 * default when detection failed.
 */
export function getDefaultThreads(): number {
  return detectedCpuCount ?? SETTING_DEFAULTS.threads;
}

/** Resolves once the archive slot is idle, or false when it stays busy. */
async function stopOwnedOperation(): Promise<boolean> {
  await invoke<boolean>("cancel_7z");
  for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS; attempt += 1) {
    if (!(await invoke<boolean>("is_7z_running"))) return true;
    await new Promise((resolve) => window.setTimeout(resolve, STOP_POLL_MS));
  }
  return false;
}

/**
 * Asks before a running operation is cancelled. Cancelling keeps the existing
 * safe teardown in the backend; declining leaves the run untouched.
 * `beforeStop` runs only after the user accepts.
 */
export async function confirmStopOperation(
  request: OperationStopRequest,
  beforeStop?: () => void,
): Promise<void> {
  if (stopPromptOpen) return;
  stopPromptOpen = true;
  try {
    const quitting = request === "quit";
    const proceed = await confirmWithE2eQueue(
      () =>
        ask(
          quitting
            ? "An operation is running. Cancel it and quit?"
            : "An operation is running. Cancel it and close?",
          {
            title: OPERATION_CONFIRM_TITLE,
            kind: "warning",
            okLabel: quitting ? "Cancel and quit" : "Cancel and close",
            cancelLabel: "Keep running",
          },
        ),
      OPERATION_CONFIRM_TITLE,
    );
    if (!proceed) return;
    beforeStop?.();
    let stopped = false;
    try {
      stopped = await stopOwnedOperation();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Could not stop the running operation: ${msg}`);
    }
    if (!stopped) {
      showToast(
        "Could not stop the operation. It is still running.",
        "error",
        5000,
      );
      return;
    }
    if (quitting) {
      await exit(0);
    } else {
      await getCurrentWebviewWindow().close();
    }
  } finally {
    stopPromptOpen = false;
  }
}

/** Listens for backend stop requests addressed to this window. */
export function listenForStopRequests(
  beforeStop?: () => void,
): Promise<UnlistenFn> {
  return listenToOwnWindow<string>(OPERATION_STOP_REQUEST_EVENT, (event) => {
    const request: OperationStopRequest =
      event.payload === "quit" ? "quit" : "close";
    void confirmStopOperation(request, beforeStop);
  });
}
