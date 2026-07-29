//! Extract window lifecycle and warm-idle tray helpers.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Manager;

use crate::process::{is_non_running_kill_error, RunningProcess};

use super::open_path::derive_extract_destination_path;
use super::{
    ExtractBoundDestination, ExtractOpenAllowlist, ExtractQueue, EXTRACT_ONLY_LAUNCH,
    MAC_FALLBACK_MAIN_PENDING,
};

static EXTRACT_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Bumped whenever extract-only warm-idle should be cancelled (new window, quit, leave warm).
pub(crate) static EXTRACT_WARM_IDLE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// True while extract-only warm-idle is engaged (dedupes ExitRequested + Destroyed).
pub(crate) static EXTRACT_WARM_IDLE_ACTIVE: AtomicBool = AtomicBool::new(false);
const EXTRACT_WARM_TRAY_ID: &str = "extract-warm";

pub fn clear_extract_window_bindings(app: &tauri::AppHandle, label: &str) {
    if let Some(state) = app.try_state::<ExtractQueue>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.remove(label);
        }
    }
    if let Some(state) = app.try_state::<ExtractBoundDestination>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.remove(label);
        }
    }
    if let Some(state) = app.try_state::<ExtractOpenAllowlist>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.remove(label);
        }
    }
}
#[tauri::command]
pub fn get_extract_paths(
    window: tauri::Window,
    state: tauri::State<'_, ExtractQueue>,
) -> Result<Vec<String>, String> {
    let mut queue = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    let label = window.label().to_string();
    Ok(queue.remove(&label).unwrap_or_default())
}
pub fn has_extract_windows(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| super::is_extract_window_label(label))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn first_extract_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            if super::is_extract_window_label(&label) {
                Some(window)
            } else {
                None
            }
        })
}

pub(crate) fn bump_extract_warm_idle_generation() {
    EXTRACT_WARM_IDLE_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Embed archive/destination for the extract window. Escapes U+2028/U+2029 because
/// serde_json leaves them unescaped and they break JavaScript string literals.
pub(crate) fn extract_session_init_script(archive: &str, destination: &str) -> String {
    let payload = serde_json::json!({
        "archive": archive,
        "destination": destination,
    });
    let json = payload
        .to_string()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        "Object.defineProperty(window,\"__ZINNIA_EXTRACT__\",{{value:Object.freeze({json}),enumerable:false,configurable:false}});"
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn set_macos_activation_policy(app: &tauri::AppHandle, policy: tauri::ActivationPolicy) {
    if let Err(error) = app.set_activation_policy(policy) {
        eprintln!("Failed to set macOS activation policy: {error}");
    }
}

/// Restore a normal Dock/app presence before showing any window again.
pub fn restore_foreground_activation(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    set_macos_activation_policy(app, tauri::ActivationPolicy::Regular);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

pub(crate) fn open_main_from_extract_warm(app: &tauri::AppHandle) {
    EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
    leave_extract_warm(app);
    if let Err(error) = show_main_window(app) {
        eprintln!("Failed to open main window from warm tray: {error}");
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_extract_warm_tray(app: &tauri::AppHandle) -> bool {
    if app.tray_by_id(EXTRACT_WARM_TRAY_ID).is_some() {
        return true;
    }
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let Ok(open) = MenuItem::with_id(app, "open", "Open Zinnia", true, None::<&str>) else {
        eprintln!("Failed to create extract warm-tray open item");
        return false;
    };
    let Ok(quit) = MenuItem::with_id(app, "quit", "Quit Zinnia", true, None::<&str>) else {
        eprintln!("Failed to create extract warm-tray quit item");
        return false;
    };
    let Ok(menu) = Menu::with_items(app, &[&open, &quit]) else {
        eprintln!("Failed to create extract warm-tray menu");
        return false;
    };
    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("Failed to create extract warm-tray: missing app icon");
        return false;
    };
    match TrayIconBuilder::with_id(EXTRACT_WARM_TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Zinnia (ready for next archive)")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_main_from_extract_warm(app),
            "quit" => {
                leave_extract_warm(app);
                EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_main_from_extract_warm(tray.app_handle());
            }
        })
        .build(app)
    {
        Ok(_) => true,
        Err(error) => {
            eprintln!("Failed to create extract warm-tray: {error}");
            false
        }
    }
}

/// Drop the resident extract-only tray and cancel the idle exit timer.
pub fn leave_extract_warm(app: &tauri::AppHandle) {
    EXTRACT_WARM_IDLE_ACTIVE.store(false, Ordering::SeqCst);
    bump_extract_warm_idle_generation();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app.remove_tray_by_id(EXTRACT_WARM_TRAY_ID);
    }
    restore_foreground_activation(app);
}

/// After the last quick-extract window closes, stay resident for the next open.
/// Returns whether warm-idle was engaged (caller may `prevent_exit`).
pub fn enter_extract_warm_idle(app: &tauri::AppHandle) -> bool {
    if !should_keep_extract_warm(app) {
        return EXTRACT_WARM_IDLE_ACTIVE.load(Ordering::SeqCst);
    }

    let prefs = crate::settings_store::quick_extract_warm_prefs(app);
    if !prefs.enabled {
        leave_extract_warm(app);
        return false;
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Warm-idle requires a tray affordance. Without it the process would be
        // invisible (or a Dock zombie on macOS) with no clear Quit path.
        if !ensure_extract_warm_tray(app) {
            return false;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Hide the Dock icon while windowless; tray + single-instance stay alive.
        set_macos_activation_policy(app, tauri::ActivationPolicy::Accessory);
    }

    // Refresh the idle timer when ExitRequested and Destroyed both fire.
    EXTRACT_WARM_IDLE_ACTIVE.store(true, Ordering::SeqCst);
    let generation = EXTRACT_WARM_IDLE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let idle_secs = prefs.idle_secs.max(60);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(idle_secs)).await;
        if EXTRACT_WARM_IDLE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) || has_extract_windows(&handle) {
            return;
        }
        let exit_handle = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            // Re-check on the main thread: a file-open may have raced the sleep wake.
            if EXTRACT_WARM_IDLE_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) || has_extract_windows(&exit_handle) {
                return;
            }
            leave_extract_warm(&exit_handle);
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            exit_handle.exit(0);
        }) {
            eprintln!("Failed to schedule warm-idle exit on main thread: {error}");
        }
    });
    true
}

