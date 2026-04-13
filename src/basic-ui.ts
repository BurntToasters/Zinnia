import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { $ } from "./utils";
import { state } from "./state";
import {
  getWorkspaceMode,
  getMode,
  setMode,
  renderInputs,
  setBrowsePasswordFieldVisible,
  registerBasicHooks,
} from "./ui";
import {
  applyPreset,
  updateCompressionOptionsForFormat,
  onCompressionOptionChange,
} from "./presets";
import { validateArchivePaths } from "./archive-rules";
import { runAction, cancelAction, browseArchive, testArchive } from "./archive";
import { chooseOutput, chooseExtract, addFiles, addFolder } from "./files";
import {
  deriveOutputArchivePath,
  resolveOutputArchiveAutofill,
  resolveExtractDestinationAutofill,
} from "./extract-path";

export type BasicView = "home" | "compress" | "extract" | "browse";

const ENCRYPTION_FORMATS = new Set(["7z", "zip"]);

let currentBasicView: BasicView = "home";

function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function getBasicView(): BasicView {
  return currentBasicView;
}

export function setBasicView(view: BasicView): void {
  currentBasicView = view;
  const views = document.querySelectorAll<HTMLElement>(
    "#basic-workspace .basic-view",
  );
  views.forEach((el) => {
    el.classList.toggle("is-active", el.id === `basic-${view}`);
  });

  if (view === "compress") {
    syncPowerToBasicCompress();
    renderBasicInputs();
    updateBasicPasswordField();
  } else if (view === "extract") {
    updateBasicExtractInfo();
    syncPowerToBasicExtract();
  } else if (view === "browse") {
    updateBasicBrowseInfo();
  }

  hideBasicProgress("compress");
  hideBasicProgress("extract");
  hideBasicCompletion("compress");
  hideBasicCompletion("extract");
}

function syncBasicToPower(): void {
  const basicPreset = document.getElementById(
    "basic-preset",
  ) as HTMLSelectElement | null;
  const basicFormat = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  const basicArchiveName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  const basicPassword = document.getElementById(
    "basic-password",
  ) as HTMLInputElement | null;

  if (basicFormat) {
    $<HTMLSelectElement>("format").value = basicFormat.value;
    updateCompressionOptionsForFormat(basicFormat.value);
  }

  if (basicPreset) {
    applyPreset(basicPreset.value);
    $<HTMLSelectElement>("preset").value = basicPreset.value;
  }

  if (basicArchiveName) {
    $<HTMLInputElement>("archive-name").value = basicArchiveName.value;
  }

  if (basicOutputPath) {
    $<HTMLInputElement>("output-path").value = basicOutputPath.value;
  }

  if (basicPassword) {
    $<HTMLInputElement>("password").value = basicPassword.value;
  }

  onCompressionOptionChange();
}

function syncBasicExtractToPower(): void {
  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  const basicExtractPassword = document.getElementById(
    "basic-extract-password",
  ) as HTMLInputElement | null;

  if (basicExtractPath) {
    $<HTMLInputElement>("extract-path").value = basicExtractPath.value;
  }

  if (basicExtractPassword) {
    $<HTMLInputElement>("extract-password").value = basicExtractPassword.value;
  }
}

function syncPowerToBasicCompress(): void {
  const basicFormat = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  const basicArchiveName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;

  if (basicFormat) {
    basicFormat.value = $<HTMLSelectElement>("format").value;
  }
  if (basicOutputPath) {
    basicOutputPath.value = $<HTMLInputElement>("output-path").value;
  }
  if (basicArchiveName) {
    basicArchiveName.value = $<HTMLInputElement>("archive-name").value;
  }
}

function syncPowerToBasicExtract(): void {
  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  if (basicExtractPath) {
    basicExtractPath.value = $<HTMLInputElement>("extract-path").value;
  }
}

function updateBasicExtractInfo(): void {
  const archivePath = state.inputs[0] ?? "";
  const name = basename(archivePath) || "archive";
  const ext =
    extension(archivePath).replace(".", "").toUpperCase() || "Archive";

  const nameEl = document.getElementById("basic-extract-archive-name");
  const metaEl = document.getElementById("basic-extract-archive-meta");
  if (nameEl) nameEl.textContent = name;
  if (metaEl) metaEl.textContent = `${ext} archive`;

  const extractPathInput = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  if (extractPathInput && !extractPathInput.value) {
    const autofill = resolveExtractDestinationAutofill(
      extractPathInput.value,
      state.lastAutoExtractDestination,
      archivePath,
    );
    if (autofill) {
      extractPathInput.value = autofill;
      state.lastAutoExtractDestination = autofill;
    }
  }
}

