import {
  setProgressIndeterminateClass,
  setProgressPercentClass,
} from "../progress-bar";

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

export function parentDir(filePath: string): string {
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (sep < 0) return ".";
  if (sep === 0) return "/";
  const parent = filePath.slice(0, sep);
  // Windows drive root: "C:" → "C:\\"
  if (parent.length === 2 && parent[1] === ":") return parent + "\\";
  return parent;
}

export function setButtons(
  showCancel: boolean,
  showOpenDestination: boolean,
  showClose: boolean,
): void {
  $("cancel-btn").hidden = !showCancel;
  $("open-destination-btn").hidden = !showOpenDestination;
  $("close-btn").hidden = !showClose;
}

export function stopProgressAt(widthPercent: number, error: boolean): void {
  const fill = $("progress-fill");
  fill.classList.toggle("extract-progress-fill--error", error);
  setProgressPercentClass(fill, widthPercent);
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(widthPercent));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.removeAttribute("aria-busy");
    bar.removeAttribute("aria-valuetext");
  }
}

export function startIndeterminateProgress(): void {
  const fill = $("progress-fill");
  fill.classList.remove("extract-progress-fill--error");
  setProgressIndeterminateClass(fill);
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-busy", "true");
    bar.setAttribute("aria-valuetext", "Working");
    bar.setAttribute("aria-valuenow", "0");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
  }
}

export function setDeterminateProgress(widthPercent: number): void {
  const clamped = Math.max(0, Math.min(100, widthPercent));
  const fill = $("progress-fill");
  fill.classList.remove("extract-progress-fill--error");
  setProgressPercentClass(fill, clamped);
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(clamped));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.removeAttribute("aria-busy");
    bar.removeAttribute("aria-valuetext");
  }
}
