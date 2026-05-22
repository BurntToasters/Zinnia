import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { $ } from "./utils";

export interface OsIntegrationStatus {
  platform: string;
  packaged: boolean;
  fileAssociationsKnown: boolean;
  contextActionsKnown: boolean;
  defaultAppHelpAvailable: boolean;
}

function platformLabel(platform: string): string {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  if (platform === "linux") return "Linux";
  return platform || "Unknown";
}

function setBadge(
  id: string,
  ok: boolean,
  ready = "Ready",
  action = "Action needed",
): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = ok ? ready : action;
  el.classList.toggle("status-pill--ok", ok);
  el.classList.toggle("status-pill--warn", !ok);
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

export function renderOsIntegrationStatus(status: OsIntegrationStatus): void {
  setText("os-platform-label", platformLabel(status.platform));
  setText(
    "os-package-label",
    status.packaged ? "Installed app" : "Development build",
  );
  setBadge("os-file-assoc-status", status.fileAssociationsKnown);
  setBadge("os-context-status", status.contextActionsKnown);

  const help = document.getElementById("os-integration-help");
  if (help) {
    if (!status.packaged) {
      help.textContent =
        "Install a packaged build to register archive file types and OS menu actions.";
    } else if (status.platform === "macos") {
      help.textContent =
        "Use Finder's Open With or Get Info panel to make Zinnia the default archive app.";
    } else if (status.platform === "windows") {
      help.textContent =
        "Use File Explorer or Default Apps to map archive extensions to Zinnia.";
    } else if (status.platform === "linux") {
      help.textContent =
        "Use Files or your desktop's default-app settings to map archive MIME types to Zinnia.";
    } else {
      help.textContent =
        "Use your OS default-app settings to map archive files to Zinnia.";
    }
  }

  const openBtn = document.getElementById(
    "open-os-integration-settings",
  ) as HTMLButtonElement | null;
  if (openBtn) openBtn.disabled = !status.defaultAppHelpAvailable;
}

export async function refreshOsIntegrationStatus(): Promise<void> {
  const status = await invoke<OsIntegrationStatus>("get_os_integration_status");
  renderOsIntegrationStatus(status);
}

export async function openOsIntegrationSettings(): Promise<void> {
  try {
    await invoke("open_os_integration_settings");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, {
      title: "Default app settings",
      kind: "info",
    });
  }
}

export function wireOsIntegrationEvents(): void {
  $("refresh-os-integration-status").addEventListener("click", () => {
    void refreshOsIntegrationStatus();
  });
  $("open-os-integration-settings").addEventListener("click", () => {
    void openOsIntegrationSettings();
  });
}
