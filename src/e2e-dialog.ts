import { isE2eFrontend } from "./e2e-env";

type DialogResult = string | string[] | null;

// WebDriver cannot drive native file dialogs. E2E builds queue the result a
// dialog would return; production builds never read or fill this queue.
const queuedResults: DialogResult[] = [];
const queuedConfirmResults: boolean[] = [];

export function queueE2eDialogResult(result: DialogResult): void {
  if (!isE2eFrontend()) return;
  queuedResults.push(result);
}

export function takeE2eDialogResult(): { result: DialogResult } | null {
  if (!isE2eFrontend() || queuedResults.length === 0) return null;
  return { result: queuedResults.shift() ?? null };
}

/** Answer the next native yes/no dialog (`confirm` / `ask`) in an E2E build. */
export function queueE2eConfirmResult(result: boolean): void {
  if (!isE2eFrontend()) return;
  queuedConfirmResults.push(result);
}

/**
 * Run a native yes/no dialog, or return the queued E2E answer. Production
 * builds compile `isE2eFrontend()` to false and always call `native`.
 */
export async function confirmWithE2eQueue(
  native: () => Promise<boolean>,
): Promise<boolean> {
  if (isE2eFrontend() && queuedConfirmResults.length > 0) {
    return queuedConfirmResults.shift() ?? false;
  }
  return native();
}
