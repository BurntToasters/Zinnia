import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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
