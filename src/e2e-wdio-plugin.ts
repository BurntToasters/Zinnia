import { isE2eFrontend } from "./e2e-env";

export async function installWdioGuestPluginIfEnabled(): Promise<void> {
  // Compare the Vite define directly so Rollup can delete the WDIO guest
  // chunk from production assets. isE2eFrontend() is the same flag.
  if (import.meta.env.VITE_ZINNIA_E2E !== "1" || !isE2eFrontend()) return;
  await import("@wdio/tauri-plugin");
}
