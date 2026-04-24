import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";
import { executeQuickAction } from "../quick-actions";

const mocks = vi.hoisted(() => ({
  runAction: vi.fn().mockResolvedValue(undefined),
  testArchive: vi.fn().mockResolvedValue("passed"),
  browseArchive: vi.fn().mockResolvedValue(null),
  previewCommand: vi.fn().mockResolvedValue(undefined),
  openSelectiveExtractModal: vi.fn().mockResolvedValue(undefined),
  applyPreset: vi.fn(),
  onCompressionOptionChange: vi.fn(),
  getCompressionSecuritySupport: vi.fn(() => ({
    password: true,
    encryptHeaders: true,
  })),
}));

vi.mock("../archive", () => ({
  runAction: mocks.runAction,
  testArchive: mocks.testArchive,
  browseArchive: mocks.browseArchive,
  previewCommand: mocks.previewCommand,
  openSelectiveExtractModal: mocks.openSelectiveExtractModal,
}));

vi.mock("../presets", () => ({
  applyPreset: mocks.applyPreset,
  onCompressionOptionChange: mocks.onCompressionOptionChange,
}));

vi.mock("../compression-security", () => ({
  getCompressionSecuritySupport: mocks.getCompressionSecuritySupport,
}));

beforeEach(() => {
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.lastQuickActionByMode = {};
  state.running = false;
  const app = document.getElementById("app") as HTMLElement;
  app.dataset.mode = "add";
  const format = document.getElementById("format") as HTMLSelectElement;
  format.value = "7z";
  const password = document.getElementById("password") as HTMLInputElement;
  password.value = "";
  const feedback = document.getElementById(
    "quick-action-feedback",
  ) as HTMLElement;
  feedback.textContent = "";
  feedback.hidden = true;

  mocks.runAction.mockClear();
  mocks.testArchive.mockClear();
  mocks.browseArchive.mockClear();
  mocks.previewCommand.mockClear();
  mocks.openSelectiveExtractModal.mockClear();
  mocks.applyPreset.mockClear();
  mocks.onCompressionOptionChange.mockClear();
  mocks.getCompressionSecuritySupport.mockClear();
  mocks.getCompressionSecuritySupport.mockReturnValue({
    password: true,
    encryptHeaders: true,
  });
});

describe("executeQuickAction", () => {
  it("runs balanced preset quick action and stores repeat context", async () => {
    await executeQuickAction("add-run-balanced");
    expect(mocks.applyPreset).toHaveBeenCalledWith("balanced");
    expect(mocks.onCompressionOptionChange).toHaveBeenCalled();
    expect(mocks.runAction).toHaveBeenCalled();
    expect(state.lastQuickActionByMode.add).toBe("add-run-balanced");
  });

  it("shows feedback when repeating without prior quick action", async () => {
    await executeQuickAction("add-repeat");
    const feedback = document.getElementById("quick-action-feedback");
    expect(feedback?.textContent).toContain("No prior quick action");
  });

  it("blocks encrypt-run when password is missing", async () => {
    await executeQuickAction("add-encrypt-run");
    const feedback = document.getElementById("quick-action-feedback");
    expect(feedback?.textContent).toContain("Enter a password first");
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("repeats last quick action for mode", async () => {
    state.lastQuickActionByMode.add = "add-run-ultra";
    await executeQuickAction("add-repeat");
    expect(mocks.applyPreset).toHaveBeenCalledWith("ultra");
    expect(mocks.runAction).toHaveBeenCalled();
  });

  it("skips extract-after-test when integrity test does not pass", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "extract";
    mocks.testArchive.mockResolvedValueOnce("failed");

    await executeQuickAction("extract-test-then-extract");

    expect(mocks.runAction).not.toHaveBeenCalled();
    const feedback = document.getElementById("quick-action-feedback");
    expect(feedback?.textContent).toContain("did not pass");
  });

  it("runs extract-after-test when integrity test passes with warnings", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "extract";
    mocks.testArchive.mockResolvedValueOnce("passed_with_warnings");

    await executeQuickAction("extract-test-then-extract");

    expect(mocks.runAction).toHaveBeenCalled();
  });
});