function updateBasicBrowseInfo(): void {
  const archivePath = state.inputs[0] ?? "";
  const name = basename(archivePath) || "archive";
  const ext =
    extension(archivePath).replace(".", "").toUpperCase() || "Archive";

  const nameEl = document.getElementById("basic-browse-archive-name");
  const metaEl = document.getElementById("basic-browse-archive-meta");
  if (nameEl) nameEl.textContent = name;
  if (metaEl) metaEl.textContent = `${ext} archive`;
}

export function renderBasicInputs(): void {
  if (getWorkspaceMode() !== "basic") return;

  const list = document.getElementById("basic-input-list");
  if (!list) return;

  list.innerHTML = "";

  if (state.inputs.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding: 16px; text-align: center; color: var(--text-secondary); font-size: 0.8125rem;";
    empty.textContent =
      "No files added yet. Drop files above or use the buttons below.";
    list.appendChild(empty);
    return;
  }

  for (let i = 0; i < state.inputs.length; i++) {
    const path = state.inputs[i];
    const item = document.createElement("div");
    item.className = "basic-file-item";

    const pathEl = document.createElement("span");
    pathEl.className = "basic-file-item__path";
    pathEl.textContent = basename(path);
    pathEl.title = path;

    const removeBtn = document.createElement("button");
    removeBtn.className = "basic-file-item__remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.title = "Remove";
    removeBtn.disabled = state.running;
    const index = i;
    removeBtn.addEventListener("click", () => {
      state.inputs.splice(index, 1);
      renderInputs();
    });

    item.appendChild(pathEl);
    item.appendChild(removeBtn);
    list.appendChild(item);
  }

  syncBasicOutputAutofill();
}

function syncBasicOutputAutofill(): void {
  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  const basicArchiveName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  const basicFormat = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  if (!basicOutputPath || !basicFormat) return;

  const format = basicFormat.value;
  const customName = basicArchiveName?.value.trim() || undefined;
  const next = resolveOutputArchiveAutofill(
    basicOutputPath.value,
    state.lastAutoOutputPath,
    state.inputs,
    format,
    customName,
  );
  if (next) {
    basicOutputPath.value = next;
    state.lastAutoOutputPath = next;
  }
}

function updateBasicPasswordField(): void {
  const formatEl = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  const passwordEl = document.getElementById(
    "basic-password",
  ) as HTMLInputElement | null;
  const toggleBtn = document.getElementById(
    "basic-toggle-password",
  ) as HTMLButtonElement | null;
  if (!formatEl || !passwordEl) return;

  const supported = ENCRYPTION_FORMATS.has(formatEl.value);
  passwordEl.disabled = !supported;
  if (toggleBtn) toggleBtn.disabled = !supported;

  if (supported) {
    passwordEl.placeholder = "Leave blank for none";
  } else {
    passwordEl.placeholder = `${formatEl.value.toUpperCase()} does not support encryption`;
    passwordEl.value = "";
  }
}

function showBasicProgress(section: "compress" | "extract"): void {
  const progress = document.getElementById(`basic-${section}-progress`);
  const completion = document.getElementById(`basic-${section}-completion`);
  if (progress) progress.classList.add("is-active");
  if (completion) completion.classList.remove("is-active");

  const runBtn =
    section === "compress"
      ? document.getElementById("basic-run-compress")
      : document.getElementById("basic-run-extract");
  if (runBtn) (runBtn as HTMLButtonElement).disabled = true;
}

function hideBasicProgress(section: "compress" | "extract"): void {
  const progress = document.getElementById(`basic-${section}-progress`);
  if (progress) progress.classList.remove("is-active");
}

function showBasicCompletion(
  section: "compress" | "extract",
  success: boolean,
  title: string,
  message: string,
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

  if (iconEl) iconEl.textContent = success ? "\u2705" : "\u274c";
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  const runBtn =
    section === "compress"
      ? document.getElementById("basic-run-compress")
      : document.getElementById("basic-run-extract");
  if (runBtn) (runBtn as HTMLButtonElement).disabled = false;
}

