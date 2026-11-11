//! Early-load script that blocks the native webview context menu until JS
//! opts in via `window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__` (hidden debug mode).
//! Editable text fields keep the native menu so mouse users can cut, copy and paste.

/// Same listener the frontend installs; runs before page scripts so WebView2
/// / WKWebView / WebKitGTK cannot flash Back, Reload, or Inspect on first right-click.
pub(crate) const NATIVE_CONTEXT_MENU_GUARD_SCRIPT: &str = r#"
(function () {
  if (window.__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__) return;
  window.__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__ = true;
  var TEXT_INPUT_TYPES = ["", "email", "number", "password", "search", "tel", "text", "url"];
  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) {
      return TEXT_INPUT_TYPES.indexOf(target.type.toLowerCase()) !== -1;
    }
    return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
  }
  document.addEventListener("contextmenu", function (event) {
    if (window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__) return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
  }, true);
})();
"#;

#[cfg(test)]
mod tests {
    use super::NATIVE_CONTEXT_MENU_GUARD_SCRIPT as SCRIPT;

    #[test]
    fn guard_script_exempts_editable_targets_before_preventing_default() {
        let editable_check = SCRIPT
            .find("isEditableTarget(event.target)")
            .expect("contextmenu handler must check editable targets");
        let prevent = SCRIPT
            .find("event.preventDefault()")
            .expect("contextmenu handler must still suppress other targets");
        assert!(
            editable_check < prevent,
            "editable exemption must run before preventDefault"
        );
    }

    #[test]
    fn guard_script_recognises_text_fields_textareas_and_contenteditable() {
        assert!(SCRIPT.contains("HTMLTextAreaElement"));
        assert!(SCRIPT.contains("HTMLInputElement"));
        assert!(SCRIPT.contains("closest("));
        assert!(SCRIPT.contains("[contenteditable]:not([contenteditable=\"false\"])"));
        for text_type in [
            "text", "search", "url", "tel", "email", "password", "number",
        ] {
            assert!(
                SCRIPT.contains(&format!("\"{text_type}\"")),
                "text-like input type {text_type} must keep the native menu"
            );
        }
        assert!(
            !SCRIPT.contains("\"checkbox\"") && !SCRIPT.contains("\"button\""),
            "non-text input types must stay suppressed"
        );
    }

    #[test]
    fn guard_script_keeps_debug_flag_and_guard_idempotence() {
        assert!(SCRIPT.contains("if (window.__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__) return;"));
        assert!(SCRIPT.contains("if (window.__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__) return;"));
    }
}
