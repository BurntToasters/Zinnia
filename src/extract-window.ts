import { runExtractWindow } from "./extract-window/run-core";

export { formatEta } from "./progress-update";
export { sanitizeStatusFileName } from "./extract-window/status-sanitize";

runExtractWindow().catch((err) => {
  document.body.textContent = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
});
