//! Extract window lifecycle and warm-idle tray helpers.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Manager;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_dialog::DialogExt;

use crate::process::{terminate_registered_child_async, ProcessState, RunningProcess};

use super::open_path::{apply_picked_folder, derive_extract_destination_path};
use super::{
    ExtractBoundDestination, ExtractBoundPaths, ExtractOpenAllowlist, ExtractQueue,
    EXTRACT_ONLY_LAUNCH, MAC_FALLBACK_MAIN_PENDING,
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
#[tauri::command(async)]
pub fn inspect_extract_destination(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
) -> Result<crate::path_safety::ExtractDestinationStatus, String> {
    if path.is_empty() {
        return Err("Choose a destination folder.".to_string());
    }
    if path.len() > 8192 || path.contains('\0') {
        return Err("A destination path is invalid or exceeds its byte limit.".to_string());
    }
    let requested = std::path::PathBuf::from(&path);
    if super::is_extract_window_label(window.label()) {
        super::open_path::assert_extract_bound_destination(&app, window.label(), &requested)?;
    }
    crate::path_safety::classify_extract_destination(&requested)
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
pub(crate) fn extract_session_init_script(
    archive: &str,
    destination: &str,
    destination_exists: bool,
) -> String {
    let payload = serde_json::json!({
        "archive": archive,
        "destination": destination,
        "destinationExists": destination_exists,
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
    // Background E2E runs stay Accessory so no window puts the app in the Dock or activates it.
    #[cfg(feature = "e2e")]
    let policy = if super::e2e_background() {
        tauri::ActivationPolicy::Accessory
    } else {
        policy
    };
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
    // An explicit user request keeps the main window. It must not stay a
    // disposable macOS fallback that a later Extract destroys.
    MAC_FALLBACK_MAIN_PENDING.store(false, Ordering::SeqCst);
    leave_extract_warm(app);
    if let Err(error) = show_main_window(app) {
        eprintln!("Failed to open main window: {error}");
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

pub(crate) fn warm_idle_timer_still_owns(generation: u64) -> bool {
    EXTRACT_WARM_IDLE_GENERATION.load(Ordering::SeqCst) == generation
}

fn clear_extract_warm_idle_ui(app: &tauri::AppHandle) {
    EXTRACT_WARM_IDLE_ACTIVE.store(false, Ordering::SeqCst);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app.remove_tray_by_id(EXTRACT_WARM_TRAY_ID);
    }
    restore_foreground_activation(app);
}

/// Drop the resident extract-only tray and cancel the idle exit timer.
pub fn leave_extract_warm(app: &tauri::AppHandle) {
    clear_extract_warm_idle_ui(app);
    bump_extract_warm_idle_generation();
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
            if !warm_idle_timer_still_owns(generation) {
                return;
            }
            if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) || has_extract_windows(&exit_handle) {
                return;
            }
            // Do not bump here. leave_extract_warm() would invalidate this
            // timer's own generation and skip exit(0), leaving a windowless process.
            clear_extract_warm_idle_ui(&exit_handle);
            if !warm_idle_timer_still_owns(generation) {
                return;
            }
            if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) || has_extract_windows(&exit_handle) {
                return;
            }
            // A Finder open, Services request, or Finder Sync drain may have
            // bumped the generation during teardown. Those entry points run on
            // the main thread, so this final check catches them before exit.
            if !warm_idle_timer_still_owns(generation) {
                return;
            }
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

    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, config)
        .map_err(|e| e.to_string())?
        .initialization_script(super::webview_context_menu::NATIVE_CONTEXT_MENU_GUARD_SCRIPT);
    #[cfg(target_os = "linux")]
    {
        builder = builder.transparent(false);
    }
    super::apply_e2e_webview_overrides(builder)
        .build()
        .map_err(|e| e.to_string())
}

pub fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    restore_foreground_activation(app);
    let window = ensure_main_window(app)?;
    #[cfg(target_os = "linux")]
    {
        window
            .set_background_color(Some(tauri::window::Color(0x20, 0x20, 0x24, 0xff)))
            .map_err(|e| e.to_string())?;
    }
    if super::e2e_session_active() {
        let _ = window.set_background_color(Some(tauri::window::Color(0xf5, 0xf5, 0xf5, 0xff)));
    }

    #[cfg(not(target_os = "macos"))]
    window.set_decorations(false).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    window.set_title("").map_err(|e| e.to_string())?;

    window.show().map_err(|e| e.to_string())?;
    if !super::window_may_take_focus() {
        return Ok(());
    }
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_main_window_ready(app: tauri::AppHandle) {
    MAC_FALLBACK_MAIN_PENDING.store(false, Ordering::SeqCst);
    super::MAIN_WINDOW_READY.store(true, Ordering::SeqCst);
    super::open_routing::emit_pending_shell_handoff_error(&app);
    crate::app_menu::flush_pending_menu_actions(&app);
    #[cfg(feature = "e2e")]
    start_e2e_extract_trigger(&app);
}

const CHOOSE_BUSY_MESSAGE: &str =
    "Wait for this extraction to finish before choosing another folder.";

pub(crate) fn assert_extract_window_label(label: &str) -> Result<(), String> {
    if super::is_extract_window_label(label) {
        Ok(())
    } else {
        Err("Only quick-extract windows can choose a destination folder.".to_string())
    }
}

pub(crate) fn extract_owner_busy(
    owner: Option<&str>,
    label: &str,
    child: bool,
    preparing: bool,
    cancelling: bool,
) -> bool {
    owner == Some(label) && (child || preparing || cancelling)
}

fn ensure_window_slot_idle(process: &ProcessState, label: &str) -> Result<(), String> {
    if extract_owner_busy(
        process.owner_label.as_deref(),
        label,
        process.child.is_some(),
        process.preparing,
        process.cancelling,
    ) {
        Err(CHOOSE_BUSY_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn pick_extract_folder(app: &tauri::AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    #[cfg(feature = "e2e")]
    {
        if super::e2e_session_active() {
            return Ok(take_e2e_picked_folder());
        }
    }
    let dialog_app = app.clone();
    let chosen = tokio::task::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("Choose a folder for the extracted files")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("Folder dialog failed: {error}"))?;
    match chosen {
        Some(path) => path
            .into_path()
            .map(Some)
            .map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn pick_extract_folder(
    _app: &tauri::AppHandle,
) -> Result<Option<std::path::PathBuf>, String> {
    Err("Choosing another folder is not supported on this platform.".to_string())
}

#[tauri::command]
pub async fn choose_extract_destination(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    let label = window.label().to_string();
    assert_extract_window_label(&label)?;
    {
        let slot = app.state::<RunningProcess>();
        let process = slot
            .0
            .lock()
            .map_err(|_| "Process lock poisoned".to_string())?;
        ensure_window_slot_idle(&process, &label)?;
    }
    {
        let bindings = app.state::<ExtractBoundDestination>();
        let guard = bindings
            .0
            .lock()
            .map_err(|_| "Extract destination lock poisoned.".to_string())?;
        if !guard.contains_key(&label) {
            return Err("Extract window has no bound destination.".to_string());
        }
    }
    let picked = pick_extract_folder(&app).await?;
    let slot = app.state::<RunningProcess>();
    let process = slot
        .0
        .lock()
        .map_err(|_| "Process lock poisoned".to_string())?;
    ensure_window_slot_idle(&process, &label)?;
    let bindings = app.state::<ExtractBoundDestination>();
    let mut guard = bindings
        .0
        .lock()
        .map_err(|_| "Extract destination lock poisoned.".to_string())?;
    let chosen = apply_picked_folder(&mut guard, &label, picked)?;
    Ok(chosen.map(|path| path.to_string_lossy().into_owned()))
}

#[cfg(feature = "e2e")]
static E2E_EXTRACT_TRIGGER_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "e2e")]
#[derive(serde::Deserialize)]
struct E2eOpenExtractRequest {
    paths: Vec<String>,
}

#[cfg(feature = "e2e")]
fn e2e_work_file(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("ZINNIA_E2E_WORK").map(|dir| std::path::PathBuf::from(dir).join(name))
}

#[cfg(feature = "e2e")]
fn take_e2e_file(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let _ = std::fs::remove_file(path);
    Some(text)
}

#[cfg(feature = "e2e")]
fn take_e2e_picked_folder() -> Option<std::path::PathBuf> {
    let text = take_e2e_file(&e2e_work_file("e2e-extract-pick.txt")?)?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| std::path::PathBuf::from(trimmed))
}

#[cfg(feature = "e2e")]
fn start_e2e_extract_trigger(app: &tauri::AppHandle) {
    if !super::e2e_session_active() {
        return;
    }
    let Some(request_file) = e2e_work_file("e2e-open-extract.json") else {
        return;
    };
    if E2E_EXTRACT_TRIGGER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let Some(text) = take_e2e_file(&request_file) else {
            continue;
        };
        let Ok(request) = serde_json::from_str::<E2eOpenExtractRequest>(&text) else {
            continue;
        };
        let target = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Err(error) = spawn_extract_window(&target, request.paths) {
                eprintln!("E2E quick-extract trigger failed: {error}");
            }
        });
    });
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
                process.child.as_ref().map(std::sync::Arc::clone)
            } else {
                None
            }
        } else {
            None
        }
    };
    if let Some(child) = child {
        terminate_registered_child_async(app, &child)
            .await
            .map_err(|error| {
                format!("Could not stop the archive operation before closing this window: {error}")
            })?;
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
    // This is only a UX warning snapshot. Transactional extraction still uses
    // no-replace publication and re-checks every final path during commit.
    let destination_exists = match std::fs::symlink_metadata(&destination) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    };

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
        map.insert(
            label.clone(),
            ExtractBoundPaths {
                destination: destination.clone(),
                archive: std::path::PathBuf::from(&archive),
            },
        );
    }

    // Inject archive + destination before the page script runs so the UI can paint
    // and start extract without waiting on get_extract_paths.
    let init_script = extract_session_init_script(
        &archive,
        destination.to_string_lossy().as_ref(),
        destination_exists,
    );

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
    // macOS 14+ suspends timers in occluded webviews, which would hold the
    // auto-close countdown until the window is visible again. Windows/Linux
    // ignore this and only throttle; the countdown is deadline-based.
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .initialization_script(init_script)
    .initialization_script(super::webview_context_menu::NATIVE_CONTEXT_MENU_GUARD_SCRIPT);

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

    let result = super::apply_e2e_webview_overrides(builder)
        .build()
        .map_err(|e| e.to_string());

    if result.is_err() {
        clear_extract_window_bindings(app, &label);
    } else {
        // Live extract window: drop tray / ACTIVE while keeping EXTRACT_ONLY_LAUNCH
        // for the caller; warm re-enters when the last extract window closes.
        leave_extract_warm(app);
    }

    result.map(|_| ())
}

