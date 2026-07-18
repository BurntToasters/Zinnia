//! Launch routing: CLI/file-association args, extract windows, pending-path queues.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, Url};

use crate::process::RunningProcess;

static EXTRACT_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);
pub static EXTRACT_ONLY_LAUNCH: AtomicBool = AtomicBool::new(false);
pub static MAC_FALLBACK_MAIN_PENDING: AtomicBool = AtomicBool::new(false);
pub static FILE_OPEN_SIGNAL: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

/// Bumped whenever extract-only warm-idle should be cancelled (new window, quit, leave warm).
static EXTRACT_WARM_IDLE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// True while extract-only warm-idle is engaged (dedupes ExitRequested + Destroyed).
static EXTRACT_WARM_IDLE_ACTIVE: AtomicBool = AtomicBool::new(false);
const EXTRACT_WARM_TRAY_ID: &str = "extract-warm";

const MAX_OPENABLE_DIRECTORIES: usize = 64;

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

/// Remember a destination folder after a successful compress/extract so the main
/// window can open it later. Failures are ignored (open will simply refuse).
pub fn remember_openable_directory(app: &tauri::AppHandle, path: &std::path::Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
        return;
    }
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    let Some(state) = app.try_state::<OpenPathAllowlist>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    guard.retain(|existing| existing != &canonical);
    guard.push_back(canonical);
    while guard.len() > MAX_OPENABLE_DIRECTORIES {
        guard.pop_front();
    }
}

#[derive(serde::Serialize, Clone)]
pub struct OpenPathsPayload {
    paths: Vec<String>,
    mode: String,
}

#[cfg(windows)]
fn normalize_shell_open_path(path: std::path::PathBuf) -> std::path::PathBuf {
    use std::path::PathBuf;

    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(windows))]
fn normalize_shell_open_path(path: std::path::PathBuf) -> std::path::PathBuf {
    path
}

fn normalize_destination_path(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            crate::path_safety::reject_link_or_reparse(path, &meta)?;
            path.canonicalize().map_err(|e| e.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| format!("Could not resolve destination parent: {e}"))?;
            let name = path
                .file_name()
                .ok_or_else(|| "Destination path must have a directory name.".to_string())?;
            Ok(canonical_parent.join(name))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Keep aligned with `src/extract-path.ts` deriveExtractDestinationPath + parent fallback.
pub fn derive_extract_destination_path(archive_path: &str) -> Option<std::path::PathBuf> {
    let trimmed = archive_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(derived) = derive_extract_folder_destination(trimmed) {
        return Some(derived);
    }
    parent_dir_path(trimmed)
}

fn parent_dir_path(path: &str) -> Option<std::path::PathBuf> {
    let parts = split_path_parts(path);
    if parts.name.is_empty() {
        return None;
    }
    if parts.parent.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(parts.parent))
}

fn derive_extract_folder_destination(archive_path: &str) -> Option<std::path::PathBuf> {
    let parts = split_path_parts(archive_path);
    if parts.name.is_empty() {
        return None;
    }
    let folder = derive_extract_folder_name(&parts.name)?;
    Some(std::path::PathBuf::from(join_path(
        &parts.parent,
        &folder,
        parts.separator,
    )))
}

struct PathParts {
    parent: String,
    name: String,
    separator: char,
}

fn looks_like_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || path.starts_with("\\\\")
}

fn split_path_parts(raw_path: &str) -> PathParts {
    let archive_path = raw_path.trim();
    if archive_path.is_empty() {
        return PathParts {
            parent: String::new(),
            name: String::new(),
            separator: '/',
        };
    }
    let windows_like = looks_like_windows_path(archive_path);
    let slash = archive_path.rfind('/');
    let backslash = if windows_like {
        archive_path.rfind('\\')
    } else {
        None
    };
    let split_index = match (slash, backslash) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    let separator = match split_index {
        None if windows_like => '\\',
        None => '/',
        Some(idx) => {
            if backslash == Some(idx) {
                '\\'
            } else {
                '/'
            }
        }
    };
    let Some(idx) = split_index else {
        return PathParts {
            parent: String::new(),
            name: archive_path.to_string(),
            separator,
        };
    };
    let mut parent = archive_path[..idx].to_string();
    let name = archive_path[idx + 1..].to_string();
    if parent.is_empty() && separator == '/' {
        parent = "/".to_string();
    } else if parent.len() == 2
        && parent.as_bytes()[0].is_ascii_alphabetic()
        && parent.as_bytes()[1] == b':'
    {
        parent = format!("{parent}{separator}");
    }
    PathParts {
        parent,
        name,
        separator,
    }
}

