import { $ } from "../utils";
import { state, dom } from "../state";
import { getBasicHooks } from "./hooks";
import { getMode, renderInputs } from "./inputs";
import {
  type ContextPersistOptions,
  queuePersistWorkingContext,
} from "./workspace";

export function setActivityPanelVisible(
  visible: boolean,
  options: ContextPersistOptions = {},
): void {
  dom.gridEl.classList.toggle("show-activity", visible);
  const btn = $("toggle-activity");
  btn.classList.toggle("is-active", visible);
  btn.setAttribute("aria-pressed", String(visible));

  state.currentSettings.showActivityPanel = visible;
  if (options.persist !== false) {
    queuePersistWorkingContext();
  }
}

export function toggleActivity() {
  const isVisible = !dom.gridEl.classList.contains("show-activity");
  setActivityPanelVisible(isVisible);
}

export function setStatus(
  text: string,
  autoResetMs?: number,
  errorDetail?: string,
) {
  if (state.statusTimeout !== undefined) {
    clearTimeout(state.statusTimeout);
    state.statusTimeout = undefined;
  }
  dom.statusEl.textContent = text;
  getBasicHooks()?.onSetStatus(text, errorDetail);
  if (autoResetMs) {
    state.statusTimeout = window.setTimeout(() => {
      setStatus("Idle");
      dom.progressEl.hidden = true;
    }, autoResetMs);
  }
}

export function setProgress(text: string) {
  dom.progressEl.textContent = text;
  dom.progressEl.hidden = false;
}

export function hideProgress() {
  dom.progressEl.hidden = true;
}

export function setRunning(active: boolean) {
  state.running = active;
  const mutationLocked =
    active || state.operationPreparing || state.incomingPathsApplying;
  const mode = getMode();
  if (mode === "add") {
    dom.runBtn.disabled = active;
    if (active) dom.runBtn.setAttribute("aria-busy", "true");
    else dom.runBtn.removeAttribute("aria-busy");
    dom.cancelBtn.hidden = !active;
    dom.cancelBtn.disabled = !active;
  } else if (mode === "extract") {
    dom.extractRunBtn.disabled = active;
    if (active) dom.extractRunBtn.setAttribute("aria-busy", "true");
    else dom.extractRunBtn.removeAttribute("aria-busy");
    dom.extractCancelBtn.hidden = !active;
    dom.extractCancelBtn.disabled = !active;
  } else {
    $<HTMLButtonElement>("browse-list").disabled = active;
    const browseCancel = $<HTMLButtonElement>("browse-cancel");
    browseCancel.hidden = !active;
    browseCancel.disabled = !active;
    $<HTMLButtonElement>("browse-test").disabled = active;
    $<HTMLButtonElement>("browse-extract").disabled = active;
    $<HTMLButtonElement>("browse-selective").disabled = active;
  }

  for (const id of [
    "add-files",
    "add-folder",
    "clear-inputs",
    "choose-output",
    "choose-extract",
    "open-settings",
    "selective-select-all",
    "selective-clear",
    "selective-cancel",
    "selective-confirm",
    "selective-browse-dest",
    "close-selective",
    "toggle-density",
  ]) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (!el) continue;
    if (id === "add-files" || id === "add-folder" || id === "clear-inputs") {
      el.disabled = mutationLocked;
    } else {
      el.disabled = active;
    }
  }

  document
    .querySelectorAll<HTMLButtonElement>("[data-quick-action-btn]")
    .forEach((btn) => {
      btn.disabled = active;
    });

  document
    .querySelectorAll<HTMLButtonElement>("[data-workspace-mode-btn]")
    .forEach((btn) => {
      btn.disabled = active;
    });

  document
    .querySelectorAll<HTMLButtonElement>("[data-mode-btn]")
    .forEach((btn) => {
      btn.disabled = active;
    });

  getBasicHooks()?.onSetRunning(active);
  renderInputs();
}

export function setCancelAvailable(available: boolean): void {
  for (const id of [
    "cancel-action",
    "extract-cancel",
    "browse-cancel",
    "selective-cancel",
    "basic-compress-cancel",
    "basic-extract-cancel",
    "basic-browse-cancel",
  ]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button && !button.hidden) button.disabled = !available;
  }
}
