import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { $ } from "./utils";

export interface OsIntegrationStatus {
  platform: string;
  packaged: boolean;
  fileAssociationsKnown: boolean;
  contextActionsKnown: boolean;
  defaultAppHelpAvailable: boolean;
  defaultArchiverActionAvailable?: boolean;
  defaultArchiverActionLabel?: string;
  defaultArchiverHelp?: string;
  /** macOS only: Finder Services (Extract/Compress) row is shown when true. */
  finderServicesAvailable?: boolean;
  /** false when pbs/plutil probe failed → show Unknown. */
  finderServicesKnown?: boolean;
  finderServicesEnabled?: boolean;
  finderServicesHelp?: string;
  /** Windows: sparse MSIX identity for Win11 menu (not a full AppX app install). */
  win11ModernMenuAvailable?: boolean;
  win11ModernMenuKnown?: boolean;
  win11ModernMenuRegistered?: boolean;
  win11ModernMenuHelp?: string;
  archiveDefaults?: ArchiveDefaultStatus[];
}

export interface ArchiveDefaultStatus {
  key: string;
  label: string;
  extension: string;
  mimeType: string;
  currentHandler: string | null;
  isDefault: boolean;
  canChange: boolean;
  status: string;
}

interface DefaultArchiverResult {
  platform: string;
  changed: boolean;
  message: string;
  results: ArchiveDefaultStatus[];
}

let latestStatus: OsIntegrationStatus | null = null;

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
  el.classList.remove("status-pill--unknown");
}

function setTriStatePill(
  id: string,
  known: boolean,
  ok: boolean,
  okLabel: string,
  offLabel: string,
  unknownLabel = "Unknown",
): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove(
    "status-pill--ok",
    "status-pill--warn",
    "status-pill--unknown",
  );
  if (!known) {
    el.textContent = unknownLabel;
    el.classList.add("status-pill--unknown");
    return;
  }
  if (ok) {
    el.textContent = okLabel;
    el.classList.add("status-pill--ok");
    return;
  }
  el.textContent = offLabel;
  el.classList.add("status-pill--warn");
}

