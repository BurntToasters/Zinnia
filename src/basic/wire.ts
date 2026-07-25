import { open } from "@tauri-apps/plugin-dialog";
import { $ } from "../utils";
import { state } from "../state";
import {
  setMode,
  renderInputs,
  registerBasicHooks,
  clearBrowsePasswordFields,
} from "../ui";
import { cancelAction } from "../archive";
import {
  chooseOutputIfCurrent,
  addFilesIfCurrent,
  addFolderIfCurrent,
} from "../files";
import { deriveOutputArchivePath } from "../extract-path";
import {
  setBasicView,
  syncBasicToPower,
  syncBasicOutputAutofill,
  updateBasicPasswordField,
  updateBasicSplitCustomVisibility,
  setBasicBrowsePasswordVisible,
  renderBasicInputs,
} from "./sync";
import {
  hideBasicCompletion,
  updateBasicRunningState,
  updateBasicStatus,
} from "./progress";
import {
  handleBasicCompressAction,
  handleBasicDrop,
  runBasicBrowseArchive,
  openPathWithFeedback,
  togglePasswordVisibility,
  parentDirForPath,
  beginBasicPreparation,
  finishBasicPreparation,
  isBasicInteractionLocked,
  isBasicPreparationCurrent,
} from "./actions";
import { refreshRecentArchives, setRecentArchiveHandler } from "./recent";
import { wireBasicBrowseEvents } from "./browse-events";
import { wireBasicKeyboardEvents } from "./keyboard-events";
import { wireBasicExtractEvents } from "./extract-events";

export { wireBasicBrowseEvents } from "./browse-events";
export { wireBasicKeyboardEvents } from "./keyboard-events";
export { wireBasicExtractEvents } from "./extract-events";

export function initBasicWorkspace(): void {
  setRecentArchiveHandler((path) => {
    void handleBasicDrop([path]);
  });

  const dropzone = document.getElementById("basic-dropzone");
  const compressCard = document.getElementById("basic-action-compress");
  const openCard = document.getElementById("basic-action-open");

  if (dropzone) {
    const activateDropzone = async (): Promise<void> => {
      const preparation = beginBasicPreparation();
      if (!preparation) return;
      let paths: string[] = [];
      try {
        const selection = await open({
          title: "Select files or archives",
          multiple: true,
        });
        if (!selection || !isBasicPreparationCurrent(preparation)) return;
        paths = Array.isArray(selection) ? selection : [selection];
      } finally {
        finishBasicPreparation(preparation);
      }
      if (paths.length > 0) await handleBasicDrop(paths);
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
      if (isBasicInteractionLocked()) return;
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      setMode("add");
      renderInputs();
      setBasicView("compress");
    });
  }

  if (openCard) {
    openCard.addEventListener("click", async () => {
      const preparation = beginBasicPreparation();
      if (!preparation) return;
      let selection: string | string[] | null = null;
      try {
        selection = await open({
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
        if (!selection || !isBasicPreparationCurrent(preparation)) return;
      } finally {
        finishBasicPreparation(preparation);
      }
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
      const preparation = beginBasicPreparation();
      if (!preparation) return;
      let selection: string | string[] | null = null;
      try {
        selection = await open({
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
        if (!selection || !isBasicPreparationCurrent(preparation)) return;
      } finally {
        finishBasicPreparation(preparation);
      }
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
      const preparation = beginBasicPreparation();
      if (!preparation) return;
      let selection: string | string[] | null = null;
      try {
        selection = await open({
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
        if (!selection || !isBasicPreparationCurrent(preparation)) return;
      } finally {
        finishBasicPreparation(preparation);
      }
      const path = typeof selection === "string" ? selection : selection[0];
      if (path) {
        clearBrowsePasswordFields();
        setBasicBrowsePasswordVisible(false);
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
      if (isBasicInteractionLocked()) return;
      setBasicView("home");
    });
  }
  const tabCompress = document.getElementById("basic-tab-compress");
  if (tabCompress) {
    tabCompress.addEventListener("click", () => {
      if (isBasicInteractionLocked()) return;
      setBasicView("compress");
      setMode("add");
      renderInputs();
    });
  }
  const tabExtract = document.getElementById("basic-tab-extract");
  if (tabExtract) {
    tabExtract.addEventListener("click", () => {
      if (isBasicInteractionLocked()) return;
      setBasicView("extract");
      setMode("extract");
      renderInputs();
    });
  }
  const tabBrowse = document.getElementById("basic-tab-browse");
  if (tabBrowse) {
    tabBrowse.addEventListener("click", () => {
      if (isBasicInteractionLocked()) return;
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
  void refreshRecentArchives();
}

async function activateBasicAddFiles(): Promise<void> {
  const preparation = beginBasicPreparation();
  if (!preparation) return;
  try {
    await addFilesIfCurrent(() => isBasicPreparationCurrent(preparation), {
      underBasicPreparation: true,
    });
  } finally {
    finishBasicPreparation(preparation);
  }
}

export function wireBasicCompressEvents(): void {
  const addFilesBtn = document.getElementById("basic-add-files");
  if (addFilesBtn) {
    addFilesBtn.addEventListener("click", () => void activateBasicAddFiles());
  }

  const inputList = document.getElementById("basic-input-list");
  if (inputList) {
    inputList.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const picker = event.target.closest("[data-basic-input-picker]");
      if (!picker || !inputList.contains(picker)) return;
      void activateBasicAddFiles();
    });
  }

  const addFolderBtn = document.getElementById("basic-add-folder");
  if (addFolderBtn) {
    addFolderBtn.addEventListener("click", async () => {
      const preparation = beginBasicPreparation();
      if (!preparation) return;
      try {
        await addFolderIfCurrent(() => isBasicPreparationCurrent(preparation), {
          underBasicPreparation: true,
        });
      } finally {
        finishBasicPreparation(preparation);
      }
    });
  }

  const clearBtn = document.getElementById("basic-clear-inputs");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
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
      const preparation = beginBasicPreparation();
      if (!preparation) return;
      let accepted = false;
      try {
        syncBasicToPower();
        await chooseOutputIfCurrent(() =>
          isBasicPreparationCurrent(preparation),
        );
        accepted = isBasicPreparationCurrent(preparation);
      } finally {
        finishBasicPreparation(preparation);
      }
      if (!accepted) return;
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
      const customName = archiveNameInput.value || undefined;
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
