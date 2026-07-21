import { beforeEach, describe, expect, it, vi } from "vitest";

type AnyInvoke = (cmd: string, payload?: unknown) => unknown;

function mountExtractDom(): void {
  document.body.innerHTML = `
    <div id="extract-app" class="extract-app">
      <div class="extract-header"><h1>Extracting</h1></div>
      <div class="extract-body">
        <span id="archive-name"></span>
        <span id="extract-dest"></span>
        <div id="extract-progress" role="progressbar">
          <div id="progress-fill" class="extract-progress-fill"></div>
        </div>
        <div id="extract-status">Preparing...</div>
        <div id="extract-error" hidden>
          <div class="extract-error-title">Extraction failed</div>
          <pre id="error-detail"></pre>
        </div>
      </div>
      <div class="extract-footer">
        <button id="cancel-btn">Cancel</button>
        <button id="open-destination-btn" hidden>Open destination</button>
        <button id="close-btn" hidden>Close</button>
      </div>
    </div>
  `;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function setupAndRun(
  invokeImpl?: AnyInvoke,
  options?: {
    injected?: { archive: string; destination: string };
    listenerRegistrations?: Array<Promise<() => void>>;
  },
): Promise<{
  invokeMock: ReturnType<
    typeof vi.mocked<(typeof import("@tauri-apps/api/core"))["invoke"]>
  >;
  appWindow: {
    close: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  progressUnlisten: ReturnType<typeof vi.fn>;
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
    close: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  const listenerRegistrations = [...(options?.listenerRegistrations ?? [])];
  vi.mocked(eventApi.listen).mockImplementation(
    () => listenerRegistrations.shift() ?? Promise.resolve(progressUnlisten),
  );
  vi.mocked(webviewApi.getCurrentWebviewWindow).mockReturnValue(
    appWindow as never,
  );

  const defaultInvoke: AnyInvoke = async (cmd, _payload) => {
    if (cmd === "get_extract_paths") return ["/tmp/archive.zip"];
    if (cmd === "run_7z") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (cmd === "close_extract_window") return undefined;
    if (cmd === "open_path") return undefined;
    if (cmd === "cancel_7z") return undefined;
    return undefined;
  };

  invokeMock.mockImplementation((cmd, payload) =>
    Promise.resolve((invokeImpl ?? defaultInvoke)(cmd, payload)),
  );

  await import("../extract-window");
  await flushAsync();

  return { invokeMock, appWindow, progressUnlisten };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("extract-window", () => {
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

  it("treats warning exits as failed transactional extraction", async () => {
    await setupAndRun(async (cmd, _payload) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "run_7z") {
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
      (document.querySelector(".extract-error-title") as HTMLElement)
        .textContent,
    ).toBe("Extraction failed");
    expect(
      (document.getElementById("open-destination-btn") as HTMLButtonElement)
        .hidden,
    ).toBe(true);
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

  it("auto-closes after successful extraction", async () => {
    vi.useFakeTimers();

    const { invokeMock } = await setupAndRun();

    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("Done");

    vi.advanceTimersByTime(1201);
    await flushAsync();

    expect(
      invokeMock.mock.calls.some(([name]) => name === "close_extract_window"),
    ).toBe(true);
  });

  it("cancels auto-close when the user opens the destination", async () => {
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
    const { invokeMock } = await setupAndRun(async (cmd) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "run_7z") {
        return await new Promise((resolve) => {
          resolveRun = resolve;
        });
      }
      if (cmd === "cancel_7z") {
        resolveRun?.({ stdout: "", stderr: "", code: -1 });
        return undefined;
      }
      return undefined;
    });

    expect(
      (document.getElementById("cancel-btn") as HTMLButtonElement).disabled,
    ).toBe(false);

    (document.getElementById("cancel-btn") as HTMLButtonElement).click();
    await flushAsync();
    await flushAsync();

    expect(invokeMock).toHaveBeenCalledWith("cancel_7z");
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
    });
    expect(
      invokeMock.mock.calls.filter(([name]) => name === "run_7z"),
    ).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([name]) => name === "probe_7z")).toBe(
      false,
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
  });

  it("keeps unicode letters and hidden-style names", async () => {
    mountExtractDom();
    const { sanitizeStatusFileName } = await import("../extract-window");
    expect(sanitizeStatusFileName("报告.pdf")).toBe("报告.pdf");
    expect(sanitizeStatusFileName(".hidden.txt")).toBe(".hidden.txt");
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
