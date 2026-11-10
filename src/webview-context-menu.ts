/**
 * Hide the webview's native right-click menu (WebView2 Back/Reload/Inspect,
 * WKWebView/WebKitGTK Reload) unless hidden debug mode turns it back on.
 * Editable text fields keep the native menu so mouse users can cut, copy and paste.
 *
 * A matching Tauri initialization script installs the same listener before
 * page JS so the native menu cannot flash during load.
 */

declare global {
  interface Window {
    __ZINNIA_NATIVE_CONTEXT_MENU_GUARD__?: boolean;
    __ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__?: boolean;
  }
}

export function setNativeWebviewContextMenuAllowed(allowed: boolean): void {
  window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__ = allowed;
}

export function isNativeWebviewContextMenuAllowed(): boolean {
  return window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__ === true;
}

const TEXT_INPUT_TYPES = new Set([
  "",
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

/** Cut, copy and paste are only useful where text can be edited. */
export function isEditableContextMenuTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type.toLowerCase());
  }
  return (
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

export function installNativeWebviewContextMenuGuard(): void {
  if (window.__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__) return;
  window.__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__ = true;
  document.addEventListener(
    "contextmenu",
    (event) => {
      if (window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__) return;
      if (isEditableContextMenuTarget(event.target)) return;
      event.preventDefault();
    },
    true,
  );
}
