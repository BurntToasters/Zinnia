import { open, save } from "@tauri-apps/plugin-dialog";
import { $ } from "./utils";
import { state } from "./state";
import { getMode, renderInputs, setBrowsePasswordFieldVisible } from "./ui";
import { deriveOutputArchivePath } from "./extract-path";

export async function chooseOutput() {
  const format = $<HTMLSelectElement>("format").value;
  const derived = deriveOutputArchivePath(state.inputs, format);
  const output = await save({
    title: "Choose output archive",
    defaultPath: derived ?? `zinnia.${format}`,
  });
  if (output) {
    $<HTMLInputElement>("output-path").value = output;
    state.lastAutoOutputPath = null;
  }
}

export async function chooseExtract() {
  const output = await open({
    title: "Choose destination folder",
    directory: true,
  });
  if (output && typeof output === "string") {
    $<HTMLInputElement>("extract-path").value = output;
    state.lastAutoExtractDestination = null;
  }
}

export async function addFiles() {
  const selection = await open({
    title: "Add files",
    multiple: true,
  });
  if (!selection) return;
  const previousPrimary = state.inputs[0] ?? null;
  const newPaths = Array.isArray(selection) ? selection : [selection];
  let changed = false;
  for (const path of newPaths) {
    if (!state.inputs.includes(path)) {
      state.inputs.push(path);
      changed = true;
    }
  }
  if (
    changed &&
    getMode() === "browse" &&
    (state.inputs[0] ?? null) !== previousPrimary
  ) {
    setBrowsePasswordFieldVisible(false);
  }
  renderInputs();
}

export async function addFolder() {
  const selection = await open({
    title: "Add folder",
    directory: true,
  });
  const previousPrimary = state.inputs[0] ?? null;
  if (selection && typeof selection === "string") {
    if (!state.inputs.includes(selection)) {
      state.inputs.push(selection);
      if (
        getMode() === "browse" &&
        (state.inputs[0] ?? null) !== previousPrimary
      ) {
        setBrowsePasswordFieldVisible(false);
      }
    }
    renderInputs();
  }
}
