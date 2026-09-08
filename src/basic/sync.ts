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
  resolveOutputArchiveAutofill,
  resolveExtractDestinationAutofill,
} from "../extract-path";
import { getCompressionSecuritySupport } from "../compression-security";
import { hideBasicCompletion, hideBasicProgress } from "./progress";
import { basename } from "../path-display";

export { basename } from "../path-display";

export type BasicView = "home" | "compress" | "extract" | "browse";

let currentBasicView: BasicView = "home";

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

export function syncPowerToBasicCompress(): void {
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

export function syncPowerToBasicExtract(): void {
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

export function renderBasicInputs(): void {
  if (getWorkspaceMode() !== "basic") return;

  const list = document.getElementById("basic-input-list");
  if (!list) return;

  list.innerHTML = "";

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

  syncBasicOutputAutofill();
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
  if (!basicOutputPath || !basicFormat) return;

  const format = basicFormat.value;
  const customName = basicArchiveName?.value ?? undefined;
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
  const pathMode = document.getElementById(
    "path-mode",
  ) as HTMLInputElement | null;
  if (pathMode) pathMode.value = "relative";
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
