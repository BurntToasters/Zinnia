import { setMode } from "../ui";
import { cancelAction, testArchive } from "../archive";
import { setBasicView, syncBasicBrowsePasswordToPower } from "./sync";
import { handleBasicExtractAction } from "./actions";

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
  document
    .getElementById("basic-browse-cancel")
    ?.addEventListener("click", () => {
      void cancelAction();
    });
}
