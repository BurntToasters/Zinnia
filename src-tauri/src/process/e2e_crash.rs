//! E2E-only crash injection for transaction recovery tests.
//!
//! This module exists only when the `e2e` feature is enabled, and every call
//! site is `#[cfg(feature = "e2e")]`, so production builds contain neither the
//! function nor the environment variable name.
//!
//! When `ZINNIA_E2E_CRASH_AT` equals the named point, the process writes that
//! name to `ZINNIA_E2E_CRASH_MARKER` (atomically, when set) and aborts. Without
//! a matching variable the call is a no-op.
//!
//! `pause_point` is the async counterpart. When `ZINNIA_E2E_PAUSE_AT` equals
//! the named point, it writes the name to `ZINNIA_E2E_PAUSE_MARKER` (atomically,
//! when set) and sleeps for `ZINNIA_E2E_PAUSE_MS` milliseconds (default 4000,
//! capped at 30000) so a test can open a race window deterministically.

/// Write the point name to the marker file named by `variable`, when it is set.
#[cfg(feature = "e2e")]
fn write_marker(variable: &str, name: &str) {
    if let Ok(marker) = std::env::var(variable) {
        let marker = std::path::PathBuf::from(marker);
        let staging = marker.with_extension("tmp");
        if std::fs::write(&staging, format!("{name}\n")).is_ok() {
            let _ = std::fs::rename(&staging, &marker);
        }
    }
}

/// Abort the process if `ZINNIA_E2E_CRASH_AT` names this crash point.
#[cfg(feature = "e2e")]
pub(crate) fn crash_point(name: &str) {
    if std::env::var("ZINNIA_E2E_CRASH_AT").as_deref() != Ok(name) {
        return;
    }
    write_marker("ZINNIA_E2E_CRASH_MARKER", name);
    std::process::abort();
}

/// Sleep if `ZINNIA_E2E_PAUSE_AT` names this pause point.
#[cfg(feature = "e2e")]
pub(crate) async fn pause_point(name: &str) {
    if std::env::var("ZINNIA_E2E_PAUSE_AT").as_deref() != Ok(name) {
        return;
    }
    write_marker("ZINNIA_E2E_PAUSE_MARKER", name);
    let millis = std::env::var("ZINNIA_E2E_PAUSE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(4000)
        .min(30_000);
    tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
}