function hideBasicCompletion(section: "compress" | "extract"): void {
  const completion = document.getElementById(`basic-${section}-completion`);
  if (completion) completion.classList.remove("is-active");
}

export function updateBasicRunningState(active: boolean): void {
  if (getWorkspaceMode() !== "basic") return;

  const section = getMode() === "extract" ? "extract" : "compress";

  if (active) {
    showBasicProgress(section);
  } else {
    hideBasicProgress(section);
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
}

export function updateBasicStatus(text: string): void {
  if (getWorkspaceMode() !== "basic") return;

  const section = getMode() === "extract" ? "extract" : "compress";
  const statusEl = document.getElementById(`basic-${section}-status`);
  if (statusEl) statusEl.textContent = text;

  if (text === "Done") {
    hideBasicProgress(section);
    showBasicCompletion(
      section,
      true,
      section === "compress" ? "Archive created" : "Extraction complete",
      section === "compress"
        ? "Your archive has been created successfully."
        : "Files have been extracted successfully.",
    );
  } else if (text === "Error") {
    hideBasicProgress(section);
    showBasicCompletion(
      section,
      false,
      "Operation failed",
      "Something went wrong. Check the error message for details.",
    );
  } else if (text === "Cancelled") {
    hideBasicProgress(section);
  }
}

async function allPathsAreArchives(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  try {
    const results = await validateArchivePaths(paths);
    return results.length === paths.length && results.every((r) => r.valid);
  } catch {
    return false;
  }
}

async function handleBasicDrop(paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  const allArchives = await allPathsAreArchives(paths);

  state.inputs.length = 0;
  for (const p of paths) {
    if (!state.inputs.includes(p)) {
      state.inputs.push(p);
    }
  }

  if (allArchives) {
    setMode("extract");
    setBasicView("extract");
    renderInputs();
    if (paths.length === 1) {
      setMode("browse");
      setBasicView("browse");
      void browseArchive();
    }
  } else {
    setMode("add");
    setBasicView("compress");
    renderInputs();
  }
}

async function handleBasicCompressAction(): Promise<void> {
  syncBasicToPower();
  setMode("add");
  showBasicProgress("compress");
  hideBasicCompletion("compress");
  await runAction();
}

async function handleBasicExtractAction(): Promise<void> {
  syncBasicExtractToPower();
  setMode("extract");
  showBasicProgress("extract");
  hideBasicCompletion("extract");
  await runAction();
}

function togglePasswordVisibility(inputId: string, btnId: string): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!input || !btn) return;

  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "Hide";
  } else {
    input.type = "password";
    btn.textContent = "Show";
  }
}

export function renderBasicBrowseTable(
  entries: Array<{
    path: string;
    size: string;
    packed: string;
    modified: string;
    isDir: boolean;
  }>,
): void {
  const tbody = document.getElementById("basic-browse-tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  for (const entry of entries) {
    const tr = document.createElement("tr");
    if (entry.isDir) tr.className = "browse-folder";

    const tdName = document.createElement("td");
    tdName.textContent = entry.path;
    tdName.style.wordBreak = "break-all";

    const tdSize = document.createElement("td");
    tdSize.textContent = entry.size;
    tdSize.style.fontVariantNumeric = "tabular-nums";

    const tdPacked = document.createElement("td");
    tdPacked.textContent = entry.packed;
    tdPacked.style.fontVariantNumeric = "tabular-nums";

    const tdModified = document.createElement("td");
    tdModified.textContent = entry.modified;

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdPacked);
    tr.appendChild(tdModified);
    tbody.appendChild(tr);
  }
}

export function setBasicBrowseSummary(text: string): void {
  const el = document.getElementById("basic-browse-summary");
  if (el) el.textContent = text;
}

