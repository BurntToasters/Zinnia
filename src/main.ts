import { init } from "./app-init";

export { parseBenchmarkSummary } from "./benchmark";
export { refreshIcons } from "./icons";

export const startup = init().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
