import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";
import {
  executeQuickAction,
  refreshQuickActionRepeatState,
  wireQuickActionEvents,
} from "../quick-actions";

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

  it("runs encrypt quick action when password is present", async () => {
    const password = document.getElementById("password") as HTMLInputElement;
    const encryptHeaders = document.getElementById(
      "encrypt-headers",
    ) as HTMLInputElement;
    password.value = "secret";
    encryptHeaders.checked = false;

    await executeQuickAction("add-encrypt-run");

    expect(encryptHeaders.checked).toBe(true);
    expect(mocks.runAction).toHaveBeenCalled();
  });

  it("shows unsupported encryption feedback for unsupported format", async () => {
    const format = document.getElementById("format") as HTMLSelectElement;
    format.value = "tar";
    mocks.getCompressionSecuritySupport.mockReturnValueOnce({
      password: false,
      encryptHeaders: false,
    });

    await executeQuickAction("add-encrypt-run");

    const feedback = document.getElementById("quick-action-feedback");
    expect(feedback?.textContent).toContain("TAR does not support password");
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("routes preview/list/selective quick actions to their handlers", async () => {
    const trigger = document.createElement("button");

    await executeQuickAction("add-preview", trigger);
    expect(mocks.previewCommand).toHaveBeenCalledWith(trigger);

    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "extract";
    await executeQuickAction("extract-now");
    await executeQuickAction("extract-selective");
    await executeQuickAction("extract-preview", trigger);

    app.dataset.mode = "browse";
    await executeQuickAction("browse-list");
    await executeQuickAction("browse-test");
    await executeQuickAction("browse-selective");

    expect(mocks.runAction).toHaveBeenCalled();
    expect(mocks.openSelectiveExtractModal).toHaveBeenCalledTimes(2);
    expect(mocks.browseArchive).toHaveBeenCalled();
    expect(mocks.testArchive).toHaveBeenCalled();
  });

  it("switches browse mode to extract", async () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "browse";

    await executeQuickAction("browse-switch-extract");

    expect(app.dataset.mode).toBe("extract");
  });
});

describe("quick action wiring", () => {
  it("disables repeat buttons when no replay target exists in active mode", () => {
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    state.lastQuickActionByMode = {};

    refreshQuickActionRepeatState();

    expect(
      (document.getElementById("quick-add-repeat") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (document.getElementById("quick-extract-repeat") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("wires click handlers and ignores clicks while running", async () => {
    const runBtn = document.getElementById(
      "quick-add-balanced",
    ) as HTMLButtonElement;

    wireQuickActionEvents();

    state.running = true;
    runBtn.click();
    await Promise.resolve();
    expect(mocks.runAction).not.toHaveBeenCalled();

    state.running = false;
    runBtn.click();
    await Promise.resolve();
    expect(mocks.runAction).toHaveBeenCalled();
  });
});
