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
import { MAX_ARCHIVE_PATHS } from "./archive-rules";
import { showToast } from "./toast";

export type AddPathsOptions = {
  /**
   * Caller already holds Basic `operationPreparing`. That flag blocks OS
   * handoffs, so we must not treat it as busy or take `incomingPathsApplying`
   * (which also waits on prep and would self-deadlock).
   */
  underBasicPreparation?: boolean;
};

type InputDialogSession = {
  mode: "add" | "extract" | "browse";
  inputs: string;
};

function captureInputDialogSession(): InputDialogSession {
  return { mode: getMode(), inputs: JSON.stringify(state.inputs) };
}

function inputDialogSessionIsCurrent(session: InputDialogSession): boolean {
  return (
    !state.running &&
    getMode() === session.mode &&
    JSON.stringify(state.inputs) === session.inputs
  );
}

export async function chooseOutput() {
  await chooseOutputIfCurrent(() => true);
}

export async function chooseOutputIfCurrent(isCurrent: () => boolean) {
  const underPrep = state.operationPreparing;
  if (underPrep) {
    if (state.running || state.incomingPathsApplying) return;
  } else {
    if (isIncomingPathBusy()) return;
    await acquireIncomingPathLock();
  }
  const session = captureInputDialogSession();
  const format = $<HTMLSelectElement>("format").value;
  try {
    const derived = deriveOutputArchivePath(state.inputs, format);
    const output = await save({
      title: "Choose output archive",
      defaultPath:
        derived ?? `zinnia.${archiveExtensionForFormat(format.toLowerCase())}`,
    });
    if (
      output &&
      isCurrent() &&
      inputDialogSessionIsCurrent(session) &&
      $<HTMLSelectElement>("format").value === format
    ) {
      $<HTMLInputElement>("output-path").value = output;
      state.lastAutoOutputPath = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the save-archive dialog: ${msg}`, "error");
    setStatus("Could not open the save dialog", 3000);
  } finally {
    if (!underPrep) releaseIncomingPathLock();
  }
}

export async function chooseExtract() {
  await chooseExtractIfCurrent(() => true);
}

export async function chooseExtractIfCurrent(isCurrent: () => boolean) {
  const underPrep = state.operationPreparing;
  if (underPrep) {
    if (state.running || state.incomingPathsApplying) return;
  } else {
    if (isIncomingPathBusy()) return;
    await acquireIncomingPathLock();
  }
  const session = captureInputDialogSession();
  try {
    const output = await open({
      title: "Choose destination folder",
      directory: true,
    });
    if (
      output &&
      typeof output === "string" &&
      isCurrent() &&
      inputDialogSessionIsCurrent(session)
    ) {
      $<HTMLInputElement>("extract-path").value = output;
      state.lastAutoExtractDestination = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the destination-folder dialog: ${msg}`, "error");
    setStatus("Could not open the folder dialog", 3000);
  } finally {
    if (!underPrep) releaseIncomingPathLock();
  }
}

function mergeAddedPaths(paths: string[]): {
  changed: boolean;
  previousPrimary: string | null;
  rejected: number;
} {
  const previousPrimary = state.inputs[0] ?? null;
  const known = new Set(state.inputs);
  let changed = false;
  let rejected = 0;
  for (const path of paths) {
    if (known.has(path)) continue;
    if (state.inputs.length >= MAX_ARCHIVE_PATHS) {
      rejected += 1;
      continue;
    }
    state.inputs.push(path);
    known.add(path);
    changed = true;
  }
  return { changed, previousPrimary, rejected };
}

function afterInputsMerged(
  changed: boolean,
  previousPrimary: string | null,
  rejected = 0,
): void {
  if (
    changed &&
    getMode() === "browse" &&
    (state.inputs[0] ?? null) !== previousPrimary
  ) {
    setBrowsePasswordFieldVisible(false);
  }
  renderInputs();
  if (rejected > 0) {
    showToast(
      `Added the first ${MAX_ARCHIVE_PATHS} unique items; ${rejected} more were not added.`,
      "error",
      5000,
    );
  }
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

  if (!underPrep) await acquireIncomingPathLock();
  const session = captureInputDialogSession();

  try {
    const selection = await open({
      title: "Add files",
      multiple: true,
    });
    if (!selection || !isCurrent() || !inputDialogSessionIsCurrent(session)) {
      return;
    }

    const newPaths = Array.isArray(selection) ? selection : [selection];
    const { changed, previousPrimary, rejected } = mergeAddedPaths(newPaths);
    afterInputsMerged(changed, previousPrimary, rejected);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the add-files dialog: ${msg}`, "error");
    setStatus("Could not open the file dialog", 3000);
  } finally {
    if (!underPrep) releaseIncomingPathLock();
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

  if (!underPrep) await acquireIncomingPathLock();
  const session = captureInputDialogSession();

  try {
    const selection = await open({
      title: "Add folder",
      directory: true,
    });
    if (
      !selection ||
      typeof selection !== "string" ||
      !isCurrent() ||
      !inputDialogSessionIsCurrent(session)
    ) {
      return;
    }

    const { changed, previousPrimary, rejected } = mergeAddedPaths([selection]);
    afterInputsMerged(changed, previousPrimary, rejected);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open the add-folder dialog: ${msg}`, "error");
    setStatus("Could not open the folder dialog", 3000);
  } finally {
    if (!underPrep) releaseIncomingPathLock();
  }
}
