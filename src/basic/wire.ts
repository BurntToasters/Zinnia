import { open } from "@tauri-apps/plugin-dialog";
import { $ } from "../utils";
import { state } from "../state";
import { setMode, renderInputs, registerBasicHooks } from "../ui";
import { cancelAction } from "../archive";
import { chooseOutput, addFiles, addFolder } from "../files";
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
      if (state.running) return;
      const selection = await open({
        title: "Select files or archives",
        multiple: true,
      });
      if (state.running) return;
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      if (paths.length > 0) {
        await handleBasicDrop(paths);
      }
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
      if (state.running) return;
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      setMode("add");
      renderInputs();
      setBasicView("compress");
    });
  }

  if (openCard) {
    openCard.addEventListener("click", async () => {
      if (state.running) return;
      const selection = await open({
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
      if (state.running) return;
      if (!selection) return;
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
      const selection = await open({
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
      if (!selection) return;
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
      const selection = await open({
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
      if (!selection) return;
      const path = typeof selection === "string" ? selection : selection[0];
      if (path) {
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
      setBasicView("home");
    });
  }
  const tabCompress = document.getElementById("basic-tab-compress");
  if (tabCompress) {
    tabCompress.addEventListener("click", () => {
      setBasicView("compress");
      setMode("add");
      renderInputs();
    });
  }
  const tabExtract = document.getElementById("basic-tab-extract");
  if (tabExtract) {
    tabExtract.addEventListener("click", () => {
      setBasicView("extract");
      setMode("extract");
      renderInputs();
    });
  }
  const tabBrowse = document.getElementById("basic-tab-browse");
  if (tabBrowse) {
    tabBrowse.addEventListener("click", () => {
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

export function wireBasicCompressEvents(): void {
  const addFilesBtn = document.getElementById("basic-add-files");
  if (addFilesBtn) {
    addFilesBtn.addEventListener("click", async () => {
      await addFiles();
    });
  }

  const addFolderBtn = document.getElementById("basic-add-folder");
  if (addFolderBtn) {
    addFolderBtn.addEventListener("click", async () => {
      await addFolder();
    });
  }

  const clearBtn = document.getElementById("basic-clear-inputs");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
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
      syncBasicToPower();
      await chooseOutput();
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
      const customName = archiveNameInput.value.trim() || undefined;
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
