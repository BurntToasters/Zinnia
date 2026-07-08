import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  renderOsIntegrationStatus,
  refreshOsIntegrationStatus,
  resetPreferredArchiverToSystem,
  setZinniaDefaultArchiver,
} from "../os-integration";

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
});
