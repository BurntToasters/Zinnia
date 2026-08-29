import { beforeEach, describe, expect, it, vi } from "vitest";
import { isNativeWebviewContextMenuAllowed } from "../webview-context-menu";

type AnyInvoke = (cmd: string, payload?: unknown) => unknown;

function mountExtractDom(): void {
  document.body.innerHTML = `
    <div id="extract-app" class="extract-app">
      <button id="titlebar-min">Minimize</button>
      <button id="titlebar-close">Close</button>
      <div class="extract-header"><h1>Extracting</h1></div>
      <div class="extract-body">
        <span id="archive-name"></span>
        <span id="extract-dest"></span>
        <div id="extract-progress" role="progressbar">
          <div id="progress-fill" class="extract-progress-fill"></div>
        </div>
        <div id="extract-status">Preparing...</div>
        <div id="extract-error" hidden>
          <div class="extract-error-header">
            <div class="extract-error-title">Extraction failed</div>
            <button type="button" id="copy-error-detail" hidden>
              Copy details
            </button>
          </div>
          <pre id="error-detail"></pre>
        </div>
      </div>
      <div class="extract-footer">
        <button id="cancel-btn">Cancel</button>
        <button id="open-destination-btn" hidden>Open destination</button>
        <button id="close-btn" hidden>Close</button>
      </div>
    </div>
    <div id="input-modal-overlay" hidden>
      <div class="modal">
        <h2 id="input-modal-title"></h2>
        <label id="input-modal-label" for="input-modal-field"></label>
        <input id="input-modal-field" />
        <button id="input-modal-confirm">OK</button>
        <button id="input-modal-cancel">Cancel</button>
        <button id="input-modal-cancel-x">Close</button>
      </div>
    </div>
  `;
}

