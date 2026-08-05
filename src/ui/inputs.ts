import { state, dom } from "../state";
import type { InputValidationInfo } from "../state";
import { releaseFocusTrap } from "../utils";
import {
  type ArchivePathValidation,
  validateArchivePaths,
} from "../archive-rules";
import {
  resolveExtractDestinationAutofill,
  resolveOutputArchiveAutofill,
} from "../extract-path";
import { getBasicHooks, triggerIconRefresh } from "./hooks";
import { devLog } from "./log";
import {
  type ContextPersistOptions,
  queuePersistWorkingContext,
} from "./workspace";

const INPUT_VALIDATION_REASON_INLINE_MAX_CHARS = 92;

export function truncateValidationReason(
  reason: string | undefined,
  maxChars = INPUT_VALIDATION_REASON_INLINE_MAX_CHARS,
): string {
  const text = (reason ?? "").trim();
  if (!text) return "Unsupported archive file.";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}\u2026`;
}

export function mapArchiveValidationResult(
  result: ArchivePathValidation,
): InputValidationInfo {
  if (result.valid) {
    return { state: "valid" };
  }
  const reason = (result.reason ?? "").trim() || "Unsupported archive file.";
  return {
    state: "invalid",
    reason,
    reasonShort: truncateValidationReason(reason),
  };
}

function syncValidationMapForInputs(paths: string[]): void {
  const normalized = paths.filter((path) => path.length > 0);
  const keep = new Set(normalized);

  for (const existing of state.inputValidationByPath.keys()) {
    if (!keep.has(existing)) {
      state.inputValidationByPath.delete(existing);
    }
  }

  for (const path of keep) {
    if (!state.inputValidationByPath.has(path)) {
      state.inputValidationByPath.set(path, { state: "unknown" });
    }
  }
}

function startInputValidation(paths: string[]): void {
  if (paths.length === 0) {
    state.inputValidationByPath.clear();
    state.inputValidationRequestId += 1;
    return;
  }

  syncValidationMapForInputs(paths);
  const requestId = ++state.inputValidationRequestId;

  void validateArchivePaths(paths)
    .then((results) => {
      if (requestId !== state.inputValidationRequestId) return;
      const next = new Map<string, InputValidationInfo>();
      for (const result of results) {
        const key = result.path;
        if (!key) continue;
        next.set(key, mapArchiveValidationResult(result));
      }
      for (const path of paths) {
        const key = path;
        if (!key || next.has(key)) continue;
        next.set(key, {
          state: "invalid",
          reason: "Validation unavailable.",
          reasonShort: "Validation unavailable.",
        });
      }
      state.inputValidationByPath = next;
      renderInputs();
    })
    .catch((err) => {
      if (requestId !== state.inputValidationRequestId) return;
      const msg = err instanceof Error ? err.message : String(err);
      devLog(`Background archive validation failed: ${msg}`);
      for (const path of paths) {
        const key = path;
        if (!key) continue;
        const current = state.inputValidationByPath.get(key);
        if (!current) {
          state.inputValidationByPath.set(key, { state: "unknown" });
        }
      }
      renderInputs();
    });
}

export function getMode(): "add" | "extract" | "browse" {
  const m = dom.appEl.dataset.mode;
  if (m === "extract") return "extract";
  if (m === "browse") return "browse";
  return "add";
}

/**
 * Clears a password field's value and resets its Show/Hide toggle back to
 * hidden (`type="password"`, "Show" label/icon, `aria-pressed="false"`).
 * Exported (originally browse-only) so any caller clearing a password value
 * can also undo a prior "Show" click; clearing `.value` alone leaves the
 * field visible in plaintext for whatever is typed into it next.
 */
export function resetPasswordFieldControl(
  inputId: string,
  toggleId: string,
): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const toggle = document.getElementById(toggleId) as HTMLButtonElement | null;
  if (input) {
    input.value = "";
    input.type = "password";
  }
  if (!toggle) return;

  const isIconOnly = toggle.classList.contains("basic-password-toggle--icon");
  if (isIconOnly) {
    const icon = toggle.querySelector<HTMLElement>("[data-lucide]");
    icon?.setAttribute("data-lucide", "eye");
    toggle.setAttribute("aria-label", "Show password");
    triggerIconRefresh();
  } else {
    toggle.textContent = "Show";
  }
  toggle.setAttribute("aria-pressed", "false");
}

/** Clears Basic then Power browse password fields and resets Show/Hide toggles. */
export function clearBrowsePasswordFields(): void {
  resetPasswordFieldControl(
    "basic-browse-password",
    "basic-toggle-browse-password",
  );
  resetPasswordFieldControl("browse-password", "toggle-browse-password");
}

export function setBrowsePasswordFieldVisible(visible: boolean) {
  const field = document.getElementById(
    "browse-password-field",
  ) as HTMLElement | null;
  if (field) {
    field.hidden = !visible;
  }
  if (!visible) {
    // Clear Basic before Power so a later sync-to-Power cannot restore the secret.
    clearBrowsePasswordFields();
    const basicField = document.getElementById("basic-browse-password-field");
    if (basicField) basicField.hidden = true;
  }
}

function clearBrowsePickerSessionState() {
  state.browseArchiveInfoByPath.clear();
  state.browseArchiveIdentityByPath.clear();
  state.browseSelectionsByArchive.clear();
  // Invalidate an asynchronous selective-open request before clearing the
  // cache or hiding its modal. Otherwise its late continuation can reopen a
  // picker for a previous mode/input session.
  state.selectiveOpenRequestId += 1;
  state.selectiveSearchQuery = "";
  state.selectiveActiveArchive = null;
  state.selectiveVisiblePaths = [];
  state.selectiveExpandedFolders.clear();
  const overlay = document.getElementById(
    "selective-overlay",
  ) as HTMLElement | null;
  if (overlay) {
    const modal = overlay.querySelector<HTMLElement>(".modal");
    if (modal) releaseFocusTrap(modal);
    overlay.hidden = true;
  }
}

export function setMode(
  mode: "add" | "extract" | "browse",
  options: ContextPersistOptions = {},
) {
  const previousMode = getMode();
  if (previousMode !== mode) {
    clearBrowsePickerSessionState();
  }

  dom.appEl.dataset.mode = mode;
  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    const isActive = el.dataset.modeBtn === mode;
    el.classList.toggle("is-active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });
  if (mode !== "browse") {
    setBrowsePasswordFieldVisible(false);
  }

  state.currentSettings.lastMode = mode;
  if (options.persist !== false && previousMode !== mode) {
    queuePersistWorkingContext();
  }

  renderInputs();
  if (previousMode !== mode) {
    document.dispatchEvent(
      new CustomEvent("zinnia:mode-changed", { detail: { mode } }),
    );
  }
}

export function renderInputs() {
  const mode = getMode();
  // JSON preserves item boundaries; joining with a newline aliases distinct
  // (legal on Unix) path arrays such as ["a\nb"] and ["a", "b"].
  const signature = JSON.stringify(state.inputs);
  const signatureChanged = signature !== state.lastInputsSignature;
  if (signatureChanged) {
    clearBrowsePickerSessionState();
    state.lastInputsSignature = signature;
  }

  const modeChangedForValidation = state.lastInputValidationMode !== mode;
  state.lastInputValidationMode = mode;
  if (mode === "add") {
    if (modeChangedForValidation || state.inputValidationByPath.size > 0) {
      state.inputValidationRequestId += 1;
      state.inputValidationByPath.clear();
    }
  } else if (signatureChanged || modeChangedForValidation) {
    const normalized = state.inputs.filter((path) => path.length > 0);
    startInputValidation(normalized);
  } else {
    syncValidationMapForInputs(state.inputs);
  }

  if (mode === "extract") {
    const extractPathInput = document.getElementById(
      "extract-path",
    ) as HTMLInputElement | null;
    if (extractPathInput) {
      const nextExtractPath = resolveExtractDestinationAutofill(
        extractPathInput.value,
        state.lastAutoExtractDestination,
        state.inputs[0] ?? null,
      );
      if (nextExtractPath) {
        extractPathInput.value = nextExtractPath;
        state.lastAutoExtractDestination = nextExtractPath;
      }
    }
  }

  if (mode === "add") {
    const outputPathInput = document.getElementById(
      "output-path",
    ) as HTMLInputElement | null;
    if (outputPathInput) {
      const archiveNameInput = document.getElementById(
        "archive-name",
      ) as HTMLInputElement | null;
      const format =
        (document.getElementById("format") as HTMLSelectElement | null)
          ?.value ?? "7z";
      const rawName = archiveNameInput?.value;
      const customName = rawName && rawName.length > 0 ? rawName : undefined;
      const next = resolveOutputArchiveAutofill(
        outputPathInput.value,
        state.lastAutoOutputPath,
        state.inputs,
        format,
        customName,
      );
      if (next) {
        outputPathInput.value = next;
        state.lastAutoOutputPath = next;
      }
    }
  }

  if (mode !== "browse" || state.inputs.length === 0) {
    setBrowsePasswordFieldVisible(false);
  }

  dom.inputList.innerHTML = "";
  if (state.inputs.length === 0) {
    const empty = document.createElement("div");
    empty.textContent =
      mode === "extract"
        ? "Select an archive file to extract."
        : mode === "browse"
          ? "Select an archive to preview its contents."
          : "Drop files here or use the buttons above.";
    empty.className = "list__empty";
    dom.inputList.appendChild(empty);
    getBasicHooks()?.onRenderInputs();
    return;
  }

  state.inputs.forEach((path, index) => {
    const item = document.createElement("div");
    item.className = "list__item";
    const content = document.createElement("div");
    content.className = "list__item-main";

    const pathEl = document.createElement("span");
    pathEl.className = "list__item-path";
    pathEl.textContent = path;
    content.appendChild(pathEl);

    if (mode !== "add") {
      const validation = state.inputValidationByPath.get(path) ?? {
        state: "unknown" as const,
      };
      const badge = document.createElement("span");
      badge.className = `list__item-badge list__item-badge--${validation.state}`;
      badge.textContent =
        validation.state === "valid"
          ? "\u2713 Valid"
          : validation.state === "invalid"
            ? "\u2717 Invalid"
            : "\u22ef Checking";
      content.appendChild(badge);

      if (validation.state === "invalid") {
        const reason = document.createElement("span");
        reason.className = "list__item-reason";
        reason.textContent =
          validation.reasonShort ?? truncateValidationReason(validation.reason);
        const fullReason = (validation.reason ?? "").trim();
        if (fullReason) {
          reason.title = fullReason;
        }
        content.appendChild(reason);
      }
    }

    const remove = document.createElement("button");
    remove.className = "btn btn--ghost btn--sm";
    remove.dataset.inputRemove = "";
    remove.setAttribute("aria-label", `Remove ${path}`);
    remove.innerHTML = '<i data-lucide="trash-2" class="lucide-icon"></i>';
    remove.disabled =
      state.running || state.operationPreparing || state.incomingPathsApplying;
    remove.addEventListener("click", () => {
      if (
        state.running ||
        state.operationPreparing ||
        state.incomingPathsApplying
      ) {
        return;
      }
      const removedPrimary = index === 0;
      state.inputs.splice(index, 1);
      if (
        getMode() === "browse" &&
        (removedPrimary || state.inputs.length === 0)
      ) {
        setBrowsePasswordFieldVisible(false);
      }
      renderInputs();
    });
    item.appendChild(content);
    item.appendChild(remove);
    dom.inputList.appendChild(item);
  });

  getBasicHooks()?.onRenderInputs();
  triggerIconRefresh();
}
