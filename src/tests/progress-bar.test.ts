import { describe, expect, it } from "vitest";
import {
  clearProgressPercentClass,
  setProgressIndeterminateClass,
  setProgressPercentClass,
} from "../progress-bar";

describe("progress-bar classes", () => {
  it("sets determinate pct class and clears indeterminate", () => {
    const el = document.createElement("div");
    el.classList.add("is-indeterminate", "pct-12");
    setProgressPercentClass(el, 45.6);
    expect(el.classList.contains("is-determinate")).toBe(true);
    expect(el.classList.contains("is-indeterminate")).toBe(false);
    expect(el.classList.contains("pct-46")).toBe(true);
    expect(el.classList.contains("pct-12")).toBe(false);
  });

  it("clamps percent into 0..100", () => {
    const el = document.createElement("div");
    setProgressPercentClass(el, -5);
    expect(el.classList.contains("pct-0")).toBe(true);
    setProgressPercentClass(el, 140);
    expect(el.classList.contains("pct-100")).toBe(true);
    expect(el.classList.contains("pct-0")).toBe(false);
  });

  it("restores indeterminate and clears pct classes", () => {
    const el = document.createElement("div");
    setProgressPercentClass(el, 80);
    setProgressIndeterminateClass(el);
    expect(el.classList.contains("is-indeterminate")).toBe(true);
    expect(el.classList.contains("is-determinate")).toBe(false);
    expect([...el.classList].some((name) => name.startsWith("pct-"))).toBe(
      false,
    );
    clearProgressPercentClass(el);
  });
});
