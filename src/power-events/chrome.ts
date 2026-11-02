import { $ } from "../utils";
import { state } from "../state";
import { toggleActivity, setWorkspaceMode, setUiDensity } from "../ui";
import { setBasicView, syncBasicWorkspaceFromPower } from "../basic";
import { refreshQuickActionRepeatState } from "../quick-actions";

export function wireWorkspaceChromeEvents(): void {
  $("toggle-activity").addEventListener("click", toggleActivity);
  document
    .querySelectorAll<HTMLButtonElement>("[data-workspace-mode-btn]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.running || state.operationPreparing) return;
        const mode =
          btn.dataset.workspaceModeBtn === "power" ? "power" : "basic";
        setWorkspaceMode(mode);
        if (mode === "basic") {
          syncBasicWorkspaceFromPower();
          setBasicView("home");
        }
        refreshQuickActionRepeatState();
      });
    });
  $("toggle-density").addEventListener("click", () => {
    const nextDensity =
      state.currentSettings.uiDensity === "compact" ? "comfortable" : "compact";
    setUiDensity(nextDensity);
  });
  document.addEventListener("zinnia:mode-changed", () => {
    refreshQuickActionRepeatState();
  });
}