fn join_path(parent: &str, name: &str, separator: char) -> String {
    if parent.is_empty() {
        return name.to_string();
    }
    if parent.ends_with('/') || parent.ends_with('\\') {
        return format!("{parent}{name}");
    }
    format!("{parent}{separator}{name}")
}

fn derive_extract_folder_name(archive_name: &str) -> Option<String> {
    const SUFFIXES: &[&str] = &[
        ".tar.gz", ".tar.bz2", ".tar.xz", ".tbz2", ".tgz", ".txz", ".7z", ".zip", ".rar", ".tar",
        ".gz", ".bz2", ".xz",
    ];
    let cleaned = archive_name.trim();
    if cleaned.is_empty() {
        return None;
    }
    let lower = cleaned.to_ascii_lowercase();
    for suffix in SUFFIXES {
        if lower.ends_with(suffix) && cleaned.len() > suffix.len() {
            return Some(cleaned[..cleaned.len() - suffix.len()].to_string());
        }
    }
    Some(format!("{cleaned}_extracted"))
}

/// Ensure an extract window's `-o` / open path matches the destination bound at spawn.
pub fn assert_extract_bound_destination(
    app: &tauri::AppHandle,
    label: &str,
    requested: &std::path::Path,
) -> Result<(), String> {
    let state = app
        .try_state::<ExtractBoundDestination>()
        .ok_or_else(|| "Extract destination binding is unavailable.".to_string())?;
    let guard = state
        .0
        .lock()
        .map_err(|_| "Extract destination lock poisoned.".to_string())?;
    let Some(bound) = guard.get(label) else {
        return Err("Extract window has no bound destination.".to_string());
    };
    let bound_norm = normalize_destination_path(bound)?;
    let requested_norm = normalize_destination_path(requested)?;
    if bound_norm != requested_norm {
        return Err(
            "Quick-extract windows may only write to their bound destination folder.".to_string(),
        );
    }
    Ok(())
}

