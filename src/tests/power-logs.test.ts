import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-dom";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

const uiMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

vi.mock("../ui", () => ({
  log: uiMocks.log,
}));

describe("power-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockReset();
    vi.mocked(ask).mockReset();
    vi.mocked(ask).mockResolvedValue(false);
    document.getElementById("toast-region")?.remove();
  });

  it("exports logs and shows success", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    const { exportLocalLogs } = await import("../power-logs");
    await exportLocalLogs();
    expect(invoke).toHaveBeenCalledWith("export_logs");
    expect(uiMocks.log).toHaveBeenCalledWith("Logs exported successfully.");
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "Logs exported successfully.",
    );
  });

  it("skips dialog when export is cancelled", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const { exportLocalLogs } = await import("../power-logs");
    await exportLocalLogs();
    expect(document.getElementById("toast-region")).toBeNull();
  });

  it("opens the logs folder", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { openLogsFolder } = await import("../power-logs");
    await openLogsFolder();
    expect(invoke).toHaveBeenCalledWith("open_log_dir");
    expect(uiMocks.log).toHaveBeenCalledWith("Opened local logs folder.");
  });

  it("clears logs only after confirm", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { clearLocalLogs } = await import("../power-logs");
    await clearLocalLogs();
    expect(invoke).toHaveBeenCalledWith("clear_logs");
    expect(uiMocks.log).toHaveBeenCalledWith("Local diagnostics logs cleared.");
  });

  it("does not clear logs when confirm is cancelled", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    const { clearLocalLogs } = await import("../power-logs");
    await clearLocalLogs();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("surfaces export failures", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("disk full"));
    const { exportLocalLogs } = await import("../power-logs");
    await exportLocalLogs();
    expect(uiMocks.log).toHaveBeenCalledWith(
      expect.stringContaining("Failed to export logs"),
      "error",
    );
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "Failed to export logs. disk full",
    );
  });

  it("surfaces open-folder failures", async () => {
    vi.mocked(invoke).mockRejectedValue("folder unavailable");
    const { openLogsFolder } = await import("../power-logs");
    await openLogsFolder();
    expect(uiMocks.log).toHaveBeenCalledWith(
      expect.stringContaining("folder unavailable"),
      "error",
    );
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "Failed to open logs folder. folder unavailable",
    );
  });

  it("surfaces clear failures", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(invoke).mockRejectedValue(new Error("locked"));
    const { clearLocalLogs } = await import("../power-logs");
    await clearLocalLogs();
    expect(uiMocks.log).toHaveBeenCalledWith(
      expect.stringContaining("Failed to clear logs"),
      "error",
    );
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "Failed to clear logs. locked",
    );
  });
});
