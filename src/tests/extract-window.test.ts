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

async function setupAndRun(invokeImpl?: AnyInvoke): Promise<{
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

  const core = await import("@tauri-apps/api/core");
  const eventApi = await import("@tauri-apps/api/event");
  const webviewApi = await import("@tauri-apps/api/webviewWindow");

  const invokeMock = vi.mocked(core.invoke);
  const progressUnlisten = vi.fn();
  const appWindow = {
    close: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(eventApi.listen).mockImplementation(async () => progressUnlisten);
  vi.mocked(webviewApi.getCurrentWebviewWindow).mockReturnValue(
    appWindow as never,
  );

  const defaultInvoke: AnyInvoke = async (cmd, payload) => {
    if (cmd === "get_extract_paths") return ["/tmp/archive.zip"];
    if (cmd === "probe_7z") return undefined;
    if (cmd === "run_7z") {
      const args = (payload as { args?: string[] } | undefined)?.args ?? [];
      if (args[0] === "l") {
        return { stdout: "- one\n- two\n", stderr: "", code: 0 };
      }
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

  it("shows error when runtime probe fails", async () => {
    await setupAndRun(async (cmd) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "probe_7z") throw new Error("missing sidecar");
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

  it("renders warnings when extraction exits with code 1", async () => {
    await setupAndRun(async (cmd, payload) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "probe_7z") return undefined;
      if (cmd === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        if (args[0] === "l") {
          return { stdout: "- entry\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "minor warning", code: 1 };
      }
      return undefined;
    });

    expect(
      (document.getElementById("extract-status") as HTMLElement).textContent,
    ).toBe("Done (with warnings)");
    expect(
      (document.getElementById("extract-error") as HTMLElement).hidden,
    ).toBe(false);
    expect(
      (document.querySelector(".extract-error-title") as HTMLElement)
        .textContent,
    ).toBe("Warnings");
    expect(
      (document.getElementById("open-destination-btn") as HTMLButtonElement)
        .hidden,
    ).toBe(false);
  });

  it("shows failure details for non-warning extraction failures", async () => {
    await setupAndRun(async (cmd, payload) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "probe_7z") return undefined;
      if (cmd === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        if (args[0] === "l") {
          return { stdout: "- entry\n", stderr: "", code: 0 };
        }
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

  it("falls back to webview close and destroy when backend close command fails", async () => {
    const { appWindow } = await setupAndRun(async (cmd) => {
      if (cmd === "get_extract_paths") return [];
      if (cmd === "close_extract_window")
        throw new Error("backend close failed");
      return undefined;
    });

    appWindow.close.mockRejectedValueOnce(new Error("close failed"));
    appWindow.destroy.mockResolvedValueOnce(undefined);

    (document.getElementById("close-btn") as HTMLButtonElement).click();
    await flushAsync();

    expect(appWindow.close).toHaveBeenCalledOnce();
    expect(appWindow.destroy).toHaveBeenCalledOnce();
  });

  it("shows open destination error without crashing", async () => {
    const { invokeMock } = await setupAndRun(async (cmd, payload) => {
      if (cmd === "get_extract_paths") return ["/tmp/archive.7z"];
      if (cmd === "probe_7z") return undefined;
      if (cmd === "run_7z") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        if (args[0] === "l") {
          return { stdout: "- entry\n", stderr: "", code: 0 };
        }
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
