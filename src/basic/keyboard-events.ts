import { getWorkspaceMode } from "../ui";
import { state } from "../state";
import { isImeComposing, isKeyHandled } from "../utils";
import { setBasicView } from "./sync";

/** Input types where Enter means "run" and not a native form action. */
const RUN_ON_ENTER_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

export function wireBasicKeyboardEvents(): void {
  document.addEventListener("keydown", (event) => {
    if (isKeyHandled(event)) return;
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
    if (isImeComposing(event)) return;
    // Only a text field runs the operation. Checkboxes, selects and buttons
    // keep their own Enter behavior. Key events target the focused element,
    // so the event target is the field that received the key.
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) ||
      !RUN_ON_ENTER_INPUT_TYPES.has(target.type)
    ) {
      return;
    }
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
