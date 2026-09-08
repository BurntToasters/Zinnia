import { beforeEach, describe, expect, it, vi } from "vitest";
import { isNativeWebviewContextMenuAllowed } from "../webview-context-menu";

type Listener = (event: { payload: unknown }) => void;

function mountDebugConsoleDom(): void {
  document.body.innerHTML = `
    <button id="titlebar-min">Minimize</button>
    <button id="titlebar-max">Maximize</button>
    <button id="titlebar-close">Close</button>
    <button id="dbg-clear">Clear</button>
    <button id="dbg-copy">Copy</button>
    <button id="dbg-dock">Dock</button>
    <pre id="dbg-log"></pre>
  `;
  document.body.className = "";
  document.documentElement.removeAttribute("data-theme");
  delete document.documentElement.dataset.windowFx;
}

async function flushAsync(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

async function setupAndRun(options?: {
  invokeImpl?: (cmd: string, payload?: unknown) => unknown;
}): Promise<{
  listeners: Map<string, Listener>;
  invoke: ReturnType<
    typeof vi.mocked<(typeof import("@tauri-apps/api/core"))["invoke"]>
  >;
  appWindow: {
    minimize: ReturnType<typeof vi.fn>;
    maximize: ReturnType<typeof vi.fn>;
    unmaximize: ReturnType<typeof vi.fn>;
    isMaximized: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}> {
  vi.resetModules();
  mountDebugConsoleDom();

  const core = await import("@tauri-apps/api/core");
  const eventApi = await import("@tauri-apps/api/event");
  const webviewApi = await import("@tauri-apps/api/webviewWindow");

  const listeners = new Map<string, Listener>();
  vi.mocked(eventApi.listen).mockImplementation(async (event, handler) => {
    listeners.set(String(event), handler as Listener);
    return () => undefined;
  });
  vi.mocked(eventApi.emit).mockReset();
  vi.mocked(eventApi.emit).mockResolvedValue(undefined);

  const appWindow = {
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(webviewApi.getCurrentWebviewWindow).mockReturnValue(
    appWindow as never,
  );

  const invokeMock = vi.mocked(core.invoke);
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, payload?: unknown) => {
    if (options?.invokeImpl) {
      const custom = await options.invokeImpl(cmd, payload);
      if (custom !== undefined) return custom;
    }
    if (cmd === "get_platform_info") return "macos";
    if (cmd === "supports_workspace_window_fx") return true;
    if (cmd === "load_settings") {
      return JSON.stringify({ basicWindowEffects: true, theme: "dark" });
    }
    if (cmd === "set_workspace_window_fx") return undefined;
    if (cmd === "close_debug_console_window") return undefined;
    if (cmd === "relay_debug_console_signal") return undefined;
    return undefined;
  });

  await import("../debug-console-window");
  await flushAsync();

  return {
    listeners,
    invoke: invokeMock,
    appWindow,
  };
}

describe("debug console window", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("wires platform/theme and signals ready after listeners attach", async () => {
    const { invoke, listeners } = await setupAndRun();
    expect(document.body.classList.contains("platform-macos")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.dataset.windowFx).toBe("basic");
    expect(invoke).toHaveBeenCalledWith("relay_debug_console_signal", {
      signal: "ready",
    });
    expect(listeners.has("zinnia-debug-log")).toBe(true);
    expect(listeners.has("zinnia-debug-seed")).toBe(true);
    expect(listeners.has("zinnia-debug-clear")).toBe(true);
    expect(isNativeWebviewContextMenuAllowed()).toBe(true);
  });

  it("appends seeded and live lines, then clears on request", async () => {
    const { listeners } = await setupAndRun();
    const log = document.getElementById("dbg-log");
    expect(log).toBeTruthy();

    listeners.get("zinnia-debug-seed")?.({
      payload: ["seed one", "seed two"],
    });
    expect(log?.textContent).toContain("seed one");
    expect(log?.textContent).toContain("seed two");

    listeners.get("zinnia-debug-log")?.({ payload: "live line" });
    expect(log?.textContent).toContain("live line");

    listeners.get("zinnia-debug-clear")?.({ payload: undefined });
    expect(log?.textContent).toBe("");
  });

  it("Dock signals preference clear and closes the window", async () => {
    const { invoke } = await setupAndRun();
    document.getElementById("dbg-dock")?.click();
    await flushAsync();
    expect(invoke).toHaveBeenCalledWith("relay_debug_console_signal", {
      signal: "dock",
    });
    expect(invoke).toHaveBeenCalledWith("relay_debug_console_signal", {
      signal: "closed",
    });
    expect(invoke).toHaveBeenCalledWith("close_debug_console_window");
  });

  it("Clear empties the log and asks main to clear the shared buffer", async () => {
    const { invoke, listeners } = await setupAndRun();
    listeners.get("zinnia-debug-log")?.({ payload: "keep me" });
    document.getElementById("dbg-clear")?.click();
    await flushAsync();
    expect(document.getElementById("dbg-log")?.textContent).toBe("");
    expect(invoke).toHaveBeenCalledWith("relay_debug_console_signal", {
      signal: "clear",
    });
  });

  it("Copy writes the log to the clipboard", async () => {
    const { listeners } = await setupAndRun();
    listeners.get("zinnia-debug-log")?.({ payload: "copy me" });
    document.getElementById("dbg-copy")?.click();
    await flushAsync();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("copy me"),
    );
    expect(document.getElementById("dbg-copy")?.textContent).toBe("Copied");
  });

  it("titlebar controls minimize and maximize", async () => {
    const { appWindow } = await setupAndRun();
    document.getElementById("titlebar-min")?.click();
    await flushAsync();
    expect(appWindow.minimize).toHaveBeenCalled();

    document.getElementById("titlebar-max")?.click();
    await flushAsync();
    expect(appWindow.isMaximized).toHaveBeenCalled();
    expect(appWindow.maximize).toHaveBeenCalled();

    appWindow.isMaximized.mockResolvedValue(true);
    document.getElementById("titlebar-max")?.click();
    await flushAsync();
    expect(appWindow.unmaximize).toHaveBeenCalled();
  });

  it("falls back to destroy when close invoke fails", async () => {
    const { appWindow } = await setupAndRun({
      invokeImpl: async (cmd) => {
        if (cmd === "get_platform_info") return "linux";
        if (cmd === "supports_workspace_window_fx") return false;
        if (cmd === "load_settings") return "{";
        if (cmd === "close_debug_console_window") {
          throw new Error("already gone");
        }
        return undefined;
      },
    });
    document.getElementById("titlebar-close")?.click();
    await flushAsync(20);
    expect(appWindow.destroy).toHaveBeenCalled();
  });
});
