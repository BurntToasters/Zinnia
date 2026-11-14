import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { init } from "./app-init";

export { parseBenchmarkSummary } from "./benchmark";
export { refreshIcons } from "./icons";

function replaceWithFreshButton(id: string): HTMLButtonElement | null {
  const current = document.getElementById(id);
  if (!current) return null;
  const fresh = current.cloneNode(true) as HTMLButtonElement;
  current.replaceWith(fresh);
  return fresh;
}

function showFatalStartupError(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  const appWindow = getCurrentWebviewWindow();

  replaceWithFreshButton("titlebar-min")?.addEventListener("click", () => {
    void appWindow.minimize();
  });
  replaceWithFreshButton("titlebar-close")?.addEventListener("click", () => {
    void appWindow.close();
  });
  const maximize = replaceWithFreshButton("titlebar-max");
  if (maximize) maximize.disabled = true;

  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  const message = document.createElement("p");
  message.textContent = `Failed to start: ${detail}`;
  const hint = document.createElement("p");
  hint.textContent = "Close this window, then open Zinnia again.";
  const closeAction = document.createElement("button");
  closeAction.type = "button";
  closeAction.className = "btn";
  closeAction.textContent = "Close";
  closeAction.addEventListener("click", () => {
    void appWindow.close();
  });
  panel.append(message, hint, closeAction);

  const host = document.getElementById("main-content");
  if (host) {
    host.replaceChildren(panel);
  } else {
    document.body.appendChild(panel);
  }
}

export const startup = init().catch(showFatalStartupError);
