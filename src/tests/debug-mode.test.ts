import { describe, it, expect, beforeEach, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  clearDebugConsole,
  debugLog,
  debugLogCommand,
  isDebugConsolePoppedOut,
  isDebugConsoleVisible,
  isDebugEnabled,
  popOutDebugConsole,
  restoreDebugConsolePopOutIfNeeded,
  setDebugConsoleVisible,
  setDebugEnabled,
} from "../debug-mode";
import { promptAndToggleDebugMode } from "../power-events";
import { state } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";
import { logCommandResult } from "../archive/runtime";

beforeEach(() => {
  setDebugEnabled(false);
  clearDebugConsole();
  setDebugConsoleVisible(false);
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.settingsExtras = {};
  vi.mocked(ask).mockReset();
  vi.mocked(ask).mockResolvedValue(false);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  expect(isDebugConsolePoppedOut()).toBe(false);
});

describe("debugLog", () => {
  it("does not evaluate thunks or touch the console when disabled", () => {
    const thunk = vi.fn(() => "should not run");
    debugLog(thunk);
    expect(thunk).not.toHaveBeenCalled();
    expect(
      document.getElementById("debug-console-log")?.textContent ?? "",
    ).toBe("");
    expect(isDebugEnabled()).toBe(false);
  });

  it("appends redacted lines when enabled", () => {
    setDebugEnabled(true, { banner: false });
    debugLog("hello debug");
    const text =
      document.getElementById("debug-console-log")?.textContent ?? "";
    expect(text).toContain("hello debug");
    expect(isDebugConsoleVisible()).toBe(true);
  });

  it("re-shows the console when logging after Close", () => {
    setDebugEnabled(true, { banner: false });
    setDebugConsoleVisible(false);
    expect(isDebugConsoleVisible()).toBe(false);
    debugLog("after close");
    expect(isDebugConsoleVisible()).toBe(true);
    expect(
      document.getElementById("debug-console-log")?.textContent ?? "",
    ).toContain("after close");
  });

  it("logs redacted command args only when enabled", () => {
    debugLogCommand(["x", "-psecret", "--", "a.zip"]);
    expect(
      document.getElementById("debug-console-log")?.textContent ?? "",
    ).toBe("");

    setDebugEnabled(true, { banner: false });
    debugLogCommand(["x", "-psecret", "--", "a.zip"]);
    const text =
      document.getElementById("debug-console-log")?.textContent ?? "";
    expect(text).toContain("7z x -p*** -- a.zip");
    expect(text).not.toContain("secret");
  });
});

describe("setDebugEnabled", () => {
  it("hides and clears the console when disabling", () => {
    setDebugEnabled(true, { banner: false });
    debugLog("line");
    setDebugEnabled(false);
    expect(isDebugEnabled()).toBe(false);
    expect(isDebugConsoleVisible()).toBe(false);
    expect(
      document.getElementById("debug-console-log")?.textContent ?? "",
    ).toBe("");
  });
});

