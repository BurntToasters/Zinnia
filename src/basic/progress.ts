import { listenToOwnWindow } from "../window-events";
import { isSevenZipRunInFlight } from "../archive/runtime";
import { state } from "../state";
import { log, getWorkspaceMode, getMode, triggerIconRefresh } from "../ui";
import { getBasicView } from "./sync";
import {
  setProgressIndeterminateClass,
  setProgressPercentClass,
} from "../progress-bar";
import {
  formatEta,
  SAFE_COPY_PROGRESS_LABEL,
  type ProgressUpdate,
} from "../progress-update";
import { basename } from "../path-display";
import { rememberRecentArchive } from "./recent";

/** Operation labels stay on screen for the whole run. */
const OPERATION_LABELS: Record<"compress" | "extract", string> = {
  compress: "Compressing…",
  extract: "Extracting…",
};

type BasicProgressDetailValues = {
  percent?: string;
  eta?: string;
  file?: string;
};

/** Percent, ETA and file rows, created once inside the progress container. */
function basicProgressDetail(
  section: "compress" | "extract",
): HTMLElement | null {
  const progress = document.getElementById(`basic-${section}-progress`);
  const status = document.getElementById(`basic-${section}-status`);
  if (!progress || !status) return null;
  const existing = progress.querySelector<HTMLElement>(
    ".basic-progress__detail",
  );
  if (existing) return existing;
  const detail = document.createElement("div");
  detail.className = "basic-progress__detail";
  // The progress container is a polite live region. Ticks must not be read
  // out on every update; the label and the bar carry the state.
  detail.setAttribute("aria-live", "off");
  for (const part of ["percent", "eta", "file"] as const) {
    const span = document.createElement("span");
    span.className = `basic-progress__${part}`;
    detail.appendChild(span);
  }
  // Right under the label in the shipped markup, which nests the status inside
  // the progress container.
  if (status.parentElement === progress) status.after(detail);
  else progress.append(detail);
  return detail;
}

function setBasicProgressDetail(
  section: "compress" | "extract",
  values: BasicProgressDetailValues,
): void {
  const detail = basicProgressDetail(section);
  if (!detail) return;
  for (const part of ["percent", "eta", "file"] as const) {
    const value = values[part];
    if (value === undefined) continue;
    const el = detail.querySelector<HTMLElement>(`.basic-progress__${part}`);
    if (el) el.textContent = value;
  }
}

export function showBasicProgress(section: "compress" | "extract"): void {
  const progress = document.getElementById(`basic-${section}-progress`);
  const completion = document.getElementById(`basic-${section}-completion`);
  if (progress) {
    progress.classList.add("is-active");
    progress.setAttribute("aria-busy", "true");
  }
  if (completion) completion.classList.remove("is-active");
  const status = document.getElementById(`basic-${section}-status`);
  if (status) status.textContent = OPERATION_LABELS[section];
  setBasicProgressDetail(section, { percent: "", eta: "", file: "" });

  const runBtn =
    section === "compress"
      ? document.getElementById("basic-run-compress")
      : document.getElementById("basic-run-extract");
  if (runBtn) (runBtn as HTMLButtonElement).disabled = true;
}

export function hideBasicProgress(section: "compress" | "extract"): void {
  const progress = document.getElementById(`basic-${section}-progress`);
  if (progress) {
    progress.classList.remove("is-active");
    progress.removeAttribute("aria-busy");
  }
}

type BasicCompletionVariant = "success" | "error" | "cancelled";

const COMPLETION_ICONS: Record<
  BasicCompletionVariant,
  { icon: string; className: string }
> = {
  success: { icon: "check", className: "lucide-icon text-success" },
  error: { icon: "alert-triangle", className: "lucide-icon text-danger" },
  cancelled: { icon: "ban", className: "lucide-icon" },
};

export function showBasicCompletion(
  section: "compress" | "extract",
  success: boolean,
  title: string,
  message: string,
  pathLabel?: string,
): void {
  renderBasicCompletion(
    section,
    success ? "success" : "error",
    title,
    message,
    pathLabel,
  );
}

/** A user-requested stop. Neutral tone: it is not a failure. */
export function showBasicCancelled(section: "compress" | "extract"): void {
  renderBasicCompletion(
    section,
    "cancelled",
    "Cancelled",
    "The operation was stopped before it finished.",
  );
}

