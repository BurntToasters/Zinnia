import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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
}));

vi.mock("../state", () => ({
  state: mockState,
}));

import { autoCheckUpdates, checkUpdates, notify } from "../updater";

const askMock = vi.mocked(ask);
const messageMock = vi.mocked(message);
const getVersionMock = vi.mocked(getVersion);
const invokeMock = vi.mocked(invoke);
const checkMock = vi.mocked(check);
const relaunchMock = vi.mocked(relaunch);
const isPermissionGrantedMock = vi.mocked(isPermissionGranted);
const requestPermissionMock = vi.mocked(requestPermission);
const sendNotificationMock = vi.mocked(sendNotification);

beforeEach(() => {
  mockState.currentSettings.updateChannel = "stable";

  askMock.mockReset();
  messageMock.mockReset();
  getVersionMock.mockReset();
  invokeMock.mockReset();
  checkMock.mockReset();
  relaunchMock.mockReset();
  isPermissionGrantedMock.mockReset();
  requestPermissionMock.mockReset();
  sendNotificationMock.mockReset();
  logMock.mockReset();
  devLogMock.mockReset();
  setStatusMock.mockReset();

  askMock.mockResolvedValue(false);
  messageMock.mockResolvedValue("Ok");
  getVersionMock.mockResolvedValue("0.4.1");
  invokeMock.mockResolvedValue("windows");
  checkMock.mockResolvedValue(null);
  relaunchMock.mockResolvedValue(undefined);
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
  it("shows no-updates message on stable channel", async () => {
    mockState.currentSettings.updateChannel = "stable";
    checkMock.mockResolvedValue(null);

    await checkUpdates();

    expect(checkMock).toHaveBeenCalledWith();
    expect(devLogMock).toHaveBeenCalledWith("No updates available.");
    expect(messageMock).toHaveBeenCalledWith(
      "You are running the latest version.",
      { title: "No updates" },
    );
    expect(setStatusMock).toHaveBeenNthCalledWith(1, "Checking updates");
    expect(setStatusMock).toHaveBeenLastCalledWith("Idle");
  });

  it("uses beta target when beta channel is selected", async () => {
    mockState.currentSettings.updateChannel = "beta";
    invokeMock.mockResolvedValue("windows");
    checkMock.mockResolvedValue(null);

    await checkUpdates();

    expect(invokeMock).toHaveBeenCalledWith("get_platform_info");
    expect(checkMock).toHaveBeenCalledWith({ target: "windows-beta" });
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

    expect(download).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(relaunchMock).toHaveBeenCalledOnce();
    expect(setStatusMock).toHaveBeenCalledWith("Downloading update");
    expect(setStatusMock).toHaveBeenCalledWith("Update ready");
    expect(setStatusMock).toHaveBeenCalledWith("Installing update");
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
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Zinnia",
      body: "Update downloaded. Install it later from Check now.",
    });
    expect(setStatusMock).toHaveBeenLastCalledWith("Idle");
  });

  it("shows update error dialog on failures", async () => {
    checkMock.mockRejectedValue(new Error("network down"));

    await checkUpdates();

    expect(logMock).toHaveBeenCalledWith("Updater error: network down");
    expect(setStatusMock).toHaveBeenLastCalledWith("Idle");
    expect(messageMock).toHaveBeenCalledWith(
      "Failed to check for updates.\n\nnetwork down",
      { title: "Update error", kind: "error" },
    );
  });
});

describe("autoCheckUpdates", () => {
  it("uses default target when auto channel runs on stable version", async () => {
    mockState.currentSettings.updateChannel = "auto";
    getVersionMock.mockResolvedValue("0.4.1");
    checkMock.mockResolvedValue(null);

    await autoCheckUpdates();

    expect(checkMock).toHaveBeenCalledWith();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(devLogMock).toHaveBeenCalledWith(
      "Auto-update check: no updates available.",
    );
  });

  it("logs and resets status when auto-check fails", async () => {
    checkMock.mockRejectedValue(new Error("timeout"));

    await autoCheckUpdates();

    expect(logMock).toHaveBeenCalledWith("Update check failed: timeout");
    expect(setStatusMock).toHaveBeenCalledWith("Idle");
    expect(messageMock).not.toHaveBeenCalled();
  });
});