fn clear_extract_window_bindings(app: &tauri::AppHandle, label: &str) {
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
pub fn register_extract_open_path(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
    state: tauri::State<'_, ExtractOpenAllowlist>,
) -> Result<(), String> {
    if !is_extract_window_label(window.label()) {
        return Err("Only extract windows can register an open destination.".to_string());
    }
    let Some(raw_path) = normalize_open_path_arg(&path) else {
        return Err("Path is required.".to_string());
    };
    if raw_path.contains('\0') {
        return Err("Path contains invalid characters.".to_string());
    }
    let resolved = std::path::PathBuf::from(&raw_path);
    assert_extract_bound_destination(&app, window.label(), &resolved)?;
    let meta =
        std::fs::symlink_metadata(&resolved).map_err(|_| "Path does not exist.".to_string())?;
    crate::path_safety::reject_link_or_reparse(&resolved, &meta)
        .map_err(|_| "Symbolic links and reparse points cannot be opened directly.".to_string())?;
    if !meta.is_dir() {
        return Err("Only directories can be opened.".to_string());
    }
    let canonical = resolved
        .canonicalize()
        .map_err(|_| "Path does not exist.".to_string())?;
    let mut allowlist = state
        .0
        .lock()
        .map_err(|_| "Extract open allowlist lock poisoned.".to_string())?;
    allowlist.insert(window.label().to_string(), canonical);
    Ok(())
}

#[tauri::command]
#[allow(deprecated)]
pub fn open_path(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
    extract_allowlist: tauri::State<'_, ExtractOpenAllowlist>,
    main_allowlist: tauri::State<'_, OpenPathAllowlist>,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let Some(raw_path) = normalize_open_path_arg(&path) else {
        return Err("Path is required.".to_string());
    };

    if raw_path.contains('\0') {
        return Err("Path contains invalid characters.".to_string());
    }

    let resolved = std::path::PathBuf::from(&raw_path);

    let meta =
        std::fs::symlink_metadata(&resolved).map_err(|_| "Path does not exist.".to_string())?;
    crate::path_safety::reject_link_or_reparse(&resolved, &meta)
        .map_err(|_| "Symbolic links and reparse points cannot be opened directly.".to_string())?;
    if !meta.is_dir() {
        return Err("Only directories can be opened.".to_string());
    }

    let canonical = resolved
        .canonicalize()
        .map_err(|_| "Path does not exist.".to_string())?;

    if is_extract_window_label(window.label()) {
        let allowed = extract_allowlist
            .0
            .lock()
            .map_err(|_| "Extract open allowlist lock poisoned.".to_string())?;
        let Some(expected) = allowed.get(window.label()) else {
            return Err(
                "Extract window must register its destination before opening it.".to_string(),
            );
        };
        if expected != &canonical {
            return Err("Extract windows may only open their registered destination.".to_string());
        }
    } else {
        let allowed = main_allowlist
            .0
            .lock()
            .map_err(|_| "Open-path allowlist lock poisoned.".to_string())?;
        if !allowed.iter().any(|entry| entry == &canonical) {
            return Err(
                "Only folders from a recent successful Zinnia compress/extract can be opened."
                    .to_string(),
            );
        }
    }

    let normalized = normalize_shell_open_path(canonical);
    let path_str = normalized.to_string_lossy().to_string();
    app.shell().open(&path_str, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_initial_paths(state: tauri::State<'_, InitialPaths>) -> Result<Vec<String>, String> {
    let mut paths = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(std::mem::take(&mut *paths))
}

#[tauri::command]
pub fn get_initial_mode(state: tauri::State<'_, InitialMode>) -> Result<String, String> {
    let mode = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(mode.clone())
}

#[tauri::command]
pub fn drain_pending_paths(
    state: tauri::State<'_, PendingPaths>,
) -> Result<Vec<OpenPathsPayload>, String> {
    let mut q = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(std::mem::take(&mut *q))
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

fn is_extract_window_label(label: &str) -> bool {
    label.starts_with("extract-")
}

pub fn has_extract_windows(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| is_extract_window_label(label))
}

pub fn first_extract_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            if is_extract_window_label(&label) {
                Some(window)
            } else {
                None
            }
        })
}

fn bump_extract_warm_idle_generation() {
    EXTRACT_WARM_IDLE_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Embed archive/destination for the extract window. Escapes U+2028/U+2029 because
/// serde_json leaves them unescaped and they break JavaScript string literals.
fn extract_session_init_script(archive: &str, destination: &str) -> String {
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn ensure_extract_warm_tray(app: &tauri::AppHandle) -> bool {
    if app.tray_by_id(EXTRACT_WARM_TRAY_ID).is_some() {
        return true;
    }
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let Ok(quit) = MenuItem::with_id(app, "quit", "Quit Zinnia", true, None::<&str>) else {
        eprintln!("Failed to create extract warm-tray quit item");
        return false;
    };
    let Ok(menu) = Menu::with_items(app, &[&quit]) else {
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
        .tooltip("Zinnia")
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                leave_extract_warm(app);
                EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
                app.exit(0);
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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
    }
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
        // macOS can stay warm via the Dock even if tray creation fails.
        // Windows/Linux need a tray affordance or the process becomes invisible.
        let tray_ok = ensure_extract_warm_tray(app);
        if !tray_ok && !cfg!(target_os = "macos") {
            return false;
        }
    }

    // Refresh the idle timer when ExitRequested and Destroyed both fire.
    EXTRACT_WARM_IDLE_ACTIVE.store(true, Ordering::SeqCst);
    let generation = EXTRACT_WARM_IDLE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let idle_secs = prefs.idle_secs.max(60);

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(idle_secs));
        if EXTRACT_WARM_IDLE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) || has_extract_windows(&handle) {
            return;
        }
        let exit_handle = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            leave_extract_warm(&exit_handle);
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            exit_handle.exit(0);
        });
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
            return Err(format!(
                "Could not stop the archive operation before closing this window: {e}"
            ));
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
    let init_script =
        extract_session_init_script(&archive, destination.to_string_lossy().as_ref());

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("extract.html".into()),
    )
    .title("Zinnia \u{2014} Extracting")
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
        // A live extract window cancels warm-idle auto-quit.
        bump_extract_warm_idle_generation();
    }

    result.map(|_| ())
}

