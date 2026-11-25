import { setMode } from "../ui";
import { cancelAction, testArchive } from "../archive";
import {
  currentBrowsedArchivePassword,
  restoreBrowsedArchivePassword,
} from "../archive/inspection";
import { state } from "../state";
import { setBasicView, syncBasicBrowsePasswordToPower } from "./sync";
import { handleBasicExtractAction } from "./actions";

export function wireBasicBrowseEvents(): void {
  const extractAllBtn = document.getElementById("basic-browse-extract-all");
  if (extractAllBtn) {
    extractAllBtn.addEventListener("click", () => {
      const browsed = currentBrowsedArchivePassword();
      const typedPassword =
        (
          document.getElementById(
            "basic-browse-password",
          ) as HTMLInputElement | null
        )?.value ?? "";
      setMode("extract");
      if (browsed?.archive && browsed.archive === state.inputs[0]) {
        restoreBrowsedArchivePassword(browsed);
      }
      setBasicView("extract");
      void handleBasicExtractAction(typedPassword || undefined);
    });
  }

  const testBtn = document.getElementById("basic-browse-test");
  if (testBtn) {
    testBtn.addEventListener("click", () => {
      syncBasicBrowsePasswordToPower();
      void testArchive();
    });
  }
  document
    .getElementById("basic-browse-cancel")
    ?.addEventListener("click", () => {
      void cancelAction();
    });
}