async function flushAsync(): Promise<void> {
  // Extract startup now includes probe + archive validation + run_7z.
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

async function setupAndRun(
  invokeImpl?: AnyInvoke,
  options?: {
    injected?: { archive: string; destination: string };
    listenerRegistrations?: Array<Promise<() => void>>;
    /** Leave false when run_7z is intentionally left pending (cancel tests). */
    waitForSettle?: boolean;
  },
): Promise<{
  invokeMock: ReturnType<
    typeof vi.mocked<(typeof import("@tauri-apps/api/core"))["invoke"]>
  >;
  appWindow: {
    minimize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  progressUnlisten: ReturnType<typeof vi.fn>;
  progressListeners: Map<string, (event: { payload: unknown }) => void>;
}> {
  vi.resetModules();
  mountExtractDom();
  delete (window as Window & { __ZINNIA_EXTRACT__?: unknown })
    .__ZINNIA_EXTRACT__;
  if (options?.injected) {
    (
      window as Window & {
        __ZINNIA_EXTRACT__?: { archive: string; destination: string };
      }
    ).__ZINNIA_EXTRACT__ = options.injected;
  }

  const core = await import("@tauri-apps/api/core");
  const eventApi = await import("@tauri-apps/api/event");
  const webviewApi = await import("@tauri-apps/api/webviewWindow");

  const invokeMock = vi.mocked(core.invoke);
  const progressUnlisten = vi.fn();
  const appWindow = {
    minimize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  const listenerRegistrations = [...(options?.listenerRegistrations ?? [])];
  const progressListeners = new Map<
    string,
    (event: { payload: unknown }) => void
  >();
  vi.mocked(eventApi.listen).mockImplementation((event, handler) => {
    progressListeners.set(
      String(event),
      handler as (event: { payload: unknown }) => void,
    );
    return listenerRegistrations.shift() ?? Promise.resolve(progressUnlisten);
  });
  vi.mocked(webviewApi.getCurrentWebviewWindow).mockReturnValue(
    appWindow as never,
  );

  const defaultInvoke: AnyInvoke = async (cmd, payload) => {
    if (cmd === "get_extract_paths") return ["/tmp/archive.zip"];
    if (cmd === "probe_7z") return "25.01";
    if (cmd === "validate_archive_paths") {
      const pathsJson =
        typeof payload === "object" &&
        payload &&
        "pathsJson" in payload &&
        typeof (payload as { pathsJson?: unknown }).pathsJson === "string"
          ? (payload as { pathsJson: string }).pathsJson
          : "[]";
      let paths: string[] = [];
      try {
        paths = JSON.parse(pathsJson) as string[];
      } catch {
        paths = [];
      }
      return paths.map((path) => ({
        path,
        valid: true,
        reason: null,
        identity: `identity:${path}`,
      }));
    }
    if (cmd === "run_7z") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (cmd === "load_settings") {
      return JSON.stringify({ extractAutoCloseSeconds: 1.5 });
    }
    if (cmd === "close_extract_window") return undefined;
    if (cmd === "open_path") return undefined;
    if (cmd === "cancel_7z") return true;
    return undefined;
  };

  invokeMock.mockImplementation(async (cmd, payload) => {
    if (invokeImpl) {
      const custom = await invokeImpl(cmd, payload);
      if (custom !== undefined) return custom;
    }
    return defaultInvoke(cmd, payload);
  });

  await import("../extract-window");
  await flushAsync();
  if (options?.waitForSettle !== false) {
    await vi.waitFor(
      () => {
        const status =
          document.getElementById("extract-status")?.textContent ?? "";
        if (
          status === "Extracting..." ||
          status === "Starting extraction..." ||
          status === "Still working…"
        ) {
          throw new Error(`extract still in progress: ${status}`);
        }
      },
      { timeout: 1000, interval: 5 },
    );
  }

  return { invokeMock, appWindow, progressUnlisten, progressListeners };
}

beforeEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("extract-window", () => {
  it("blocks the native webview context menu unless debug is on", async () => {
    await setupAndRun();
    expect(isNativeWebviewContextMenuAllowed()).toBe(false);

    await setupAndRun(async (cmd) => {
      if (cmd === "load_settings") {
        return JSON.stringify({
          debug: true,
          extractAutoCloseSeconds: -1,
        });
      }
      return undefined;
    });
    expect(isNativeWebviewContextMenuAllowed()).toBe(true);
  });

  it("disables auto-close when load_settings fails", async () => {
    await setupAndRun(async (cmd) => {
      if (cmd === "load_settings") {
        throw new Error("settings unavailable");
      }
      if (cmd === "run_7z") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    expect(
      (document.getElementById("close-btn") as HTMLButtonElement).textContent,
    ).toBe("Close");
  });

  it("applies the system dark theme and enabled window effects", async () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const { invokeMock } = await setupAndRun(async (cmd) => {
      if (cmd === "get_extract_paths") return [];
      if (cmd === "supports_workspace_window_fx") return true;
      if (cmd === "load_settings") {
        return JSON.stringify({ basicWindowEffects: true, theme: "system" });
      }
      return undefined;
    });
    await flushAsync();

    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(document.documentElement.dataset.windowFx).toBe("basic");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(invokeMock).toHaveBeenCalledWith("set_workspace_window_fx", {
      enabled: true,
      dark: true,
    });
  });

  it("shows no-archive state when no extract path is provided", async () => {
    const { invokeMock } = await setupAndRun(async (cmd) => {
      if (cmd === "get_extract_paths") return [];
      return undefined;
    });

    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("No archive specified.");
    expect(
      (document.getElementById("cancel-btn") as HTMLButtonElement).hidden,
    ).toBe(true);
    expect(
      (document.getElementById("close-btn") as HTMLButtonElement).hidden,
    ).toBe(false);
    expect(invokeMock.mock.calls.some(([name]) => name === "probe_7z")).toBe(
      false,
    );
  });

  it("uses injected archive/destination without waiting on get_extract_paths", async () => {
    const claim = {
      resolve: null as ((value: string[]) => void) | null,
    };
    const { invokeMock } = await setupAndRun(
      async (cmd) => {
        if (cmd === "get_extract_paths") {
          return await new Promise<string[]>((resolve) => {
            claim.resolve = resolve;
          });
        }
        if (cmd === "run_7z") {
          return { stdout: "", stderr: "", code: 0 };
        }
        return undefined;
      },
      {
        injected: {
          archive: "/Downloads/packed.7z",
          destination: "/Downloads/packed",
        },
      },
    );

    await flushAsync();

    expect(
      (document.getElementById("archive-name") as HTMLElement).textContent,
    ).toBe("packed.7z");
    expect(
      (document.getElementById("extract-dest") as HTMLElement).textContent,
    ).toBe("/Downloads/packed");
    expect(invokeMock).toHaveBeenCalledWith("run_7z", {
      args: [
        "x",
        "-o/Downloads/packed",
        "-aou",
        "-bb1",
        "-bsp1",
        "--",
        "/Downloads/packed.7z",
      ],
      expectedArchiveIdentity: "identity:/Downloads/packed.7z",
    });

    claim.resolve?.([]);
    await flushAsync();
  });

  it("shows error when extraction process fails to start", async () => {
    await setupAndRun(async (cmd) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "run_7z") throw new Error("missing sidecar");
      return undefined;
    });

    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("Failed");
    expect(
      (document.getElementById("extract-error") as HTMLElement).hidden,
    ).toBe(false);
    expect(
      (document.getElementById("error-detail") as HTMLElement).textContent,
    ).toContain("missing sidecar");
  });

  it("treats warning exits as failed extraction with warning detail", async () => {
    await setupAndRun(async (cmd, payload) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "probe_7z") return "25.01";
      if (cmd === "validate_archive_paths") {
        return [
          {
            path: "/tmp/archive.7z",
            valid: true,
            reason: null,
            identity: "identity:/tmp/archive.7z",
          },
        ];
      }
      if (cmd === "run_7z") {
        expect(
          (payload as { expectedArchiveIdentity?: string } | undefined)
            ?.expectedArchiveIdentity,
        ).toBe("identity:/tmp/archive.7z");
        return { stdout: "", stderr: "minor warning", code: 1 };
      }
      return undefined;
    });

    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("Failed");
    expect(
      (document.getElementById("extract-error") as HTMLElement).hidden,
    ).toBe(false);
    expect(
      (document.getElementById("error-detail") as HTMLElement).textContent,
    ).toContain("minor warning");
  });

  it("includes copyable debug dump on extract failure when settings.debug is true", async () => {
    await setupAndRun(async (cmd) => {
      if (cmd === "load_settings") {
        return JSON.stringify({
          debug: true,
          extractAutoCloseSeconds: -1,
        });
      }
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "run_7z") {
        return {
          stdout: "stdout body",
          stderr: "stderr body",
          code: 2,
        };
      }
      return undefined;
    });

    const text =
      (document.getElementById("error-detail") as HTMLElement).textContent ??
      "";
    expect(text).toContain("--- debug ---");
    expect(text).toContain("exit: 2");
    expect(text).toContain("cmd: 7z x");
    expect(text).toContain("stdout body");
    expect(text).toContain("stderr body");
    expect(
      (document.getElementById("copy-error-detail") as HTMLButtonElement)
        .hidden,
    ).toBe(false);
  });

  it("retries when header-encrypted member preflight requests a password", async () => {
    let runCount = 0;
    const { invokeMock } = await setupAndRun(
      async (cmd, payload) => {
        if (cmd === "get_extract_paths") return ["/tmp/headers.7z"];
        if (cmd === "run_7z") {
          runCount += 1;
          if (runCount === 1) {
            throw new Error(
              "Could not list archive members for path safety: Enter password:",
            );
          }
          expect((payload as { args: string[] }).args).toContain("-psecret");
          return { stdout: "", stderr: "", code: 0 };
        }
        return undefined;
      },
      { waitForSettle: false },
    );

    await vi.waitFor(() => {
      expect(
        (document.getElementById("input-modal-overlay") as HTMLElement).hidden,
      ).toBe(false);
    });
    (document.getElementById("input-modal-field") as HTMLInputElement).value =
      "secret";
    (
      document.getElementById("input-modal-confirm") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([name]) => name === "run_7z"),
      ).toHaveLength(2);
      expect(document.getElementById("extract-status")?.textContent).toBe(
        "Done",
      );
    });
  });

  it("ignores Finalizing progress while waiting for a password", async () => {
    let runCount = 0;
    const { progressListeners } = await setupAndRun(
      async (cmd) => {
        if (cmd === "get_extract_paths") return ["/tmp/headers.7z"];
        if (cmd === "run_7z") {
          runCount += 1;
          if (runCount === 1) {
            throw new Error(
              "Could not list archive members for path safety: Enter password:",
            );
          }
          return new Promise(() => undefined);
        }
        return undefined;
      },
      { waitForSettle: false },
    );

    await vi.waitFor(() => {
      expect(
        (document.getElementById("input-modal-overlay") as HTMLElement).hidden,
      ).toBe(false);
    });
    const cancelBtn = document.getElementById(
      "cancel-btn",
    ) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);

    progressListeners.get("7z-progress-structured")?.({
      payload: { currentFile: "Finalizing…", percent: 100 },
    });
    await flushAsync();
    expect(cancelBtn.disabled).toBe(false);
    expect(document.getElementById("extract-status")?.textContent).not.toBe(
      "Finalizing…",
    );
  });

  it("shows failure details for non-warning extraction failures", async () => {
    await setupAndRun(async (cmd, _payload) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "run_7z") {
        return { stdout: "", stderr: "fatal extraction error", code: 2 };
      }
      return undefined;
    });

    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("Failed");
    expect(
      (document.getElementById("error-detail") as HTMLElement).textContent,
    ).toBe("fatal extraction error");
  });

  it("keeps successful extraction visible until the user acts", async () => {
    vi.useFakeTimers();

    const { invokeMock } = await setupAndRun();

    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("Done");

    vi.advanceTimersByTime(1201);
    await flushAsync();

    expect(
      invokeMock.mock.calls.some(([name]) => name === "close_extract_window"),
    ).toBe(false);
  });

  it("removes auto-close abort listeners when the countdown expires", async () => {
    vi.useFakeTimers();
    const removeListener = vi.spyOn(window, "removeEventListener");

    await setupAndRun();
    vi.advanceTimersByTime(1600);
    await flushAsync();

    for (const eventName of ["mousemove", "keydown", "click"]) {
      expect(removeListener).toHaveBeenCalledWith(
        eventName,
        expect.any(Function),
      );
    }
    removeListener.mockRestore();
  });

  it("wires the native minimize titlebar action", async () => {
    const { appWindow } = await setupAndRun();

    (document.getElementById("titlebar-min") as HTMLButtonElement).click();
    await flushAsync();

    expect(appWindow.minimize).toHaveBeenCalledOnce();
  });

  it("does not close after the user opens the destination", async () => {
    vi.useFakeTimers();

    const { invokeMock } = await setupAndRun();

    (
      document.getElementById("open-destination-btn") as HTMLButtonElement
    ).click();
    await flushAsync();
    vi.advanceTimersByTime(1201);
    await flushAsync();

    expect(invokeMock).toHaveBeenCalledWith("register_extract_open_path", {
      path: "/tmp/archive",
    });
    expect(invokeMock).toHaveBeenCalledWith("open_path", {
      path: "/tmp/archive",
    });
    expect(
      invokeMock.mock.calls.some(([name]) => name === "close_extract_window"),
    ).toBe(false);
  });

  it("cancels a running extraction via cancel_7z", async () => {
    let resolveRun: ((value: unknown) => void) | null = null;
    const { invokeMock } = await setupAndRun(
      async (cmd) => {
        if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
        if (cmd === "run_7z") {
          return await new Promise((resolve) => {
            resolveRun = resolve;
          });
        }
        if (cmd === "cancel_7z") {
          resolveRun?.({ stdout: "", stderr: "", code: -1 });
          return true;
        }
        return undefined;
      },
      { waitForSettle: false },
    );

    expect(
      (document.getElementById("cancel-btn") as HTMLButtonElement).disabled,
    ).toBe(false);

    (document.getElementById("cancel-btn") as HTMLButtonElement).click();
    await flushAsync();
    await flushAsync();

    expect(invokeMock).toHaveBeenCalledWith("cancel_7z");
  });

  it("re-enables Cancel after a failed cancel_7z so the user can retry", async () => {
    await setupAndRun(
      async (cmd) => {
        if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
        if (cmd === "run_7z") {
          return await new Promise(() => {
            /* keep extraction running */
          });
        }
        if (cmd === "cancel_7z") {
          throw new Error("Could not stop 7z safely: permission denied");
        }
        return undefined;
      },
      { waitForSettle: false },
    );

    const cancelBtn = document.getElementById(
      "cancel-btn",
    ) as HTMLButtonElement;
    const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
    cancelBtn.click();
    await flushAsync();
    await flushAsync();

    expect(cancelBtn.disabled).toBe(false);
    expect(closeBtn.disabled).toBe(false);
    expect(
      (document.getElementById("error-detail") as HTMLElement).textContent,
    ).toContain("Could not stop 7z safely");
  });

  it("removes a registered progress listener when its sibling registration fails", async () => {
    const unlistenStructured = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await setupAndRun(undefined, {
      listenerRegistrations: [
        Promise.resolve(unlistenStructured),
        Promise.reject(new Error("raw listener unavailable")),
      ],
    });

    expect(unlistenStructured).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("raw listener unavailable"),
    );
    warning.mockRestore();
  });

  it("removes every registered progress listener when one cleanup throws", async () => {
    const failingUnlisten = vi.fn(() => {
      throw new Error("structured cleanup unavailable");
    });
    const rawUnlisten = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await setupAndRun(undefined, {
      listenerRegistrations: [
        Promise.resolve(failingUnlisten),
        Promise.resolve(rawUnlisten),
      ],
    });

    expect(failingUnlisten).toHaveBeenCalledOnce();
    expect(rawUnlisten).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("structured cleanup unavailable"),
    );
    warning.mockRestore();
  });

  it("extracts opened archives into a sibling folder named after the archive", async () => {
    const { invokeMock } = await setupAndRun(async (cmd, _payload) => {
      if (cmd === "get_extract_paths") return ["/Downloads/test.zip"];
      if (cmd === "run_7z") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });

    expect(
      (document.getElementById("extract-dest") as HTMLElement).textContent,
    ).toBe("/Downloads/test");

    expect(invokeMock).toHaveBeenCalledWith("run_7z", {
      args: [
        "x",
        "-o/Downloads/test",
        "-aou",
        "-bb1",
        "-bsp1",
        "--",
        "/Downloads/test.zip",
      ],
      expectedArchiveIdentity: "identity:/Downloads/test.zip",
    });
    expect(
      invokeMock.mock.calls.filter(([name]) => name === "run_7z"),
    ).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([name]) => name === "probe_7z")).toBe(
      true,
    );
  });

  it("keeps the window open when backend close cannot finish safely", async () => {
    const { appWindow } = await setupAndRun(async (cmd) => {
      if (cmd === "get_extract_paths") return [];
      if (cmd === "close_extract_window")
        throw new Error("backend close failed");
      return undefined;
    });

    (document.getElementById("close-btn") as HTMLButtonElement).click();
    await flushAsync();

    expect(appWindow.close).not.toHaveBeenCalled();
    expect(appWindow.destroy).not.toHaveBeenCalled();
    expect(document.getElementById("extract-status")?.textContent).toBe(
      "Waiting for cleanup",
    );
  });

  it("shows open destination error without crashing", async () => {
    const { invokeMock } = await setupAndRun(async (cmd, _payload) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "run_7z") {
        return { stdout: "", stderr: "warning only", code: 1 };
      }
      if (cmd === "open_path") throw new Error("permission denied");
      return undefined;
    });

    (
      document.getElementById("open-destination-btn") as HTMLButtonElement
    ).click();
    await flushAsync();

    expect(invokeMock.mock.calls.some(([name]) => name === "open_path")).toBe(
      true,
    );
    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("Done (open destination failed)");
    expect(
      (document.querySelector(".extract-error-title") as HTMLElement)
        .textContent,
    ).toBe("Could not open destination");
    expect(
      (document.getElementById("error-detail") as HTMLElement).textContent,
    ).toContain("permission denied");
  });
});

