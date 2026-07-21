import { open } from "@tauri-apps/plugin-dialog";
import { $ } from "../utils";
import { state } from "../state";
import {
  getWorkspaceMode,
  setMode,
  renderInputs,
  registerBasicHooks,
} from "../ui";
import { applyPreset } from "../presets";
import { cancelAction, testArchive } from "../archive";
import { chooseOutput, chooseExtract, addFiles, addFolder } from "../files";
import { deriveOutputArchivePath } from "../extract-path";
import {
  setBasicView,
  syncBasicToPower,
  syncBasicBrowsePasswordToPower,
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
  handleBasicExtractAction,
  handleBasicDrop,
  runBasicBrowseArchive,
  openPathWithFeedback,
  togglePasswordVisibility,
  parentDirForPath,
} from "./actions";
import { renderRecentArchives, setRecentArchiveHandler } from "./recent";

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
  renderRecentArchives();
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

export function wireBasicExtractEvents(): void {
  const chooseExtractBtn = document.getElementById("basic-choose-extract");
  if (chooseExtractBtn) {
    chooseExtractBtn.addEventListener("click", async () => {
      await chooseExtract();
      const extractVal = $<HTMLInputElement>("extract-path").value;
      const basicExtract = document.getElementById(
        "basic-extract-path",
      ) as HTMLInputElement | null;
      if (basicExtract && extractVal) basicExtract.value = extractVal;
    });
  }

  const runBtn = document.getElementById("basic-run-extract");
  if (runBtn) {
    runBtn.addEventListener("click", () => void handleBasicExtractAction());
  }

  const cancelBtn = document.getElementById("basic-extract-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", cancelAction);
  }

  const browseContentsBtn = document.getElementById("basic-browse-contents");
  if (browseContentsBtn) {
    browseContentsBtn.addEventListener("click", async () => {
      setMode("browse");
      setBasicBrowsePasswordVisible(false);
      setBasicView("browse");
      await runBasicBrowseArchive();
    });
  }

  const toggleBrowsePwBtn = document.getElementById(
    "basic-toggle-browse-password",
  );
  if (toggleBrowsePwBtn) {
    toggleBrowsePwBtn.addEventListener("click", () => {
      togglePasswordVisibility(
        "basic-browse-password",
        "basic-toggle-browse-password",
      );
    });
  }

  const basicBrowsePassword = document.getElementById("basic-browse-password");
  if (basicBrowsePassword) {
    basicBrowsePassword.addEventListener("change", () => {
      syncBasicBrowsePasswordToPower();
    });
    basicBrowsePassword.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") {
        void runBasicBrowseArchive();
      }
    });
  }

  const togglePwBtn = document.getElementById("basic-toggle-extract-password");
  if (togglePwBtn) {
    togglePwBtn.addEventListener("click", () => {
      togglePasswordVisibility(
        "basic-extract-password",
        "basic-toggle-extract-password",
      );
    });
  }

  const openDestBtn = document.getElementById("basic-extract-open-dest");
  if (openDestBtn) {
    openDestBtn.addEventListener("click", () => {
      const extractPath =
        (
          document.getElementById(
            "basic-extract-path",
          ) as HTMLInputElement | null
        )?.value ?? "";
      if (extractPath) {
        void openPathWithFeedback(extractPath);
      }
    });
  }

  document
    .querySelectorAll<HTMLButtonElement>(".basic-preset-pill")
    .forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(".basic-preset-pill").forEach((p) => {
          p.classList.remove("is-active");
          p.setAttribute("aria-pressed", "false");
        });
        pill.classList.add("is-active");
        pill.setAttribute("aria-pressed", "true");

        const preset = pill.dataset.basicPreset;
        const select = document.getElementById(
          "basic-preset",
        ) as HTMLSelectElement | null;
        if (select && preset) {
          select.value = preset;
          applyPreset(preset);
        }
      });
    });

  const compressAnotherBtn = document.getElementById("basic-compress-another");
  if (compressAnotherBtn) {
    compressAnotherBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      renderInputs();
      hideBasicCompletion("compress");
      setBasicView("home");
    });
  }

  const compressHomeBtn = document.getElementById("basic-compress-home");
  if (compressHomeBtn) {
    compressHomeBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoOutputPath = null;
      renderInputs();
      hideBasicCompletion("compress");
      setBasicView("home");
    });
  }

  const extractAnotherBtn = document.getElementById("basic-extract-another");
  if (extractAnotherBtn) {
    extractAnotherBtn.addEventListener("click", () => {
      const isFailure = extractAnotherBtn.textContent?.trim() === "Close";
      if (isFailure) {
        hideBasicCompletion("extract");
      } else {
        state.inputs.length = 0;
        state.lastAutoExtractDestination = null;
        renderInputs();
        hideBasicCompletion("extract");
        setBasicView("home");
      }
    });
  }

  const extractCloseBtn = document.getElementById(
    "basic-extract-completion-close",
  );
  if (extractCloseBtn) {
    extractCloseBtn.addEventListener("click", () => {
      hideBasicCompletion("extract");
    });
  }

  const extractHomeBtn = document.getElementById("basic-extract-home");
  if (extractHomeBtn) {
    extractHomeBtn.addEventListener("click", () => {
      state.inputs.length = 0;
      state.lastAutoExtractDestination = null;
      renderInputs();
      hideBasicCompletion("extract");
      setBasicView("home");
    });
  }
}

export function wireBasicBrowseEvents(): void {
  const extractAllBtn = document.getElementById("basic-browse-extract-all");
  if (extractAllBtn) {
    extractAllBtn.addEventListener("click", () => {
      setMode("extract");
      setBasicView("extract");
      void handleBasicExtractAction();
    });
  }

  const testBtn = document.getElementById("basic-browse-test");
  if (testBtn) {
    testBtn.addEventListener("click", () => {
      syncBasicBrowsePasswordToPower();
      void testArchive();
    });
  }
}

export function wireBasicKeyboardEvents(): void {
  document.addEventListener("keydown", (e) => {
    if (getWorkspaceMode() !== "basic") return;
    // Overlays use [hidden]; .modal nodes stay in the DOM without that attribute.
    if (document.querySelector(".modal-overlay:not([hidden])")) return;

    if (e.key === "Escape") {
      const activeElement = document.activeElement as HTMLElement;
      if (
        activeElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName)
      ) {
        activeElement.blur();
        return;
      }
      if (
        document
          .getElementById("basic-compress")
          ?.classList.contains("is-active") ||
        document
          .getElementById("basic-extract")
          ?.classList.contains("is-active") ||
        document.getElementById("basic-browse")?.classList.contains("is-active")
      ) {
        setBasicView("home");
      }
    } else if (e.key === "Enter") {
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement && ["BUTTON", "A"].includes(activeElement.tagName))
        return;

      if (
        document
          .getElementById("basic-compress")
          ?.classList.contains("is-active")
      ) {
        document.getElementById("basic-run-compress")?.click();
      } else if (
        document
          .getElementById("basic-extract")
          ?.classList.contains("is-active")
      ) {
        document.getElementById("basic-run-extract")?.click();
      }
    }
  });
}
