import { describe, it, expect } from "vitest";
import { promptInput } from "../prompt-modal";

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
});
