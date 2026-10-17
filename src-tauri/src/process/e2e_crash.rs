//! E2E-only crash injection for transaction recovery tests.
//!
//! This module exists only when the `e2e` feature is enabled, and every call
//! site is `#[cfg(feature = "e2e")]`, so production builds contain neither the
//! function nor the environment variable name.
//!
//! When `ZINNIA_E2E_CRASH_AT` equals the named point, the process writes that
//! name to `ZINNIA_E2E_CRASH_MARKER` (atomically, when set) and aborts. Without
//! a matching variable the call is a no-op.

/// Abort the process if `ZINNIA_E2E_CRASH_AT` names this crash point.
#[cfg(feature = "e2e")]
pub(crate) fn crash_point(name: &str) {
    if std::env::var("ZINNIA_E2E_CRASH_AT").as_deref() != Ok(name) {
        return;
    }
    if let Ok(marker) = std::env::var("ZINNIA_E2E_CRASH_MARKER") {
        let marker = std::path::PathBuf::from(marker);
        let staging = marker.with_extension("tmp");
        if std::fs::write(&staging, format!("{name}\n")).is_ok() {
            let _ = std::fs::rename(&staging, &marker);
        }
    }
    std::process::abort();
}
