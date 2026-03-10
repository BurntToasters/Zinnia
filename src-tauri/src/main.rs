use std::io::Write;
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandEvent, CommandChild};
use tauri_plugin_shell::ShellExt;

const MAX_OUTPUT_BYTES: usize = 50 * 1024 * 1024;
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;
const LOG_FILE_NAME: &str = "zinnia.log";

#[derive(serde::Serialize)]
struct RunResult {
    stdout: String,
    stderr: String,
    code: i32,
}

struct InitialPaths(Mutex<Vec<String>>);
struct InitialMode(Mutex<String>);
struct RunningProcess(Mutex<Option<CommandChild>>);

fn lock_process(state: &RunningProcess) -> Result<std::sync::MutexGuard<'_, Option<CommandChild>>, String> {
    state.0.lock().map_err(|_| "Process lock poisoned".to_string())
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn validate_json(json: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    Ok(())
}

fn parse_json_object(json: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {e}"))?;
    match parsed {
        serde_json::Value::Object(map) => Ok(map),
        _ => Err("Settings JSON must be an object.".to_string()),
    }
}

fn merge_reserved_settings(
    existing: &serde_json::Map<String, serde_json::Value>,
    incoming: &mut serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in existing {
        if key.starts_with('_') && !incoming.contains_key(key) {
            incoming.insert(key.clone(), value.clone());
        }
    }
}

fn truncate_for_bytes(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }

    let mut boundary = max_bytes;
    while boundary > 0 && !input.is_char_boundary(boundary) {
        boundary -= 1;
    }

    let omitted = input.len().saturating_sub(boundary);
    format!("{} [truncated {} bytes]", &input[..boundary], omitted)
}

fn atomic_write_text(path: &std::path::Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        let _ = std::fs::remove_file(path);
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn logs_dir_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
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
    std::fs::write(path, clipped).map_err(|e| e.to_string())
}

fn ensure_idle<T>(slot: &Option<T>) -> Result<(), String> {
    if slot.is_some() {
        Err("Another archive operation is already running.".to_string())
    } else {
        Ok(())
    }
}

fn is_non_running_kill_error(message: &str) -> bool {
    message.contains("finished") || message.contains("not running")
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    validate_json(&json)?;
    let path = settings_path(&app)?;

    let mut incoming = parse_json_object(&json)?;
    if path.exists() {
        if let Ok(existing_raw) = std::fs::read_to_string(&path) {
            if let Ok(existing) = parse_json_object(&existing_raw) {
                merge_reserved_settings(&existing, &mut incoming);
            }
        }
    }

    let merged = serde_json::Value::Object(incoming);
    let serialized = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
    atomic_write_text(&path, &serialized)
}

#[tauri::command]
fn append_local_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    let _ = ensure_logs_dir(&app)?;
    let path = log_file_path(&app)?;
    trim_log_file_if_needed(&path)?;
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
fn get_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = ensure_logs_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn export_logs(app: tauri::AppHandle, destination_path: String) -> Result<(), String> {
    if destination_path.trim().is_empty() {
        return Err("Destination path is required.".to_string());
    }

    let destination = std::path::PathBuf::from(destination_path);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let source = log_file_path(&app)?;
    if source.exists() {
        std::fs::copy(source, destination).map_err(|e| e.to_string())?;
    } else {
        std::fs::write(destination, "No local logs have been recorded yet.\n")
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn clear_logs(app: tauri::AppHandle) -> Result<(), String> {
    let path = log_file_path(&app)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = ensure_logs_dir(&app)?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Opening log folder is not supported on this platform.".to_string())
}

#[tauri::command]
async fn probe_7z(app: tauri::AppHandle) -> Result<(), String> {
    let command = app
        .shell()
        .sidecar("7z")
        .map_err(|e| e.to_string())?
        .args(["--help"]);

    let (_rx, child) = command.spawn().map_err(|e| e.to_string())?;
    let _ = child.kill();
    Ok(())
}

fn sanitize_output(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || matches!(*c, '\n' | '\r' | '\t'))
        .collect()
}

#[tauri::command]
async fn run_7z(app: tauri::AppHandle, args: Vec<String>, state: tauri::State<'_, RunningProcess>) -> Result<RunResult, String> {
    if args.is_empty() {
        return Err("Missing 7z arguments".to_string());
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = -1;

    let command = app
        .shell()
        .sidecar("7z")
        .map_err(|e| e.to_string())?
        .args(args);

    let mut rx = {
        let mut process = lock_process(&state)?;
        ensure_idle(&*process)?;

        let (rx, child) = command.spawn().map_err(|e| e.to_string())?;
        *process = Some(child);
        rx
    };

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let chunk = String::from_utf8_lossy(&line);
                if stdout.len() + chunk.len() <= MAX_OUTPUT_BYTES {
                    stdout.push_str(&chunk);
                }
            }
            CommandEvent::Stderr(line) => {
                let chunk = String::from_utf8_lossy(&line);
                if stderr.len() + chunk.len() <= MAX_OUTPUT_BYTES {
                    stderr.push_str(&chunk);
                }
            }
            CommandEvent::Terminated(payload) => {
                if let Some(code) = payload.code {
                    exit_code = code;
                }
                break;
            }
            _ => {}
        }
    }

    {
        let mut process = lock_process(&state)?;
        *process = None;
    }

    Ok(RunResult {
        stdout: sanitize_output(&stdout),
        stderr: sanitize_output(&stderr),
        code: exit_code,
    })
}

