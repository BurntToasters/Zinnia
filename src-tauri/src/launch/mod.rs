//! Launch routing: CLI/file-association args, extract windows, pending-path queues.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

mod debug_console_window;
mod extract_window;
mod open_path;
mod open_routing;
mod webview_context_menu;

pub static EXTRACT_ONLY_LAUNCH: AtomicBool = AtomicBool::new(false);
pub static MAC_FALLBACK_MAIN_PENDING: AtomicBool = AtomicBool::new(false);
pub static MAIN_WINDOW_READY: AtomicBool = AtomicBool::new(false);
pub static FILE_OPEN_SIGNAL: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

pub(crate) const MAX_OPENABLE_DIRECTORIES: usize = 64;

pub struct InitialPaths(pub Mutex<Vec<String>>);
pub struct InitialMode(pub Mutex<String>);
pub struct ExtractQueue(pub Mutex<HashMap<String, Vec<String>>>);
pub struct PendingPaths(pub Mutex<Vec<OpenPathsPayload>>);
/// Extract windows may only open directories they register here first.
pub struct ExtractOpenAllowlist(pub Mutex<HashMap<String, std::path::PathBuf>>);
/// Destination folder bound at extract-window spawn (E1/E2). Survives after
/// `get_extract_paths` drains the queue so run_7z/-o and open_path stay pinned.
pub struct ExtractBoundDestination(pub Mutex<HashMap<String, std::path::PathBuf>>);
/// Main window may only open directories produced by recent successful operations.
pub struct OpenPathAllowlist(pub Mutex<VecDeque<std::path::PathBuf>>);

impl Default for OpenPathAllowlist {
    fn default() -> Self {
        Self(Mutex::new(VecDeque::new()))
    }
}

#[derive(serde::Serialize, Clone)]
pub struct OpenPathsPayload {
    paths: Vec<String>,
    mode: String,
}

pub fn is_extract_window_label(label: &str) -> bool {
    label.starts_with("extract-")
}

/// Unpackaged WebdriverIO sets `ZINNIA_E2E=1` on the launched binary.
pub fn e2e_session_active() -> bool {
    std::env::var("ZINNIA_E2E").is_ok_and(|value| value == "1")
}

/// WebView2 `ExecuteScript` completion is dropped on transparent/hidden HWNDs.
#[cfg(windows)]
pub(crate) const E2E_WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-gpu --disable-features=CalculateNativeWinOcclusion,RendererCodeIntegrity";

pub(crate) fn apply_e2e_webview_overrides<'a, R, M>(
    mut builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    if !e2e_session_active() {
        return builder;
    }
    builder = builder.transparent(false).visible(true);
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(E2E_WEBVIEW2_BROWSER_ARGS);
    }
    builder
}

pub use debug_console_window::{
    close_debug_console_window, debug_console_window_open, open_debug_console_window,
    relay_debug_console_clear, relay_debug_console_line, relay_debug_console_seed,
    relay_debug_console_signal,
};

// Public API re-exports (stable `launch::…` paths for main.rs / process / macos_services).
pub(crate) use extract_window::bump_extract_warm_idle_generation;
#[cfg(any(target_os = "macos", target_os = "ios"))]
#[allow(unused_imports)]
pub use extract_window::first_extract_window;
#[allow(unused_imports)]
pub use extract_window::{
    cancel_owner_and_wait, clear_extract_window_bindings, close_extract_window, ensure_main_window,
    enter_extract_warm_idle, get_extract_paths, has_extract_windows, inspect_extract_destination,
    leave_extract_warm, mark_main_window_ready, restore_foreground_activation,
    should_keep_extract_warm, show_main_window, spawn_extract_window,
};
#[allow(unused_imports)]
pub use open_path::{
    assert_extract_bound_destination, derive_extract_destination_path, drain_pending_paths,
    get_initial_mode, get_initial_paths, open_path, register_extract_open_path,
    remember_openable_directory,
};
#[cfg(any(target_os = "macos", target_os = "ios"))]
#[allow(unused_imports)]
pub use open_routing::emit_open_urls;
#[allow(unused_imports)]
pub use open_routing::{
    collect_cli_context, emit_open_paths, get_shell_handoff_error,
    resolve_cli_context_with_handoffs,
};

#[doc(hidden)]
pub use debug_console_window::{
    __cmd__close_debug_console_window, __cmd__debug_console_window_open,
    __cmd__open_debug_console_window, __cmd__relay_debug_console_clear,
    __cmd__relay_debug_console_line, __cmd__relay_debug_console_seed,
    __cmd__relay_debug_console_signal, __tauri_command_name_close_debug_console_window,
    __tauri_command_name_debug_console_window_open, __tauri_command_name_open_debug_console_window,
    __tauri_command_name_relay_debug_console_clear, __tauri_command_name_relay_debug_console_line,
    __tauri_command_name_relay_debug_console_seed, __tauri_command_name_relay_debug_console_signal,
};
#[doc(hidden)]
pub use extract_window::{
    __cmd__close_extract_window, __cmd__get_extract_paths, __cmd__inspect_extract_destination,
    __cmd__mark_main_window_ready, __tauri_command_name_close_extract_window,
    __tauri_command_name_get_extract_paths, __tauri_command_name_inspect_extract_destination,
    __tauri_command_name_mark_main_window_ready,
};
#[doc(hidden)]
pub use open_path::{
    __cmd__drain_pending_paths, __cmd__get_initial_mode, __cmd__get_initial_paths,
    __cmd__open_path, __cmd__register_extract_open_path, __tauri_command_name_drain_pending_paths,
    __tauri_command_name_get_initial_mode, __tauri_command_name_get_initial_paths,
    __tauri_command_name_open_path, __tauri_command_name_register_extract_open_path,
};
#[doc(hidden)]
pub use open_routing::{
    __cmd__get_shell_handoff_error, __tauri_command_name_get_shell_handoff_error,
};

#[cfg(test)]
mod tests;
