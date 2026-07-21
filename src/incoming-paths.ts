import { state } from "./state";
import {
  devLog,
  renderInputs,
  setMode,
  getWorkspaceMode,
  setBrowsePasswordFieldVisible,
} from "./ui";
import { browseArchive } from "./archive";
import { validateArchivePaths } from "./archive-rules";
import { setBasicView } from "./basic";

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
    for (const path of paths) {
      if (!state.inputs.includes(path)) {
        state.inputs.push(path);
      }
    }
    renderInputs();
    devLog(`Received ${paths.length} path(s) from ${source}.`);
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
    state.inputs.length = 0;
  } else if (shouldAutoBrowse) {
    setMode("browse");
    state.inputs.length = 0;
  }

  for (const path of paths) {
    if (!state.inputs.includes(path)) {
      state.inputs.push(path);
    }
  }
  if (shouldAutoBrowse) {
    setBrowsePasswordFieldVisible(false);
  }
  renderInputs();
  devLog(`Received ${paths.length} path(s) from ${source}.`);

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
