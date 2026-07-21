import { open, confirm, save, message } from "@tauri-apps/plugin-dialog";
import { promptInput } from "./prompt-modal";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { $ } from "./utils";
import { state } from "./state";
import {
  log,
  getWorkspaceMode,
  getMode,
  setMode,
  renderInputs,
  setBrowsePasswordFieldVisible,
  registerBasicHooks,
  triggerIconRefresh,
} from "./ui";
import {
  applyPreset,
  updateCompressionOptionsForFormat,
  onCompressionOptionChange,
} from "./presets";
import { validateArchivePaths } from "./archive-rules";
import {
  runAction,
  cancelAction,
  browseArchive,
  testArchive,
  Run7zResult,
  looksLikePasswordRequiredError,
  parseArchiveListing,
} from "./archive";
import { chooseOutput, chooseExtract, addFiles, addFolder } from "./files";
import {
  deriveOutputArchivePath,
  isPreferredCompressParent,
  resolveOutputArchiveAutofill,
  resolveExtractDestinationAutofill,
} from "./extract-path";
import { getCompressionSecuritySupport } from "./compression-security";
import {
  setProgressIndeterminateClass,
  setProgressPercentClass,
} from "./progress-bar";

export type BasicView = "home" | "compress" | "extract" | "browse";

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

function parentDirForPath(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (sep < 0) return path;
  if (sep === 0) return "/";
  const parent = path.slice(0, sep);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

const RECENT_ARCHIVES_KEY = "zinnia.basic.recentArchives";
const MAX_RECENT_ARCHIVES = 5;

function loadRecentArchives(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_ARCHIVES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
      .slice(0, MAX_RECENT_ARCHIVES);
  } catch {
    return [];
  }
}

function saveRecentArchives(paths: string[]): void {
  try {
    localStorage.setItem(
      RECENT_ARCHIVES_KEY,
      JSON.stringify(paths.slice(0, MAX_RECENT_ARCHIVES)),
    );
  } catch {
    // ignore quota / private mode
  }
}

function rememberRecentArchive(path: string): void {
  if (!path) return;
  const next = [path, ...loadRecentArchives().filter((p) => p !== path)].slice(
    0,
    MAX_RECENT_ARCHIVES,
  );
  saveRecentArchives(next);
  renderRecentArchives();
}

function renderRecentArchives(): void {
  const wrap = document.getElementById("basic-recent");
  const list = document.getElementById("basic-recent-list");
  if (!wrap || !list) return;
  const recent = loadRecentArchives();
  list.replaceChildren();
  if (recent.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  for (const path of recent) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "basic-recent__item";
    btn.textContent = basename(path);
    btn.title = path;
    btn.addEventListener("click", () => {
      void handleBasicDrop([path]);
    });
    list.appendChild(btn);
  }
}

