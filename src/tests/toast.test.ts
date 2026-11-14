import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { showToast } from "../toast";

beforeEach(() => {
  vi.useFakeTimers();
  document.getElementById("toast-region")?.remove();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showToast", () => {
  it("creates the region on first use and appends a toast", () => {
    showToast("Saved", "success");
    const region = document.getElementById("toast-region");
    expect(region).not.toBeNull();
    const toast = region?.querySelector(".toast");
    expect(toast?.textContent).toBe("Saved");
    expect(region?.hasAttribute("aria-live")).toBe(false);
    expect(toast?.classList.contains("toast--success")).toBe(true);
  });

  it("reuses the same region for multiple toasts", () => {
    showToast("One");
    showToast("Two");
    const regions = document.querySelectorAll("#toast-region");
    expect(regions).toHaveLength(1);
    expect(regions[0].querySelectorAll(".toast")).toHaveLength(2);
  });

  it("uses role=alert for errors and role=status otherwise", () => {
    showToast("Boom", "error");
    showToast("Note", "info");
    const toasts = document.querySelectorAll(".toast");
    expect(toasts[0].getAttribute("role")).toBe("alert");
    expect(toasts[1].getAttribute("role")).toBe("status");
  });

  it("auto-dismisses after the duration", () => {
    showToast("Bye", "info", 1000);
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    vi.advanceTimersByTime(1000); // dismiss timer
    vi.advanceTimersByTime(200); // removal timer
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("pauses auto-dismiss while hovered and resumes with the remaining time", () => {
    showToast("Hover", "info", 1000);
    const toast = document.querySelector(".toast") as HTMLElement;
    vi.advanceTimersByTime(300);
    toast.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(5000);
    expect(toast.classList.contains("toast--leaving")).toBe(false);
    toast.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(699);
    expect(toast.classList.contains("toast--leaving")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.classList.contains("toast--leaving")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("keeps a timed toast paused while focus and hover overlap", () => {
    showToast("Focus", "success", 1000);
    const toast = document.querySelector(".toast") as HTMLElement;
    toast.dispatchEvent(new Event("focusin"));
    toast.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(5000);
    toast.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(5000);
    expect(toast.classList.contains("toast--leaving")).toBe(false);
    toast.dispatchEvent(new Event("focusout"));
    vi.advanceTimersByTime(1000);
    expect(toast.classList.contains("toast--leaving")).toBe(true);
  });

  it("keeps the toast when its body or text is clicked", () => {
    showToast("Tap", "info", 0);
    const toast = document.querySelector(".toast") as HTMLElement;
    expect(toast.tabIndex).toBe(0);
    toast.click();
    (toast.querySelector(".toast-message") as HTMLElement).click();
    vi.advanceTimersByTime(200);
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    expect(toast.classList.contains("toast--leaving")).toBe(false);
  });

  it("dismisses through the close button", () => {
    showToast("Close me", "error", 0);
    const toast = document.querySelector(".toast") as HTMLElement;
    toast.querySelector<HTMLButtonElement>(".toast-dismiss")?.click();
    vi.advanceTimersByTime(200);
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("offers Copy on error toasts only and copies the message text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      showToast("Could not read archive. Details here", "error", 0);
      const toast = document.querySelector(".toast") as HTMLElement;
      const copy = toast.querySelector<HTMLButtonElement>(".toast-copy");
      expect(copy?.textContent).toBe("Copy");
      copy?.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      expect(writeText).toHaveBeenCalledWith(
        "Could not read archive. Details here",
      );
      expect(document.querySelectorAll(".toast")).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("shows no Copy button on success or info toasts", () => {
    showToast("Saved", "success");
    showToast("Note", "info");
    expect(document.querySelectorAll(".toast-copy")).toHaveLength(0);
  });

  it("collapses an identical visible toast and shows how many times it fired", () => {
    showToast("Select an archive to test.", "info", 0);
    showToast("Select an archive to test.", "info", 0);
    const toasts = document.querySelectorAll(".toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0].querySelector(".toast-count")?.textContent).toBe("(2)");
  });

  it("keeps toasts with different text or kind separate", () => {
    showToast("Same", "info", 0);
    showToast("Other", "info", 0);
    showToast("Same", "error", 0);
    expect(document.querySelectorAll(".toast")).toHaveLength(3);
  });

  it("restarts the timer of a collapsed timed toast", () => {
    showToast("Again", "info", 1000);
    vi.advanceTimersByTime(800);
    showToast("Again", "info", 1000);
    const toast = document.querySelector(".toast") as HTMLElement;
    vi.advanceTimersByTime(800);
    expect(toast.classList.contains("toast--leaving")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(toast.classList.contains("toast--leaving")).toBe(true);
  });

  it("dismisses sticky toasts with Escape", () => {
    showToast("Sticky", "error", 0);
    const toast = document.querySelector(".toast") as HTMLElement;
    toast.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    vi.advanceTimersByTime(200);
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("bounds hostile or oversized feedback text", () => {
    showToast("x".repeat(10_000), "error", 0);
    const text = document.querySelector(".toast")?.textContent ?? "";
    expect(text).toContain("[truncated");
    expect(text.length).toBeLessThan(4_100);
  });

  it("keeps success and error tints over the opaque toast surface", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "src/styles/main-mid-overlay-toast.css"),
      "utf8",
    );
    expect(css.match(/\.toast\s*{([\s\S]*?)}/)?.[1]).toContain(
      "background: var(--surface)",
    );
    for (const kind of ["success", "error"]) {
      const rule = css.match(
        new RegExp(`\\.toast--${kind}\\s*{([\\s\\S]*?)}`),
      )?.[1];
      expect(rule).toContain("background-image: linear-gradient(");
      expect(rule).not.toMatch(/(^|\n)\s*background:/);
    }
  });
});
