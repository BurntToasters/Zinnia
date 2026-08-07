import { message } from "@tauri-apps/plugin-dialog";
import { trapFocus, releaseFocusTrap } from "../utils";
import { buildArgs } from "./args";
import { buildCommandPreviewText } from "./command-sanitize";

export {
  sanitizeCommandArgsForPreview,
  buildCommandPreviewText,
} from "./command-sanitize";

let commandPreviewTrigger: HTMLElement | null = null;
let commandPreviewCopyTimer: number | undefined;

function setCommandPreviewCopyButton(copied: boolean): void {
  const btn = document.getElementById(
    "copy-command-preview",
  ) as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = copied ? "Copied" : "Copy";
  btn.setAttribute("aria-label", copied ? "Command copied" : "Copy command");
}

function resetCommandPreviewCopyStateSoon(): void {
  if (commandPreviewCopyTimer !== undefined) {
    clearTimeout(commandPreviewCopyTimer);
  }
  commandPreviewCopyTimer = window.setTimeout(() => {
    setCommandPreviewCopyButton(false);
  }, 1300);
}

export function closeCommandPreviewModal() {
  const overlay = document.getElementById(
    "command-preview-overlay",
  ) as HTMLElement | null;
  if (!overlay) return;
  overlay.hidden = true;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
  if (commandPreviewTrigger) {
    commandPreviewTrigger.focus();
    commandPreviewTrigger = null;
  } else {
    document.getElementById("show-command")?.focus();
  }
}

export async function copyCommandPreview(): Promise<void> {
  const preview = document.getElementById(
    "command-preview-text",
  ) as HTMLElement | null;
  const text = preview?.textContent?.trim() ?? "";
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.className = "copy-scratch";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCommandPreviewCopyButton(true);
    resetCommandPreviewCopyStateSoon();
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await message(`Could not copy command.\n\n${messageText}`, {
      title: "Copy failed",
      kind: "error",
    });
  }
}

export async function previewCommand(trigger?: HTMLElement) {
  try {
    const args = buildArgs();
    const previewText = buildCommandPreviewText(args);
    const overlay = document.getElementById(
      "command-preview-overlay",
    ) as HTMLElement | null;
    const preview = document.getElementById(
      "command-preview-text",
    ) as HTMLElement | null;
    if (!overlay || !preview) {
      await message(previewText, { title: "Command preview" });
      return;
    }

    commandPreviewTrigger = trigger ?? null;
    setCommandPreviewCopyButton(false);
    preview.textContent = previewText;
    overlay.hidden = false;
    const modal = overlay.querySelector<HTMLElement>(".modal");
    if (modal) trapFocus(modal);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await message(messageText, { title: "Missing info" });
  }
}
