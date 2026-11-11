import { invoke } from "@tauri-apps/api/core";

/**
 * Restarts Zinnia through Rust. On macOS the new instance opens only after this
 * process exits, which keeps a pinned Dock tile on the relaunched app.
 */
export function relaunchApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}
