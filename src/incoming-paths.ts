import { state } from "./state";
import {
  devLog,
  log,
  renderInputs,
  setMode,
  getMode,
  getWorkspaceMode,
  setBrowsePasswordFieldVisible,
} from "./ui";
import { browseArchive } from "./archive";
import { MAX_ARCHIVE_PATHS, validateArchivePaths } from "./archive-rules";
import { setBasicView } from "./basic";
import { showToast } from "./toast";

export async function allPathsAreArchives(
  paths: string[],
): Promise<boolean | null> {
  if (paths.length === 0) return false;
  try {
    const results = await validateArchivePaths(paths);
    return (
      results.length === paths.length && results.every((result) => result.valid)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Archive probe failed for auto-detect: ${msg}`);
    // Fail closed: unknown must not route archives into Compress.
    return null;
  }
}

/**
 * Add an OS handoff without letting independently accepted native batches make
 * the visible operation impossible to validate. The native FIFO is drained in
 * batches, so its own limit is not an aggregate limit for this input model.
 */
function mergeIncomingPaths(paths: string[]): {
  accepted: number;
  rejected: number;
} {
  const known = new Set(state.inputs);
  let accepted = 0;
  let rejected = 0;
  for (const path of paths) {
    if (known.has(path)) continue;
    if (state.inputs.length >= MAX_ARCHIVE_PATHS) {
      rejected += 1;
      continue;
    }
    state.inputs.push(path);
    known.add(path);
    accepted += 1;
  }
  return { accepted, rejected };
}

function logIncomingPathLimit(source: string, rejected: number): void {
  if (rejected === 0) return;
  log(
    `Received paths from ${source}, but kept only the first ${MAX_ARCHIVE_PATHS} unique inputs; ${rejected} excess path(s) were not added.`,
  );
}

function isIncomingPathMutationBlocked(): boolean {
  // Basic preparation (password / destination dialogs) shares the input model
  // with OS handoffs. Block both active jobs and in-flight preparation so a
  // verified password cannot be applied to a different archive.
  return state.running || state.operationPreparing;
}

/** True while Power/Basic drops or another handoff must not mutate `state.inputs`. */
export function isIncomingPathBusy(): boolean {
  return isIncomingPathMutationBlocked() || state.incomingPathsApplying;
}

function refreshIncomingPathMutationControls(): void {
  const locked =
    state.running || state.operationPreparing || state.incomingPathsApplying;
  for (const id of ["add-files", "add-folder", "clear-inputs"]) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = locked;
  }
}

/**
 * Wait for jobs/prep and any other mutator to finish, then take the applying
 * lock. No await between the free check and the set  -  JS is single-threaded, so
 * Power drops and OS handoffs cannot both hold the lock.
 */
export async function acquireIncomingPathLock(): Promise<void> {
  for (;;) {
    while (isIncomingPathBusy()) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    state.incomingPathsApplying = true;
    if (!isIncomingPathMutationBlocked()) {
      refreshIncomingPathMutationControls();
      return;
    }
    state.incomingPathsApplying = false;
  }
}

export function releaseIncomingPathLock(): void {
  state.incomingPathsApplying = false;
  refreshIncomingPathMutationControls();
}

/** Wait until jobs/prep/applying clear without taking the lock. */
export async function waitUntilIncomingPathIdle(): Promise<void> {
  while (isIncomingPathBusy()) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
}

/** Wait only for the applying lock (not Basic prep / running jobs). */
export async function waitUntilIncomingPathsApplyingClear(): Promise<void> {
  while (state.incomingPathsApplying) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
}

async function waitUntilJobOrPrepAllowsMutation(): Promise<void> {
  while (isIncomingPathMutationBlocked()) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
}

export async function applyIncomingPaths(
  paths: string[],
  mode: string,
  source: string,
): Promise<void> {
  if (!paths.length) return;

  // Serialize against Power drops and other handoffs, and against active jobs /
  // Basic preparation. Keeping this promise pending also preserves file-open FIFO.
  await acquireIncomingPathLock();
  try {
    await applyIncomingPathsUnlocked(paths, mode, source);
  } finally {
    releaseIncomingPathLock();
  }
}

async function applyIncomingPathsUnlocked(
  paths: string[],
  mode: string,
  source: string,
): Promise<void> {
  if (mode === "compress") {
    // Append only within an existing compress session; otherwise drop leftovers
    // from extract/browse before merging the new handoff.
    if (getMode() !== "add") {
      state.inputs.length = 0;
    }
    setMode("add");
    const { rejected } = mergeIncomingPaths(paths);
    renderInputs();
    devLog(`Received ${paths.length} path(s) from ${source}.`);
    logIncomingPathLimit(source, rejected);
    if (getWorkspaceMode() === "basic") {
      setBasicView("compress");
    }
    return;
  }

  let allArchives: boolean | null;
  // Archive detection crosses the IPC boundary. An operation or Basic
  // preparation may start while that await is pending, so re-check and retry
  // before touching shared input. Wait only on job/prep  -  we already hold
  // incomingPathsApplying and must not deadlock on ourselves.
  for (;;) {
    allArchives = await allPathsAreArchives(paths);
    if (!isIncomingPathMutationBlocked()) break;
    await waitUntilJobOrPrepAllowsMutation();
  }
  if (allArchives === null) {
    log(
      `Could not detect whether paths from ${source} are archives; left inputs unchanged.`,
      "error",
    );
    showToast(
      "Could not detect archive types for the dropped files. Try again.",
      "error",
      5000,
    );
    return;
  }
  const shouldAutoBrowse =
    mode !== "extract" && paths.length === 1 && allArchives;
  const shouldAutoExtract =
    mode === "extract" ||
    (mode !== "extract" && paths.length > 1 && allArchives);
  if (shouldAutoExtract) {
    // Explicit extract handoffs may arrive as multiple Explorer/Finder batches.
    // Append only when the UI is already in extract; otherwise clear leftovers
    // from compress/browse so they are not mixed into the extract session.
    // Auto-detected extract (multi-archive drop without explicit mode) always
    // starts a fresh extract input list.
    const keepExistingInputs = mode === "extract" && getMode() === "extract";
    if (!keepExistingInputs) {
      state.inputs.length = 0;
    }
    setMode("extract");
  } else if (shouldAutoBrowse) {
    setMode("browse");
    state.inputs.length = 0;
  }

  const { rejected } = mergeIncomingPaths(paths);
  if (shouldAutoBrowse) {
    setBrowsePasswordFieldVisible(false);
  }
  renderInputs();
  devLog(`Received ${paths.length} path(s) from ${source}.`);
  logIncomingPathLimit(source, rejected);

  if (getWorkspaceMode() === "basic") {
    if (shouldAutoExtract || shouldAutoBrowse) {
      setBasicView(shouldAutoBrowse ? "browse" : "extract");
    } else {
      setBasicView("compress");
    }
  }

  if (shouldAutoBrowse) {
    void browseArchive();
  }
}
