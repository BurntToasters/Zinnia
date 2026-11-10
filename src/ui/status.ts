import { $ } from "../utils";
import { state, dom, type LastQuickActionByMode } from "../state";
import { getBasicHooks } from "./hooks";
import { getMode } from "./inputs";
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

/** Percent step at which the announcer speaks during one run. */
const PROGRESS_ANNOUNCE_STEP = 25;
const TERMINAL_ANNOUNCEMENTS: Readonly<Record<string, string>> = {
  Done: "Finished",
  Error: "Failed",
  Cancelled: "Cancelled",
};

// Progress text changes every tick, so only the visible #progress follows it.
// The announcer is written at the start, each 25% step, and the end of a run.
let progressRunActive = false;
let lastAnnouncedPercent = 0;

function announceProgress(message: string): void {
  const announcer = document.getElementById("progress-announcer");
  if (announcer) announcer.textContent = message;
}

function noteProgressForAnnouncer(text: string): void {
  if (!progressRunActive) {
    progressRunActive = true;
    lastAnnouncedPercent = 0;
    announceProgress("Started");
  }
  const match = /^(\d{1,3})%/.exec(text);
  if (!match) return;
  const percent = Math.min(100, Number(match[1]));
  // A percent below the last announced step means a new run began without a
  // terminal status, so the steps start again.
  if (percent < lastAnnouncedPercent) lastAnnouncedPercent = 0;
  const step =
    Math.floor(percent / PROGRESS_ANNOUNCE_STEP) * PROGRESS_ANNOUNCE_STEP;
  if (step > lastAnnouncedPercent && step < 100) {
    lastAnnouncedPercent = step;
    announceProgress(`${step}% done`);
  }
}

function announceRunEnd(text: string): void {
  if (!progressRunActive) return;
  const message = TERMINAL_ANNOUNCEMENTS[text];
  if (!message) return;
  progressRunActive = false;
  announceProgress(message);
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
  announceRunEnd(text);
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
  noteProgressForAnnouncer(text);
}

export function hideProgress() {
  dom.progressEl.hidden = true;
}

/** Run and Cancel controls of one mode. Busy only while that mode runs. */
function setRunControlsBusy(
  runBtn: HTMLButtonElement,
  cancelBtn: HTMLButtonElement,
  busy: boolean,
): void {
  runBtn.disabled = busy;
  if (busy) runBtn.setAttribute("aria-busy", "true");
  else runBtn.removeAttribute("aria-busy");
  cancelBtn.hidden = !busy;
  cancelBtn.disabled = !busy;
}

/**
 * A Repeat button is usable only when its mode has a recorded action to
 * replay. Repeat actions are never recorded, so the stored key is the target.
 * Mirrors `refreshQuickActionRepeatState` in quick-actions.ts.
 */
function quickActionUnavailable(
  button: HTMLButtonElement,
  active: boolean,
): boolean {
  if (active) return true;
  const key = button.dataset.quickAction ?? "";
  const repeatSuffix = "-repeat";
  if (!key.endsWith(repeatSuffix)) return false;
  const modeName = key.slice(
    0,
    -repeatSuffix.length,
  ) as keyof LastQuickActionByMode;
  return !state.lastQuickActionByMode[modeName];
}

export function setRunning(active: boolean) {
  state.running = active;
  const mutationLocked =
    active || state.operationPreparing || state.incomingPathsApplying;
  const mode = getMode();
  // Both modes' controls are reset, not only the current mode's, so a Cancel
  // button from another mode cannot stay visible after a run.
  setRunControlsBusy(dom.runBtn, dom.cancelBtn, active && mode === "add");
  setRunControlsBusy(
    dom.extractRunBtn,
    dom.extractCancelBtn,
    active && mode === "extract",
  );
  if (mode !== "add" && mode !== "extract") {
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
      btn.disabled = quickActionUnavailable(btn, active);
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

  dom.inputList
    .querySelectorAll<HTMLButtonElement>("[data-input-remove]")
    .forEach((button) => {
      button.disabled = mutationLocked;
    });

  getBasicHooks()?.onSetRunning(active);
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