function renderBasicCompletion(
  section: "compress" | "extract",
  variant: BasicCompletionVariant,
  title: string,
  message: string,
  pathLabel?: string,
): void {
  const completion = document.getElementById(`basic-${section}-completion`);
  if (!completion) return;
  const succeeded = variant === "success";

  completion.classList.remove(
    "basic-completion--success",
    "basic-completion--error",
    "basic-completion--cancelled",
  );
  completion.classList.add(`basic-completion--${variant}`);
  completion.classList.add("is-active");

  const iconEl = document.getElementById(`basic-${section}-completion-icon`);
  const titleEl = document.getElementById(`basic-${section}-completion-title`);
  const msgEl = document.getElementById(`basic-${section}-completion-msg`);
  const pathEl = document.getElementById(`basic-${section}-completion-path`);

  if (iconEl) {
    const { icon, className } = COMPLETION_ICONS[variant];
    const iconNode = document.createElement("i");
    iconNode.setAttribute("data-lucide", icon);
    iconNode.className = className;
    iconEl.replaceChildren(iconNode);
  }
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (pathEl) {
    pathEl.textContent = pathLabel ?? "";
    pathEl.hidden = !(pathLabel ?? "");
  }

  // Manage "Open folder" button visibility based on success state
  const openDestBtn = document.getElementById(`basic-${section}-open-dest`);
  if (openDestBtn) {
    openDestBtn.hidden = !succeeded;
  }

  // The secondary button's behavior is stored as data, not read back from its
  // label. "dismiss" keeps the inputs; "reset" starts a new operation.
  const secondaryBtn = document.getElementById(
    section === "compress" ? "basic-compress-again" : "basic-extract-another",
  ) as HTMLButtonElement | null;
  if (secondaryBtn) {
    secondaryBtn.textContent = succeeded
      ? section === "compress"
        ? "Compress more"
        : "Extract another"
      : "Close";
    secondaryBtn.dataset.completionAction = succeeded ? "reset" : "dismiss";
  }

  triggerIconRefresh();

  const runBtn =
    section === "compress"
      ? document.getElementById("basic-run-compress")
      : document.getElementById("basic-run-extract");
  if (runBtn) (runBtn as HTMLButtonElement).disabled = false;
}

export function hideBasicCompletion(section: "compress" | "extract"): void {
  const completion = document.getElementById(`basic-${section}-completion`);
  if (completion) completion.classList.remove("is-active");
}

let basicProgressUnlisten: (() => void) | null = null;
let basicProgressGeneration = 0;

export function setBasicBarDeterminate(
  section: "compress" | "extract",
  percent: number,
): void {
  const bar = document.getElementById(`basic-${section}-bar`);
  if (!bar) return;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  setProgressPercentClass(bar, clamped);
  const progressbar =
    (bar.closest('[role="progressbar"]') as HTMLElement | null) ?? bar;
  progressbar.setAttribute("aria-valuenow", String(clamped));
  progressbar.setAttribute("aria-valuemin", "0");
  progressbar.setAttribute("aria-valuemax", "100");
}

export function resetBasicBar(section: "compress" | "extract"): void {
  const bar = document.getElementById(`basic-${section}-bar`);
  if (!bar) return;
  setProgressIndeterminateClass(bar);
  const progressbar =
    (bar.closest('[role="progressbar"]') as HTMLElement | null) ?? bar;
  progressbar.setAttribute("aria-valuenow", "0");
  progressbar.setAttribute("aria-valuemin", "0");
  progressbar.setAttribute("aria-valuemax", "100");
}

type BasicLockableControl =
  | HTMLButtonElement
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLTextAreaElement;

// A WeakMap drops the entry when a locked control is removed from the DOM.
// A Map would keep every removed control alive until the next unlock.
const disabledBeforeBasicLock = new WeakMap<BasicLockableControl, boolean>();
const basicCancelIds = new Set([
  "basic-compress-cancel",
  "basic-extract-cancel",
  "basic-browse-cancel",
]);

function setControlInteractionLock(
  button: BasicLockableControl,
  active: boolean,
): void {
  if (active) {
    if (!disabledBeforeBasicLock.has(button)) {
      disabledBeforeBasicLock.set(button, button.disabled);
    }
    button.disabled = true;
    return;
  }
  const previous = disabledBeforeBasicLock.get(button);
  if (previous === undefined) return;
  button.disabled = previous;
  disabledBeforeBasicLock.delete(button);
}

