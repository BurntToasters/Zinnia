import { $ } from "./utils";
import {
  runAction,
  testArchive,
  browseArchive,
  previewCommand,
  openSelectiveExtractModal,
} from "./archive";
import { applyPreset, onCompressionOptionChange } from "./presets";
import { getCompressionSecuritySupport } from "./compression-security";
import { state } from "./state";
import { getMode, setMode } from "./ui";
import type { ArchiveFormat } from "./settings-model";

type QuickActionKey =
  | "add-run-balanced"
  | "add-run-ultra"
  | "add-encrypt-run"
  | "add-preview"
  | "add-repeat"
  | "extract-now"
  | "extract-test-then-extract"
  | "extract-selective"
  | "extract-preview"
  | "extract-repeat"
  | "browse-list"
  | "browse-test"
  | "browse-selective"
  | "browse-switch-extract"
  | "browse-repeat";

const REPEAT_ACTIONS: ReadonlySet<QuickActionKey> = new Set([
  "add-repeat",
  "extract-repeat",
  "browse-repeat",
]);

function setQuickActionFeedback(message: string): void {
  const feedback = document.getElementById(
    "quick-action-feedback",
  ) as HTMLElement | null;
  if (!feedback) return;
  feedback.textContent = message;
  feedback.hidden = message.length === 0;
}

function rememberQuickAction(mode: "add" | "extract" | "browse", key: string) {
  if (REPEAT_ACTIONS.has(key as QuickActionKey)) return;
  state.lastQuickActionByMode[mode] = key;
}

function getReplayTarget(
  mode: "add" | "extract" | "browse",
): QuickActionKey | null {
  const action = state.lastQuickActionByMode[mode];
  if (!action) return null;
  if (REPEAT_ACTIONS.has(action as QuickActionKey)) return null;
  return action as QuickActionKey;
}

export function refreshQuickActionRepeatState(): void {
  const mode = getMode();
  const repeatButtons: Array<{ id: string; targetMode: typeof mode }> = [
    { id: "quick-add-repeat", targetMode: "add" },
    { id: "quick-extract-repeat", targetMode: "extract" },
    { id: "quick-browse-repeat", targetMode: "browse" },
  ];
  for (const entry of repeatButtons) {
    const button = document.getElementById(
      entry.id,
    ) as HTMLButtonElement | null;
    if (!button) continue;
    const replayTarget = getReplayTarget(entry.targetMode);
    button.disabled = entry.targetMode === mode && !replayTarget;
  }
}

async function runQuickAction(
  key: QuickActionKey,
  trigger?: HTMLElement,
): Promise<boolean> {
  switch (key) {
    case "add-run-balanced":
      applyPreset("balanced");
      onCompressionOptionChange();
      await runAction();
      return true;
    case "add-run-ultra":
      applyPreset("ultra");
      onCompressionOptionChange();
      await runAction();
      return true;
    case "add-encrypt-run": {
      const format = $<HTMLSelectElement>("format").value;
      const support = getCompressionSecuritySupport(format as ArchiveFormat);
      if (!support.password) {
        setQuickActionFeedback(
          `${format.toUpperCase()} does not support password protection.`,
        );
        return false;
      }
      const password = $<HTMLInputElement>("password").value.trim();
      if (!password) {
        setQuickActionFeedback(
          "Enter a password first, then run Encrypt + Run.",
        );
        $<HTMLInputElement>("password").focus();
        return false;
      }
      if (support.encryptHeaders) {
        $<HTMLInputElement>("encrypt-headers").checked = true;
      }
      await runAction();
      return true;
    }
    case "add-preview":
      await previewCommand(trigger);
      return true;
    case "extract-now":
      await runAction();
      return true;
    case "extract-test-then-extract": {
      await testArchive();
      const status = (document.getElementById("status")?.textContent ?? "")
        .trim()
        .toLowerCase();
      if (!status.startsWith("integrity test passed")) {
        setQuickActionFeedback(
          "Extraction skipped because integrity test did not pass.",
        );
        return false;
      }
      await runAction();
      return true;
    }
    case "extract-selective":
      await openSelectiveExtractModal();
      return true;
    case "extract-preview":
      await previewCommand(trigger);
      return true;
    case "browse-list":
      await browseArchive();
      return true;
    case "browse-test":
      await testArchive();
      return true;
    case "browse-selective":
      await openSelectiveExtractModal();
      return true;
    case "browse-switch-extract":
      setMode("extract");
      return true;
    default:
      return false;
  }
}

export async function executeQuickAction(
  key: string,
  trigger?: HTMLElement,
): Promise<void> {
  const mode = getMode();
  const typed = key as QuickActionKey;

  if (REPEAT_ACTIONS.has(typed)) {
    const target = getReplayTarget(mode);
    if (!target) {
      setQuickActionFeedback("No prior quick action to repeat in this mode.");
      refreshQuickActionRepeatState();
      return;
    }
    setQuickActionFeedback("");
    const executed = await runQuickAction(target, trigger);
    if (executed) {
      rememberQuickAction(mode, target);
    }
    refreshQuickActionRepeatState();
    return;
  }

  setQuickActionFeedback("");
  const executed = await runQuickAction(typed, trigger);
  if (executed) {
    rememberQuickAction(mode, typed);
  }
  refreshQuickActionRepeatState();
}

export function wireQuickActionEvents(): void {
  document
    .querySelectorAll<HTMLButtonElement>("[data-quick-action-btn]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        if (state.running) return;
        const key = button.dataset.quickAction;
        if (!key) return;
        void executeQuickAction(key, button);
      });
    });
  refreshQuickActionRepeatState();
}