#[cfg(test)]
mod choose_destination_tests {
    use super::{assert_extract_window_label, extract_owner_busy};

    #[test]
    fn only_extract_window_labels_may_choose_a_destination() {
        assert!(assert_extract_window_label("extract-0").is_ok());
        assert!(assert_extract_window_label("extract-42").is_ok());
        for label in ["main", "settings", "debug-console", "extract", ""] {
            assert!(assert_extract_window_label(label).is_err(), "{label}");
        }
    }

    #[test]
    fn busy_slot_owned_by_this_window_blocks_a_choice() {
        assert!(extract_owner_busy(
            Some("extract-0"),
            "extract-0",
            true,
            false,
            false
        ));
        assert!(extract_owner_busy(
            Some("extract-0"),
            "extract-0",
            false,
            true,
            false
        ));
        assert!(extract_owner_busy(
            Some("extract-0"),
            "extract-0",
            false,
            false,
            true
        ));
    }

    #[test]
    fn idle_slot_or_another_owner_does_not_block_a_choice() {
        assert!(!extract_owner_busy(
            Some("extract-0"),
            "extract-0",
            false,
            false,
            false
        ));
        assert!(!extract_owner_busy(None, "extract-0", true, true, true));
        assert!(!extract_owner_busy(
            Some("main"),
            "extract-0",
            true,
            true,
            true
        ));
    }
}
