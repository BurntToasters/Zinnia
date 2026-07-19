/** CSP-safe progress width helpers (class-based; no element.style / inline CSS). */

const PCT_CLASS_RE = /^pct-\d{1,3}$/;

export function clearProgressPercentClass(el: HTMLElement): void {
  for (const name of [...el.classList]) {
    if (PCT_CLASS_RE.test(name)) el.classList.remove(name);
  }
}

/** Apply determinate progress 0-100 via `pct-N` + `is-determinate`. */
export function setProgressPercentClass(
  el: HTMLElement,
  percent: number,
): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  clearProgressPercentClass(el);
  el.classList.remove("is-indeterminate");
  el.classList.add("is-determinate", `pct-${clamped}`);
}

/** Restore indeterminate animation classes and clear determinate width classes. */
export function setProgressIndeterminateClass(el: HTMLElement): void {
  clearProgressPercentClass(el);
  el.classList.remove("is-determinate");
  el.classList.add("is-indeterminate");
}
