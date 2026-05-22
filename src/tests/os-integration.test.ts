import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  renderOsIntegrationStatus,
  refreshOsIntegrationStatus,
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
  });

  it("loads status from backend", async () => {
    invokeMock.mockResolvedValueOnce({
      platform: "linux",
      packaged: false,
      fileAssociationsKnown: false,
      contextActionsKnown: false,
      defaultAppHelpAvailable: false,
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
});
