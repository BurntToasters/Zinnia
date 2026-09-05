import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirmExtractDestination } from "../extract-destination";

const e2eEnv = vi.hoisted(() => ({
  isE2eFrontend: vi.fn(() => false),
}));
vi.mock("../e2e-env", () => e2eEnv);

const confirmChoice = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../prompt-modal", () => ({
  promptInput: vi.fn(),
  confirmChoice,
}));

const invokeMock = vi.mocked(invoke);

describe("confirmExtractDestination", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    confirmChoice.mockReset();
    confirmChoice.mockResolvedValue(true);
    e2eEnv.isE2eFrontend.mockReturnValue(false);
  });

  it("continues when the destination does not exist", async () => {
    invokeMock.mockResolvedValue("missing");
    await expect(confirmExtractDestination("/tmp/new-out")).resolves.toBe(true);
    expect(confirmChoice).not.toHaveBeenCalled();
  });

  it("warns when merging into an existing directory", async () => {
    invokeMock.mockResolvedValue("directory");
    confirmChoice.mockResolvedValue(false);
    await expect(confirmExtractDestination("/tmp/out")).resolves.toBe(false);
    expect(confirmChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Destination already exists",
        confirmLabel: "Extract safely",
        message: expect.stringContaining("Existing items will be kept"),
      }),
    );
  });

  it("rejects files, links, and other non-directory destinations", async () => {
    invokeMock.mockResolvedValue("invalid");
    await expect(confirmExtractDestination("/tmp/out")).rejects.toThrow(
      /not a file, symbolic link, or reparse point/,
    );
    expect(confirmChoice).not.toHaveBeenCalled();
  });

  it("rejects an empty destination before inspecting", async () => {
    await expect(confirmExtractDestination("   ")).rejects.toThrow(
      "Choose a destination folder.",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("skips dialogs in unpackaged E2E builds so CI can run headless", async () => {
    e2eEnv.isE2eFrontend.mockReturnValue(true);
    invokeMock.mockResolvedValue("directory");
    await expect(confirmExtractDestination("/tmp/out")).resolves.toBe(true);
    expect(confirmChoice).not.toHaveBeenCalled();
  });
});
