import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const { logMock, devLogMock, setStatusMock, mockState } = vi.hoisted(() => ({
  logMock: vi.fn(),
  devLogMock: vi.fn(),
  setStatusMock: vi.fn(),
  mockState: {
    currentSettings: {
      updateChannel: "stable",
    },
  },
}));

vi.mock("../ui", () => ({
  log: (...args: unknown[]) => logMock(...args),
  devLog: (...args: unknown[]) => devLogMock(...args),
  setStatus: (...args: unknown[]) => setStatusMock(...args),
  triggerIconRefresh: vi.fn(),
  registerIconRefreshHook: vi.fn(),
}));

vi.mock("../state", () => ({
  state: mockState,
}));

import {
  autoCheckUpdates,
  checkUpdates,
  notify,
  discardPendingUpdate,
} from "../updater";

function defaultInvoke(command: string): Promise<unknown> {
  if (command === "is_7z_running") return Promise.resolve(false);
  if (command === "is_flatpak") return Promise.resolve(false);
  if (command === "relaunch_app") return Promise.resolve(undefined);
  if (command === "get_beta_updater_target") {
    return Promise.resolve("windows-beta-x86_64-nsis");
  }
  return Promise.resolve("windows");
}

const askMock = vi.mocked(ask);
const getVersionMock = vi.mocked(getVersion);
const invokeMock = vi.mocked(invoke);
const checkMock = vi.mocked(check);
function relaunchCalls(): number {
  return invokeMock.mock.calls.filter((call) => call[0] === "relaunch_app")
    .length;
}
const isPermissionGrantedMock = vi.mocked(isPermissionGranted);
const requestPermissionMock = vi.mocked(requestPermission);
const sendNotificationMock = vi.mocked(sendNotification);

function fakeUpdate(version: string) {
  return {
    version,
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function asCheckResult(update: ReturnType<typeof fakeUpdate> | null) {
  return update as unknown as Awaited<ReturnType<typeof check>>;
}

function indicatorButton(): HTMLElement {
  const element = document.getElementById("update-ready-indicator");
  if (!element) throw new Error("update-ready-indicator is missing");
  return element;
}

function toastText(): string {
  return document.getElementById("toast-region")?.textContent ?? "";
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  discardPendingUpdate();
  mockState.currentSettings.updateChannel = "stable";

  askMock.mockReset();
  getVersionMock.mockReset();
  invokeMock.mockReset();
  checkMock.mockReset();
  isPermissionGrantedMock.mockReset();
  requestPermissionMock.mockReset();
  sendNotificationMock.mockReset();
  logMock.mockReset();
  devLogMock.mockReset();
  setStatusMock.mockReset();

  askMock.mockResolvedValue(false);
  document.getElementById("toast-region")?.remove();
  getVersionMock.mockResolvedValue("0.4.1");
  invokeMock.mockImplementation((command) => defaultInvoke(String(command)));
  checkMock.mockResolvedValue(null);
  isPermissionGrantedMock.mockResolvedValue(true);
  requestPermissionMock.mockResolvedValue("denied");
});

describe("notify", () => {
  it("sends notification immediately when permission is already granted", async () => {
    isPermissionGrantedMock.mockResolvedValue(true);

    await notify("Title", "Body");

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Title",
      body: "Body",
    });
  });

  it("requests permission before sending when needed", async () => {
    isPermissionGrantedMock.mockResolvedValue(false);
    requestPermissionMock.mockResolvedValue("granted");

    await notify("Title", "Body");

    expect(requestPermissionMock).toHaveBeenCalledOnce();
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Title",
      body: "Body",
    });
  });

  it("does not send notification when permission stays denied", async () => {
    isPermissionGrantedMock.mockResolvedValue(false);
    requestPermissionMock.mockResolvedValue("denied");

    await notify("Title", "Body");

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});

