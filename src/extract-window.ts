import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { runExtractWindow } from "./extract-window/run-core";

export { formatEta } from "./progress-update";
export { sanitizeStatusFileName } from "./extract-window/status-sanitize";

function replaceWithFreshButton(id: string): HTMLButtonElement | null {
  const current = document.getElementById(id);
  if (!current) return null;
  const fresh = current.cloneNode(true) as HTMLButtonElement;
  current.replaceWith(fresh);
  return fresh;
}

function showFatalExtractError(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  const appWindow = getCurrentWebviewWindow();

  replaceWithFreshButton("titlebar-min")?.addEventListener("click", () => {
    void appWindow.minimize();
  });
  replaceWithFreshButton("titlebar-close")?.addEventListener("click", () => {
    void appWindow.close();
  });

  const panel = document.createElement("div");
  panel.className = "extract-error";
  panel.setAttribute("role", "alert");
  const title = document.createElement("div");
  title.className = "extract-error-title";
  title.textContent = "Zinnia could not start this extraction window.";
  const detailText = document.createElement("pre");
  detailText.className = "extract-error-detail";
  detailText.textContent = `Fatal: ${detail}`;
  const closeAction = document.createElement("button");
  closeAction.type = "button";
  closeAction.className = "btn btn--close";
  closeAction.textContent = "Close";
  closeAction.addEventListener("click", () => {
    void appWindow.close();
  });
  panel.append(title, detailText, closeAction);

  const host = document.getElementById("extract-app");
  if (host) {
    host.replaceChildren(panel);
  } else {
    document.body.appendChild(panel);
  }
}

runExtractWindow().catch(showFatalExtractError);
