import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const confirmMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

import {
  confirmZipSymlinkRisk,
  formatWeakForSymlinks,
} from "../archive/compress-fidelity";

describe("compress fidelity helpers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    confirmMock.mockReset();
  });

  it("treats only zip as weak for symlinks", () => {
    expect(formatWeakForSymlinks("zip")).toBe(true);
    expect(formatWeakForSymlinks("ZIP")).toBe(true);
    expect(formatWeakForSymlinks("7z")).toBe(false);
    expect(formatWeakForSymlinks("tar")).toBe(false);
  });

  it("skips probing for non-zip formats", async () => {
    await expect(confirmZipSymlinkRisk("7z", ["/App.app"])).resolves.toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("asks before zip when nested links or apps are present", async () => {
    invokeMock.mockResolvedValue({
      nestedSymlinks: 2,
      appBundles: 1,
      nestedReparsePoints: 0,
      examples: ["/Demo.app"],
    });
    confirmMock.mockResolvedValue(true);
    await expect(confirmZipSymlinkRisk("zip", ["/Demo.app"])).resolves.toBe(
      true,
    );
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("does not ask when zip inputs have no links or apps", async () => {
    invokeMock.mockResolvedValue({
      nestedSymlinks: 0,
      appBundles: 0,
      nestedReparsePoints: 0,
      examples: [],
    });
    await expect(confirmZipSymlinkRisk("zip", ["/a.txt"])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("asks when zip probe fails instead of silently continuing", async () => {
    invokeMock.mockRejectedValue(new Error("too large"));
    confirmMock.mockResolvedValue(false);
    await expect(confirmZipSymlinkRisk("zip", ["/a"])).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledOnce();
  });
});
