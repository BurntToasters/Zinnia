import { applyIncomingPaths } from "./incoming-paths";
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
  if (import.meta.env.VITE_ZINNIA_E2E !== "1") return;
  await installWdioGuestPluginIfEnabled();
  window.__ZINNIA_E2E__ = {
    applyIncomingPaths: (paths, mode) => applyIncomingPaths(paths, mode, "e2e"),
  };
}
