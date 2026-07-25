import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-dom";

describe("power-helpers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("detects editable targets", async () => {
    const { isEditableTarget } = await import("../power-helpers");
    const input = document.createElement("input");
    const div = document.createElement("div");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("toggles password visibility", async () => {
    const { togglePasswordVisibility } = await import("../power-helpers");
    const input = document.getElementById("password") as HTMLInputElement;
    input.type = "password";
    const btn = document.getElementById("toggle-password") as HTMLButtonElement;
    expect(input.type).toBe("password");
    togglePasswordVisibility("password", "toggle-password");
    expect(input.type).toBe("text");
    expect(btn.textContent).toBe("Hide");
    togglePasswordVisibility("password", "toggle-password");
    expect(input.type).toBe("password");
    expect(btn.textContent).toBe("Show");
  });

  it("resets runtime state for first run", async () => {
    const { state } = await import("../state");
    state.inputs.push("/tmp/a.7z");
    state.lastAutoOutputPath = "/tmp/out.7z";
    const { resetRuntimeStateForFirstRun } = await import("../power-helpers");
    resetRuntimeStateForFirstRun();
    expect(state.inputs).toEqual([]);
    expect(state.lastAutoOutputPath).toBeNull();
  });
  it("wires password toggles once", async () => {
    const { wirePasswordToggle } = await import("../power-helpers");
    const input = document.getElementById("password") as HTMLInputElement;
    input.type = "password";
    const btn = document.getElementById("toggle-password") as HTMLButtonElement;
    wirePasswordToggle("password", "toggle-password");
    wirePasswordToggle("password", "toggle-password");
    btn.click();
    expect(input.type).toBe("text");
  });
});

describe("power-shortcuts", () => {
  beforeEach(() => {
    vi.resetModules();
    const overlay = document.getElementById("shortcuts-overlay") as HTMLElement;
    overlay.hidden = true;
  });

  it("opens and closes the shortcuts modal", async () => {
    const { openShortcutsModal, closeShortcutsModal } =
      await import("../power-shortcuts");
    const overlay = document.getElementById("shortcuts-overlay") as HTMLElement;
    expect(overlay.hidden).toBe(true);
    openShortcutsModal();
    expect(overlay.hidden).toBe(false);
    closeShortcutsModal();
    expect(overlay.hidden).toBe(true);
  });

  it("wires shortcut close handlers", async () => {
    const { wireShortcutsEvents, openShortcutsModal } =
      await import("../power-shortcuts");
    wireShortcutsEvents();
    openShortcutsModal();
    const overlay = document.getElementById("shortcuts-overlay") as HTMLElement;
    expect(overlay.hidden).toBe(false);
    document.getElementById("close-shortcuts")!.click();
    expect(overlay.hidden).toBe(true);
  });

  it("wires footer and backdrop close handlers", async () => {
    const { wireShortcutsEvents, openShortcutsModal } =
      await import("../power-shortcuts");
    const overlay = document.getElementById("shortcuts-overlay") as HTMLElement;
    wireShortcutsEvents();

    openShortcutsModal();
    document.getElementById("close-shortcuts-footer")!.click();
    expect(overlay.hidden).toBe(true);

    openShortcutsModal();
    overlay.click();
    expect(overlay.hidden).toBe(true);
  });

  it("ignores duplicate close and backdrop clicks from modal children", async () => {
    const { wireShortcutsEvents, openShortcutsModal, closeShortcutsModal } =
      await import("../power-shortcuts");
    const overlay = document.getElementById("shortcuts-overlay") as HTMLElement;
    const modal = overlay.querySelector<HTMLElement>(".modal")!;
    wireShortcutsEvents();

    closeShortcutsModal();
    expect(overlay.hidden).toBe(true);

    openShortcutsModal();
    modal.click();
    expect(overlay.hidden).toBe(false);
    closeShortcutsModal();
  });
});