describe("promptAndToggleDebugMode", () => {
  it("enables debug mode after confirm and persists settings", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    await promptAndToggleDebugMode();
    expect(isDebugEnabled()).toBe(true);
    expect(state.currentSettings.debug).toBe(true);
    expect(isDebugConsoleVisible()).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "save_settings",
      expect.objectContaining({
        json: expect.stringContaining('"debug":true'),
      }),
    );
  });

  it("does nothing when the confirm dialog is cancelled", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    await promptAndToggleDebugMode();
    expect(isDebugEnabled()).toBe(false);
    expect(state.currentSettings.debug).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("logCommandResult debug sink", () => {
  it("does not write command streams to the debug console when off", () => {
    logCommandResult("stdout line\n", "stderr line\n");
    expect(
      document.getElementById("debug-console-log")?.textContent ?? "",
    ).toBe("");
  });

  it("writes full streams to the debug console when on", () => {
    setDebugEnabled(true, { banner: false });
    logCommandResult("stdout line\n", "stderr line\n", 2);
    const text =
      document.getElementById("debug-console-log")?.textContent ?? "";
    expect(text).toContain("Exit code: 2");
    expect(text).toContain("stdout:");
    expect(text).toContain("stdout line");
    expect(text).toContain("stderr:");
    expect(text).toContain("stderr line");
  });
});

describe("popOutDebugConsole", () => {
  it("opens the detached window and hides the docked panel", async () => {
    setDebugEnabled(true, { banner: false });
    debugLog("before pop");
    await popOutDebugConsole();
    expect(invoke).toHaveBeenCalledWith("open_debug_console_window");
    expect(isDebugConsolePoppedOut()).toBe(true);
    expect(isDebugConsoleVisible()).toBe(false);
    debugLog("while popped");
    expect(invoke).toHaveBeenCalledWith(
      "relay_debug_console_line",
      expect.objectContaining({
        line: expect.stringContaining("while popped"),
      }),
    );
  });

  it("is a no-op when debug mode is off", async () => {
    await popOutDebugConsole();
    expect(invoke).not.toHaveBeenCalledWith("open_debug_console_window");
    expect(isDebugConsolePoppedOut()).toBe(false);
  });

  it("disabling debug closes the popped-out window", async () => {
    setDebugEnabled(true, { banner: false });
    await popOutDebugConsole();
    expect(isDebugConsolePoppedOut()).toBe(true);
    setDebugEnabled(false);
    expect(isDebugConsolePoppedOut()).toBe(false);
    expect(invoke).toHaveBeenCalledWith("close_debug_console_window");
  });

  it("seeds immediately when the pop-out window is already open", async () => {
    setDebugEnabled(true, { banner: false });
    debugLog("history line");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "debug_console_window_open") return true;
      return undefined;
    });
    await popOutDebugConsole();
    expect(invoke).toHaveBeenCalledWith(
      "relay_debug_console_seed",
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.stringContaining("history line"),
        ]),
      }),
    );
  });

  it("does not seed before ready when opening a new pop-out window", async () => {
    setDebugEnabled(true, { banner: false });
    debugLog("fresh history");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "debug_console_window_open") return false;
      return undefined;
    });
    await popOutDebugConsole();
    expect(invoke).not.toHaveBeenCalledWith(
      "relay_debug_console_seed",
      expect.anything(),
    );
    expect(isDebugConsolePoppedOut()).toBe(true);
  });

  it("persists pop-out preference when opening", async () => {
    setDebugEnabled(true, { banner: false });
    await popOutDebugConsole();
    expect(state.currentSettings.debugConsolePoppedOut).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "save_settings",
      expect.objectContaining({
        json: expect.stringContaining('"debugConsolePoppedOut":true'),
      }),
    );
  });

  it("restores pop-out from settings when debug is on", async () => {
    setDebugEnabled(true, { banner: false });
    state.currentSettings = {
      ...state.currentSettings,
      debug: true,
      debugConsolePoppedOut: true,
    };
    await restoreDebugConsolePopOutIfNeeded();
    expect(invoke).toHaveBeenCalledWith("open_debug_console_window");
    expect(isDebugConsolePoppedOut()).toBe(true);
  });

  it("does not restore pop-out when the preference is off", async () => {
    setDebugEnabled(true, { banner: false });
    state.currentSettings.debugConsolePoppedOut = false;
    await restoreDebugConsolePopOutIfNeeded();
    expect(invoke).not.toHaveBeenCalledWith("open_debug_console_window");
  });

  it("keeps pop-out preference when disabling debug", async () => {
    setDebugEnabled(true, { banner: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "debug_console_window_open") return true;
      return undefined;
    });
    await popOutDebugConsole();
    expect(state.currentSettings.debugConsolePoppedOut).toBe(true);
    setDebugEnabled(false);
    expect(isDebugConsolePoppedOut()).toBe(false);
    expect(state.currentSettings.debugConsolePoppedOut).toBe(true);
  });
});