describe("checkUpdates", () => {
  it.each(["0.4.1", "0.3.0"])(
    "refuses to download version %s at or below the installed version",
    async (version) => {
      const download = vi.fn();
      const close = vi.fn().mockResolvedValue(undefined);
      checkMock.mockResolvedValue({
        version,
        download,
        close,
      } as unknown as Awaited<ReturnType<typeof check>>);
      await checkUpdates();
      expect(download).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(askMock).not.toHaveBeenCalled();
      expect(setStatusMock).toHaveBeenLastCalledWith("Idle");
    },
  );

  it.each(["busy", "unavailable", "reservation race"])(
    "keeps the downloaded update ready when archive status is %s",
    async (scenario) => {
      const install = vi.fn();
      checkMock.mockResolvedValue({
        version: "0.5.0",
        download: vi.fn().mockResolvedValue(undefined),
        install,
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof check>>);
      askMock.mockResolvedValue(true);
      invokeMock.mockImplementation((command, payload) => {
        if (command === "is_7z_running") {
          if (scenario === "unavailable")
            return Promise.reject(new Error("status unavailable"));
          const mode = (payload as { mode?: string } | undefined)?.mode;
          return Promise.resolve(
            scenario === "busy" || mode === "reserve_update",
          );
        }
        return defaultInvoke(String(command));
      });
      await checkUpdates();
      expect(install).not.toHaveBeenCalled();
      expect(relaunchCalls()).toBe(0);
      expect(setStatusMock).toHaveBeenLastCalledWith("Update ready");
      expect(document.getElementById("update-ready-indicator")?.hidden).toBe(
        false,
      );
      expect(askMock).toHaveBeenCalledTimes(
        scenario === "reservation race" ? 1 : 0,
      );
    },
  );

  it.each([false, true])(
    "installs a background download from its indicator and reports failure=%s",
    async (fails) => {
      const install = fails
        ? vi.fn().mockRejectedValue(new Error("installer unavailable"))
        : vi.fn().mockResolvedValue(undefined);
      const download = vi.fn().mockResolvedValue(undefined);
      checkMock.mockResolvedValue({
        version: "0.5.0",
        download,
        install,
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof check>>);
      await autoCheckUpdates();
      expect(askMock).not.toHaveBeenCalled();
      const indicator = document.getElementById("update-ready-indicator")!;
      expect(indicator.hidden).toBe(false);
      expect(indicator.textContent).toContain("0.5.0");
      askMock.mockResolvedValue(true);
      indicator.click();
      await vi.waitFor(() => {
        if (fails) {
          expect(
            document.getElementById("toast-region")?.textContent,
          ).toContain("Failed to install update. installer unavailable");
        } else {
          expect(relaunchCalls()).toBe(1);
        }
      });
      expect(install).toHaveBeenCalledOnce();
      expect(download).toHaveBeenCalledOnce();
      expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
        mode: "release_update",
      });
      expect(relaunchCalls()).toBe(fails ? 0 : 1);
    },
  );

  it("shows no-updates message on stable channel", async () => {
    mockState.currentSettings.updateChannel = "stable";
    checkMock.mockResolvedValue(null);

    await checkUpdates();

    expect(checkMock).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(devLogMock).toHaveBeenCalledWith("No updates available.");
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "You are running the latest version.",
    );
    expect(setStatusMock).toHaveBeenNthCalledWith(1, "Checking updates");
    expect(setStatusMock).toHaveBeenLastCalledWith("Idle");
  });

  it("skips the in-app updater on Flatpak", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "is_flatpak") return Promise.resolve(true);
      return defaultInvoke(String(command));
    });

    await checkUpdates();

    expect(checkMock).not.toHaveBeenCalled();
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "Flatpak builds update through Flathub or a reinstalled bundle, not the in-app updater.",
    );
  });

  it("uses beta target when beta channel is selected", async () => {
    mockState.currentSettings.updateChannel = "beta";
    invokeMock.mockImplementation((command) => {
      if (command === "get_beta_updater_target") {
        return Promise.resolve("windows-beta-x86_64-nsis");
      }
      return defaultInvoke(String(command));
    });
    checkMock.mockResolvedValue(null);

    await checkUpdates();

    expect(invokeMock).toHaveBeenCalledWith("get_beta_updater_target");
    expect(checkMock).toHaveBeenCalledWith({
      target: "windows-beta-x86_64-nsis",
      timeout: 30_000,
    });
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient beta feed lookup failure once", async () => {
    mockState.currentSettings.updateChannel = "beta";
    invokeMock.mockImplementation((command) => defaultInvoke(String(command)));
    checkMock
      .mockRejectedValueOnce(new Error("feed swap"))
      .mockResolvedValueOnce(null);

    await checkUpdates();

    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "You are running the latest version.",
    );
  });

  it("downloads and installs update when user accepts restart", async () => {
    const download = vi.fn().mockResolvedValue(undefined);
    const install = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download,
      install,
    } as unknown as Awaited<ReturnType<typeof check>>);
    askMock.mockResolvedValue(true);

    await checkUpdates();

    expect(download).toHaveBeenCalledWith(undefined, { timeout: 120_000 });
    expect(install).toHaveBeenCalledOnce();
    expect(relaunchCalls()).toBe(1);
    // The reservation must be released before relaunch_app, or Quit stays deferred.
    const releaseIndex = invokeMock.mock.calls.findIndex(
      (call) =>
        call[0] === "is_7z_running" &&
        (call[1] as { mode?: string } | undefined)?.mode === "release_update",
    );
    const relaunchIndex = invokeMock.mock.calls.findIndex(
      (call) => call[0] === "relaunch_app",
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(invokeMock.mock.invocationCallOrder[releaseIndex]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[relaunchIndex],
    );
    expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
      mode: "reserve_update",
    });
    expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
      mode: "release_update",
    });
    expect(setStatusMock).toHaveBeenCalledWith("Downloading update");
    expect(setStatusMock).toHaveBeenCalledWith("Update ready");
    expect(setStatusMock).toHaveBeenCalledWith("Installing update");
  });

  it("releases the archive-operation reservation when install fails", async () => {
    const install = vi.fn().mockRejectedValue(new Error("install failed"));
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download: vi.fn().mockResolvedValue(undefined),
      install,
    } as unknown as Awaited<ReturnType<typeof check>>);
    askMock.mockResolvedValue(true);

    await checkUpdates();

    expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
      mode: "release_update",
    });
    expect(relaunchCalls()).toBe(0);
  });

  it("still requests relaunch when reservation release IPC fails after install", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download: vi.fn().mockResolvedValue(undefined),
      install,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof check>>);
    askMock.mockResolvedValue(true);
    invokeMock.mockImplementation((command, payload) => {
      if (
        command === "is_7z_running" &&
        (payload as { mode?: string } | undefined)?.mode === "release_update"
      ) {
        return Promise.reject(new Error("release IPC unavailable"));
      }
      return defaultInvoke(String(command));
    });

    await checkUpdates();

    expect(install).toHaveBeenCalledOnce();
    expect(relaunchCalls()).toBe(1);
    expect(logMock).toHaveBeenCalledWith(
      "Unable to release update reservation: release IPC unavailable",
      "error",
    );
    expect(toastText()).not.toContain("Failed to");
  });

  it("reports an installed update when release fails and relaunch resolves", async () => {
    checkMock.mockResolvedValue(asCheckResult(fakeUpdate("0.5.0")));
    askMock.mockResolvedValue(true);
    invokeMock.mockImplementation((command, payload) => {
      if (
        command === "is_7z_running" &&
        (payload as { mode?: string } | undefined)?.mode === "release_update"
      ) {
        return Promise.reject(new Error("release IPC unavailable"));
      }
      return defaultInvoke(String(command));
    });

    await checkUpdates();

    expect(relaunchCalls()).toBe(1);
    expect(toastText()).toContain(
      "Update installed. Quit and reopen Zinnia to finish.",
    );
    expect(document.querySelectorAll('[data-sticky="true"]')).toHaveLength(1);
    expect(setStatusMock).toHaveBeenLastCalledWith("Update installed");
  });

  it("keeps the archive-operation reservation when install watchdog fires", async () => {
    vi.useFakeTimers();
    let resolveInstall: (() => void) | undefined;
    const install = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInstall = resolve;
        }),
    );
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download: vi.fn().mockResolvedValue(undefined),
      install,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof check>>);
    askMock.mockResolvedValue(true);

    try {
      const pending = checkUpdates();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(invokeMock).not.toHaveBeenCalledWith("is_7z_running", {
        mode: "release_update",
      });
      expect(logMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "Update install still running after 180 seconds",
        ),
      );
      expect(setStatusMock).toHaveBeenCalledWith("Still installing update");
      expect(relaunchCalls()).toBe(0);

      resolveInstall?.();
      await pending;

      expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
        mode: "release_update",
      });
      expect(relaunchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the update reservation while a long install is in flight", async () => {
    vi.useFakeTimers();
    let resolveInstall: (() => void) | undefined;
    const install = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInstall = resolve;
        }),
    );
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download: vi.fn().mockResolvedValue(undefined),
      install,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof check>>);
    askMock.mockResolvedValue(true);

    try {
      const pending = checkUpdates();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
        mode: "touch_update",
      });
      resolveInstall?.();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still attempts release_update when the release invoke itself fails", async () => {
    const install = vi.fn().mockRejectedValue(new Error("install failed"));
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download: vi.fn().mockResolvedValue(undefined),
      install,
    } as unknown as Awaited<ReturnType<typeof check>>);
    askMock.mockResolvedValue(true);
    invokeMock.mockImplementation((command, payload) => {
      if (
        command === "is_7z_running" &&
        payload &&
        typeof payload === "object" &&
        "mode" in payload &&
        (payload as { mode?: string }).mode === "release_update"
      ) {
        return Promise.reject(new Error("release ipc failed"));
      }
      return defaultInvoke(String(command));
    });

    await checkUpdates();

    expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
      mode: "release_update",
    });
    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining("Unable to release update reservation"),
      "error",
    );
    expect(relaunchCalls()).toBe(0);
  });

  it("downloads update and defers install when user chooses later", async () => {
    const download = vi.fn().mockResolvedValue(undefined);
    const install = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download,
      install,
    } as unknown as Awaited<ReturnType<typeof check>>);
    askMock.mockResolvedValue(false);
    isPermissionGrantedMock.mockResolvedValue(true);

    await checkUpdates();

    expect(download).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(relaunchCalls()).toBe(0);
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Zinnia",
      body: "Update downloaded and ready to install from Check now.",
    });
    expect(setStatusMock).toHaveBeenLastCalledWith("Update ready");
  });

  it("releases a deferred update when it is discarded", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
      close,
    } as unknown as Awaited<ReturnType<typeof check>>);

    await checkUpdates();
    discardPendingUpdate();
    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
  });

  it("discards an update whose channel changes during download", async () => {
    let resolveDownload: (() => void) | undefined;
    const close = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download,
      install: vi.fn().mockResolvedValue(undefined),
      close,
    } as unknown as Awaited<ReturnType<typeof check>>);

    const checking = checkUpdates();
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    mockState.currentSettings.updateChannel = "beta";
    discardPendingUpdate();
    resolveDownload?.();
    await checking;

    expect(close).toHaveBeenCalledOnce();
    expect(askMock).not.toHaveBeenCalled();
  });

  it("logs a pending-update resource cleanup failure", async () => {
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    checkMock.mockResolvedValue({
      version: "0.5.0",
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
      close,
    } as unknown as Awaited<ReturnType<typeof check>>);

    await checkUpdates();
    discardPendingUpdate();
    await vi.waitFor(() =>
      expect(devLogMock).toHaveBeenCalledWith(
        "Failed to release pending update resources: Error: close failed",
      ),
    );
  });

  it("coalesces overlapping update checks", async () => {
    let resolveCheck: (value: null) => void = () => {};
    checkMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const first = checkUpdates();
    const second = checkUpdates();
    await vi.waitFor(() => expect(checkMock).toHaveBeenCalledOnce());
    resolveCheck(null);
    await Promise.all([first, second]);

    expect(checkMock).toHaveBeenCalledOnce();
  });

  it("shows update error toast on failures", async () => {
    checkMock.mockRejectedValue(new Error("network down"));

    await checkUpdates();

    expect(logMock).toHaveBeenCalledWith("Updater error: network down");
    expect(setStatusMock).toHaveBeenLastCalledWith("Idle");
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "Failed to check for updates. network down",
    );
  });
});

