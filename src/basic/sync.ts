import { $ } from "../utils";
import { state } from "../state";
import {
  getWorkspaceMode,
  getMode,
  renderInputs,
  clearBrowsePasswordFields,
  setBrowsePasswordFieldVisible,
  triggerIconRefresh,
} from "../ui";
import {
  applyPreset,
  updateCompressionOptionsForFormat,
  onCompressionOptionChange,
} from "../presets";
import {
  deriveOutputArchivePath,
  outputPathForFormatChange,
  resolveOutputArchiveAutofill,
  resolveExtractDestinationAutofill,
  looksLikeWindowsPath,
} from "../extract-path";
import { getCompressionSecuritySupport } from "../compression-security";
import { hideBasicCompletion, hideBasicProgress } from "./progress";
import { basename } from "../path-display";

export { basename } from "../path-display";

export type BasicView = "home" | "compress" | "extract" | "browse";

let currentBasicView: BasicView = "home";
let compressInputsKey: string | null = null;
let autoOutputPath: string | null = null;
let extractInputsKey: string | null = null;
let autoExtractDestination: string | null = null;

type DestinationRowIds = {
  output: string;
  folder: string;
  name: string;
  change: string;
};

const SAVE_TO_IDS: DestinationRowIds = {
  output: "basic-save-to-path",
  folder: "basic-save-to-folder",
  name: "basic-save-to-name",
  change: "basic-change-save-location",
};

const EXTRACT_TO_IDS: DestinationRowIds = {
  output: "basic-extract-to-path",
  folder: "basic-extract-to-folder",
  name: "basic-extract-to-name",
  change: "basic-change-extract-folder",
};

export function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function getBasicView(): BasicView {
  return currentBasicView;
}

