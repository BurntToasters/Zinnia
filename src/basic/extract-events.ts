import { $ } from "../utils";
import { state } from "../state";
import { setMode, renderInputs } from "../ui";
import { applyPreset } from "../presets";
import { cancelAction } from "../archive";
import { chooseExtractIfCurrent } from "../files";
import {
  setBasicView,
  syncBasicBrowsePasswordToPower,
  setBasicBrowsePasswordVisible,
} from "./sync";
import { hideBasicCompletion } from "./progress";
import {
  handleBasicExtractAction,
  openPathWithFeedback,
  runBasicBrowseArchive,
  togglePasswordVisibility,
  beginBasicPreparation,
  finishBasicPreparation,
  isBasicPreparationCurrent,
} from "./actions";

function resetCompressCompletion(): void {
  state.inputs.length = 0;
  state.lastAutoOutputPath = null;
  renderInputs();
  hideBasicCompletion("compress");
  setBasicView("home");
}

function resetExtractCompletion(): void {
  state.inputs.length = 0;
  state.lastAutoExtractDestination = null;
  renderInputs();
  hideBasicCompletion("extract");
  setBasicView("home");
}

export function wireBasicExtractEvents(): void {
  document
    .getElementById("basic-choose-extract")
    ?.addEventListener("click", async () => {
      const preparation = beginBasicPreparation();
      if (!preparation) return;
      let accepted = false;
      try {
        await chooseExtractIfCurrent(() =>
          isBasicPreparationCurrent(preparation),
        );
        accepted = isBasicPreparationCurrent(preparation);
      } finally {
        finishBasicPreparation(preparation);
      }
      if (!accepted) return;
      const basicExtract = document.getElementById(
        "basic-extract-path",
      ) as HTMLInputElement | null;
      const extractPath = $<HTMLInputElement>("extract-path").value;
      if (basicExtract && extractPath) basicExtract.value = extractPath;
    });
  document
    .getElementById("basic-run-extract")
    ?.addEventListener("click", () => void handleBasicExtractAction());
  document
    .getElementById("basic-extract-cancel")
    ?.addEventListener("click", cancelAction);
  document
    .getElementById("basic-browse-contents")
    ?.addEventListener("click", async () => {
      setMode("browse");
      setBasicBrowsePasswordVisible(false);
      setBasicView("browse");
      await runBasicBrowseArchive();
    });
  document
    .getElementById("basic-toggle-browse-password")
    ?.addEventListener("click", () => {
      togglePasswordVisibility(
        "basic-browse-password",
        "basic-toggle-browse-password",
      );
    });
  const browsePassword = document.getElementById("basic-browse-password");
  browsePassword?.addEventListener("change", syncBasicBrowsePasswordToPower);
  browsePassword?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void runBasicBrowseArchive();
  });
  document
    .getElementById("basic-toggle-extract-password")
    ?.addEventListener("click", () => {
      togglePasswordVisibility(
        "basic-extract-password",
        "basic-toggle-extract-password",
      );
    });
  document
    .getElementById("basic-extract-open-dest")
    ?.addEventListener("click", () => {
      const path =
        (
          document.getElementById(
            "basic-extract-path",
          ) as HTMLInputElement | null
        )?.value ?? "";
      if (path) void openPathWithFeedback(path);
    });
  document
    .querySelectorAll<HTMLButtonElement>(".basic-preset-pill")
    .forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(".basic-preset-pill").forEach((item) => {
          item.classList.remove("is-active");
          item.setAttribute("aria-pressed", "false");
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
  document
    .getElementById("basic-compress-home")
    ?.addEventListener("click", resetCompressCompletion);
  const extractAgain = document.getElementById("basic-extract-another");
  extractAgain?.addEventListener("click", () => {
    if (extractAgain.textContent?.trim() === "Close")
      hideBasicCompletion("extract");
    else resetExtractCompletion();
  });
  document
    .getElementById("basic-extract-completion-close")
    ?.addEventListener("click", () => hideBasicCompletion("extract"));
  document
    .getElementById("basic-extract-home")
    ?.addEventListener("click", resetExtractCompletion);
}