export function initBasicWorkspace(): void {
  const dropzone = document.getElementById("basic-dropzone");
  const compressCard = document.getElementById("basic-action-compress");
  const openCard = document.getElementById("basic-action-open");

  if (dropzone) {
    dropzone.addEventListener("click", async () => {
      const selection = await open({
        title: "Select files or archives",
        multiple: true,
      });
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      if (paths.length > 0) {
        await handleBasicDrop(paths);
      }
    });
  }

  if (compressCard) {
    compressCard.addEventListener("click", async () => {
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      setMode("add");
      renderInputs();
      setBasicView("compress");
    });
  }

  if (openCard) {
    openCard.addEventListener("click", async () => {
      const selection = await open({
        title: "Open archive",
        multiple: true,
        filters: [
          {
            name: "Archives",
            extensions: [
              "7z",
              "zip",
              "tar",
              "gz",
              "tgz",
              "bz2",
              "tbz2",
              "xz",
              "txz",
              "rar",
            ],
          },
        ],
      });
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      if (paths.length > 0) {
        state.inputs.length = 0;
        for (const p of paths) {
          if (!state.inputs.includes(p)) state.inputs.push(p);
        }
        setMode("extract");
        renderInputs();
        setBasicView("extract");
      }
    });
  }

  wireBasicCompressEvents();
  wireBasicExtractEvents();
  wireBasicBrowseEvents();

  registerBasicHooks({
    onRenderInputs: () => renderBasicInputs(),
    onSetRunning: (active) => updateBasicRunningState(active),
    onSetStatus: (text) => updateBasicStatus(text),
  });
}

function wireBasicCompressEvents(): void {
  const backBtn = document.getElementById("basic-compress-back");
  if (backBtn) {
    backBtn.addEventListener("click", () => setBasicView("home"));
  }

  const addFilesBtn = document.getElementById("basic-add-files");
  if (addFilesBtn) {
    addFilesBtn.addEventListener("click", async () => {
      await addFiles();
    });
  }

  const addFolderBtn = document.getElementById("basic-add-folder");
  if (addFolderBtn) {
    addFolderBtn.addEventListener("click", async () => {
      await addFolder();
    });
  }

  const clearBtn = document.getElementById("basic-clear-inputs");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      renderInputs();
      const nameInput = document.getElementById(
        "basic-archive-name",
      ) as HTMLInputElement | null;
      const outputInput = document.getElementById(
        "basic-output-path",
      ) as HTMLInputElement | null;
      if (nameInput) nameInput.value = "";
      if (outputInput) outputInput.value = "";
    });
  }

  const chooseOutputBtn = document.getElementById("basic-choose-output");
  if (chooseOutputBtn) {
    chooseOutputBtn.addEventListener("click", async () => {
      syncBasicToPower();
      await chooseOutput();
      const outputVal = $<HTMLInputElement>("output-path").value;
      const basicOutput = document.getElementById(
        "basic-output-path",
      ) as HTMLInputElement | null;
      if (basicOutput && outputVal) basicOutput.value = outputVal;
    });
  }

  const presetSelect = document.getElementById(
    "basic-preset",
  ) as HTMLSelectElement | null;
  if (presetSelect) {
    presetSelect.addEventListener("change", () => {
      syncBasicToPower();
    });
  }

  const formatSelect = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  if (formatSelect) {
    formatSelect.addEventListener("change", () => {
      syncBasicToPower();
      syncBasicOutputAutofill();
      updateBasicPasswordField();
    });
  }

  const archiveNameInput = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  if (archiveNameInput) {
    archiveNameInput.addEventListener("input", () => {
      const format =
        (document.getElementById("basic-format") as HTMLSelectElement | null)
          ?.value ?? "7z";
      const customName = archiveNameInput.value.trim() || undefined;
      const next = deriveOutputArchivePath(state.inputs, format, customName);
      const basicOutput = document.getElementById(
        "basic-output-path",
      ) as HTMLInputElement | null;
      if (next && basicOutput) {
        basicOutput.value = next;
        state.lastAutoOutputPath = next;
      }
    });
  }

  const runBtn = document.getElementById("basic-run-compress");
  if (runBtn) {
    runBtn.addEventListener("click", () => void handleBasicCompressAction());
  }

  const cancelBtn = document.getElementById("basic-compress-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", cancelAction);
  }

  const togglePwBtn = document.getElementById("basic-toggle-password");
  if (togglePwBtn) {
    togglePwBtn.addEventListener("click", () => {
      togglePasswordVisibility("basic-password", "basic-toggle-password");
    });
  }

  const openDestBtn = document.getElementById("basic-compress-open-dest");
  if (openDestBtn) {
    openDestBtn.addEventListener("click", () => {
      const outputPath =
        (
          document.getElementById(
            "basic-output-path",
          ) as HTMLInputElement | null
        )?.value ?? "";
      if (outputPath) {
        const sep = Math.max(
          outputPath.lastIndexOf("/"),
          outputPath.lastIndexOf("\\"),
        );
        const folder = sep >= 0 ? outputPath.slice(0, sep) : outputPath;
        void invoke("open_path", { path: folder });
      }
    });
  }

  const compressAgainBtn = document.getElementById("basic-compress-again");
  if (compressAgainBtn) {
    compressAgainBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      renderInputs();
      hideBasicCompletion("compress");
      const nameInput = document.getElementById(
        "basic-archive-name",
      ) as HTMLInputElement | null;
      const outputInput = document.getElementById(
        "basic-output-path",
      ) as HTMLInputElement | null;
      if (nameInput) nameInput.value = "";
      if (outputInput) outputInput.value = "";
    });
  }
}