function updateBasicInteractionLock(active: boolean): void {
  // Workspace mode buttons have no independent disabled state. Keep their
  // disabled property owned by this lock so a stale lock snapshot cannot leave
  // Power inaccessible after a Basic operation finishes.
  document
    .querySelectorAll<HTMLButtonElement>("[data-workspace-mode-btn]")
    .forEach((button) => {
      button.disabled = active;
    });
  document
    .querySelectorAll<HTMLButtonElement>("#basic-workspace button")
    .forEach((button) => {
      if (button.matches("[data-workspace-mode-btn]")) return;
      if (active && state.running && basicCancelIds.has(button.id)) {
        // Cancel stays usable during a run. Keep the pre-lock snapshot so the
        // idle value comes back when the Basic lock ends.
        if (!disabledBeforeBasicLock.has(button)) {
          disabledBeforeBasicLock.set(button, button.disabled);
        }
        button.disabled = false;
        return;
      }
      setControlInteractionLock(button, active);
    });
  // Completion and recent archives describe the submitted operation. Form
  // fields stay read-only until it ends so the two cannot diverge.
  document
    .querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >(
      "#basic-workspace input, #basic-workspace select, #basic-workspace textarea",
    )
    .forEach((control) => {
      setControlInteractionLock(control, active);
    });

  const dropzone = document.getElementById("basic-dropzone");
  if (dropzone) {
    dropzone.setAttribute("aria-disabled", String(active));
    dropzone.classList.toggle("is-disabled", active);
  }
}

function applyBasicProgressUpdate(
  section: "compress" | "extract",
  update: ProgressUpdate | undefined,
  startedAt: number,
): void {
  if (!update) return;
  const currentFile = update.currentFile;
  // Heartbeats carry no progress; they must not replace a live value.
  if (currentFile === "Working…") return;
  if (currentFile === "Finalizing…") {
    setBasicBarDeterminate(section, 100);
    for (const id of ["basic-compress-cancel", "basic-extract-cancel"]) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (button) button.disabled = true;
    }
    setBasicProgressDetail(section, {
      percent: "",
      eta: "",
      file: "Finalizing…",
    });
    return;
  }

  const values: BasicProgressDetailValues = {};
  if (currentFile) {
    values.file =
      currentFile === SAFE_COPY_PROGRESS_LABEL
        ? currentFile
        : basename(currentFile);
  }
  const percent = update.percent;
  if (typeof percent === "number" && Number.isFinite(percent)) {
    // 100 is reserved for success, so the live value stops at 99.
    const shown = Math.min(99, Math.max(0, Math.round(percent)));
    setBasicBarDeterminate(section, shown);
    values.percent = `${shown}%`;
    const eta = formatEta(Date.now() - startedAt, shown);
    values.eta = eta ? `· ${eta}` : "";
  }
  setBasicProgressDetail(section, values);
}

export function updateBasicPreparingState(active: boolean): void {
  state.operationPreparing = active;
  if (getWorkspaceMode() !== "basic") return;
  updateBasicInteractionLock(active || state.running);
}

