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

  it("dismisses on click", () => {
    showToast("Tap", "info", 0);
    const toast = document.querySelector(".toast") as HTMLElement;
    toast.click();
    vi.advanceTimersByTime(200);
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });
});
