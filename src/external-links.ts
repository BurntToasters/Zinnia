import { open } from "@tauri-apps/plugin-shell";
import { safeHref } from "./utils";
import { log } from "./ui";

/**
 * Open an http(s) URL in the system browser.
 *
 * Prefer `<a href="…" target="_blank">` for in-UI links. The shell plugin
 * intercepts those under `shell:allow-open`, the only permission the
 * `shell:default` set grants. Use this helper only for programmatic opens
 * (app menu, etc.) so clicks are not opened twice.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const href = safeHref(url);
  if (href === "#") {
    log(`Blocked unsafe external URL: ${url}`, "error");
    return;
  }
  try {
    await open(href);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to open external link: ${msg}`, "error");
  }
}