describe("autoCheckUpdates", () => {
  it("parks a background update without downloading and notifies without prompting for permission", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(asCheckResult(update));
    isPermissionGrantedMock.mockResolvedValue(true);

    await autoCheckUpdates();

    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(askMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Zinnia Update Available",
      body: "Version 0.5.0 is available. Use the update button in the status bar to install.",
    });
    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(indicatorButton().hidden).toBe(false);
    expect(indicatorButton().textContent).toBe(
      "Update 0.5.0 available. Click to install",
    );
    expect(setStatusMock).toHaveBeenLastCalledWith("Update available");
    discardPendingUpdate();
  });

  it("uses default target when auto channel runs on stable version", async () => {
    mockState.currentSettings.updateChannel = "auto";
    getVersionMock.mockResolvedValue("0.4.1");
    checkMock.mockResolvedValue(null);

    await autoCheckUpdates();

    expect(checkMock).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(invokeMock).toHaveBeenCalledWith("is_flatpak");
    expect(devLogMock).toHaveBeenCalledWith(
      "Auto-update check: no updates available.",
    );
  });

  it("parks the background update when notification permission probing fails", async () => {
    const update = fakeUpdate("0.5.1");
    checkMock.mockResolvedValue(asCheckResult(update));
    isPermissionGrantedMock.mockRejectedValue(
      new Error("notification service unavailable"),
    );

    await autoCheckUpdates();

    expect(update.download).not.toHaveBeenCalled();
    expect(devLogMock).toHaveBeenCalledWith(
      "Unable to send update notification: notification service unavailable",
    );
    expect(indicatorButton().textContent).toBe(
      "Update 0.5.1 available. Click to install",
    );
    discardPendingUpdate();
  });

  it("logs and resets status when auto-check fails", async () => {
    checkMock.mockRejectedValue(new Error("timeout"));

    await autoCheckUpdates();

    expect(logMock).toHaveBeenCalledWith("Update check failed: timeout");
    expect(setStatusMock).toHaveBeenCalledWith("Idle");
    expect(document.getElementById("toast-region")).toBeNull();
  });
});

