import { listen } from "@tauri-apps/api/event";
import { state } from "../state";
import { log, getWorkspaceMode, getMode, triggerIconRefresh } from "../ui";
import {
  setProgressIndeterminateClass,
  setProgressPercentClass,
} from "../progress-bar";
import { rememberRecentArchive } from "./recent";

export function showBasicProgress(section: "compress" | "extract"): void {
  const progress = document.getElementById(`basic-${section}-progress`);
  const completion = document.getElementById(`basic-${section}-completion`);
  if (progress) {
    progress.classList.add("is-active");
    progress.setAttribute("aria-busy", "true");
  }
  if (completion) completion.classList.remove("is-active");

  const runBtn =
    section === "compress"
      ? document.getElementById("basic-run-compress")
      : document.getElementById("basic-run-extract");
  if (runBtn) (runBtn as HTMLButtonElement).disabled = true;
}

export function hideBasicProgress(section: "compress" | "extract"): void {
  const progress = document.getElementById(`basic-${section}-progress`);
  if (progress) progress.classList.remove("is-active");
}

export function showBasicCompletion(
  section: "compress" | "extract",
  success: boolean,
  title: string,
  message: string,
  pathLabel?: string,
): void {
  const completion = document.getElementById(`basic-${section}-completion`);
  if (!completion) return;

  completion.classList.remove(
    "basic-completion--success",
    "basic-completion--error",
  );
  completion.classList.add(
    success ? "basic-completion--success" : "basic-completion--error",
  );
  completion.classList.add("is-active");

  const iconEl = document.getElementById(`basic-${section}-completion-icon`);
  const titleEl = document.getElementById(`basic-${section}-completion-title`);
  const msgEl = document.getElementById(`basic-${section}-completion-msg`);
  const pathEl = document.getElementById(`basic-${section}-completion-path`);

  if (iconEl) {
    iconEl.innerHTML = success
      ? '<i data-lucide="check" class="lucide-icon text-success"></i>'
      : '<i data-lucide="alert-triangle" class="lucide-icon text-danger"></i>';
  }
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (pathEl) {
    pathEl.textContent = pathLabel?.trim() ?? "";
    pathEl.hidden = !(pathLabel?.trim() ?? "");
  }

  // Manage "Open folder" button visibility based on success state
  const openDestBtn = document.getElementById(`basic-${section}-open-dest`);
  if (openDestBtn) {
    openDestBtn.hidden = !success;
  }

  // Manage text of secondary action button based on success state
  if (section === "compress") {
    const compressAgainBtn = document.getElementById("basic-compress-again");
    if (compressAgainBtn) {
      compressAgainBtn.textContent = success ? "Compress more" : "Close";
    }
  } else {
    const extractAnotherBtn = document.getElementById("basic-extract-another");
    if (extractAnotherBtn) {
      extractAnotherBtn.textContent = success ? "Extract another" : "Close";
    }
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
  setProgressPercentClass(bar, percent);
}

export function resetBasicBar(section: "compress" | "extract"): void {
  const bar = document.getElementById(`basic-${section}-bar`);
  if (!bar) return;
  setProgressIndeterminateClass(bar);
}

export function updateBasicRunningState(active: boolean): void {
  if (getWorkspaceMode() !== "basic") return;

  const section = getMode() === "extract" ? "extract" : "compress";

  if (active) {
    const generation = ++basicProgressGeneration;
    showBasicProgress(section);
    resetBasicBar(section);
    // Listen for structured progress events to show determinate progress.
    void listen<{ percent?: number; currentFile?: string }>(
      "7z-progress-structured",
      (event) => {
        if (event.payload?.currentFile === "Finalizing…") {
          setBasicBarDeterminate(section, 100);
          const status = document.getElementById(`basic-${section}-status`);
          if (status) status.textContent = "Finalizing…";
          return;
        }
        const percent = event.payload?.percent;
        if (typeof percent === "number") {
          setBasicBarDeterminate(section, Math.min(99, percent));
        }
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
    hideBasicProgress(section);
    resetBasicBar(section);
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
    if (el) el.disabled = active;
  }
  for (const id of [
    "basic-dropzone",
    "basic-action-compress",
    "basic-action-open",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.setAttribute("aria-disabled", String(active));
    el.classList.toggle("is-disabled", active);
    if (el instanceof HTMLButtonElement) el.disabled = active;
  }
}

export function updateBasicStatus(text: string, errorDetail?: string): void {
  if (getWorkspaceMode() !== "basic") return;

  const section = getMode() === "extract" ? "extract" : "compress";
  const statusEl = document.getElementById(`basic-${section}-status`);
  if (statusEl) statusEl.textContent = text;

  if (text === "Done") {
    hideBasicProgress(section);
    const outputPath = (
      document.getElementById("basic-output-path") as HTMLInputElement | null
    )?.value?.trim();
    const extractPath = (
      document.getElementById("basic-extract-path") as HTMLInputElement | null
    )?.value?.trim();
    const pathCandidates =
      section === "compress"
        ? [outputPath, state.lastAutoOutputPath]
        : [state.lastAutoExtractDestination, extractPath];
    const pathLabel =
      pathCandidates.find((candidate) => (candidate?.length ?? 0) > 0) ??
      undefined;
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
    // Empty user-visible detail needs the fallback too, not only null/undefined.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (!detail) {
      detail = "Something went wrong. Check the error message for details.";
    }
    showBasicCompletion(section, false, "Operation failed", detail);
  } else if (text === "Cancelled") {
    hideBasicProgress(section);
  }
}