describe("sanitizeStatusFileName", () => {
  it("strips leading symbol junk before the real filename", async () => {
    mountExtractDom();
    const { sanitizeStatusFileName } = await import("../extract-window");
    expect(sanitizeStatusFileName("░░░░ ░░░░- insurance 2026.pdf")).toBe(
      "insurance 2026.pdf",
    );
    expect(sanitizeStatusFileName("*** file.txt")).toBe("file.txt");
    expect(sanitizeStatusFileName("■■■ report.pdf")).toBe("report.pdf");
  });

  it("keeps unicode letters and hidden-style names", async () => {
    mountExtractDom();
    const { sanitizeStatusFileName } = await import("../extract-window");
    expect(sanitizeStatusFileName("报告.pdf")).toBe("报告.pdf");
    expect(sanitizeStatusFileName(".hidden.txt")).toBe(".hidden.txt");
    expect(sanitizeStatusFileName("(report).txt")).toBe("(report).txt");
    expect(sanitizeStatusFileName("[draft] notes.txt")).toBe(
      "[draft] notes.txt",
    );
  });

  it("logs an injected-session queue drain failure without blocking extraction", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setupAndRun(
      async (cmd) => {
        if (cmd === "get_extract_paths") throw new Error("queue unavailable");
        if (cmd === "run_7z") return { stdout: "", stderr: "", code: 0 };
        return undefined;
      },
      {
        injected: { archive: "/tmp/injected.7z", destination: "/tmp/out" },
      },
    );

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Could not drain quick-extract launch queue"),
    );
    expect(document.getElementById("extract-status")?.textContent).toBe("Done");
    warning.mockRestore();
  });

  it("returns empty for replacement-only junk", async () => {
    mountExtractDom();
    const { sanitizeStatusFileName } = await import("../extract-window");
    expect(sanitizeStatusFileName("\uFFFD\uFFFD")).toBe("");
  });
});

describe("formatEta", () => {
  it("returns empty before any progress", async () => {
    mountExtractDom();
    const { formatEta } = await import("../extract-window");
    expect(formatEta(0, 0)).toBe("");
    expect(formatEta(1000, 0)).toBe("");
    expect(formatEta(1000, 100)).toBe("");
  });

  it("estimates seconds remaining", async () => {
    mountExtractDom();
    const { formatEta } = await import("../extract-window");
    // 50% in 10s → ~10s left
    expect(formatEta(10_000, 50)).toBe("~10s left");
  });

  it("formats minutes and seconds for longer waits", async () => {
    mountExtractDom();
    const { formatEta } = await import("../extract-window");
    // 10% in 18s → total 180s, remaining 162s → 2m 42s
    expect(formatEta(18_000, 10)).toBe("~2m 42s left");
  });
});
