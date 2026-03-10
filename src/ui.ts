import { $, MAX_LOG_LINES } from "./utils";
import { state, dom } from "./state";

function trimLog() {
  const text = dom.logEl.textContent || "";
  const lines = text.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    dom.logEl.textContent = lines.slice(lines.length - MAX_LOG_LINES).join("\n");
  }
}

export function log(line: string) {
  const stamp = new Date().toLocaleTimeString();
  dom.logEl.textContent += `[${stamp}] ${line}\n`;
  trimLog();
  dom.logEl.scrollTop = dom.logEl.scrollHeight;
}

export function devLog(line: string) {
  if (import.meta.env.DEV) {
    log(line);
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

export function setMode(mode: "add" | "extract" | "browse") {
  dom.appEl.dataset.mode = mode;
  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    el.classList.toggle("is-active", el.dataset.modeBtn === mode);
  });
  renderInputs();
}

export function renderInputs() {
  dom.inputList.innerHTML = "";
  if (state.inputs.length === 0) {
    const empty = document.createElement("div");
    const mode = getMode();
    empty.textContent = mode === "extract"
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
    remove.addEventListener("click", () => {
      state.inputs.splice(index, 1);
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
  }
}
