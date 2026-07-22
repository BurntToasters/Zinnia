import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  configureDefaultArchiverActionButton,
  openFinderServicesSettings,
  openFinderSyncSettings,
  renderOsIntegrationStatus,
  refreshOsIntegrationStatus,
  runDefaultArchiverAction,
  resetPreferredArchiverToSystem,
  setZinniaDefaultArchiver,
  wireOsIntegrationEvents,
} from "../os-integration";
import { message } from "@tauri-apps/plugin-dialog";

const messageMock = vi.mocked(message);

const invokeMock = vi.mocked(invoke);

describe("OS integration UI", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("");
  });

  it("renders packaged status and enables settings button", () => {
    renderOsIntegrationStatus({
      platform: "windows",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Open Default Apps",
      defaultArchiverHelp: "Windows requires selecting defaults in Settings.",
      archiveDefaults: [
        {
          key: "zip",
          label: "ZIP",
          extension: "zip",
          mimeType: "application/zip",
          currentHandler: "Zinnia",
          isDefault: true,
          canChange: false,
          status: "Default",
        },
      ],
    });

    expect(document.getElementById("os-platform-label")?.textContent).toBe(
      "Windows",
    );
    expect(document.getElementById("os-package-label")?.textContent).toBe(
      "Installed app",
    );
    expect(
      document
        .getElementById("os-file-assoc-status")
        ?.classList.contains("status-pill--ok"),
    ).toBe(true);
    expect(
      (
        document.getElementById(
          "open-os-integration-settings",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (document.getElementById("open-os-integration-settings") as HTMLElement)
        .textContent,
    ).toBe("Open Default Apps");
    expect(
      (
        document.getElementById(
          "reset-os-integration-defaults",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      document.getElementById("os-archive-default-list")?.textContent,
    ).toContain("ZIP");
  });

  it("shows packaged Linux integrations as manual verification", () => {
    renderOsIntegrationStatus({
      platform: "linux",
      packaged: true,
      fileAssociationsKnown: false,
      contextActionsKnown: false,
      defaultAppHelpAvailable: false,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "Zinnia can ask xdg-mime to set archive defaults.",
      archiveDefaults: [],
    });

    expect(document.getElementById("os-file-assoc-status")?.textContent).toBe(
      "Verify manually",
    );
    expect(document.getElementById("os-context-status")?.textContent).toBe(
      "Verify manually",
    );
    expect(
      (
        document.getElementById(
          "reset-os-integration-defaults",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("loads status from backend", async () => {
    invokeMock.mockResolvedValueOnce({
      platform: "linux",
      packaged: false,
      fileAssociationsKnown: false,
      contextActionsKnown: false,
      defaultAppHelpAvailable: false,
      defaultArchiverActionAvailable: false,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "Install a packaged build first.",
      archiveDefaults: [],
    });

    await refreshOsIntegrationStatus();

    expect(invokeMock).toHaveBeenCalledWith("get_os_integration_status");
    expect(document.getElementById("os-platform-label")?.textContent).toBe(
      "Linux",
    );
    expect(
      (
        document.getElementById(
          "open-os-integration-settings",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("sets Zinnia as the default archiver and refreshes status", async () => {
    invokeMock.mockResolvedValueOnce({
      platform: "linux",
      changed: true,
      message: "ok",
      results: [
        {
          key: "zip",
          label: "ZIP",
          extension: "zip",
          mimeType: "application/zip",
          currentHandler: "run.rosie.zinnia.desktop",
          isDefault: true,
          canChange: true,
          status: "Default",
        },
      ],
    });
    invokeMock.mockResolvedValueOnce({
      platform: "linux",
      packaged: true,
      fileAssociationsKnown: false,
      contextActionsKnown: false,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "Zinnia can ask xdg-mime to set archive defaults.",
      archiveDefaults: [],
    });

    await setZinniaDefaultArchiver();

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "set_zinnia_default_archiver",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_os_integration_status");
  });

  it("configures setup-style default action buttons from platform status", () => {
    const button = document.createElement("button");

    configureDefaultArchiverActionButton(button, {
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "macOS may ask you to confirm each archive type.",
      archiveDefaults: [],
    });

    expect(button.textContent).toBe("Make Zinnia Default");
    expect(button.disabled).toBe(false);
    expect(button.title).toContain("macOS");
  });

  it("runs the shared default archiver action for macOS", async () => {
    const button = document.createElement("button");
    renderOsIntegrationStatus({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "macOS may ask you to confirm each archive type.",
      archiveDefaults: [],
    });
    invokeMock.mockResolvedValueOnce({
      platform: "macos",
      changed: true,
      message: "ok",
      results: [
        {
          key: "tgz",
          label: "TGZ",
          extension: "tgz",
          mimeType: "application/x-compressed-tar",
          currentHandler: "run.rosie.zinnia",
          isDefault: true,
          canChange: true,
          status: "Default",
        },
      ],
    });
    invokeMock.mockResolvedValueOnce({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "macOS may ask you to confirm each archive type.",
      archiveDefaults: [],
    });

    await runDefaultArchiverAction(button);

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "set_zinnia_default_archiver",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_os_integration_status");
  });

  it("runs the shared default archiver action through Windows Settings", async () => {
    const button = document.createElement("button");
    renderOsIntegrationStatus({
      platform: "windows",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: false,
      defaultArchiverActionLabel: "Open Default Apps",
      defaultArchiverHelp: "Windows requires selecting defaults in Settings.",
      archiveDefaults: [],
    });

    await runDefaultArchiverAction(button);

    expect(invokeMock).toHaveBeenCalledWith("open_os_integration_settings");
  });

  it("resets preferred archiver to the system archiver and refreshes status", async () => {
    invokeMock.mockResolvedValueOnce({
      platform: "macos",
      changed: true,
      message: "ok",
      results: [
        {
          key: "zip",
          label: "ZIP",
          extension: "zip",
          mimeType: "application/zip",
          currentHandler: "com.apple.archiveutility",
          isDefault: false,
          canChange: true,
          status: "System",
        },
      ],
    });
    invokeMock.mockResolvedValueOnce({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "macOS may ask you to confirm each archive type.",
      archiveDefaults: [],
    });

    await resetPreferredArchiverToSystem();

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "reset_preferred_archiver_to_system",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_os_integration_status");
  });

  it("surfaces reset failures and unchanged system results", async () => {
    messageMock.mockClear();
    invokeMock.mockRejectedValueOnce(new Error("xdg-mime failed"));

    await resetPreferredArchiverToSystem();

    expect(messageMock).toHaveBeenCalledWith(
      "xdg-mime failed",
      expect.objectContaining({ title: "System archive app", kind: "warning" }),
    );

    invokeMock.mockResolvedValueOnce({
      platform: "linux",
      changed: false,
      message: "nothing changed",
      results: [
        {
          key: "zip",
          label: "ZIP",
          extension: "zip",
          mimeType: "application/zip",
          currentHandler: "other.desktop",
          isDefault: false,
          canChange: true,
          status: "Other",
        },
      ],
    });
    invokeMock.mockResolvedValueOnce({
      platform: "linux",
      packaged: true,
      fileAssociationsKnown: false,
      contextActionsKnown: false,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "help",
      archiveDefaults: [],
    });

    await resetPreferredArchiverToSystem();

    expect(messageMock).toHaveBeenCalledWith(
      "nothing changed",
      expect.objectContaining({ kind: "warning" }),
    );
  });

  it("wires refresh/default/reset buttons", async () => {
    invokeMock.mockResolvedValue({
      platform: "linux",
      packaged: true,
      fileAssociationsKnown: false,
      contextActionsKnown: false,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "help",
      archiveDefaults: [],
    });

    wireOsIntegrationEvents();

    (
      document.getElementById(
        "refresh-os-integration-status",
      ) as HTMLButtonElement
    ).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("get_os_integration_status");
  });

  it("shows Finder Sync status on macOS and enables via pluginkit", async () => {
    renderOsIntegrationStatus({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: false,
      defaultAppHelpAvailable: true,
      finderServicesAvailable: true,
      finderServicesKnown: true,
      finderServicesEnabled: false,
      finderSyncAvailable: true,
      finderSyncKnown: true,
      finderSyncEnabled: false,
      finderSyncHelp: "Finder Sync is installed but not enabled.",
      archiveDefaults: [],
    });

    const row = document.getElementById("os-finder-sync-row") as HTMLElement;
    expect(row.hidden).toBe(false);
    expect(document.getElementById("os-finder-sync-status")?.textContent).toBe(
      "Not enabled",
    );

    messageMock.mockClear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce("").mockResolvedValueOnce({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      finderServicesAvailable: true,
      finderServicesKnown: true,
      finderServicesEnabled: false,
      finderSyncAvailable: true,
      finderSyncKnown: true,
      finderSyncEnabled: true,
      finderSyncHelp: "Finder Sync is enabled.",
      archiveDefaults: [],
    });
    await openFinderSyncSettings();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "enable_finder_sync");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_os_integration_status");
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("Finder extension is enabled"),
      expect.objectContaining({ title: "Finder context menu enabled" }),
    );
    expect(document.getElementById("os-finder-sync-status")?.textContent).toBe(
      "Enabled",
    );
  });

  it("opens Login Items & Extensions when pluginkit does not enable Finder Sync", async () => {
    renderOsIntegrationStatus({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: false,
      defaultAppHelpAvailable: true,
      finderServicesAvailable: true,
      finderServicesKnown: true,
      finderServicesEnabled: false,
      finderSyncAvailable: true,
      finderSyncKnown: true,
      finderSyncEnabled: false,
      archiveDefaults: [],
    });

    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({
        platform: "macos",
        packaged: true,
        fileAssociationsKnown: true,
        contextActionsKnown: false,
        defaultAppHelpAvailable: true,
        finderServicesAvailable: true,
        finderServicesKnown: true,
        finderServicesEnabled: false,
        finderSyncAvailable: true,
        finderSyncKnown: true,
        finderSyncEnabled: false,
        archiveDefaults: [],
      })
      .mockResolvedValueOnce("");

    await openFinderSyncSettings();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "enable_finder_sync");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_os_integration_status");
    expect(invokeMock).toHaveBeenNthCalledWith(3, "open_finder_sync_settings");
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("System Settings will open"),
      expect.objectContaining({ title: "Enable Finder context menu" }),
    );
  });

  it("shows Finder Services status on macOS and opens System Settings", async () => {
    renderOsIntegrationStatus({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      defaultArchiverActionAvailable: true,
      defaultArchiverActionLabel: "Make Zinnia Default",
      defaultArchiverHelp: "macOS may ask you to confirm each archive type.",
      finderServicesAvailable: true,
      finderServicesKnown: true,
      finderServicesEnabled: false,
      finderServicesHelp:
        "Turn on Extract with Zinnia and Compress with Zinnia under Keyboard Shortcuts → Services.",
      archiveDefaults: [],
    });

    const row = document.getElementById(
      "os-finder-services-row",
    ) as HTMLElement;
    expect(row.hidden).toBe(false);
    expect(
      document.getElementById("os-finder-services-status")?.textContent,
    ).toBe("Not enabled");
    expect(
      (
        document.getElementById(
          "open-finder-services-settings",
        ) as HTMLButtonElement
      ).textContent,
    ).toBe("Enable…");

    renderOsIntegrationStatus({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      finderServicesAvailable: true,
      finderServicesKnown: false,
      finderServicesEnabled: false,
      finderServicesHelp: "Could not verify Services status.",
      archiveDefaults: [],
    });
    expect(
      document.getElementById("os-finder-services-status")?.textContent,
    ).toBe("Unknown");
    expect(
      document
        .getElementById("os-finder-services-status")
        ?.classList.contains("status-pill--unknown"),
    ).toBe(true);

    messageMock.mockClear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce("").mockResolvedValueOnce({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      finderServicesAvailable: true,
      finderServicesKnown: true,
      finderServicesEnabled: true,
      finderServicesHelp:
        "Extract with Zinnia and Compress with Zinnia are enabled in Finder's Services menu.",
      archiveDefaults: [],
    });
    await openFinderServicesSettings();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "enable_finder_services");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_os_integration_status");
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("now enabled for Finder"),
      expect.objectContaining({ title: "Finder Services enabled" }),
    );
    expect(
      document.getElementById("os-finder-services-status")?.textContent,
    ).toBe("Enabled");

    renderOsIntegrationStatus({
      platform: "macos",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      finderServicesAvailable: true,
      finderServicesKnown: true,
      finderServicesEnabled: true,
      archiveDefaults: [],
    });
    messageMock.mockClear();
    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce("");
    await openFinderServicesSettings();
    expect(invokeMock).toHaveBeenCalledWith("open_finder_services_settings");
    expect(messageMock).not.toHaveBeenCalled();

    renderOsIntegrationStatus({
      platform: "windows",
      packaged: true,
      fileAssociationsKnown: true,
      contextActionsKnown: true,
      defaultAppHelpAvailable: true,
      finderServicesAvailable: false,
      finderServicesEnabled: false,
      win11ModernMenuAvailable: true,
      win11ModernMenuKnown: true,
      win11ModernMenuRegistered: false,
      win11ModernMenuHelp: "Win11 modern menu is not registered.",
      archiveDefaults: [],
    });
    expect(row.hidden).toBe(true);
    const win11Row = document.getElementById(
      "os-win11-menu-row",
    ) as HTMLElement;
    expect(win11Row.hidden).toBe(false);
    expect(document.getElementById("os-win11-menu-status")?.textContent).toBe(
      "Not registered",
    );
  });
});
