import { describe, it, expect } from "vitest";
import { confirmChoice, promptInput } from "../prompt-modal";

describe("promptInput", () => {
  it("resolves with the entered value on confirm", async () => {
    const p = promptInput({ title: "T", label: "L", defaultValue: "seed" });
    const field = document.getElementById(
      "input-modal-field",
    ) as HTMLInputElement;
    expect(document.getElementById("input-modal-overlay")?.hidden).toBe(false);
    field.value = "hello";
    document
      .getElementById("input-modal-confirm")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(await p).toBe("hello");
    expect(document.getElementById("input-modal-overlay")?.hidden).toBe(true);
  });

  it("resolves null on cancel", async () => {
    const p = promptInput({ title: "T", label: "L" });
    document
      .getElementById("input-modal-cancel")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(await p).toBeNull();
  });

  it("confirms on Enter and cancels on Escape", async () => {
    const p1 = promptInput({ title: "T", label: "L" });
    const field = document.getElementById(
      "input-modal-field",
    ) as HTMLInputElement;
    field.value = "viaEnter";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(await p1).toBe("viaEnter");

    const p2 = promptInput({ title: "T", label: "L" });
    document
      .getElementById("input-modal-field")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    expect(await p2).toBeNull();
  });

  it("cancels on Escape when focus moved off input", async () => {
    const p = promptInput({ title: "T", label: "L" });
    const cancelBtn = document.getElementById(
      "input-modal-cancel",
    ) as HTMLButtonElement;
    cancelBtn.focus();
    cancelBtn.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(await p).toBeNull();
  });

  it.each(["input-modal-cancel", "input-modal-cancel-x"])(
    "cancels on Enter from %s",
    async (id) => {
      const p = promptInput({
        title: "T",
        label: "L",
        defaultValue: "must-not-submit",
      });
      const cancel = document.getElementById(id) as HTMLButtonElement;
      cancel.focus();
      cancel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      expect(await p).toBeNull();
    },
  );

  it("applies password type when requested", async () => {
    const p = promptInput({ title: "T", label: "L", password: true });
    const field = document.getElementById(
      "input-modal-field",
    ) as HTMLInputElement;
    expect(field.type).toBe("password");
    document
      .getElementById("input-modal-cancel")
      ?.dispatchEvent(new MouseEvent("click"));
    await p;
  });

  it("applies placeholder and confirm label options", async () => {
    const p = promptInput({
      title: "Name",
      label: "Preset",
      placeholder: "My preset",
      confirmLabel: "Save",
    });
    const field = document.getElementById(
      "input-modal-field",
    ) as HTMLInputElement;
    expect(field.placeholder).toBe("My preset");
    expect(document.getElementById("input-modal-confirm")?.textContent).toBe(
      "Save",
    );
    document
      .getElementById("input-modal-cancel")
      ?.dispatchEvent(new MouseEvent("click"));
    await p;
  });

  it("cancels when the overlay backdrop is clicked", async () => {
    const p = promptInput({ title: "T", label: "L" });
    const overlay = document.getElementById(
      "input-modal-overlay",
    ) as HTMLElement;
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: overlay });
    overlay.dispatchEvent(event);
    expect(await p).toBeNull();
  });

  it("cancels via the X button when present", async () => {
    const p = promptInput({ title: "T", label: "L" });
    const cancelX = document.getElementById("input-modal-cancel-x");
    expect(cancelX).toBeTruthy();
    cancelX!.dispatchEvent(new MouseEvent("click"));
    expect(await p).toBeNull();
  });

  it("rejects a concurrent prompt instead of sharing or overwriting it", async () => {
    const first = promptInput({ title: "First", label: "Password" });
    const second = promptInput({ title: "Second", label: "Other" });
    expect(await second).toBeNull();
    expect(document.getElementById("input-modal-title")?.textContent).toBe(
      "First",
    );
    document
      .getElementById("input-modal-cancel")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(await first).toBeNull();
  });

  it("returns null when required modal nodes are missing", async () => {
    const field = document.getElementById("input-modal-field");
    const parent = field?.parentElement;
    field?.remove();
    expect(await promptInput({ title: "T", label: "L" })).toBeNull();
    if (parent && field) parent.appendChild(field);
  });
});

describe("confirmChoice", () => {
  it("resolves true on confirm and restores the prompt field", async () => {
    const field = document.getElementById(
      "input-modal-field",
    ) as HTMLInputElement;
    const p = confirmChoice({
      title: "Destination already exists",
      message: "Existing items will be kept.",
      confirmLabel: "Extract safely",
      cancelLabel: "Cancel",
    });
    expect(document.getElementById("input-modal-overlay")?.hidden).toBe(false);
    expect(field.hidden).toBe(true);
    expect(document.getElementById("input-modal-confirm")?.textContent).toBe(
      "Extract safely",
    );
    document
      .getElementById("input-modal-confirm")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(await p).toBe(true);
    expect(document.getElementById("input-modal-overlay")?.hidden).toBe(true);
    expect(field.hidden).toBe(false);
  });

  it("resolves false on cancel", async () => {
    const p = confirmChoice({ title: "T", message: "M" });
    document
      .getElementById("input-modal-cancel")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(await p).toBe(false);
  });

  it("confirms on Enter and cancels on Escape", async () => {
    const p1 = confirmChoice({ title: "T", message: "M" });
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(await p1).toBe(true);

    const p2 = confirmChoice({ title: "T", message: "M" });
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(await p2).toBe(false);
  });

  it.each(["input-modal-cancel", "input-modal-cancel-x"])(
    "cancels on Enter from %s",
    async (id) => {
      const p = confirmChoice({ title: "T", message: "M" });
      const cancel = document.getElementById(id) as HTMLButtonElement;
      cancel.focus();
      cancel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      expect(await p).toBe(false);
    },
  );

  it("rejects a concurrent confirm instead of sharing the open prompt", async () => {
    const first = promptInput({ title: "First", label: "Password" });
    const second = confirmChoice({ title: "Second", message: "Other" });
    expect(await second).toBe(false);
    expect(document.getElementById("input-modal-title")?.textContent).toBe(
      "First",
    );
    document
      .getElementById("input-modal-cancel")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(await first).toBeNull();
  });

  it("returns false when required modal nodes are missing", async () => {
    const field = document.getElementById("input-modal-field");
    const parent = field?.parentElement;
    field?.remove();
    expect(await confirmChoice({ title: "T", message: "M" })).toBe(false);
    if (parent && field) parent.appendChild(field);
  });
});
