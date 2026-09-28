import { isE2eFrontend } from "./e2e-env";

type DialogResult = string | string[] | null;

// WebDriver cannot drive native file dialogs. E2E builds queue the result a
// dialog would return; production builds never read or fill this queue.
const queuedResults: DialogResult[] = [];

export function queueE2eDialogResult(result: DialogResult): void {
  if (!isE2eFrontend()) return;
  queuedResults.push(result);
}

export function takeE2eDialogResult(): { result: DialogResult } | null {
  if (!isE2eFrontend() || queuedResults.length === 0) return null;
  return { result: queuedResults.shift() ?? null };
}
