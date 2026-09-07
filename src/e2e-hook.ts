import {
  applyIncomingPaths,
  waitUntilIncomingPathIdle,
} from "./incoming-paths";
import { isE2eFrontend } from "./e2e-env";
import { installWdioGuestPluginIfEnabled } from "./e2e-wdio-plugin";

export type E2eHook = {
  applyIncomingPaths: (paths: string[], mode: string) => Promise<void>;
};

declare global {
  interface Window {
    __ZINNIA_E2E__?: E2eHook;
  }
}

export async function installE2eHookIfEnabled(): Promise<void> {
  if (import.meta.env.VITE_ZINNIA_E2E !== "1" || !isE2eFrontend()) return;
  await installWdioGuestPluginIfEnabled();
  window.__ZINNIA_E2E__ = {
    applyIncomingPaths: async (paths, mode) => {
      await applyIncomingPaths(paths, mode, "e2e");
      await waitUntilIncomingPathIdle();
    },
  };
}