#[tauri::command]
fn cancel_7z(state: tauri::State<'_, RunningProcess>) -> Result<(), String> {
    let mut process = lock_process(&state)?;
    if let Some(child) = process.take() {
        match child.kill() {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if is_non_running_kill_error(&msg) {
                    Ok(())
                } else {
                    Err(msg)
                }
            }
        }
    } else {
        Ok(())
    }
}

#[cfg(windows)]
const ARCHIVE_EXTENSIONS: &[&str] = &[
    ".7z", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz2",
    ".xz", ".txz", ".rar",
];

#[tauri::command]
fn register_windows_context_menu() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_string();

        if exe_str.contains('"') {
            return Err("Installation path contains invalid characters for registry integration.".to_string());
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (classes, _) = hkcu
            .create_subkey("Software\\Classes")
            .map_err(|e| e.to_string())?;

        let compress_entries = [
            ("*\\shell\\Zinnia", "Compress with Zinnia"),
            ("Directory\\shell\\Zinnia", "Compress folder with Zinnia"),
        ];

        for (key_path, verb) in compress_entries {
            let (key, _) = classes.create_subkey(key_path).map_err(|e| e.to_string())?;
            key.set_value("MUIVerb", &verb).map_err(|e| e.to_string())?;
            key.set_value("Icon", &format!("\"{}\",0", exe_str))
                .map_err(|e| e.to_string())?;
            let (cmd_key, _) = key.create_subkey("command").map_err(|e| e.to_string())?;
            cmd_key
                .set_value("", &format!("\"{}\" \"%1\"", exe_str))
                .map_err(|e| e.to_string())?;
        }

        for ext in ARCHIVE_EXTENSIONS {
            let key_path = format!("SystemFileAssociations\\{}\\shell\\Zinnia.Extract", ext);
            let (key, _) = classes.create_subkey(&key_path).map_err(|e| e.to_string())?;
            key.set_value("MUIVerb", &"Extract with Zinnia")
                .map_err(|e| e.to_string())?;
            key.set_value("Icon", &format!("\"{}\",0", exe_str))
                .map_err(|e| e.to_string())?;
            let (cmd_key, _) = key.create_subkey("command").map_err(|e| e.to_string())?;
            cmd_key
                .set_value("", &format!("\"{}\" --extract \"%1\"", exe_str))
                .map_err(|e| e.to_string())?;
        }

        {
            let (key, _) = classes
                .create_subkey("Zinnia.Archive")
                .map_err(|e| e.to_string())?;
            key.set_value("", &"Archive File")
                .map_err(|e| e.to_string())?;
            key.set_value("FriendlyTypeName", &"Archive File (Zinnia)")
                .map_err(|e| e.to_string())?;
            let (icon_key, _) = key
                .create_subkey("DefaultIcon")
                .map_err(|e| e.to_string())?;
            icon_key
                .set_value("", &format!("\"{}\",0", exe_str))
                .map_err(|e| e.to_string())?;
            let (cmd_key, _) = key
                .create_subkey("shell\\open\\command")
                .map_err(|e| e.to_string())?;
            cmd_key
                .set_value("", &format!("\"{}\" --extract \"%1\"", exe_str))
                .map_err(|e| e.to_string())?;
        }

        for ext in ARCHIVE_EXTENSIONS {
            let key_path = format!("{}\\OpenWithProgids", ext);
            let (key, _) = classes.create_subkey(&key_path).map_err(|e| e.to_string())?;
            key.set_value("Zinnia.Archive", &"")
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("Explorer integration is only available on Windows.".to_string())
    }
}