/// Keep ExitRequested from tearing down extract-only warm idle.
pub fn should_keep_extract_warm(app: &tauri::AppHandle) -> bool {
    EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) && !has_extract_windows(app)
}

pub fn ensure_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("main") {
        return Ok(window);
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or_else(|| "Main window configuration is missing".to_string())?;

    tauri::WebviewWindowBuilder::from_config(app, config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

pub fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    restore_foreground_activation(app);
    let window = ensure_main_window(app)?;

    #[cfg(not(target_os = "macos"))]
    window.set_decorations(false).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    window.set_title("").map_err(|e| e.to_string())?;

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_main_window_ready() {
    MAC_FALLBACK_MAIN_PENDING.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub async fn close_extract_window(
    window: tauri::Window,
    app: tauri::AppHandle,
    _state: tauri::State<'_, RunningProcess>,
    _allowlist: tauri::State<'_, ExtractOpenAllowlist>,
) -> Result<(), String> {
    cancel_owner_and_wait(&app, window.label()).await?;
    clear_extract_window_bindings(&app, window.label());

    if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.destroy();
        }
        return window.destroy().map_err(|e| e.to_string());
    }

    window.destroy().map_err(|e| e.to_string())
}

pub async fn cancel_owner_and_wait(
    app: &tauri::AppHandle,
    owner_label: &str,
) -> Result<(), String> {
    let state = app.state::<RunningProcess>();
    let child = {
        let mut process = state
            .0
            .lock()
            .map_err(|_| "Process lock poisoned".to_string())?;
        if let Some(owner) = &process.owner_label {
            if owner == owner_label {
                process.cancelling = true;
                process.child.take()
            } else {
                None
            }
        } else {
            None
        }
    };
    if let Some(child) = child {
        if let Err(e) = child.kill() {
            let msg = e.to_string();
            // Mirror cancel_7z: already-exited is success; real kill failure must
            // restore the handle so a later close/cancel can retry.
            if !is_non_running_kill_error(&msg) {
                if let Ok(mut process) = state.0.lock() {
                    if process.child.is_none() {
                        process.child = Some(child);
                    }
                }
                return Err(format!(
                    "Could not stop the archive operation before closing this window: {msg}"
                ));
            }
        }
    }

    // `run_7z` owns termination collection and filesystem finalization.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let busy = {
            let process = state
                .0
                .lock()
                .map_err(|_| "Process lock poisoned".to_string())?;
            process.owner_label.as_deref() == Some(owner_label)
                && (process.child.is_some() || process.preparing || process.cancelling)
        };
        if !busy {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err("The archive operation has not finished cleaning up. Keep Zinnia open and try closing again shortly.".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(())
}

pub fn spawn_extract_window(app: &tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.len() > 100 {
        return Err("Too many paths in a single extract batch.".to_string());
    }
    let archive = paths
        .first()
        .cloned()
        .ok_or_else(|| "Extract window requires an archive path.".to_string())?;
    let destination = derive_extract_destination_path(&archive)
        .ok_or_else(|| "Could not derive an extract destination for this archive.".to_string())?;

    let label = format!(
        "extract-{}",
        EXTRACT_WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst)
    );

    {
        let queue = app.state::<ExtractQueue>();
        let mut q = queue.0.lock().map_err(|_| "Lock poisoned".to_string())?;
        if q.len() >= 20 {
            return Err("Extract queue is full".to_string());
        }
        q.insert(label.clone(), paths);
    }
    {
        let bound = app.state::<ExtractBoundDestination>();
        let mut map = bound.0.lock().map_err(|_| "Lock poisoned".to_string())?;
        map.insert(label.clone(), destination.clone());
    }

    // Inject archive + destination before the page script runs so the UI can paint
    // and start extract without waiting on get_extract_paths.
    let init_script = extract_session_init_script(&archive, destination.to_string_lossy().as_ref());

    restore_foreground_activation(app);

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("extract.html".into()),
    )
    .title("Zinnia: Extracting")
    .inner_size(440.0, 320.0)
    .resizable(false)
    .minimizable(true)
    .maximizable(false)
    .initialization_script(init_script);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title("")
            .title_bar_style(tauri::TitleBarStyle::Overlay);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let result = builder.build().map_err(|e| e.to_string());

    if result.is_err() {
        clear_extract_window_bindings(app, &label);
    } else {
        // Live extract window: drop tray / ACTIVE while keeping EXTRACT_ONLY_LAUNCH
        // for the caller; warm re-enters when the last extract window closes.
        leave_extract_warm(app);
    }

    result.map(|_| ())
}
