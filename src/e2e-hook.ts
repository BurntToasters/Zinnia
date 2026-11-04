import {
  applyIncomingPaths,
  waitUntilIncomingPathIdle,
} from "./incoming-paths";
import { isE2eFrontend } from "./e2e-env";
import { flushPendingSettingsPersistence } from "./ui/workspace";
import { queueE2eConfirmResult, queueE2eDialogResult } from "./e2e-dialog";
import { installWdioGuestPluginIfEnabled } from "./e2e-wdio-plugin";
import type {
  ArchiveBenchmarkRequest,
  ArchiveBenchmarkResult,
} from "./e2e-archive-benchmark";

export type E2eHook = {
  applyIncomingPaths: (paths: string[], mode: string) => Promise<void>;
  queueDialogResult: (result: string | string[] | null) => void;
  queueConfirmResult: (result: boolean) => void;
  /**
   * Drop the debounced working-context write and wait for any write already in
   * flight. A test that seeds settings.json calls this first so a stale write
   * queued by earlier UI activity cannot land on top of the seed.
   */
  flushPendingSettingsPersistence: () => Promise<void>;
  runArchiveBenchmarkOperation: (
    request: ArchiveBenchmarkRequest,
  ) => Promise<ArchiveBenchmarkResult>;
};

declare global {
  interface Window {
    __ZINNIA_E2E__?: E2eHook;
  }
}

export async function installE2eHookIfEnabled(): Promise<void> {
  if (import.meta.env.VITE_ZINNIA_E2E !== "1" || !isE2eFrontend()) return;
  await installWdioGuestPluginIfEnabled();
  const { runArchiveBenchmarkOperation } =
    await import("./e2e-archive-benchmark");
  window.__ZINNIA_E2E__ = {
    applyIncomingPaths: async (paths, mode) => {
      await applyIncomingPaths(paths, mode, "e2e");
      await waitUntilIncomingPathIdle();
    },
    queueDialogResult: queueE2eDialogResult,
    queueConfirmResult: queueE2eConfirmResult,
    flushPendingSettingsPersistence,
    runArchiveBenchmarkOperation,
  };
}
