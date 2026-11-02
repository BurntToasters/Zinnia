import { $ } from "../utils";
import { setMode } from "../ui";
import { checkUpdates } from "../updater";
import { openLicensesModal, closeLicensesModal } from "../licenses";
import {
  wireQuickActionEvents,
  refreshQuickActionRepeatState,
} from "../quick-actions";
import { wireOsIntegrationEvents } from "../os-integration";
import { runBenchmark } from "../benchmark";
import { wireDebugConsoleControls } from "../debug-mode";
import { exportLocalLogs, openLogsFolder, clearLocalLogs } from "../power-logs";
import { promptAndToggleDebugMode } from "./debug-toggle";

export function wireAboutAndToolsEvents(): void {
  $("check-updates").addEventListener("click", checkUpdates);
  $("export-logs").addEventListener("click", exportLocalLogs);
  $("open-logs-folder").addEventListener("click", openLogsFolder);
  $("clear-logs").addEventListener("click", clearLocalLogs);
  $("run-benchmark").addEventListener("click", runBenchmark);
  $("show-licenses").addEventListener("click", (e) =>
    openLicensesModal(e.currentTarget as HTMLElement),
  );
  $("about-show-licenses").addEventListener("click", (e) =>
    openLicensesModal(e.currentTarget as HTMLElement),
  );
  const aboutDebugToggle = $("about-debug-toggle");
  aboutDebugToggle.addEventListener("click", () => {
    void promptAndToggleDebugMode();
  });
  aboutDebugToggle.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    void promptAndToggleDebugMode();
  });
  wireDebugConsoleControls();
  wireOsIntegrationEvents();

  $("close-licenses").addEventListener("click", closeLicensesModal);
  $("licenses-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeLicensesModal();
  });

  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = (btn as HTMLButtonElement).dataset.modeBtn;
      if (m === "extract") setMode("extract");
      else if (m === "browse") setMode("browse");
      else setMode("add");
      refreshQuickActionRepeatState();
    });
  });

  wireQuickActionEvents();
}
