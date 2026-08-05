import { $ } from "./utils";
import { SETTING_DEFAULTS, state, dom } from "./state";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    Boolean(target.isContentEditable)
  );
}

/** Toggle a password input between masked and plain text. */
export function togglePasswordVisibility(
  inputId: string,
  buttonId: string,
): void {
  const input = $<HTMLInputElement>(inputId);
  const btn = $<HTMLButtonElement>(buttonId);
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "Hide";
    btn.setAttribute("aria-pressed", "true");
  } else {
    input.type = "password";
    btn.textContent = "Show";
    btn.setAttribute("aria-pressed", "false");
  }
}

export function wirePasswordToggle(inputId: string, buttonId: string): void {
  const btn = $<HTMLButtonElement>(buttonId);
  if (btn.dataset.zinniaWired) return;
  btn.dataset.zinniaWired = "true";
  btn.addEventListener("click", () =>
    togglePasswordVisibility(inputId, buttonId),
  );
}

/** Reset in-memory UI state after a full settings reset (before relaunch). */
export function resetRuntimeStateForFirstRun(): void {
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.lastPersistedSettings = { ...SETTING_DEFAULTS };
  state.settingsExtras = {};
  state.inputs = [];
  state.lastAutoExtractDestination = null;
  state.lastAutoOutputPath = null;
  state.browseArchiveInfoByPath.clear();
  state.browseSelectionsByArchive.clear();
  state.selectiveSearchQuery = "";
  state.selectiveActiveArchive = null;
  state.selectiveVisiblePaths = [];
  state.selectiveExpandedFolders.clear();
  state.inputValidationByPath.clear();
  state.inputValidationRequestId += 1;
  state.lastInputsSignature = "[]";
  state.lastQuickActionByMode = {};
  dom.logEl.textContent = "";
}
