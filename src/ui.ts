import { invoke } from "@tauri-apps/api/core";
import { $, MAX_LOG_LINES, redactSensitiveText } from "./utils";
import { state, dom } from "./state";
import { LogVerbosity } from "./settings-model";
import {
  resolveExtractDestinationAutofill,
  resolveOutputArchiveAutofill,
} from "./extract-path";

type LogLevel = "info" | "debug" | "error";

let logWriteQueue = Promise.resolve();
const MAX_LOG_ENTRY_CHARS = 8_000;
const LOG_CHUNK_CHARS = 2_000;
const MAX_PENDING_LOCAL_LOG_WRITES = 250;
let pendingLocalLogWrites = 0;
let droppedLocalLogWrites = 0;

export function buildLogFragments(input: string): string[] {
  if (input.length <= MAX_LOG_ENTRY_CHARS) return [input];

  const capped = input.slice(0, MAX_LOG_ENTRY_CHARS);
  const chunks: string[] = [];
  for (let i = 0; i < capped.length; i += LOG_CHUNK_CHARS) {
    chunks.push(capped.slice(i, i + LOG_CHUNK_CHARS));
  }
  chunks.push(`[truncated ${input.length - MAX_LOG_ENTRY_CHARS} chars]`);
  return chunks;
}

export function shouldPersistLevel(
  level: LogLevel,
  verbosity: LogVerbosity,
): boolean {
  if (level === "debug") return verbosity === "debug";
  return true;
}

function enqueueLocalLogLine(line: string): void {
  pendingLocalLogWrites += 1;
  logWriteQueue = logWriteQueue
    .then(() => invoke("append_local_log", { line }).then(() => undefined))
    .catch(() => {
      // Ignore logging backend failures to avoid noisy loops.
    })
    .finally(() => {
      pendingLocalLogWrites = Math.max(0, pendingLocalLogWrites - 1);
    });
}

function persistLocalLog(level: LogLevel, line: string): void {
  if (!state.currentSettings.localLoggingEnabled) return;
  if (!shouldPersistLevel(level, state.currentSettings.logVerbosity)) return;

  if (pendingLocalLogWrites >= MAX_PENDING_LOCAL_LOG_WRITES) {
    droppedLocalLogWrites += 1;
    return;
  }

  if (droppedLocalLogWrites > 0) {
    const dropped = droppedLocalLogWrites;
    droppedLocalLogWrites = 0;
    enqueueLocalLogLine(
      `${new Date().toISOString()} [error] Local log queue overloaded; dropped ${dropped} log entr${dropped === 1 ? "y" : "ies"}.`,
    );
  }

  const entry = `${new Date().toISOString()} [${level}] ${line}`;
  enqueueLocalLogLine(entry);
}

function trimLog() {
  const text = dom.logEl.textContent || "";
  const lines = text.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    dom.logEl.textContent = lines
      .slice(lines.length - MAX_LOG_LINES)
      .join("\n");
  }
}

export function log(line: string, level: LogLevel = "info") {
  const sanitized = redactSensitiveText(line);
  const fragments = buildLogFragments(sanitized);

  for (const [index, fragment] of fragments.entries()) {
    const stamp = new Date().toLocaleTimeString();
    const marker =
      fragments.length > 1 ? ` (${index + 1}/${fragments.length})` : "";
    const rendered = `${fragment}${marker}`;
    dom.logEl.textContent += `[${stamp}] ${rendered}\n`;
    persistLocalLog(level, rendered);
  }

  trimLog();
  dom.logEl.scrollTop = dom.logEl.scrollHeight;
}

export function devLog(line: string) {
  if (import.meta.env.DEV || state.currentSettings.logVerbosity === "debug") {
    log(line, "debug");
  }
}

export function toggleActivity() {
  const isVisible = dom.gridEl.classList.toggle("show-activity");
  $("toggle-activity").classList.toggle("is-active", isVisible);
}

export function setStatus(text: string, autoResetMs?: number) {
  if (state.statusTimeout !== undefined) {
    clearTimeout(state.statusTimeout);
    state.statusTimeout = undefined;
  }
  dom.statusEl.textContent = text;
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

export function getMode(): "add" | "extract" | "browse" {
  const m = dom.appEl.dataset.mode;
  if (m === "extract") return "extract";
  if (m === "browse") return "browse";
  return "add";
}

export function setBrowsePasswordFieldVisible(visible: boolean) {
  const field = document.getElementById(
    "browse-password-field",
  ) as HTMLElement | null;
  const input = document.getElementById(
    "browse-password",
  ) as HTMLInputElement | null;
  const toggle = document.getElementById(
    "toggle-browse-password",
  ) as HTMLButtonElement | null;
  if (!field || !input || !toggle) return;
  field.hidden = !visible;
  if (!visible) {
    input.value = "";
    input.type = "password";
    toggle.textContent = "Show";
  }
}

function clearBrowsePickerSessionState() {
  state.browseArchiveInfoByPath.clear();
  state.browseSelectionsByArchive.clear();
  state.selectiveSearchQuery = "";
  state.selectiveActiveArchive = null;
  state.selectiveVisiblePaths = [];
  const overlay = document.getElementById(
    "selective-overlay",
  ) as HTMLElement | null;
  if (overlay) overlay.hidden = true;
}

export function setMode(mode: "add" | "extract" | "browse") {
  const previousMode = getMode();
  if (previousMode !== mode) {
    clearBrowsePickerSessionState();
  }

  dom.appEl.dataset.mode = mode;
  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    el.classList.toggle("is-active", el.dataset.modeBtn === mode);
  });
  if (mode !== "browse") {
    setBrowsePasswordFieldVisible(false);
  }
  renderInputs();
}

export function renderInputs() {
  const mode = getMode();
  const signature = state.inputs.join("\n");
  if (signature !== state.lastInputsSignature) {
    clearBrowsePickerSessionState();
    state.lastInputsSignature = signature;
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
      const customName = archiveNameInput?.value.trim() || undefined;
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
    return;
  }

  state.inputs.forEach((path, index) => {
    const item = document.createElement("div");
    item.className = "list__item";
    const span = document.createElement("span");
    span.textContent = path;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.disabled = state.running;
    remove.addEventListener("click", () => {
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
    item.appendChild(span);
    item.appendChild(remove);
    dom.inputList.appendChild(item);
  });
}

export function setRunning(active: boolean) {
  state.running = active;
  const mode = getMode();
  if (mode === "add") {
    dom.runBtn.disabled = active;
    if (active) dom.runBtn.setAttribute("aria-busy", "true");
    else dom.runBtn.removeAttribute("aria-busy");
    dom.cancelBtn.hidden = !active;
  } else if (mode === "extract") {
    dom.extractRunBtn.disabled = active;
    if (active) dom.extractRunBtn.setAttribute("aria-busy", "true");
    else dom.extractRunBtn.removeAttribute("aria-busy");
    dom.extractCancelBtn.hidden = !active;
  } else {
    $<HTMLButtonElement>("browse-list").disabled = active;
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
  ]) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = active;
  }

  document
    .querySelectorAll<HTMLButtonElement>("[data-mode-btn]")
    .forEach((btn) => {
      btn.disabled = active;
    });

  renderInputs();
}
