//! Launch routing: CLI/file-association args, extract windows, pending-path queues.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, Url};

use crate::archive_detect::validate_archive_path;

static EXTRACT_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);
pub static EXTRACT_ONLY_LAUNCH: AtomicBool = AtomicBool::new(false);
pub static FILE_OPEN_SIGNAL: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

pub struct InitialPaths(pub Mutex<Vec<String>>);
pub struct InitialMode(pub Mutex<String>);
pub struct ExtractQueue(pub Mutex<HashMap<String, Vec<String>>>);
pub struct PendingPaths(pub Mutex<Vec<OpenPathsPayload>>);

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

#[tauri::command]
#[allow(deprecated)]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
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
    if meta.is_symlink() {
        return Err("Symbolic links cannot be opened directly.".to_string());
    }
    if !meta.is_dir() {
        return Err("Only directories can be opened.".to_string());
    }

    let canonical = resolved
        .canonicalize()
        .map_err(|_| "Path does not exist.".to_string())?;
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

#[tauri::command]
pub fn close_extract_window(window: tauri::Window, app: tauri::AppHandle) -> Result<(), String> {
    if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.destroy();
        }
        return window.destroy().map_err(|e| e.to_string());
    }

    window.destroy().map_err(|e| e.to_string())
}

pub fn spawn_extract_window(app: &tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.len() > 100 {
        return Err("Too many paths in a single extract batch.".to_string());
    }

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

    let result = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("extract.html".into()),
    )
    .title("Zinnia \u{2014} Extracting")
    .inner_size(440.0, 320.0)
    .resizable(false)
    .minimizable(true)
    .maximizable(false)
    .build()
    .map_err(|e| e.to_string());

    if result.is_err() {
        let queue = app.state::<ExtractQueue>();
        if let Ok(mut q) = queue.0.lock() {
            q.remove(&label);
        };
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

    validate_archive_path(&paths[0]).valid
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
        && paths.iter().all(|path| validate_archive_path(path).valid)
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
        if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        if let Err(e) = spawn_extract_window(app, paths) {
            eprintln!("Failed to open extract window: {e}");
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
        } else {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.destroy();
            }
            EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
        }
        return;
    }

    EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);

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
            }
        }
        Err(e) => eprintln!("Failed to acquire pending paths lock: {e}"),
    }

    if let Err(e) = app.emit("pending-paths-changed", ()) {
        eprintln!("Failed to emit pending-paths-changed: {e}");
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
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
        let base = std::env::temp_dir().join(format!(
            "zinnia-{tag}-{}",
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