describe("install outcome", () => {
  it("reports an installed update when relaunch throws after release succeeds", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(asCheckResult(update));
    askMock.mockResolvedValue(true);
    invokeMock.mockImplementation((command) => {
      if (command === "relaunch_app") {
        return Promise.reject(new Error("relaunch failed"));
      }
      return defaultInvoke(String(command));
    });

    await expect(checkUpdates()).resolves.toBeUndefined();

    expect(update.install).toHaveBeenCalledOnce();
    expect(toastText()).toContain(
      "Update installed. Quit and reopen Zinnia to finish.",
    );
    expect(toastText()).not.toContain("Failed to");
    expect(document.querySelector('[data-sticky="true"]')).not.toBeNull();
    expect(setStatusMock).toHaveBeenLastCalledWith("Update installed");
    expect(logMock).toHaveBeenCalledWith(
      "Update installed but relaunch failed: relaunch failed",
      "error",
    );
  });

  it("reports an installed update when release and relaunch both fail", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(asCheckResult(update));
    askMock.mockResolvedValue(true);
    invokeMock.mockImplementation((command, payload) => {
      if (command === "relaunch_app") {
        return Promise.reject(new Error("relaunch failed"));
      }
      if (
        command === "is_7z_running" &&
        (payload as { mode?: string } | undefined)?.mode === "release_update"
      ) {
        return Promise.reject(new Error("release IPC unavailable"));
      }
      return defaultInvoke(String(command));
    });

    await expect(checkUpdates()).resolves.toBeUndefined();

    expect(update.install).toHaveBeenCalledOnce();
    expect(toastText()).toContain(
      "Update installed. Quit and reopen Zinnia to finish.",
    );
    expect(toastText()).not.toContain("Failed to");
    expect(document.querySelectorAll('[data-sticky="true"]')).toHaveLength(1);
    expect(setStatusMock).toHaveBeenLastCalledWith("Update installed");
    expect(logMock).toHaveBeenCalledWith(
      "Unable to release update reservation: release IPC unavailable",
      "error",
    );
  });

  it("keeps install errors as failures and does not relaunch", async () => {
    const update = fakeUpdate("0.5.0");
    update.install.mockRejectedValue(new Error("install failed"));
    checkMock.mockResolvedValue(asCheckResult(update));
    askMock.mockResolvedValue(true);

    await checkUpdates();

    expect(invokeMock).toHaveBeenCalledWith("is_7z_running", {
      mode: "release_update",
    });
    expect(relaunchCalls()).toBe(0);
    expect(toastText()).toContain(
      "Failed to check for updates. install failed",
    );
    expect(toastText()).not.toContain("Update installed");
    expect(setStatusMock).toHaveBeenLastCalledWith("Idle");
  });
});

