import { $ } from "../utils";
import { state, dom } from "../state";
import { renderInputs, setMode } from "../ui";
import {
  runAction,
  cancelAction,
  testArchive,
  browseArchive,
  addFilesToArchive,
  convertArchive,
  previewCommand,
  copyCommandPreview,
  closeCommandPreviewModal,
  openSelectiveExtractModal,
} from "../archive";
import { chooseOutput, chooseExtract, addFiles, addFolder } from "../files";
import { wireShortcutsEvents } from "../power-shortcuts";

export function wireSessionEvents(): void {
  $("add-files").addEventListener("click", addFiles);
  $("add-folder").addEventListener("click", addFolder);
  $("clear-inputs").addEventListener("click", () => {
    if (
      state.running ||
      state.operationPreparing ||
      state.incomingPathsApplying
    ) {
      return;
    }
    state.inputs.length = 0;
    state.lastAutoOutputPath = null;
    renderInputs();
    $<HTMLInputElement>("output-path").value = "";
    $<HTMLInputElement>("archive-name").value = "";
    const bc = document.getElementById("browse-contents");
    if (bc) bc.hidden = true;
  });
  $("choose-output").addEventListener("click", chooseOutput);
  $("choose-extract").addEventListener("click", chooseExtract);
  $("run-action").addEventListener("click", runAction);
  $("cancel-action").addEventListener("click", cancelAction);
  $("show-command").addEventListener(
    "click",
    (e) => void previewCommand(e.currentTarget as HTMLElement),
  );
  $("clear-log").addEventListener("click", () => (dom.logEl.textContent = ""));

  $("extract-run").addEventListener("click", runAction);
  $("extract-cancel").addEventListener("click", cancelAction);
  $("extract-preview").addEventListener(
    "click",
    (e) => void previewCommand(e.currentTarget as HTMLElement),
  );

  $("copy-command-preview").addEventListener("click", () => {
    void copyCommandPreview();
  });
  $("close-command-preview").addEventListener(
    "click",
    closeCommandPreviewModal,
  );
  $("close-command-preview-footer").addEventListener(
    "click",
    closeCommandPreviewModal,
  );
  $("command-preview-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCommandPreviewModal();
  });

  wireShortcutsEvents();

  $("test-integrity").addEventListener("click", testArchive);

  $("browse-list").addEventListener("click", browseArchive);
  $("browse-cancel").addEventListener("click", cancelAction);
  $("browse-test").addEventListener("click", testArchive);
  $("browse-extract").addEventListener("click", () => setMode("extract"));
  $("browse-selective").addEventListener("click", () => {
    void openSelectiveExtractModal();
  });
  $("browse-add-files").addEventListener("click", () => {
    void addFilesToArchive();
  });
  $("browse-convert").addEventListener("click", () => {
    void convertArchive();
  });
}
