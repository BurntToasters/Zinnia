//! Rolling local diagnostics log under the app data dir, with size-based trimming.

use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::output::{truncate_for_bytes, MAX_LOG_ENTRY_BYTES};
use crate::settings_store::atomic_write_text;

const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const LOG_FILE_NAME: &str = "zinnia.log";
const LOG_EXPORT_FILE_NAME: &str = "zinnia-logs.txt";

pub struct LogFileLock(pub Mutex<()>);

fn lock_log_file(state: &LogFileLock) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Log file lock poisoned".to_string())
}

fn logs_dir_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("logs"))
}

fn log_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(logs_dir_path(app)?.join(LOG_FILE_NAME))
}

fn ensure_logs_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = logs_dir_path(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn trim_log_file_if_needed(path: &std::path::Path) -> Result<(), String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };

    if meta.len() <= MAX_LOG_FILE_BYTES {
        return Ok(());
    }

    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let contents = String::from_utf8_lossy(&bytes).to_string();
    let keep_size = (MAX_LOG_FILE_BYTES / 2) as usize;
    let mut start = contents.len().saturating_sub(keep_size);
    while start > 0 && !contents.is_char_boundary(start) {
        start -= 1;
    }

    let mut clipped = contents[start..].to_string();
    if let Some(pos) = clipped.find('\n') {
        clipped = clipped[pos + 1..].to_string();
    }
    atomic_write_text(path, &clipped)
}

#[tauri::command]
pub fn append_local_log(
    app: tauri::AppHandle,
    line: String,
    lock: tauri::State<'_, LogFileLock>,
) -> Result<(), String> {
    let _guard = lock_log_file(&lock)?;
    let _ = ensure_logs_dir(&app)?;
    let path = log_file_path(&app)?;
    trim_log_file_if_needed(&path)?;
    let line = line.replace('\r', "").replace('\n', " ");
    let line = truncate_for_bytes(&line, MAX_LOG_ENTRY_BYTES);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    trim_log_file_if_needed(&path)
}

#[tauri::command]
pub fn get_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = ensure_logs_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn export_logs(
    app: tauri::AppHandle,
    lock: tauri::State<'_, LogFileLock>,
) -> Result<bool, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        let _ = lock;
        return Err("Exporting logs is not supported on this platform.".to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let Some(file_path) = app
            .dialog()
            .file()
            .set_title("Export local diagnostics log")
            .set_file_name(LOG_EXPORT_FILE_NAME)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let destination = file_path.into_path().map_err(|e| e.to_string())?;
        if destination.is_dir() {
            return Err("Destination path must be a file, not a directory.".to_string());
        }
        if let Some(parent) = destination.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err("Destination parent directory does not exist.".to_string());
            }
        }

        let _guard = lock_log_file(&lock)?;
        let source = log_file_path(&app)?;
        if source.exists() {
            std::fs::copy(source, &destination).map_err(|e| e.to_string())?;
        } else {
            std::fs::write(&destination, "No local logs have been recorded yet.\n")
                .map_err(|e| e.to_string())?;
        }

        Ok(true)
    }
}

#[tauri::command]
pub fn clear_logs(app: tauri::AppHandle, lock: tauri::State<'_, LogFileLock>) -> Result<(), String> {
    let _guard = lock_log_file(&lock)?;
    let path = log_file_path(&app)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
#[allow(deprecated)]
pub fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let dir = ensure_logs_dir(&app)?;
    let dir_str = dir.to_string_lossy().to_string();
    app.shell().open(&dir_str, None).map_err(|e| e.to_string())
}