#[tauri::command]
fn unregister_windows_context_menu() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = hkcu
            .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
            .map_err(|e| e.to_string())?;

        for path in ["*\\shell\\Zinnia", "Directory\\shell\\Zinnia"] {
            match classes.delete_subkey_all(path) {
                Ok(()) => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Failed to remove {}: {}", path, e)),
            }
        }

        for ext in ARCHIVE_EXTENSIONS {
            let key_path = format!("SystemFileAssociations\\{}\\shell\\Zinnia.Extract", ext);
            match classes.delete_subkey_all(&key_path) {
                Ok(()) => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Failed to remove {}: {}", key_path, e)),
            }

            let owp_path = format!("{}\\OpenWithProgids", ext);
            if let Ok(key) = classes.open_subkey_with_flags(&owp_path, KEY_SET_VALUE) {
                let _ = key.delete_value("Zinnia.Archive");
            }
        }

        match classes.delete_subkey_all("Zinnia.Archive") {
            Ok(()) => {}
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to remove Zinnia.Archive: {}", e)),
        }

        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("Explorer integration is only available on Windows.".to_string())
    }
}

#[tauri::command]
fn get_windows_context_menu_status() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = hkcu
            .open_subkey_with_flags("Software\\Classes", KEY_READ)
            .map_err(|e| e.to_string())?;

        for required in [
            "*\\shell\\Zinnia\\command",
            "Directory\\shell\\Zinnia\\command",
            "Zinnia.Archive\\DefaultIcon",
            "Zinnia.Archive\\shell\\open\\command",
        ] {
            if classes.open_subkey(required).is_err() {
                return Ok(false);
            }
        }

        for ext in ARCHIVE_EXTENSIONS {
            let extract_key = format!("SystemFileAssociations\\{}\\shell\\Zinnia.Extract\\command", ext);
            if classes.open_subkey(&extract_key).is_err() {
                return Ok(false);
            }

            let open_with = format!("{}\\OpenWithProgids", ext);
            let open_with_key = match classes.open_subkey(&open_with) {
                Ok(key) => key,
                Err(_) => return Ok(false),
            };

            if open_with_key.get_raw_value("Zinnia.Archive").is_err() {
                return Ok(false);
            }
        }

        Ok(true)
    }

    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn get_initial_paths(state: tauri::State<'_, InitialPaths>) -> Result<Vec<String>, String> {
    let mut paths = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(std::mem::take(&mut *paths))
}

#[tauri::command]
fn get_initial_mode(state: tauri::State<'_, InitialMode>) -> Result<String, String> {
    let mode = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(mode.clone())
}

#[tauri::command]
fn get_platform_info() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn is_flatpak() -> bool {
    std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists()
}

#[tauri::command]
fn is_packaged() -> bool {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return false,
    };

    #[cfg(windows)]
    {
        let lower = exe.to_lowercase();
        if lower.contains("\\target\\debug\\") || lower.contains("\\target\\release\\") {
            return false;
        }
        true
    }

    #[cfg(target_os = "macos")]
    {
        exe.contains(".app/Contents/MacOS/")
    }

    #[cfg(target_os = "linux")]
    {
        if exe.contains("/target/debug/") || exe.contains("/target/release/") {
            return false;
        }
        true
    }
}

#[tauri::command]
fn get_cpu_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8)
}

#[cfg(target_os = "linux")]
fn linux_desktop_file_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home)
        .join(".local/share/applications/run.rosie.zinnia.desktop"))
}

#[cfg(target_os = "linux")]
fn escape_desktop_exec_arg(arg: &str) -> String {
    let mut escaped = String::with_capacity(arg.len());
    for ch in arg.chars() {
        match ch {
            ' ' | '\t' | '\n' | '"' | '\'' | '\\' | '>' | '<' | '~' | '|'
            | '&' | ';' | '$' | '*' | '?' | '#' | '(' | ')' | '`' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(target_os = "linux")]
const LINUX_DESKTOP_ENTRY: &str = r#"[Desktop Entry]
Type=Application
Name=Zinnia
Exec={exe} %F
Icon=run.rosie.zinnia
Categories=Utility;Archiving;
Terminal=false
MimeType=application/x-7z-compressed;application/zip;application/x-tar;application/gzip;application/x-bzip2;application/x-xz;application/vnd.rar;application/x-compressed-tar;application/x-bzip2-compressed-tar;application/x-xz-compressed-tar;
"#;

#[tauri::command]
fn register_linux_desktop_integration() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path = linux_desktop_file_path()
            .ok_or_else(|| "Could not determine HOME directory.".to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_escaped = escape_desktop_exec_arg(&exe.to_string_lossy());
        let contents = LINUX_DESKTOP_ENTRY.replace("{exe}", &exe_escaped);
        std::fs::write(&path, contents).map_err(|e| e.to_string())?;
        let _ = std::process::Command::new("update-desktop-database")
            .arg(path.parent().unwrap())
            .status();
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("Desktop integration is only available on Linux.".to_string())
    }
}

#[tauri::command]
fn unregister_linux_desktop_integration() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path = linux_desktop_file_path()
            .ok_or_else(|| "Could not determine HOME directory.".to_string())?;
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        let _ = std::process::Command::new("update-desktop-database")
            .arg(path.parent().unwrap())
            .status();
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("Desktop integration is only available on Linux.".to_string())
    }
}