describe("restart prompt guard", () => {
  it("does not open a second restart prompt from the indicator or an interactive check", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(asCheckResult(update));
    askMock.mockResolvedValueOnce(false);
    await checkUpdates();
    expect(askMock).toHaveBeenCalledTimes(1);

    let resolveAsk: (value: boolean) => void = () => {};
    askMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAsk = resolve;
        }),
    );
    indicatorButton().click();
    await vi.waitFor(() => expect(askMock).toHaveBeenCalledTimes(2));

    indicatorButton().click();
    await checkUpdates();
    await flushAsync();

    expect(askMock).toHaveBeenCalledTimes(2);
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(update.close).not.toHaveBeenCalled();

    resolveAsk(false);
    await flushAsync();
    indicatorButton().click();
    await vi.waitFor(() => expect(askMock).toHaveBeenCalledTimes(3));
  });

  it("closes a new candidate found while a prompt is open instead of stacking prompts", async () => {
    const first = fakeUpdate("0.5.0");
    checkMock.mockResolvedValueOnce(asCheckResult(first));
    await autoCheckUpdates();

    let resolveAsk: (value: boolean) => void = () => {};
    askMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAsk = resolve;
        }),
    );
    indicatorButton().click();
    await vi.waitFor(() => expect(askMock).toHaveBeenCalledOnce());

    discardPendingUpdate();
    const second = fakeUpdate("0.6.0");
    checkMock.mockResolvedValueOnce(asCheckResult(second));
    await checkUpdates();

    expect(second.download).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(askMock).toHaveBeenCalledOnce();
    expect(indicatorButton().hidden).toBe(true);

    resolveAsk(false);
    await flushAsync();
  });
});

