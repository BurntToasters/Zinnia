import { state } from "./state";
import {
  devLog,
  log,
  renderInputs,
  setMode,
  getWorkspaceMode,
  setBrowsePasswordFieldVisible,
} from "./ui";
import { browseArchive } from "./archive";
import { validateArchivePaths } from "./archive-rules";
import { setBasicView } from "./basic";

// Keep in sync with archive-rules.ts MAX_ARCHIVE_PATHS. This local constant
// keeps OS handoff handling independent of archive-probe test doubles.
const MAX_INCOMING_PATHS = 4096;

export async function allPathsAreArchives(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  try {
    const results = await validateArchivePaths(paths);
    return (
      results.length === paths.length && results.every((result) => result.valid)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    devLog(`Archive probe failed for auto-detect: ${msg}`);
    return false;
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
  let accepted = 0;
  let rejected = 0;
  for (const path of paths) {
    if (state.inputs.includes(path)) continue;
    if (state.inputs.length >= MAX_INCOMING_PATHS) {
      rejected += 1;
      continue;
    }
    state.inputs.push(path);
    accepted += 1;
  }
  return { accepted, rejected };
}

function logIncomingPathLimit(source: string, rejected: number): void {
  if (rejected === 0) return;
  log(
    `Received paths from ${source}, but kept only the first ${MAX_INCOMING_PATHS} unique inputs; ${rejected} excess path(s) were not added.`,
  );
}

export async function applyIncomingPaths(
  paths: string[],
  mode: string,
  source: string,
): Promise<void> {
  if (!paths.length) return;

  // Do not mutate the shared input model underneath an active job. Keeping
  // this promise pending also preserves file-open FIFO ordering.
  while (state.running) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }

  if (mode === "compress") {
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

  let allArchives: boolean;
  // Archive detection crosses the IPC boundary. An operation may start while
  // that await is pending, so re-check and retry before touching shared input.
  for (;;) {
    allArchives = await allPathsAreArchives(paths);
    if (!state.running) break;
    while (state.running) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
  }
  const shouldAutoBrowse =
    mode !== "extract" && paths.length === 1 && allArchives;
  const shouldAutoExtract =
    mode === "extract" ||
    (mode !== "extract" && paths.length > 1 && allArchives);
  if (shouldAutoExtract) {
    setMode("extract");
    // OS integrations may split one Explorer/Finder selection across several
    // process handoffs. Append and de-duplicate explicit extract batches just
    // like compress batches so a later handoff can never erase an earlier one.
    // The UI does not auto-run, so retaining an existing visible archive is
    // safer than silently replacing work the user already selected.
    if (mode !== "extract") {
      state.inputs.length = 0;
    }
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