fn should_use_extract_window(paths: &[String], mode: &str) -> bool {
    if mode == "compress" {
        return false;
    }
    if mode == "extract-explicit" && paths.len() == 1 {
        return true;
    }
    if paths.len() != 1 {
        return false;
    }

    looks_like_archive_path(&paths[0])
}

fn looks_like_archive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    // Windows: omit .rar so file-open routing does not land on the temporary
    // RAR extract block (CVE-2026-58052). macOS/Linux still treat RAR as archives.
    let extensions: &[&str] = if cfg!(windows) {
        &[
            ".7z", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz",
        ]
    } else {
        &[
            ".7z", ".zip", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz",
        ]
    };
    extensions
        .iter()
        .any(|extension| lower.ends_with(extension))
        || lower.rsplit_once('.').is_some_and(|(_, suffix)| {
            suffix.len() == 3 && suffix.bytes().all(|b| b.is_ascii_digit())
        })
}

fn normalize_open_path_arg(arg: &str) -> Option<String> {
    let trimmed = arg.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed == "--" {
        return None;
    }
    if trimmed.contains('\0') {
        return None;
    }

    if trimmed.to_ascii_lowercase().starts_with("file://") {
        if let Ok(url) = Url::parse(trimmed) {
            if let Ok(path) = url.to_file_path() {
                return Some(path.to_string_lossy().to_string());
            }
            return None;
        }
    }

    Some(trimmed.to_string())
}

fn parse_open_request_args<I>(args: I) -> (Vec<String>, String)
where
    I: IntoIterator<Item = String>,
{
    let mut paths = Vec::new();
    let mut mode = String::new();

    for arg in args {
        if arg == "--extract" {
            mode = "extract-explicit".to_string();
            continue;
        }

        if arg == "--compress" {
            mode = "compress".to_string();
            continue;
        }

        let Some(path) = normalize_open_path_arg(&arg) else {
            continue;
        };

        if path.starts_with('-') && !std::path::Path::new(&path).exists() {
            continue;
        }

        paths.push(path);
    }

    if mode == "compress" {
        return (paths, mode);
    }

    if mode != "extract"
        && !paths.is_empty()
        && paths.iter().all(|path| looks_like_archive_path(path))
    {
        mode = "extract".to_string();
    }

    if should_use_extract_window(&paths, &mode) || mode == "extract-explicit" {
        mode = "extract".to_string();
    }

    (paths, mode)
}

fn route_open_request(app: &tauri::AppHandle, paths: Vec<String>, mode: String) {
    if paths.is_empty() {
        return;
    }

    if should_use_extract_window(&paths, &mode) {
        // The backend intentionally owns one 7z job at a time. Route additional
        // open requests into the main window's existing pending FIFO instead of
        // creating a second quick window that can only fail as busy.
        if has_extract_windows(app) {
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            leave_extract_warm(app);
            let pending = app.state::<PendingPaths>();
            if let Ok(mut queue) = pending.0.lock() {
                let total_paths: usize = queue.iter().map(|item| item.paths.len()).sum();
                if queue.len() < 100 && total_paths + paths.len() <= 1000 {
                    queue.push(OpenPathsPayload {
                        paths,
                        mode: "extract".to_string(),
                    });
                } else {
                    eprintln!("Pending extract queue full, dropping open request");
                    let _ = app.emit(
                        "open-paths-dropped",
                        "Zinnia is busy and the pending extract queue is full. Try again shortly.",
                    );
                }
            }
            let _ = app.emit("pending-paths-changed", ());
            if let Err(e) = show_main_window(app) {
                eprintln!("Failed to show queued extraction in main window: {e}");
            }
            return;
        }
        let fallback_main = MAC_FALLBACK_MAIN_PENDING.swap(false, Ordering::SeqCst);
        let had_main_window = app.get_webview_window("main").is_some() && !fallback_main;
        if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        if let Err(e) = spawn_extract_window(app, paths) {
            eprintln!("Failed to open extract window: {e}");
            if let Err(main_error) = show_main_window(app) {
                eprintln!("Failed to open main window: {main_error}");
            }
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            leave_extract_warm(app);
        } else if had_main_window {
            // Warm opens must not discard the user's active main workspace.
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            leave_extract_warm(app);
        } else {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.destroy();
            }
            EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
        }
        return;
    }

    EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
    leave_extract_warm(app);

    if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
        guard.take();
    }

    let pending = app.state::<PendingPaths>();
    match pending.0.lock() {
        Ok(mut q) => {
            let total_paths: usize = q.iter().map(|p| p.paths.len()).sum();
            if q.len() < 100 && total_paths + paths.len() <= 1000 {
                q.push(OpenPathsPayload { paths, mode });
            } else {
                eprintln!("Pending paths queue full, dropping open request");
                let _ = app.emit(
                    "open-paths-dropped",
                    "Zinnia could not accept more open requests. Finish the current job and try again.",
                );
            }
        }
        Err(e) => eprintln!("Failed to acquire pending paths lock: {e}"),
    }

    if let Err(e) = app.emit("pending-paths-changed", ()) {
        eprintln!("Failed to emit pending-paths-changed: {e}");
    }

    if let Err(e) = show_main_window(app) {
        eprintln!("Failed to open main window: {e}");
    }
}