function wireBasicExtractEvents(): void {
  const backBtn = document.getElementById("basic-extract-back");
  if (backBtn) {
    backBtn.addEventListener("click", () => setBasicView("home"));
  }

  const chooseExtractBtn = document.getElementById("basic-choose-extract");
  if (chooseExtractBtn) {
    chooseExtractBtn.addEventListener("click", async () => {
      await chooseExtract();
      const extractVal = $<HTMLInputElement>("extract-path").value;
      const basicExtract = document.getElementById(
        "basic-extract-path",
      ) as HTMLInputElement | null;
      if (basicExtract && extractVal) basicExtract.value = extractVal;
    });
  }

  const runBtn = document.getElementById("basic-run-extract");
  if (runBtn) {
    runBtn.addEventListener("click", () => void handleBasicExtractAction());
  }

  const cancelBtn = document.getElementById("basic-extract-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", cancelAction);
  }

  const browseContentsBtn = document.getElementById("basic-browse-contents");
  if (browseContentsBtn) {
    browseContentsBtn.addEventListener("click", async () => {
      setMode("browse");
      setBrowsePasswordFieldVisible(false);
      setBasicView("browse");
      await browseArchive();
    });
  }

  const togglePwBtn = document.getElementById("basic-toggle-extract-password");
  if (togglePwBtn) {
    togglePwBtn.addEventListener("click", () => {
      togglePasswordVisibility(
        "basic-extract-password",
        "basic-toggle-extract-password",
      );
    });
  }

  const openDestBtn = document.getElementById("basic-extract-open-dest");
  if (openDestBtn) {
    openDestBtn.addEventListener("click", () => {
      const extractPath =
        (
          document.getElementById(
            "basic-extract-path",
          ) as HTMLInputElement | null
        )?.value ?? "";
      if (extractPath) {
        void invoke("open_path", { path: extractPath });
      }
    });
  }

  const extractAnotherBtn = document.getElementById("basic-extract-another");
  if (extractAnotherBtn) {
    extractAnotherBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoExtractDestination = null;
      renderInputs();
      hideBasicCompletion("extract");
      setBasicView("home");
    });
  }
}

function wireBasicBrowseEvents(): void {
  const backBtn = document.getElementById("basic-browse-back");
  if (backBtn) {
    backBtn.addEventListener("click", () => setBasicView("home"));
  }

  const extractAllBtn = document.getElementById("basic-browse-extract-all");
  if (extractAllBtn) {
    extractAllBtn.addEventListener("click", () => {
      setMode("extract");
      setBasicView("extract");
    });
  }

  const testBtn = document.getElementById("basic-browse-test");
  if (testBtn) {
    testBtn.addEventListener("click", () => void testArchive());
  }
}

export function syncBasicBeforeRun(): void {
  if (getWorkspaceMode() !== "basic") return;
  const mode = getMode();
  if (mode === "add") {
    syncBasicToPower();
  } else if (mode === "extract") {
    syncBasicExtractToPower();
  }
}

export function handleBasicDragDrop(type: string, paths?: string[]): void {
  if (getWorkspaceMode() !== "basic") return;

  const dropzone = document.getElementById("basic-dropzone");
  if (!dropzone) return;

  if (type === "enter" || type === "over") {
    dropzone.classList.add("is-drag-over");
  } else if (type === "leave") {
    dropzone.classList.remove("is-drag-over");
  } else if (type === "drop") {
    dropzone.classList.remove("is-drag-over");
    if (paths && paths.length > 0) {
      void handleBasicDrop(paths);
    }
  }
}