#[tauri::command]
fn get_linux_desktop_integration_status() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let path = linux_desktop_file_path()
            .ok_or_else(|| "Could not determine HOME directory.".to_string())?;
        if !path.exists() {
            return Ok(false);
        }

        let contents = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let looks_valid = contents.contains("Name=Zinnia")
            && contents.contains("Exec=")
            && contents.contains("%F")
            && contents.contains("MimeType=");
        Ok(looks_valid)
    }

    #[cfg(not(target_os = "linux"))]
    {
        Ok(false)
    }
}

#[derive(serde::Serialize, Clone)]
struct OpenPathsPayload {
    paths: Vec<String>,
    mode: String,
}

fn emit_open_paths(app: &tauri::AppHandle, argv: Vec<String>) {
    let mut mode = String::new();
    let paths: Vec<String> = argv
        .into_iter()
        .skip(1)
        .filter(|arg| {
            if arg == "--extract" {
                mode = "extract".to_string();
                false
            } else {
                !arg.starts_with("--")
            }
        })
        .collect();

    if paths.is_empty() {
        return;
    }

    let _ = app.emit("open-paths", OpenPathsPayload { paths, mode });

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

fn collect_cli_context() -> (Vec<String>, String) {
    let mut paths = Vec::new();
    let mut mode = String::new();
    for arg in std::env::args().skip(1) {
        if arg == "--extract" {
            mode = "extract".to_string();
        } else if !arg.starts_with("--") {
            paths.push(arg);
        }
    }
    (paths, mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_json_rejects_invalid_payload() {
        let result = validate_json("{ not-valid-json }");
        assert!(result.is_err());
    }

    #[test]
    fn atomic_write_text_replaces_existing_contents() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("settings.json");

        std::fs::write(&file_path, "{\"old\":true}").expect("seed file should be written");
        atomic_write_text(&file_path, "{\"new\":true}").expect("atomic write should succeed");

        let contents = std::fs::read_to_string(&file_path).expect("file should be readable");
        assert_eq!(contents, "{\"new\":true}");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn ensure_idle_detects_busy_state() {
        assert!(ensure_idle(&Option::<()>::None).is_ok());
        assert!(ensure_idle(&Some(())).is_err());
    }

    #[test]
    fn kill_error_detection_handles_known_messages() {
        assert!(is_non_running_kill_error("process already finished"));
        assert!(is_non_running_kill_error("child process is not running"));
        assert!(!is_non_running_kill_error("permission denied"));
    }

    #[test]
    fn merge_reserved_settings_preserves_internal_keys() {
        let existing = parse_json_object(r#"{"theme":"dark","_integrationAutoEnabled":true,"_integrationUserDisabled":true}"#)
            .expect("existing object should parse");
        let mut incoming = parse_json_object(r#"{"theme":"light"}"#)
            .expect("incoming object should parse");

        merge_reserved_settings(&existing, &mut incoming);

        assert_eq!(incoming.get("theme"), Some(&serde_json::Value::String("light".to_string())));
        assert_eq!(incoming.get("_integrationAutoEnabled"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(incoming.get("_integrationUserDisabled"), Some(&serde_json::Value::Bool(true)));
    }

    #[test]
    fn truncate_for_bytes_caps_large_entries() {
        let long = "x".repeat(MAX_LOG_ENTRY_BYTES + 100);
        let truncated = truncate_for_bytes(&long, MAX_LOG_ENTRY_BYTES);
        assert!(truncated.len() <= MAX_LOG_ENTRY_BYTES + 64);
        assert!(truncated.contains("[truncated"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_exec_escaping_quotes_spaces() {
        let escaped = escape_desktop_exec_arg("/tmp/My App/zinnia");
        assert_eq!(escaped, "/tmp/My\\ App/zinnia");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            emit_open_paths(app, argv);
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage({
            let ctx = collect_cli_context();
            InitialPaths(Mutex::new(ctx.0))
        })
        .manage({
            let ctx = collect_cli_context();
            InitialMode(Mutex::new(ctx.1))
        })
        .manage(RunningProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            run_7z,
            cancel_7z,
            probe_7z,
            register_windows_context_menu,
            unregister_windows_context_menu,
            get_windows_context_menu_status,
            register_linux_desktop_integration,
            unregister_linux_desktop_integration,
            get_linux_desktop_integration_status,
            load_settings,
            save_settings,
            append_local_log,
            get_log_dir,
            export_logs,
            clear_logs,
            open_log_dir,
            get_initial_paths,
            get_initial_mode,
            get_platform_info,
            get_cpu_count,
            is_flatpak,
            is_packaged
        ])
        .run(tauri::generate_context!())
        .expect("failed to initialize Tauri application");
}