describe("parked background update", () => {
  it("downloads on indicator click before prompting", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(asCheckResult(update));
    await autoCheckUpdates();

    indicatorButton().click();
    await vi.waitFor(() => expect(askMock).toHaveBeenCalledOnce());

    expect(update.download).toHaveBeenCalledWith(undefined, {
      timeout: 120_000,
    });
    expect(update.download.mock.invocationCallOrder[0]).toBeLessThan(
      askMock.mock.invocationCallOrder[0],
    );
    expect(setStatusMock).toHaveBeenCalledWith("Downloading update");
    expect(indicatorButton().textContent).toBe(
      "Update 0.5.0 ready. Restart to install",
    );
  });

  it("keeps the update parked after a failed download and retries on the next click", async () => {
    const update = fakeUpdate("0.5.0");
    update.download.mockRejectedValueOnce(new Error("download failed"));
    checkMock.mockResolvedValue(asCheckResult(update));
    await autoCheckUpdates();

    indicatorButton().click();
    await vi.waitFor(() =>
      expect(toastText()).toContain(
        "Failed to install update. download failed",
      ),
    );
    expect(logMock).toHaveBeenCalledWith(
      "Updater error: download failed",
      "error",
    );
    expect(setStatusMock).toHaveBeenLastCalledWith("Update available");
    expect(indicatorButton().hidden).toBe(false);
    expect(indicatorButton().textContent).toBe(
      "Update 0.5.0 available. Click to install",
    );
    expect(askMock).not.toHaveBeenCalled();
    expect(update.close).not.toHaveBeenCalled();

    indicatorButton().click();
    await vi.waitFor(() => expect(askMock).toHaveBeenCalledOnce());
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(indicatorButton().textContent).toBe(
      "Update 0.5.0 ready. Restart to install",
    );
  });

  it("does not start a second download while one is running", async () => {
    let resolveDownload: (() => void) | undefined;
    const update = fakeUpdate("0.5.0");
    update.download.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    checkMock.mockResolvedValue(asCheckResult(update));
    await autoCheckUpdates();

    indicatorButton().click();
    await vi.waitFor(() => expect(update.download).toHaveBeenCalledOnce());
    indicatorButton().click();
    await checkUpdates();
    expect(update.download).toHaveBeenCalledOnce();

    resolveDownload?.();
    await vi.waitFor(() => expect(askMock).toHaveBeenCalledOnce());
    expect(update.download).toHaveBeenCalledOnce();
  });

  it("downloads a parked update when an interactive check runs", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(asCheckResult(update));
    await autoCheckUpdates();

    await checkUpdates();

    expect(update.download).toHaveBeenCalledOnce();
    expect(askMock).toHaveBeenCalledOnce();
    expect(checkMock).toHaveBeenCalledOnce();
  });

  it("restores Update available when an interactive check cannot download a parked update", async () => {
    const update = fakeUpdate("0.5.0");
    update.download.mockRejectedValueOnce(new Error("download failed"));
    checkMock.mockResolvedValue(asCheckResult(update));
    await autoCheckUpdates();

    await checkUpdates();

    expect(logMock).toHaveBeenCalledWith("Updater error: download failed");
    expect(toastText()).toContain(
      "Failed to check for updates. download failed",
    );
    expect(setStatusMock).toHaveBeenLastCalledWith("Update available");
    expect(indicatorButton().textContent).toBe(
      "Update 0.5.0 available. Click to install",
    );
    expect(update.close).not.toHaveBeenCalled();
    discardPendingUpdate();
  });

  it("closes a parked update discarded mid-download once the download settles", async () => {
    let resolveDownload: (() => void) | undefined;
    const update = fakeUpdate("0.5.0");
    update.download.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    checkMock.mockResolvedValue(asCheckResult(update));
    await autoCheckUpdates();

    indicatorButton().click();
    await vi.waitFor(() => expect(update.download).toHaveBeenCalledOnce());
    discardPendingUpdate();
    expect(update.close).not.toHaveBeenCalled();
    expect(indicatorButton().hidden).toBe(true);

    resolveDownload?.();
    await vi.waitFor(() => expect(update.close).toHaveBeenCalledOnce());
    expect(askMock).not.toHaveBeenCalled();
  });

  it("treats a newly parked update as not downloaded after discard", async () => {
    const first = fakeUpdate("0.5.0");
    checkMock.mockResolvedValueOnce(asCheckResult(first));
    askMock.mockResolvedValueOnce(false);
    await checkUpdates();
    discardPendingUpdate();

    const second = fakeUpdate("0.6.0");
    checkMock.mockResolvedValueOnce(asCheckResult(second));
    await autoCheckUpdates();

    expect(second.download).not.toHaveBeenCalled();
    expect(indicatorButton().textContent).toBe(
      "Update 0.6.0 available. Click to install",
    );

    indicatorButton().click();
    await vi.waitFor(() => expect(second.download).toHaveBeenCalledOnce());
    discardPendingUpdate();
  });
});
