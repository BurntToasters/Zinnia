import { open, save } from "@tauri-apps/plugin-dialog";
import { $ } from "./utils";
import { state } from "./state";
import {
  getMode,
  log,
  renderInputs,
  setBrowsePasswordFieldVisible,
  setStatus,
} from "./ui";
import {
  archiveExtensionForFormat,
  deriveOutputArchivePath,
} from "./extract-path";
import {
  acquireIncomingPathLock,
  isIncomingPathBusy,
  releaseIncomingPathLock,
} from "./incoming-paths";

const MAX_INPUT_PATHS = 4096;

export type AddPathsOptions = {
  /**
   * Caller already holds Basic `operationPreparing`. That flag blocks OS
   * handoffs, so we must not treat it as busy or take `incomingPathsApplying`
   * (which also waits on prep and would self-deadlock).
   */
  underBasicPreparation?: boolean;
};

export async function chooseOutput() {
  await chooseOutputIfCurrent(() => true);
}

export async function chooseOutputIfCurrent(isCurrent: () => boolean) {
  const format = $<HTMLSelectElement>("format").value;
  const derived = deriveOutputArchivePath(state.inputs, format);
  let output: string | null;
  try {
    output = await save({
      title: "Choose output archive",
      defaultPath:
        derived ?? `zinnia.${archiveExtensionForFormat(format.toLowerCase())}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the save-archive dialog: ${msg}`, "error");
    setStatus("Could not open the save dialog", 3000);
    return;
  }
  if (
    output &&
    isCurrent() &&
    $<HTMLSelectElement>("format").value === format
  ) {
    $<HTMLInputElement>("output-path").value = output;
    state.lastAutoOutputPath = null;
  }
}

export async function chooseExtract() {
  await chooseExtractIfCurrent(() => true);
}

export async function chooseExtractIfCurrent(isCurrent: () => boolean) {
  let output: string | string[] | null;
  try {
    output = await open({
      title: "Choose destination folder",
      directory: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the destination-folder dialog: ${msg}`, "error");
    setStatus("Could not open the folder dialog", 3000);
    return;
  }
  if (output && typeof output === "string" && isCurrent()) {
    $<HTMLInputElement>("extract-path").value = output;
    state.lastAutoExtractDestination = null;
  }
}

function mergeAddedPaths(paths: string[]): {
  changed: boolean;
  previousPrimary: string | null;
} {
  const previousPrimary = state.inputs[0] ?? null;
  let changed = false;
  for (const path of paths) {
    if (state.inputs.includes(path)) continue;
    if (state.inputs.length >= MAX_INPUT_PATHS) break;
    state.inputs.push(path);
    changed = true;
  }
  return { changed, previousPrimary };
}

function afterInputsMerged(
  changed: boolean,
  previousPrimary: string | null,
): void {
  if (
    changed &&
    getMode() === "browse" &&
    (state.inputs[0] ?? null) !== previousPrimary
  ) {
    setBrowsePasswordFieldVisible(false);
  }
  renderInputs();
}

export async function addFiles() {
  await addFilesIfCurrent(() => true);
}

export async function addFilesIfCurrent(
  isCurrent: () => boolean,
  options: AddPathsOptions = {},
): Promise<void> {
  const underPrep = options.underBasicPreparation === true;
  if (underPrep) {
    if (state.running || state.incomingPathsApplying) return;
  } else if (isIncomingPathBusy()) {
    return;
  }

  let selection: string | string[] | null;
  try {
    selection = await open({
      title: "Add files",
      multiple: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the add-files dialog: ${msg}`, "error");
    setStatus("Could not open the file dialog", 3000);
    return;
  }
  if (!selection || !isCurrent()) return;

  const newPaths = Array.isArray(selection) ? selection : [selection];

  if (underPrep) {
    if (!isCurrent() || state.running) return;
    const { changed, previousPrimary } = mergeAddedPaths(newPaths);
    afterInputsMerged(changed, previousPrimary);
    return;
  }

  await acquireIncomingPathLock();
  try {
    if (!isCurrent() || state.running || state.operationPreparing) return;
    const { changed, previousPrimary } = mergeAddedPaths(newPaths);
    afterInputsMerged(changed, previousPrimary);
  } finally {
    releaseIncomingPathLock();
  }
}

export async function addFolder() {
  await addFolderIfCurrent(() => true);
}

export async function addFolderIfCurrent(
  isCurrent: () => boolean,
  options: AddPathsOptions = {},
): Promise<void> {
  const underPrep = options.underBasicPreparation === true;
  if (underPrep) {
    if (state.running || state.incomingPathsApplying) return;
  } else if (isIncomingPathBusy()) {
    return;
  }

  let selection: string | string[] | null;
  try {
    selection = await open({
      title: "Add folder",
      directory: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the add-folder dialog: ${msg}`, "error");
    setStatus("Could not open the folder dialog", 3000);
    return;
  }
  if (!selection || typeof selection !== "string" || !isCurrent()) return;

  if (underPrep) {
    if (!isCurrent() || state.running) return;
    const { changed, previousPrimary } = mergeAddedPaths([selection]);
    afterInputsMerged(changed, previousPrimary);
    return;
  }

  await acquireIncomingPathLock();
  try {
    if (!isCurrent() || state.running || state.operationPreparing) return;
    const { changed, previousPrimary } = mergeAddedPaths([selection]);
    afterInputsMerged(changed, previousPrimary);
  } finally {
    releaseIncomingPathLock();
  }
}
