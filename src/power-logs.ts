import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { log } from "./ui";
import { showToast } from "./toast";

export async function exportLocalLogs(): Promise<void> {
  try {
    const exported = await invoke<boolean>("export_logs");
    if (!exported) return;
    log("Logs exported successfully.");
    showToast("Logs exported successfully.", "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to export logs: ${msg}`, "error");
    showToast(`Failed to export logs. ${msg}`, "error", 0);
  }
}

export async function openLogsFolder(): Promise<void> {
  try {
    await invoke("open_log_dir");
    log("Opened local logs folder.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to open logs folder: ${msg}`, "error");
    showToast(`Failed to open logs folder. ${msg}`, "error", 0);
  }
}

export async function clearLocalLogs(): Promise<void> {
  const confirmed = await ask(
    "Clear local diagnostics logs? This cannot be undone.",
    {
      title: "Clear logs",
      kind: "warning",
      okLabel: "Clear logs",
      cancelLabel: "Cancel",
    },
  );
  if (!confirmed) return;

  try {
    await invoke("clear_logs");
    log("Local diagnostics logs cleared.");
    showToast("Local diagnostics logs were cleared.", "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to clear logs: ${msg}`, "error");
    showToast(`Failed to clear logs. ${msg}`, "error", 0);
  }
}