pub fn emit_open_urls(app: &tauri::AppHandle, urls: Vec<Url>) {
    let paths: Vec<String> = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect();

    route_open_request(app, paths, String::new());
}

pub fn emit_open_paths(app: &tauri::AppHandle, argv: Vec<String>) {
    let (paths, mode) = parse_open_request_args(argv.into_iter().skip(1));
    route_open_request(app, paths, mode);
}

pub fn collect_cli_context() -> (Vec<String>, String) {
    parse_open_request_args(std::env::args().skip(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn extract_session_init_script_escapes_js_line_separators() {
        let script = extract_session_init_script("foo\u{2028}bar.zip", "a\u{2029}b");
        assert!(
            script.contains("\\u2028"),
            "U+2028 must be escaped for JS embedding: {script}"
        );
        assert!(
            script.contains("\\u2029"),
            "U+2029 must be escaped for JS embedding: {script}"
        );
        assert!(
            !script.contains('\u{2028}') && !script.contains('\u{2029}'),
            "raw line separators must not appear in init script"
        );
        assert!(script.contains("__ZINNIA_EXTRACT__"));
    }

    #[test]
    fn derive_extract_destination_matches_frontend_rules() {
        assert_eq!(
            derive_extract_destination_path("/downloads/example.zip"),
            Some(std::path::PathBuf::from("/downloads/example"))
        );
        assert_eq!(
            derive_extract_destination_path("/downloads/example.tar.gz"),
            Some(std::path::PathBuf::from("/downloads/example"))
        );
        assert_eq!(
            derive_extract_destination_path(r"C:\downloads\example.7z"),
            Some(std::path::PathBuf::from(r"C:\downloads\example"))
        );
        assert_eq!(
            derive_extract_destination_path("/downloads/example.custom"),
            Some(std::path::PathBuf::from("/downloads/example.custom_extracted"))
        );
        assert_eq!(
            derive_extract_destination_path("/example.zip"),
            Some(std::path::PathBuf::from("/example"))
        );
        assert_eq!(
            derive_extract_destination_path(r"C:\example.zip"),
            Some(std::path::PathBuf::from(r"C:\example"))
        );
        assert_eq!(derive_extract_destination_path("   "), None);
    }

    #[test]
    fn normalize_destination_path_joins_missing_leaf_under_canonical_parent() {
        let base = temp_base("normalize-dest");
        let missing = base.join("fresh-output");
        let normalized = normalize_destination_path(&missing).expect("normalize");
        assert_eq!(
            normalized,
            base.canonicalize().expect("base").join("fresh-output")
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn should_use_extract_window_honors_explicit_extract_mode() {
        let paths = vec!["/tmp/not-an-archive.txt".to_string()];
        assert!(should_use_extract_window(&paths, "extract-explicit"));
    }

    #[test]
    fn should_use_extract_window_accepts_single_archive_path() {
        let base = temp_base("extract-mode");
        let file_path = base.join("archive.zip");
        write_zip(&file_path);

        let path = file_path.to_string_lossy().to_string();
        assert!(should_use_extract_window(&[path], ""));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn should_use_extract_window_rejects_non_archive_path() {
        let base = temp_base("extract-mode");
        let file_path = base.join("plain.txt");
        std::fs::write(&file_path, b"this is plain text").expect("probe file should be written");

        let path = file_path.to_string_lossy().to_string();
        assert!(!should_use_extract_window(&[path], ""));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn should_use_extract_window_rejects_multiple_paths_without_explicit_mode() {
        let base = temp_base("extract-mode");
        let one = base.join("one.zip");
        let two = base.join("two.zip");
        write_zip(&one);
        write_zip(&two);

        let paths = vec![
            one.to_string_lossy().to_string(),
            two.to_string_lossy().to_string(),
        ];
        assert!(!should_use_extract_window(&paths, ""));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parse_open_request_args_handles_file_urls() {
        let base = temp_base("open-args");
        let file_path = base.join("archive.zip");
        write_zip(&file_path);

        let file_url = Url::from_file_path(&file_path)
            .expect("file URL should be generated")
            .to_string();
        let (paths, mode) = parse_open_request_args(vec![file_url]);

        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], file_path.to_string_lossy().to_string());
        assert_eq!(mode, "extract");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parse_open_request_args_ignores_macos_process_serial_number_flag() {
        let base = temp_base("open-args");
        let file_path = base.join("archive.zip");
        write_zip(&file_path);

        let (paths, mode) = parse_open_request_args(vec![
            "-psn_0_12345".to_string(),
            file_path.to_string_lossy().to_string(),
        ]);

        assert_eq!(paths, vec![file_path.to_string_lossy().to_string()]);
        assert_eq!(mode, "extract");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parse_open_request_args_keeps_file_paths_with_dotdot_in_name() {
        let base = temp_base("open-args");
        let file_path = base.join("name..bak.zip");
        write_zip(&file_path);

        let file_url = Url::from_file_path(&file_path)
            .expect("file URL should be generated")
            .to_string();
        let (paths, mode) = parse_open_request_args(vec![file_url]);

        assert_eq!(paths, vec![file_path.to_string_lossy().to_string()]);
        assert_eq!(mode, "extract");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parse_open_request_args_sets_extract_mode_for_multiple_archives() {
        let base = temp_base("open-args");
        let one = base.join("one.zip");
        let two = base.join("two.zip");
        write_zip(&one);
        write_zip(&two);

        let (paths, mode) = parse_open_request_args(vec![
            one.to_string_lossy().to_string(),
            two.to_string_lossy().to_string(),
        ]);

        assert_eq!(
            paths,
            vec![
                one.to_string_lossy().to_string(),
                two.to_string_lossy().to_string()
            ]
        );
        assert_eq!(mode, "extract");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parse_open_request_args_keeps_compress_mode_for_archive_input() {
        let base = temp_base("compress-args");
        let archive = base.join("input.zip");
        write_zip(&archive);

        let (paths, mode) = parse_open_request_args(vec![
            "--compress".to_string(),
            archive.to_string_lossy().to_string(),
        ]);

        assert_eq!(paths, vec![archive.to_string_lossy().to_string()]);
        assert_eq!(mode, "compress");
        assert!(!should_use_extract_window(&paths, &mode));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parse_open_request_args_keeps_compress_mode_for_folder_input() {
        let base = temp_base("compress-folder");

        let (paths, mode) = parse_open_request_args(vec![
            "--compress".to_string(),
            base.to_string_lossy().to_string(),
        ]);

        assert_eq!(paths, vec![base.to_string_lossy().to_string()]);
        assert_eq!(mode, "compress");
        assert!(!should_use_extract_window(&paths, &mode));

        let _ = std::fs::remove_dir_all(base);
    }

    fn temp_base(tag: &str) -> std::path::PathBuf {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "zinnia-{tag}-{}-{}-{sequence}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        base
    }

    fn write_zip(path: &std::path::Path) {
        std::fs::write(path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("probe file should be written");
    }
}
