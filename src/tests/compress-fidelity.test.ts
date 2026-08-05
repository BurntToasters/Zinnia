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

  it("treats bundled formats as link-safe", () => {
    expect(formatWeakForSymlinks("zip")).toBe(false);
    expect(formatWeakForSymlinks("ZIP")).toBe(false);
    expect(formatWeakForSymlinks("7z")).toBe(false);
    expect(formatWeakForSymlinks("tar")).toBe(false);
  });

  it("skips probing for non-zip formats", async () => {
    await expect(confirmZipSymlinkRisk("7z", ["/App.app"])).resolves.toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not warn for zip trees with links or app bundles", async () => {
    await expect(confirmZipSymlinkRisk("zip", ["/Demo.app"])).resolves.toBe(
      true,
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("does not ask when zip inputs have no links or apps", async () => {
    await expect(confirmZipSymlinkRisk("zip", ["/a.txt"])).resolves.toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