export function updateBasicRunningState(active: boolean): void {
  if (getWorkspaceMode() !== "basic") return;

  updateBasicInteractionLock(active || state.operationPreparing);
  const browsing = getMode() === "browse";
  for (const id of ["basic-browse-extract-all", "basic-browse-test"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = active || state.operationPreparing;
  }
  const browseCancel = document.getElementById(
    "basic-browse-cancel",
  ) as HTMLButtonElement | null;
  if (browseCancel) browseCancel.hidden = !active || !browsing;
  const browseStatus = document.getElementById("basic-browse-status");
  if (browsing) {
    if (browseStatus) {
      browseStatus.classList.toggle("is-loading", active);
      browseStatus.toggleAttribute("aria-busy", active);
      if (active && !browseStatus.classList.contains("is-error")) {
        browseStatus.textContent = "Working…";
      } else if (!active) {
        browseStatus.classList.remove("is-loading");
        browseStatus.removeAttribute("aria-busy");
      }
    }
    if (basicProgressUnlisten) {
      basicProgressUnlisten();
      basicProgressUnlisten = null;
    }
    return;
  }

  const section = getMode() === "extract" ? "extract" : "compress";

  if (active) {
    const generation = ++basicProgressGeneration;
    const startedAt = Date.now();
    showBasicProgress(section);
    resetBasicBar(section);
    // Listen for structured progress events to show determinate progress.
    void listenToOwnWindow<ProgressUpdate>(
      "7z-progress-structured",
      (event) => {
        if (!isSevenZipRunInFlight()) return;
        applyBasicProgressUpdate(section, event.payload, startedAt);
      },
    )
      .then((unlisten) => {
        if (
          generation !== basicProgressGeneration ||
          getWorkspaceMode() !== "basic"
        ) {
          unlisten();
          return;
        }
        if (basicProgressUnlisten) basicProgressUnlisten();
        basicProgressUnlisten = unlisten;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to listen for basic progress updates: ${msg}`, "error");
      });
  } else {
    basicProgressGeneration += 1;
    // The bar is not reset here. A finished run leaves it at 100 for the
    // completion, and the next run resets it when it starts.
    hideBasicProgress(section);
    if (basicProgressUnlisten) {
      basicProgressUnlisten();
      basicProgressUnlisten = null;
    }
    const runBtn =
      section === "compress"
        ? document.getElementById("basic-run-compress")
        : document.getElementById("basic-run-extract");
    if (runBtn) (runBtn as HTMLButtonElement).disabled = false;
  }

  const btns = [
    "basic-add-files",
    "basic-add-folder",
    "basic-clear-inputs",
    "basic-choose-output",
    "basic-choose-extract",
  ];
  for (const id of btns) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = active || state.operationPreparing;
  }
  for (const id of [
    "basic-dropzone",
    "basic-action-compress",
    "basic-action-open",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const locked = active || state.operationPreparing;
    el.setAttribute("aria-disabled", String(locked));
    el.classList.toggle("is-disabled", locked);
    if (el instanceof HTMLButtonElement) el.disabled = locked;
  }
}

type BasicProgressSection = "compress" | "extract" | "browse";

function resolveBasicProgressSection(): BasicProgressSection {
  if (getBasicView() === "browse") return "browse";
  return getMode() === "extract" ? "extract" : "compress";
}

function setBasicBrowseStatusMessage(
  message: string,
  tone: "idle" | "loading" | "error" | "success",
): void {
  const statusEl = document.getElementById("basic-browse-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove("is-loading", "is-error", "is-success");
  if (tone === "loading") {
    statusEl.classList.add("is-loading");
    statusEl.setAttribute("aria-busy", "true");
  } else {
    statusEl.removeAttribute("aria-busy");
  }
  if (tone === "error") statusEl.classList.add("is-error");
  if (tone === "success") statusEl.classList.add("is-success");
}

export function updateBasicStatus(text: string, errorDetail?: string): void {
  if (getWorkspaceMode() !== "basic") return;

  const section = resolveBasicProgressSection();
  if (section === "browse") {
    const runningLike =
      text === "Running" ||
      text.startsWith("Listing") ||
      text.startsWith("Testing") ||
      text === "Adding files";
    if (text === "Done" || text.startsWith("Integrity test passed")) {
      setBasicBrowseStatusMessage(
        text.startsWith("Integrity test passed") ? text : "Archive loaded",
        "success",
      );
      return;
    }
    if (text === "Cancelled") {
      setBasicBrowseStatusMessage("", "idle");
      return;
    }
    if (text === "Error") {
      let detail = errorDetail?.trim();
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      if (!detail) {
        detail = "Something went wrong. Check the activity log for details.";
      }
      setBasicBrowseStatusMessage(detail, "error");
      return;
    }
    if (runningLike) {
      setBasicBrowseStatusMessage(text, "loading");
      return;
    }
    if (errorDetail?.trim()) {
      setBasicBrowseStatusMessage(errorDetail.trim(), "error");
      return;
    }
    if (text && text !== "Idle") {
      setBasicBrowseStatusMessage(text, "idle");
    }
    return;
  }

  // The operation label is set when the run starts and is not replaced here.
  // "Running" and the 2-second "Idle" reset carry no information for Basic.
  if (text === "Done") {
    setBasicBarDeterminate(section, 100);
    setBasicProgressDetail(section, { percent: "100%", eta: "", file: "" });
    hideBasicProgress(section);
    const outputPath = (
      document.getElementById("basic-output-path") as HTMLInputElement | null
    )?.value;
    const extractPath = (
      document.getElementById("basic-extract-path") as HTMLInputElement | null
    )?.value;
    const pathCandidates =
      section === "compress"
        ? [outputPath, state.lastAutoOutputPath]
        : [extractPath, state.lastAutoExtractDestination];
    let pathLabel =
      pathCandidates.find((candidate) => (candidate?.length ?? 0) > 0) ??
      undefined;
    if (
      section === "compress" &&
      pathLabel &&
      (document.getElementById("split-size") as HTMLSelectElement | null)?.value
    ) {
      pathLabel = `${pathLabel}.001`;
    }
    showBasicCompletion(
      section,
      true,
      section === "compress" ? "Archive created" : "Extraction complete",
      section === "compress"
        ? "Your archive has been created successfully."
        : "Files have been extracted successfully.",
      pathLabel,
    );
    if (section === "extract" && state.inputs[0]) {
      rememberRecentArchive(state.inputs[0]);
    } else if (section === "compress" && pathLabel) {
      rememberRecentArchive(pathLabel);
    }
  } else if (text === "Error") {
    hideBasicProgress(section);
    let detail = errorDetail?.trim();
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (!detail) {
      detail = "Something went wrong. Check the activity log for details.";
    }
    showBasicCompletion(section, false, "Operation failed", detail);
  } else if (text === "Cancelled") {
    hideBasicProgress(section);
    showBasicCancelled(section);
  } else if (text !== "Running" && text !== "Idle" && text.trim()) {
    // Mid-run notes such as "Cancelling..." go on the detail line.
    setBasicProgressDetail(section, { file: text });
  }
}