export function setBasicView(view: BasicView): void {
  if (
    (state.running || state.operationPreparing) &&
    view !== currentBasicView
  ) {
    return;
  }
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
      el.setAttribute("aria-selected", String(isActive));
      el.tabIndex = isActive ? 0 : -1;
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

export function syncBasicToPower(): void {
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

  if (basicPreset) {
    applyPreset(basicPreset.value);
    $<HTMLSelectElement>("preset").value = basicPreset.value;
  }

  // Presets provide compression tuning, but Basic's explicitly selected
  // format is authoritative.
  if (basicFormat) {
    $<HTMLSelectElement>("format").value = basicFormat.value;
    updateCompressionOptionsForFormat(basicFormat.value);
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

export function syncBasicExtractToPower(): void {
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

function fillBasicSecretFromPower(
  basic: HTMLInputElement,
  powerValue: string,
): void {
  if (powerValue !== "" || basic.value === "") {
    basic.value = powerValue;
  }
}

export function syncBasicPasswordToPower(): void {
  const basicPassword = document.getElementById(
    "basic-password",
  ) as HTMLInputElement | null;
  if (basicPassword) {
    $<HTMLInputElement>("password").value = basicPassword.value;
  }
}

export function syncBasicExtractPasswordToPower(): void {
  const basicExtractPassword = document.getElementById(
    "basic-extract-password",
  ) as HTMLInputElement | null;
  if (basicExtractPassword) {
    $<HTMLInputElement>("extract-password").value = basicExtractPassword.value;
  }
}

export function syncBasicSecretsToPower(): void {
  syncBasicPasswordToPower();
  syncBasicExtractPasswordToPower();
}

export function syncPowerToBasicCompress(): void {
  const basicFormat = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
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

  if (basicArchiveName) {
    basicArchiveName.value = $<HTMLInputElement>("archive-name").value;
  }
  if (basicFormat) {
    const powerFormat = $<HTMLSelectElement>("format").value;
    const formatChanged = basicFormat.value !== powerFormat;
    basicFormat.value = powerFormat;
    if (formatChanged && basicFormat.value) {
      syncBasicOutputForFormat(basicFormat.value);
    }
  }
  if (basicPassword) {
    fillBasicSecretFromPower(
      basicPassword,
      $<HTMLInputElement>("password").value,
    );
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

export function updateBasicSplitCustomVisibility(): void {
  const basicSplitSize = document.getElementById(
    "basic-split-size",
  ) as HTMLSelectElement | null;
  const customField = document.getElementById("basic-split-custom-field");
  if (!basicSplitSize || !customField) return;
  customField.hidden = basicSplitSize.value !== "custom";
}

export function syncBasicBrowsePasswordToPower(): void {
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

export function setBasicBrowsePasswordVisible(visible: boolean): void {
  if (!visible) {
    // Clear Basic before any sync-to-Power path can copy the secret back.
    clearBrowsePasswordFields();
  }
  const field = document.getElementById("basic-browse-password-field");
  if (field) {
    field.hidden = !visible;
  }
  setBrowsePasswordFieldVisible(visible);
}

export function revealBasicBrowsePasswordIfNeeded(): void {
  if (getWorkspaceMode() !== "basic" || currentBasicView !== "browse") return;
  const powerField = document.getElementById("browse-password-field");
  if (powerField && !powerField.hidden) {
    setBasicBrowsePasswordVisible(true);
  }
}

export function syncPowerToBasicExtract(): void {
  const basicExtractPassword = document.getElementById(
    "basic-extract-password",
  ) as HTMLInputElement | null;
  if (basicExtractPassword) {
    fillBasicSecretFromPower(
      basicExtractPassword,
      $<HTMLInputElement>("extract-password").value,
    );
  }
}

export function syncPowerToBasicBrowsePassword(): void {
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
  rederiveBasicDestinations();
}

export function resumeBasicView(): void {
  const needsArchive =
    currentBasicView === "extract" || currentBasicView === "browse";
  setBasicView(
    needsArchive && state.inputs.length === 0 ? "home" : currentBasicView,
  );
}

export function updateBasicExtractInfo(): void {
  const archivePath = state.inputs[0] ?? "";
  const name = basename(archivePath) || "No archive selected";
  const ext = archivePath
    ? `${extension(archivePath).replace(".", "").toUpperCase()} archive`
    : "Click to select an archive file";

  const nameEl = document.getElementById("basic-extract-archive-name");
  const metaEl = document.getElementById("basic-extract-archive-meta");
  if (nameEl) nameEl.textContent = name;
  if (metaEl) metaEl.textContent = ext;

  syncBasicExtractDestination();
}

export function updateBasicBrowseInfo(): void {
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

/** Keep the visible archive card in step with inputs replaced in place. */
export function refreshBasicArchiveInfo(): void {
  if (getWorkspaceMode() !== "basic") return;
  if (currentBasicView === "extract") updateBasicExtractInfo();
  else if (currentBasicView === "browse") updateBasicBrowseInfo();
}

export function renderBasicInputs(): void {
  if (getWorkspaceMode() !== "basic") return;
  rederiveBasicDestinations();

  const list = document.getElementById("basic-input-list");
  if (!list) return;

  list.replaceChildren();

  if (state.inputs.length === 0) {
    const empty = document.createElement("button");
    empty.id = "basic-empty-input-picker";
    empty.type = "button";
    empty.className = "basic-archive-info basic-empty-input-picker";
    empty.dataset.basicInputPicker = "";
    empty.disabled =
      state.running || state.operationPreparing || state.incomingPathsApplying;
    empty.innerHTML = `
      <span class="basic-archive-info__icon">
        <i data-lucide="file-plus" class="lucide-icon"></i>
      </span>
      <div class="basic-archive-info__details">
        <span class="basic-archive-info__name">No files added yet</span>
        <span class="basic-archive-info__meta">Click to select files or folders</span>
      </div>
    `;
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
    removeBtn.setAttribute("aria-label", `Remove ${basename(path)}`);
    removeBtn.disabled =
      state.running || state.operationPreparing || state.incomingPathsApplying;
    const index = i;
    removeBtn.addEventListener("click", () => {
      if (
        state.running ||
        state.operationPreparing ||
        state.incomingPathsApplying
      ) {
        return;
      }
      state.inputs.splice(index, 1);
      renderInputs();
    });

    item.appendChild(pathEl);
    item.appendChild(removeBtn);
    list.appendChild(item);
  }
}

function inputsKey(): string {
  return JSON.stringify(state.inputs);
}

function isExplicitPath(value: string, autoValue: string | null): boolean {
  return value !== "" && value !== autoValue;
}

function setAutoOutputPath(path: string | null): void {
  autoOutputPath = path;
  state.lastAutoOutputPath = path;
}

function setAutoExtractDestination(path: string | null): void {
  autoExtractDestination = path;
  state.lastAutoExtractDestination = path;
}

export function syncBasicOutputAutofill(): void {
  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  const basicArchiveName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  const basicFormat = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  if (basicOutputPath && basicFormat && !state.running) {
    const key = inputsKey();
    const inputsChanged = key !== compressInputsKey;
    compressInputsKey = key;
    if (
      inputsChanged ||
      !isExplicitPath(basicOutputPath.value, autoOutputPath)
    ) {
      const next =
        resolveOutputArchiveAutofill(
          "",
          null,
          state.inputs,
          basicFormat.value,
          basicArchiveName?.value ?? undefined,
        ) ?? "";
      basicOutputPath.value = next;
      setAutoOutputPath(next === "" ? null : next);
    }
  }
  renderBasicDestinations();
}

function syncBasicExtractDestination(): void {
  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  if (basicExtractPath && !state.running) {
    const key = inputsKey();
    const inputsChanged = key !== extractInputsKey;
    extractInputsKey = key;
    if (
      inputsChanged ||
      !isExplicitPath(basicExtractPath.value, autoExtractDestination)
    ) {
      const next =
        resolveExtractDestinationAutofill(
          "",
          null,
          state.inputs[0],
          state.inputs,
        ) ?? "";
      basicExtractPath.value = next;
      setAutoExtractDestination(next === "" ? null : next);
    }
  }
  renderBasicDestinations();
}

export function rederiveBasicDestinations(): void {
  syncBasicOutputAutofill();
  syncBasicExtractDestination();
}

export function syncBasicOutputForFormat(format: string): void {
  const basicOutput = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  const basicName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  if (basicOutput) {
    const current = basicOutput.value;
    const next = outputPathForFormatChange(
      current,
      autoOutputPath,
      format,
      basicName?.value ?? "",
      (customName) => deriveOutputArchivePath(state.inputs, format, customName),
    );
    if (next && next !== current) {
      const wasAutofilled = !current || current === autoOutputPath;
      basicOutput.value = next;
      if (wasAutofilled) setAutoOutputPath(next);
    }
  }
  renderBasicDestinations();
}

export function chooseBasicOutputPath(path: string): void {
  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  if (basicOutputPath) basicOutputPath.value = path;
  setAutoOutputPath(null);
  renderBasicDestinations();
}

export function chooseBasicExtractDestination(path: string): void {
  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  if (basicExtractPath) basicExtractPath.value = path;
  setAutoExtractDestination(null);
  renderBasicDestinations();
}

function renderDestinationRow(
  ids: DestinationRowIds,
  value: string,
  placeholder: string,
  canChange: boolean,
): void {
  const output = document.getElementById(ids.output);
  const folder = document.getElementById(ids.folder);
  const name = document.getElementById(ids.name);
  const change = document.getElementById(
    ids.change,
  ) as HTMLButtonElement | null;
  if (output) {
    output.classList.toggle("is-placeholder", value === "");
    if (value === "") output.removeAttribute("title");
    else output.title = value;
  }
  // `\` only separates Windows-shaped paths; on POSIX it is a file name character.
  const sep = Math.max(
    value.lastIndexOf("/"),
    looksLikeWindowsPath(value) ? value.lastIndexOf("\\") : -1,
  );
  if (folder)
    folder.textContent = value !== "" && sep > 0 ? value.slice(0, sep) : "";
  if (name) {
    name.textContent =
      value === "" ? placeholder : sep >= 0 ? value.slice(sep) : value;
  }
  if (change) change.disabled = !canChange;
}

export function renderBasicDestinations(): void {
  const locked = state.running || state.operationPreparing;
  const hasInputs = state.inputs.length > 0;
  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  renderDestinationRow(
    SAVE_TO_IDS,
    basicOutputPath?.value ?? "",
    hasInputs ? "Choose where to save" : "Add files first",
    hasInputs && !locked,
  );
  renderDestinationRow(
    EXTRACT_TO_IDS,
    basicExtractPath?.value ?? "",
    hasInputs ? "Choose a folder" : "Choose an archive first",
    hasInputs && !locked,
  );
  const note = document.getElementById("basic-extract-to-note");
  if (note) note.hidden = state.inputs.length < 2;
}

export function updateBasicPasswordField(): void {
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

export function syncBasicBeforeRun(): void {
  if (getWorkspaceMode() !== "basic") return;
  // Basic does not expose these Power-only controls. Clear them before every
  // Basic run so a prior Power session cannot leak state into the args.
  const updateMode = document.getElementById(
    "update-mode",
  ) as HTMLInputElement | null;
  if (updateMode) updateMode.checked = false;
  const storeTimestamps = document.getElementById(
    "store-timestamps",
  ) as HTMLInputElement | null;
  if (storeTimestamps) storeTimestamps.checked = false;
  const extraArgs = document.getElementById(
    "extra-args",
  ) as HTMLInputElement | null;
  if (extraArgs) extraArgs.value = "";
  const extractExtraArgs = document.getElementById(
    "extract-extra-args",
  ) as HTMLInputElement | null;
  if (extractExtraArgs) extractExtraArgs.value = "";
  const mode = getMode();
  if (mode === "add") {
    syncBasicToPower();
  } else if (mode === "extract") {
    syncBasicExtractToPower();
  } else if (mode === "browse") {
    syncBasicBrowsePasswordToPower();
  }
}
