import { isE2eFrontend } from "./e2e-env";

export async function installWdioGuestPluginIfEnabled(): Promise<void> {
  if (!isE2eFrontend()) return;
  // Official WDIO guest script. Vite drops this from production builds because
  // VITE_ZINNIA_E2E is a compile-time constant outside e2e mode.
  await import("@wdio/tauri-plugin");
}
