import { open } from "@tauri-apps/plugin-shell";
import { safeHref } from "./utils";
import { log } from "./ui";

/** Open an http(s) URL in the system browser (Tauri webviews block window.open). */
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

/**
 * Intercept http(s) anchors so they open via the shell plugin instead of the
 * webview navigation/`window.open` path, which is disabled in Tauri.
 */
export function wireExternalLinkClicks(root: ParentNode = document): void {
  root.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^https?:/i.test(href)) return;
      event.preventDefault();
      void openExternalUrl(href);
    },
    true,
  );
}