function setFinderServicesBadge(
  known: boolean,
  enabled: boolean,
  packaged: boolean,
): void {
  setTriStatePill(
    "os-finder-services-status",
    known,
    enabled,
    "Enabled",
    packaged ? "Off" : "Action needed",
  );
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function defaultActionLabel(status: OsIntegrationStatus): string {
  if (status.defaultArchiverActionLabel)
    return status.defaultArchiverActionLabel;
  return status.platform === "windows"
    ? "Open Default Apps"
    : "Make Zinnia Default";
}

function defaultArchiverActionAvailable(status: OsIntegrationStatus): boolean {
  return (
    (status.defaultArchiverActionAvailable ?? false) ||
    status.defaultAppHelpAvailable
  );
}

function systemResetAvailable(status: OsIntegrationStatus): boolean {
  return status.platform === "windows" && status.defaultAppHelpAvailable;
}

function systemResetHelp(status: OsIntegrationStatus): string {
  if (!status.packaged && status.platform !== "windows") {
    return "Install a packaged build before changing archive defaults.";
  }
  if (status.platform === "macos") {
    return "macOS has no universal system archiver for every archive type. Use Finder's Get Info / Open With controls.";
  }
  if (status.platform === "windows") {
    return "Open Windows Default Apps and choose the system archive app.";
  }
  if (status.platform === "linux") {
    return "Linux does not expose one universal system archiver.";
  }
  return "System archiver reset is not available for this platform.";
}

function renderArchiveDefaults(defaults: ArchiveDefaultStatus[] = []): void {
  const list = document.getElementById("os-archive-default-list");
  if (!list) return;

  list.innerHTML = "";
  for (const item of defaults) {
    const row = document.createElement("div");
    row.className = "os-default-row";

    const name = document.createElement("span");
    name.className = "os-default-row__name";
    name.textContent = item.label;

    const handler = document.createElement("span");
    handler.className = "os-default-row__handler";
    handler.textContent = item.currentHandler
      ? `Default: ${item.currentHandler}`
      : item.status;
    handler.title = handler.textContent;

    const badge = document.createElement("span");
    badge.className = `status-pill ${
      item.isDefault ? "status-pill--ok" : "status-pill--warn"
    }`;
    badge.textContent = item.isDefault ? "Zinnia" : item.status;

    row.append(name, handler, badge);
    list.appendChild(row);
  }
}

export function renderOsIntegrationStatus(status: OsIntegrationStatus): void {
  latestStatus = status;
  setText("os-platform-label", platformLabel(status.platform));
  setText(
    "os-package-label",
    status.packaged ? "Installed app" : "Development build",
  );
  setBadge(
    "os-file-assoc-status",
    status.fileAssociationsKnown,
    "Ready",
    status.platform === "linux" && status.packaged
      ? "Verify manually"
      : "Action needed",
  );
  {
    let contextReady = "Ready";
    let contextAction = "Action needed";
    if (status.platform === "linux" && status.packaged) {
      contextAction = "Verify manually";
    } else if (
      status.platform === "macos" &&
      status.packaged &&
      status.finderServicesAvailable
    ) {
      if (status.finderServicesKnown === false) {
        contextAction = "Unknown";
      } else if (!status.finderServicesEnabled) {
        contextAction = "Off";
      }
    }
    setBadge(
      "os-context-status",
      status.contextActionsKnown,
      contextReady,
      contextAction,
    );
  }

  const finderRow = document.getElementById(
    "os-finder-services-row",
  ) as HTMLElement | null;
  const finderAvailable = status.finderServicesAvailable === true;
  if (finderRow) {
    finderRow.hidden = !finderAvailable;
  }
  if (finderAvailable) {
    const finderKnown = status.finderServicesKnown !== false;
    const finderEnabled = status.finderServicesEnabled === true;
    setFinderServicesBadge(finderKnown, finderEnabled, status.packaged);
    setText(
      "os-finder-services-help",
      status.finderServicesHelp ??
        "Extract / Compress with Zinnia in Finder's Services menu.",
    );
    const finderBtn = document.getElementById(
      "open-finder-services-settings",
    ) as HTMLButtonElement | null;
    if (finderBtn) {
      finderBtn.textContent =
        finderKnown && finderEnabled ? "Open Services…" : "Enable…";
      finderBtn.disabled = false;
      finderBtn.title =
        finderKnown && finderEnabled
          ? "Open Keyboard Shortcuts → Services in System Settings"
          : "Open System Settings so you can turn on Finder Services";
    }
  }

  const win11Row = document.getElementById(
    "os-win11-menu-row",
  ) as HTMLElement | null;
  const win11Available = status.win11ModernMenuAvailable === true;
  if (win11Row) {
    win11Row.hidden = !win11Available;
  }
  if (win11Available) {
    const win11Known = status.win11ModernMenuKnown !== false;
    const win11Registered = status.win11ModernMenuRegistered === true;
    setTriStatePill(
      "os-win11-menu-status",
      win11Known,
      win11Registered,
      "Registered",
      status.packaged ? "Not registered" : "Action needed",
    );
    setText(
      "os-win11-menu-help",
      status.win11ModernMenuHelp ??
        "Sparse identity package for the primary right-click menu (Zinnia stays a normal NSIS install).",
    );
  }

  const help = document.getElementById("os-integration-help");
  if (help) {
    if (!status.packaged) {
      help.textContent =
        "Install a packaged build to register archive file types and OS menu actions.";
    } else if (status.platform === "macos") {
      help.textContent =
        status.defaultArchiverHelp ??
        "Use Finder's Open With or Get Info for defaults. Packaged builds also add Services: Extract / Compress with Zinnia.";
    } else if (status.platform === "windows") {
      help.textContent =
        status.win11ModernMenuHelp ??
        status.defaultArchiverHelp ??
        "Zinnia installs as a normal NSIS app. Classic Explorer verbs always register; the Win11 modern menu uses a separate sparse identity package (not a Store/AppX app install).";
    } else if (status.platform === "linux") {
      help.textContent =
        status.defaultArchiverHelp ??
        "Linux package installs can vary by desktop environment. Verify the Zinnia desktop entry registered archive MIME types after install.";
    } else {
      help.textContent =
        "Use your OS default-app settings to map archive files to Zinnia.";
    }
  }

  const openBtn = document.getElementById(
    "open-os-integration-settings",
  ) as HTMLButtonElement | null;
  if (openBtn) {
    configureDefaultArchiverActionButton(openBtn, status);
  }

  const resetBtn = document.getElementById(
    "reset-os-integration-defaults",
  ) as HTMLButtonElement | null;
  if (resetBtn) {
    resetBtn.textContent = "Reset Preferred Archiver to System Archiver";
    resetBtn.disabled = !systemResetAvailable(status);
    resetBtn.title = systemResetHelp(status);
  }
  renderArchiveDefaults(status.archiveDefaults);
}

async function getOsIntegrationStatus(): Promise<OsIntegrationStatus> {
  const status = await invoke<OsIntegrationStatus>("get_os_integration_status");
  latestStatus = status;
  return status;
}

export function configureDefaultArchiverActionButton(
  button: HTMLButtonElement,
  status: OsIntegrationStatus,
): void {
  button.textContent = defaultActionLabel(status);
  button.disabled = !defaultArchiverActionAvailable(status);
  button.title = status.defaultArchiverHelp ?? "";
}

export async function refreshDefaultArchiverActionButton(
  button: HTMLButtonElement,
): Promise<void> {
  try {
    const status = await getOsIntegrationStatus();
    configureDefaultArchiverActionButton(button, status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to refresh default archiver action: ${msg}`);
  }
}

export async function refreshOsIntegrationStatus(): Promise<void> {
  try {
    const status = await getOsIntegrationStatus();
    renderOsIntegrationStatus(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to refresh OS integration status: ${msg}`);
  }
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

export async function openFinderServicesSettings(): Promise<void> {
  try {
    await invoke("open_finder_services_settings");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, {
      title: "Finder Services",
      kind: "info",
    });
  }
}

export async function setZinniaDefaultArchiver(
  button = document.getElementById(
    "open-os-integration-settings",
  ) as HTMLButtonElement | null,
): Promise<void> {
  const previousLabel = button?.textContent ?? "";
  if (button) {
    button.disabled = true;
    button.textContent = "Working…";
  }

  try {
    const result = await invoke<DefaultArchiverResult>(
      "set_zinnia_default_archiver",
    );
    renderArchiveDefaults(result.results);
    await refreshOsIntegrationStatus();
    if (result.results.some((entry) => !entry.isDefault)) {
      await message(result.message, {
        title: "Default archive app",
        kind: result.changed ? "info" : "warning",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, {
      title: "Default archive app",
      kind: "warning",
    });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = latestStatus
        ? defaultActionLabel(latestStatus)
        : previousLabel;
    }
  }
}

export async function runDefaultArchiverAction(
  button = document.getElementById(
    "open-os-integration-settings",
  ) as HTMLButtonElement | null,
): Promise<void> {
  let status = latestStatus;
  if (!status) {
    try {
      status = await getOsIntegrationStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message(msg, {
        title: "Default archive app",
        kind: "warning",
      });
      return;
    }
  }

  if (status.platform === "windows") {
    await openOsIntegrationSettings();
    return;
  }

  await setZinniaDefaultArchiver(button);
}

export async function resetPreferredArchiverToSystem(): Promise<void> {
  const button = document.getElementById(
    "reset-os-integration-defaults",
  ) as HTMLButtonElement | null;
  const previousLabel = button?.textContent ?? "";
  const wasDisabled = button?.disabled ?? false;
  if (button) {
    button.disabled = true;
    button.textContent = "Working…";
  }

  try {
    const result = await invoke<DefaultArchiverResult>(
      "reset_preferred_archiver_to_system",
    );
    await refreshOsIntegrationStatus();
    const needsAttention =
      !result.changed ||
      result.results.some((entry) => entry.status !== "System");
    if (needsAttention) {
      await message(result.message, {
        title: "System archive app",
        kind: result.changed ? "info" : "warning",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message(msg, {
      title: "System archive app",
      kind: "warning",
    });
  } finally {
    if (button) {
      button.textContent = previousLabel;
      button.disabled = latestStatus
        ? !systemResetAvailable(latestStatus)
        : wasDisabled;
      button.title = latestStatus
        ? systemResetHelp(latestStatus)
        : button.title;
    }
  }
}

export function wireOsIntegrationEvents(): void {
  $("refresh-os-integration-status").addEventListener("click", () => {
    void refreshOsIntegrationStatus();
  });
  $("open-os-integration-settings").addEventListener("click", () => {
    void runDefaultArchiverAction();
  });
  $("reset-os-integration-defaults").addEventListener("click", () => {
    void resetPreferredArchiverToSystem();
  });
  const finderBtn = document.getElementById("open-finder-services-settings");
  if (finderBtn) {
    finderBtn.addEventListener("click", () => {
      void openFinderServicesSettings();
    });
  }
}
