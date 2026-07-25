import { getWorkspaceMode } from "../ui";
import { state } from "../state";
import { setBasicView } from "./sync";

export function wireBasicKeyboardEvents(): void {
  document.addEventListener("keydown", (event) => {
    if (getWorkspaceMode() !== "basic") return;
    if (document.querySelector(".modal-overlay:not([hidden])")) return;
    if (state.running || state.operationPreparing) return;

    const eventTarget =
      event.target instanceof Element ? event.target : document.activeElement;
    const activeTab = eventTarget?.closest<HTMLButtonElement>(
      '[role="tab"][data-basic-tab]',
    );
    if (
      activeTab &&
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      const tabs = Array.from(
        activeTab
          .closest('[role="tablist"]')
          ?.querySelectorAll<HTMLButtonElement>(
            '[role="tab"][data-basic-tab]',
          ) ?? [],
      ).filter((tab) => !tab.disabled);
      const currentIndex = tabs.indexOf(activeTab);
      if (currentIndex < 0 || tabs.length === 0) return;

      event.preventDefault();
      let nextIndex = currentIndex;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else if (event.key === "ArrowLeft")
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      else nextIndex = (currentIndex + 1) % tabs.length;

      const nextTab = tabs[nextIndex];
      nextTab.focus();
      nextTab.click();
      return;
    }

    if (event.key === "Escape") {
      const activeElement = document.activeElement as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(activeElement?.tagName)) {
        activeElement.blur();
        return;
      }
      if (
        ["basic-compress", "basic-extract", "basic-browse"].some((id) =>
          document.getElementById(id)?.classList.contains("is-active"),
        )
      ) {
        setBasicView("home");
      }
      return;
    }

    if (event.key !== "Enter") return;
    const activeElement = document.activeElement as HTMLElement;
    if (["BUTTON", "A"].includes(activeElement?.tagName)) return;
    if (
      document.getElementById("basic-compress")?.classList.contains("is-active")
    ) {
      document.getElementById("basic-run-compress")?.click();
    } else if (
      document.getElementById("basic-extract")?.classList.contains("is-active")
    ) {
      document.getElementById("basic-run-extract")?.click();
    }
  });
}
