import { $ } from "../utils";
import {
  closeSelectiveExtractModal,
  setSelectiveExtractSearch,
  selectAllVisibleInPicker,
  clearPickerSelection,
  runSelectiveExtractFromModal,
  syncSelectiveDestinationAfterBrowseChoice,
  syncDestinationWhilePickerOpen,
} from "../archive";
import { chooseExtract } from "../files";
import { wirePasswordToggle } from "../power-helpers";

export function wireSelectiveModalEvents(): void {
  $("close-selective").addEventListener("click", closeSelectiveExtractModal);
  $("selective-cancel").addEventListener("click", closeSelectiveExtractModal);
  $("selective-search").addEventListener("input", () => {
    setSelectiveExtractSearch(
      $<HTMLInputElement>("selective-search").value,
      true,
    );
  });
  $("selective-select-all").addEventListener("click", selectAllVisibleInPicker);
  $("selective-clear").addEventListener("click", clearPickerSelection);
  $("selective-confirm").addEventListener("click", () => {
    void runSelectiveExtractFromModal();
  });
  $("selective-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSelectiveExtractModal();
  });
  $("selective-browse-dest").addEventListener("click", async () => {
    await chooseExtract();
    syncSelectiveDestinationAfterBrowseChoice();
  });
  $("selective-dest").addEventListener("input", () => {
    syncDestinationWhilePickerOpen($<HTMLInputElement>("selective-dest").value);
  });

  wirePasswordToggle("browse-password", "toggle-browse-password");
}