async function openPathWithFeedback(path: string): Promise<void> {
  if (!path) return;
  try {
    await invoke("open_path", { path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to open path: ${msg}`, "error");
  }
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

  const toolbar = document.getElementById("basic-toolbar");
  if (toolbar) {
    toolbar.hidden = view === "home";
    const tabs = toolbar.querySelectorAll(".basic-toolbar__tab");
    tabs.forEach((tab) => {
      const el = tab as HTMLButtonElement;
      const isActive = el.dataset.basicTab === view;
      el.classList.toggle("is-active", isActive);
    });
  }

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
  triggerIconRefresh();
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
  const basicEncryptHeaders = document.getElementById(
    "basic-encrypt-headers",
  ) as HTMLInputElement | null;
  const basicSplitSize = document.getElementById(
    "basic-split-size",
  ) as HTMLSelectElement | null;

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

  if (basicEncryptHeaders) {
    $<HTMLInputElement>("encrypt-headers").checked =
      basicEncryptHeaders.checked;
  }

  if (basicSplitSize) {
    const splitValue = basicSplitSize.value;
    $<HTMLSelectElement>("split-size").value = splitValue;
    const customField = document.getElementById("split-custom-field");
    if (customField) customField.hidden = splitValue !== "custom";
    if (splitValue === "custom") {
      const basicCustom = document.getElementById(
        "basic-split-custom",
      ) as HTMLInputElement | null;
      if (basicCustom) {
        $<HTMLInputElement>("split-custom").value = basicCustom.value;
      }
    }
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
  const basicPassword = document.getElementById(
    "basic-password",
  ) as HTMLInputElement | null;
  const basicEncryptHeaders = document.getElementById(
    "basic-encrypt-headers",
  ) as HTMLInputElement | null;
  const basicSplitSize = document.getElementById(
    "basic-split-size",
  ) as HTMLSelectElement | null;

  if (basicFormat) {
    basicFormat.value = $<HTMLSelectElement>("format").value;
  }
  if (basicOutputPath) {
    basicOutputPath.value = $<HTMLInputElement>("output-path").value;
  }
  if (basicArchiveName) {
    basicArchiveName.value = $<HTMLInputElement>("archive-name").value;
  }
  if (basicPassword) {
    basicPassword.value = $<HTMLInputElement>("password").value;
  }
  if (basicEncryptHeaders) {
    basicEncryptHeaders.checked =
      $<HTMLInputElement>("encrypt-headers").checked;
  }
  if (basicSplitSize) {
    const powerSplit = $<HTMLSelectElement>("split-size").value;
    const known = [...basicSplitSize.options].some(
      (option) => option.value === powerSplit,
    );
    basicSplitSize.value = known ? powerSplit : powerSplit ? "custom" : "";
    const basicCustom = document.getElementById(
      "basic-split-custom",
    ) as HTMLInputElement | null;
    if (basicCustom && powerSplit === "custom") {
      basicCustom.value = $<HTMLInputElement>("split-custom").value;
    }
    updateBasicSplitCustomVisibility();
  }
}

function updateBasicSplitCustomVisibility(): void {
  const basicSplitSize = document.getElementById(
    "basic-split-size",
  ) as HTMLSelectElement | null;
  const customField = document.getElementById("basic-split-custom-field");
  if (!basicSplitSize || !customField) return;
  customField.hidden = basicSplitSize.value !== "custom";
}

function syncBasicBrowsePasswordToPower(): void {
  const basic = document.getElementById(
    "basic-browse-password",
  ) as HTMLInputElement | null;
  const power = document.getElementById(
    "browse-password",
  ) as HTMLInputElement | null;
  if (basic && power) {
    power.value = basic.value;
  }
}

function setBasicBrowsePasswordVisible(visible: boolean): void {
  const field = document.getElementById("basic-browse-password-field");
  if (field) {
    field.hidden = !visible;
  }
  setBrowsePasswordFieldVisible(visible);
}

async function runBasicBrowseArchive(): Promise<void> {
  syncBasicBrowsePasswordToPower();
  await browseArchive();
  const powerField = document.getElementById("browse-password-field");
  if (powerField && !powerField.hidden) {
    setBasicBrowsePasswordVisible(true);
  }
}

function syncPowerToBasicExtract(): void {
  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  const basicExtractPassword = document.getElementById(
    "basic-extract-password",
  ) as HTMLInputElement | null;
  if (basicExtractPath) {
    basicExtractPath.value = $<HTMLInputElement>("extract-path").value;
  }
  if (basicExtractPassword) {
    basicExtractPassword.value = $<HTMLInputElement>("extract-password").value;
  }
}

function syncPowerToBasicBrowsePassword(): void {
  const basic = document.getElementById(
    "basic-browse-password",
  ) as HTMLInputElement | null;
  const power = document.getElementById(
    "browse-password",
  ) as HTMLInputElement | null;
  if (basic && power) {
    basic.value = power.value;
  }
}

export function syncBasicWorkspaceFromPower(): void {
  syncPowerToBasicCompress();
  syncPowerToBasicExtract();
  syncPowerToBasicBrowsePassword();
  updateBasicPasswordField();
  updateBasicSplitCustomVisibility();
}

function updateBasicExtractInfo(): void {
  const archivePath = state.inputs[0] ?? "";
  const name = basename(archivePath) || "No archive selected";
  const ext = archivePath
    ? `${extension(archivePath).replace(".", "").toUpperCase()} archive`
    : "Click to select an archive file";

  const nameEl = document.getElementById("basic-extract-archive-name");
  const metaEl = document.getElementById("basic-extract-archive-meta");
  if (nameEl) nameEl.textContent = name;
  if (metaEl) metaEl.textContent = ext;

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
  const name = basename(archivePath) || "No archive selected";
  const ext = archivePath
    ? `${extension(archivePath).replace(".", "").toUpperCase()} archive`
    : "Click to select an archive file";

  const nameEl = document.getElementById("basic-browse-archive-name");
  const metaEl = document.getElementById("basic-browse-archive-meta");
  if (nameEl) nameEl.textContent = name;
  if (metaEl) metaEl.textContent = ext;
}

export function renderBasicInputs(): void {
  if (getWorkspaceMode() !== "basic") return;

  const list = document.getElementById("basic-input-list");
  if (!list) return;

  list.innerHTML = "";

  if (state.inputs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "basic-archive-info cursor-default";
    empty.innerHTML = `
      <span class="basic-archive-info__icon">
        <i data-lucide="file-plus" class="lucide-icon"></i>
      </span>
      <div class="basic-archive-info__details">
        <span class="basic-archive-info__name">No files added yet</span>
        <span class="basic-archive-info__meta">Click to select files or folders</span>
      </div>
    `;
    empty.addEventListener("click", async () => {
      const selection = await open({
        title: "Select files or folders",
        multiple: true,
      });
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      if (paths.length > 0) {
        state.inputs.length = 0;
        for (const p of paths) {
          if (!state.inputs.includes(p)) state.inputs.push(p);
        }
        renderInputs();
      }
    });
    list.appendChild(empty);
    triggerIconRefresh();
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
  const customName = basicArchiveName?.value.trim() ?? undefined;
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
  const encryptHeadersEl = document.getElementById(
    "basic-encrypt-headers",
  ) as HTMLInputElement | null;
  const encryptHeadersRow = document.getElementById(
    "basic-encrypt-headers-row",
  ) as HTMLElement | null;
  if (!formatEl || !passwordEl) return;

  const support = getCompressionSecuritySupport(formatEl.value);
  passwordEl.disabled = !support.password;
  if (toggleBtn) toggleBtn.disabled = !support.password;

  if (support.password) {
    passwordEl.placeholder = "Leave blank for none";
  } else {
    passwordEl.placeholder = `${formatEl.value.toUpperCase()} does not support encryption`;
    passwordEl.value = "";
  }

  if (encryptHeadersEl) {
    if (!support.encryptHeaders) {
      encryptHeadersEl.checked = false;
    }
    encryptHeadersEl.disabled = !support.encryptHeaders;
  }
  if (encryptHeadersRow) {
    encryptHeadersRow.hidden = !support.encryptHeaders;
  }
}

function showBasicProgress(section: "compress" | "extract"): void {
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

function hideBasicProgress(section: "compress" | "extract"): void {
  const progress = document.getElementById(`basic-${section}-progress`);
  if (progress) progress.classList.remove("is-active");
}

function showBasicCompletion(
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

function hideBasicCompletion(section: "compress" | "extract"): void {
  const completion = document.getElementById(`basic-${section}-completion`);
  if (completion) completion.classList.remove("is-active");
}

let basicProgressUnlisten: (() => void) | null = null;
let basicProgressGeneration = 0;

function setBasicBarDeterminate(
  section: "compress" | "extract",
  percent: number,
): void {
  const bar = document.getElementById(`basic-${section}-bar`);
  if (!bar) return;
  setProgressPercentClass(bar, percent);
}

function resetBasicBar(section: "compress" | "extract"): void {
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

async function partitionByArchive(
  paths: string[],
): Promise<{ archives: string[]; others: string[] }> {
  try {
    const results = await validateArchivePaths(paths);
    const validByPath = new Map(results.map((r) => [r.path, r.valid]));
    const archives: string[] = [];
    const others: string[] = [];
    for (const p of paths) {
      if (validByPath.get(p)) archives.push(p);
      else others.push(p);
    }
    return { archives, others };
  } catch {
    return { archives: [], others: paths };
  }
}

function loadInputs(paths: string[]): void {
  state.inputs.length = 0;
  for (const p of paths) {
    if (!state.inputs.includes(p)) state.inputs.push(p);
  }
}

async function handleBasicDrop(paths: string[]): Promise<void> {
  if (paths.length === 0 || state.running) return;

  const { archives, others } = await partitionByArchive(paths);
  if (state.running) return;
  const allArchives = others.length === 0 && archives.length > 0;
  const mixed = archives.length > 0 && others.length > 0;

  // Mixed drop: let the user choose extract-the-archives vs compress-everything.
  if (mixed) {
    const extractThem = await confirm(
      `You dropped ${archives.length} archive(s) and ${others.length} other file(s). Extract the archives, or compress everything into a new archive?`,
      {
        title: "Mixed selection",
        okLabel: "Extract archives",
        cancelLabel: "Compress all",
      },
    );
    if (state.running) return;
    if (extractThem) {
      loadInputs(archives);
      setMode("extract");
      setBasicView("extract");
      renderInputs();
    } else {
      loadInputs(paths);
      setMode("add");
      setBasicView("compress");
      renderInputs();
    }
    return;
  }

  loadInputs(paths);

  if (allArchives) {
    if (paths.length === 1) {
      setMode("browse");
      setBasicView("browse");
      renderInputs();
      void runBasicBrowseArchive();
    } else {
      setMode("extract");
      setBasicView("extract");
      renderInputs();
    }
  } else {
    setMode("add");
    setBasicView("compress");
    renderInputs();
  }
}

async function handleBasicCompressAction(): Promise<void> {
  if (state.inputs.length === 0) {
    showBasicCompletion(
      "compress",
      false,
      "Operation failed",
      "Add at least one input.",
    );
    return;
  }

  const formatEarly = (
    document.getElementById("basic-format") as HTMLSelectElement | null
  )?.value?.toLowerCase();
  if (
    state.inputs.length > 1 &&
    (formatEarly === "gzip" || formatEarly === "bzip2" || formatEarly === "xz")
  ) {
    showBasicCompletion(
      "compress",
      false,
      "Operation failed",
      `${(formatEarly || "format").toUpperCase()} accepts exactly one input. Pick one file, or use 7z/ZIP/TAR.`,
    );
    return;
  }

  const formatSelect = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  const format = formatSelect?.value ?? "7z";

  // Prefer saving next to the source, but not under Start Menu / Program Files
  // (common for .lnk shortcuts) where staging dirs get Access Denied.
  let defaultPath = `Archive.${format}`;
  if (state.inputs[0]) {
    const parent = parentDirForPath(state.inputs[0]);
    if (parent && isPreferredCompressParent(parent)) {
      const sep = state.inputs[0].includes("\\") ? "\\" : "/";
      defaultPath = parent.endsWith(sep)
        ? `${parent}Archive.${format}`
        : `${parent}${sep}Archive.${format}`;
    }
  }

  const output = await save({
    title: "Choose output archive",
    defaultPath,
  });

  if (!output) {
    return;
  }

  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  if (basicOutputPath) {
    basicOutputPath.value = output;
  }

  const basicArchiveName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  if (basicArchiveName) {
    basicArchiveName.value = ""; // Let output path dictate name
  }

  syncBasicToPower();
  setMode("add");
  showBasicProgress("compress");
  hideBasicCompletion("compress");
  await runAction();
}

async function testArchivePassword(
  archive: string,
  password?: string,
): Promise<boolean> {
  try {
    const args = ["t"];
    if (password) {
      args.push(`-p${password}`);
    }
    args.push("--", archive);
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (result.code > 1) {
      return !looksLikePasswordRequiredError(result.stdout, result.stderr);
    }
    return true;
  } catch {
    return false;
  }
}

async function isArchiveEncrypted(archivePath: string): Promise<boolean> {
  const cached = state.browseArchiveInfoByPath.get(archivePath);
  if (cached) {
    return cached.encrypted;
  }

  try {
    const args = ["l", "-slt", "--", archivePath];
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (result.code > 1) {
      return looksLikePasswordRequiredError(result.stdout, result.stderr);
    }
    const info = parseArchiveListing(result.stdout);
    return info.encrypted;
  } catch {
    return false;
  }
}

async function handleBasicExtractAction(): Promise<void> {
  const archive = state.inputs[0];
  if (!archive) {
    showBasicCompletion(
      "extract",
      false,
      "Operation failed",
      "Select an archive to extract.",
    );
    return;
  }

  // 1. Check if archive is encrypted
  const isEncrypted = await isArchiveEncrypted(archive);
  let password = "";

  if (isEncrypted) {
    let correctPassword = false;
    while (!correctPassword) {
      const input = await promptInput({
        title: "Password Required",
        label: "This archive is encrypted. Enter password:",
        password: true,
      });

      if (input === null) {
        // User cancelled the prompt modal
        return;
      }

      // Test the password
      const ok = await testArchivePassword(archive, input);
      if (ok) {
        password = input;
        correctPassword = true;
      } else {
        await message("Incorrect password. Please try again.", {
          title: "Error",
          kind: "error",
        });
      }
    }
  }

  // 2. Open the folder picker before copying a password into the DOM. A
  // cancelled picker must not leave a verified password resident in fields.
  const output = await open({
    title: "Choose destination folder",
    directory: true,
  });

  if (!output || typeof output !== "string") {
    return;
  }

  // 3. Populate the fields only for the immediate extraction run. The normal
  // run cleanup clears both fields when the operation finishes.
  const basicPasswordInput = document.getElementById(
    "basic-extract-password",
  ) as HTMLInputElement | null;
  if (basicPasswordInput) {
    basicPasswordInput.value = password;
  }
  const powerPasswordInput = document.getElementById(
    "extract-password",
  ) as HTMLInputElement | null;
  if (powerPasswordInput) {
    powerPasswordInput.value = password;
  }

  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  if (basicExtractPath) {
    basicExtractPath.value = output;
  }

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

  const isPassword = input.type === "password";
  if (isPassword) {
    input.type = "text";
    btn.textContent = "Hide";
    btn.setAttribute("aria-pressed", "true");
  } else {
    input.type = "password";
    btn.textContent = "Show";
    btn.setAttribute("aria-pressed", "false");
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
    const iconName = entry.isDir ? "folder" : "file";
    tdName.innerHTML = `<i data-lucide="${iconName}" class="lucide-icon lucide-icon--inline"></i><span></span>`;
    tdName.querySelector("span")!.textContent = entry.path;
    tdName.classList.add("cell-break");

    const tdSize = document.createElement("td");
    tdSize.textContent = entry.size;
    tdSize.classList.add("cell-tabular");

    const tdPacked = document.createElement("td");
    tdPacked.textContent = entry.packed;
    tdPacked.classList.add("cell-tabular");

    const tdModified = document.createElement("td");
    tdModified.textContent = entry.modified;

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdPacked);
    tr.appendChild(tdModified);
    tbody.appendChild(tr);
  }
  triggerIconRefresh();
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
    const activateDropzone = async (): Promise<void> => {
      if (state.running) return;
      const selection = await open({
        title: "Select files or archives",
        multiple: true,
      });
      if (state.running) return;
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      if (paths.length > 0) {
        await handleBasicDrop(paths);
      }
    };
    dropzone.addEventListener("click", () => void activateDropzone());
    dropzone.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void activateDropzone();
      }
    });
  }

  if (compressCard) {
    compressCard.addEventListener("click", async () => {
      if (state.running) return;
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      setMode("add");
      renderInputs();
      setBasicView("compress");
    });
  }

  if (openCard) {
    openCard.addEventListener("click", async () => {
      if (state.running) return;
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
      if (state.running) return;
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      if (paths.length > 0) {
        state.inputs.length = 0;
        for (const p of paths) {
          if (!state.inputs.includes(p)) state.inputs.push(p);
        }
        if (paths.length === 1) {
          setMode("browse");
          setBasicBrowsePasswordVisible(false);
          renderInputs();
          setBasicView("browse");
          await runBasicBrowseArchive();
        } else {
          setMode("extract");
          renderInputs();
          setBasicView("extract");
        }
      }
    });
  }

  const extractArchiveInfo = document.getElementById(
    "basic-extract-archive-info",
  );
  if (extractArchiveInfo) {
    extractArchiveInfo.addEventListener("click", async () => {
      const selection = await open({
        title: "Open archive",
        multiple: false,
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
      const path = typeof selection === "string" ? selection : selection[0];
      if (path) {
        state.inputs = [path];
        renderInputs();
      }
    });
  }

  const browseArchiveInfo = document.getElementById(
    "basic-browse-archive-info",
  );
  if (browseArchiveInfo) {
    browseArchiveInfo.addEventListener("click", async () => {
      const selection = await open({
        title: "Open archive",
        multiple: false,
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
      const path = typeof selection === "string" ? selection : selection[0];
      if (path) {
        state.inputs = [path];
        renderInputs();
        void runBasicBrowseArchive();
      }
    });
  }

  wireBasicCompressEvents();
  wireBasicExtractEvents();
  wireBasicBrowseEvents();
  wireBasicKeyboardEvents();

  const tabHome = document.getElementById("basic-tab-home");
  if (tabHome) {
    tabHome.addEventListener("click", () => {
      setBasicView("home");
    });
  }
  const tabCompress = document.getElementById("basic-tab-compress");
  if (tabCompress) {
    tabCompress.addEventListener("click", () => {
      setBasicView("compress");
      setMode("add");
      renderInputs();
    });
  }
  const tabExtract = document.getElementById("basic-tab-extract");
  if (tabExtract) {
    tabExtract.addEventListener("click", () => {
      setBasicView("extract");
      setMode("extract");
      renderInputs();
    });
  }
  const tabBrowse = document.getElementById("basic-tab-browse");
  if (tabBrowse) {
    tabBrowse.addEventListener("click", () => {
      setBasicView("browse");
      setMode("browse");
      renderInputs();
    });
  }

  registerBasicHooks({
    onRenderInputs: () => renderBasicInputs(),
    onSetRunning: (active) => updateBasicRunningState(active),
    onSetStatus: (text, errorDetail) => updateBasicStatus(text, errorDetail),
  });
  renderRecentArchives();
}

function wireBasicCompressEvents(): void {
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

  const encryptHeadersInput = document.getElementById(
    "basic-encrypt-headers",
  ) as HTMLInputElement | null;
  if (encryptHeadersInput) {
    encryptHeadersInput.addEventListener("change", () => {
      syncBasicToPower();
    });
  }

  const splitSizeSelect = document.getElementById(
    "basic-split-size",
  ) as HTMLSelectElement | null;
  if (splitSizeSelect) {
    splitSizeSelect.addEventListener("change", () => {
      updateBasicSplitCustomVisibility();
      syncBasicToPower();
    });
  }

  const splitCustomInput = document.getElementById(
    "basic-split-custom",
  ) as HTMLInputElement | null;
  if (splitCustomInput) {
    splitCustomInput.addEventListener("input", () => {
      syncBasicToPower();
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
        const folder = parentDirForPath(outputPath);
        void openPathWithFeedback(folder);
      }
    });
  }

  const compressAgainBtn = document.getElementById("basic-compress-again");
  if (compressAgainBtn) {
    compressAgainBtn.addEventListener("click", () => {
      const isFailure = compressAgainBtn.textContent?.trim() === "Close";
      if (isFailure) {
        hideBasicCompletion("compress");
      } else {
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
      }
    });
  }

  const compressCloseBtn = document.getElementById(
    "basic-compress-completion-close",
  );
  if (compressCloseBtn) {
    compressCloseBtn.addEventListener("click", () => {
      hideBasicCompletion("compress");
    });
  }
}

function wireBasicExtractEvents(): void {
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
      setBasicBrowsePasswordVisible(false);
      setBasicView("browse");
      await runBasicBrowseArchive();
    });
  }

  const toggleBrowsePwBtn = document.getElementById(
    "basic-toggle-browse-password",
  );
  if (toggleBrowsePwBtn) {
    toggleBrowsePwBtn.addEventListener("click", () => {
      togglePasswordVisibility(
        "basic-browse-password",
        "basic-toggle-browse-password",
      );
    });
  }

  const basicBrowsePassword = document.getElementById("basic-browse-password");
  if (basicBrowsePassword) {
    basicBrowsePassword.addEventListener("change", () => {
      syncBasicBrowsePasswordToPower();
    });
    basicBrowsePassword.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") {
        void runBasicBrowseArchive();
      }
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
        void openPathWithFeedback(extractPath);
      }
    });
  }

  document
    .querySelectorAll<HTMLButtonElement>(".basic-preset-pill")
    .forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(".basic-preset-pill").forEach((p) => {
          p.classList.remove("is-active");
          p.setAttribute("aria-pressed", "false");
        });
        pill.classList.add("is-active");
        pill.setAttribute("aria-pressed", "true");

        const preset = pill.dataset.basicPreset;
        const select = document.getElementById(
          "basic-preset",
        ) as HTMLSelectElement | null;
        if (select && preset) {
          select.value = preset;
          applyPreset(preset);
        }
      });
    });

  const compressAnotherBtn = document.getElementById("basic-compress-another");
  if (compressAnotherBtn) {
    compressAnotherBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      renderInputs();
      hideBasicCompletion("compress");
      setBasicView("home");
    });
  }

  const compressHomeBtn = document.getElementById("basic-compress-home");
  if (compressHomeBtn) {
    compressHomeBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      renderInputs();
      hideBasicCompletion("compress");
      setBasicView("home");
    });
  }

  const extractAnotherBtn = document.getElementById("basic-extract-another");
  if (extractAnotherBtn) {
    extractAnotherBtn.addEventListener("click", () => {
      const isFailure = extractAnotherBtn.textContent?.trim() === "Close";
      if (isFailure) {
        hideBasicCompletion("extract");
      } else {
        state.inputs.length = 0;
        state.lastAutoExtractDestination = null;
        renderInputs();
        hideBasicCompletion("extract");
        setBasicView("home");
      }
    });
  }

  const extractCloseBtn = document.getElementById(
    "basic-extract-completion-close",
  );
  if (extractCloseBtn) {
    extractCloseBtn.addEventListener("click", () => {
      hideBasicCompletion("extract");
    });
  }

  const extractHomeBtn = document.getElementById("basic-extract-home");
  if (extractHomeBtn) {
    extractHomeBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoExtractDestination = null;
      renderInputs();
      hideBasicCompletion("extract");
      setBasicView("home");
    });
  }
}

function wireBasicBrowseEvents(): void {
  const extractAllBtn = document.getElementById("basic-browse-extract-all");
  if (extractAllBtn) {
    extractAllBtn.addEventListener("click", () => {
      setMode("extract");
      setBasicView("extract");
      void handleBasicExtractAction();
    });
  }

  const testBtn = document.getElementById("basic-browse-test");
  if (testBtn) {
    testBtn.addEventListener("click", () => {
      syncBasicBrowsePasswordToPower();
      void testArchive();
    });
  }
}

export function syncBasicBeforeRun(): void {
  if (getWorkspaceMode() !== "basic") return;
  const mode = getMode();
  if (mode === "add") {
    syncBasicToPower();
    // Basic mode does not expose these Power-only controls; force safe defaults
    // so a prior Power session cannot leak update behavior into Basic runs.
    const updateMode = document.getElementById(
      "update-mode",
    ) as HTMLInputElement | null;
    if (updateMode) updateMode.checked = false;
    const pathMode = document.getElementById(
      "path-mode",
    ) as HTMLInputElement | null;
    if (pathMode) pathMode.value = "relative";
  } else if (mode === "extract") {
    syncBasicExtractToPower();
  } else if (mode === "browse") {
    syncBasicBrowsePasswordToPower();
  }
}

export function handleBasicDragDrop(type: string, paths?: string[]): void {
  if (getWorkspaceMode() !== "basic") return;

  // Highlight the home dropzone when it's showing, otherwise the whole
  // workspace so drops are discoverable from every basic view.
  const dropzone = document.getElementById("basic-dropzone");
  const workspace = document.getElementById("basic-workspace");
  const target = currentBasicView === "home" && dropzone ? dropzone : workspace;
  if (!target) return;

  if (state.running) {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
    return;
  }

  if (type === "enter" || type === "over") {
    target.classList.add("is-drag-over");
  } else if (type === "leave") {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
  } else if (type === "drop") {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
    if (paths && paths.length > 0) {
      void handleBasicDrop(paths);
    }
  }
}

function wireBasicKeyboardEvents(): void {
  document.addEventListener("keydown", (e) => {
    if (getWorkspaceMode() !== "basic") return;
    // Overlays use [hidden]; .modal nodes stay in the DOM without that attribute.
    if (document.querySelector(".modal-overlay:not([hidden])")) return;

    if (e.key === "Escape") {
      const activeElement = document.activeElement as HTMLElement;
      if (
        activeElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName)
      ) {
        activeElement.blur();
        return;
      }
      if (
        document
          .getElementById("basic-compress")
          ?.classList.contains("is-active") ||
        document
          .getElementById("basic-extract")
          ?.classList.contains("is-active") ||
        document.getElementById("basic-browse")?.classList.contains("is-active")
      ) {
        setBasicView("home");
      }
    } else if (e.key === "Enter") {
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement && ["BUTTON", "A"].includes(activeElement.tagName))
        return;

      if (
        document
          .getElementById("basic-compress")
          ?.classList.contains("is-active")
      ) {
        document.getElementById("basic-run-compress")?.click();
      } else if (
        document
          .getElementById("basic-extract")
          ?.classList.contains("is-active")
      ) {
        document.getElementById("basic-run-extract")?.click();
      }
    }
  });
}
