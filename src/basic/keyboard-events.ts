import { getWorkspaceMode } from "../ui";
import { setBasicView } from "./sync";

export function wireBasicKeyboardEvents(): void {
  document.addEventListener("keydown", (event) => {
    if (getWorkspaceMode() !== "basic") return;
    if (document.querySelector(".modal-overlay:not([hidden])")) return;

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
