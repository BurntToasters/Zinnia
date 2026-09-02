//! Early-load script that blocks the native webview context menu until JS
//! opts in via `window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__` (hidden debug mode).

/// Same listener the frontend installs; runs before page scripts so WebView2
/// / WKWebView / WebKitGTK cannot flash Back, Reload, or Inspect on first right-click.
pub(crate) const NATIVE_CONTEXT_MENU_GUARD_SCRIPT: &str = r#"
(function () {
  if (window.__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__) return;
  window.__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__ = true;
  document.addEventListener("contextmenu", function (event) {
    if (!window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__) {
      event.preventDefault();
    }
  }, true);
})();
"#;
