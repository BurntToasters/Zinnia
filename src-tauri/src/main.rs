#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandEvent, CommandChild};
use tauri_plugin_shell::ShellExt;

const MAX_OUTPUT_BYTES: usize = 50 * 1024 * 1024;
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;
const LOG_FILE_NAME: &str = "zinnia.log";
const ARCHIVE_SIGNATURE_SCAN_BYTES: usize = 512;
const SUPPORTED_ARCHIVE_EXTENSIONS: &[&str] = &[
    ".7z", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz", ".rar",
];

#[derive(serde::Serialize)]
struct RunResult {
    stdout: String,
    stderr: String,
    code: i32,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

struct InitialPaths(Mutex<Vec<String>>);
struct InitialMode(Mutex<String>);
struct ProcessState {
    child: Option<CommandChild>,
    cancelling: bool,
}

struct RunningProcess(Mutex<ProcessState>);

fn lock_process(state: &RunningProcess) -> Result<std::sync::MutexGuard<'_, ProcessState>, String> {
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

fn append_limited_output(target: &mut String, chunk: &str, max_bytes: usize, truncated: &mut bool) {
    if *truncated {
        return;
    }

    if target.len() >= max_bytes {
        *truncated = true;
        return;
    }

    let remaining = max_bytes - target.len();
    if chunk.len() <= remaining {
        target.push_str(chunk);
        return;
    }

    let mut boundary = remaining;
    while boundary > 0 && !chunk.is_char_boundary(boundary) {
        boundary -= 1;
    }

    if boundary > 0 {
        target.push_str(&chunk[..boundary]);
    }
    *truncated = true;
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

fn ensure_idle(state: &ProcessState) -> Result<(), String> {
    if state.child.is_some() || state.cancelling {
        Err("Another archive operation is already running.".to_string())
    } else {
        Ok(())
    }
}

fn is_non_running_kill_error(message: &str) -> bool {
    message.contains("finished") || message.contains("not running")
}

#[derive(serde::Serialize, Clone, Debug)]
struct ArchivePathValidation {
    path: String,
    valid: bool,
    reason: Option<String>,
}

fn expected_archive_family(lower_path: &str) -> Option<&'static str> {
    if lower_path.ends_with(".7z") {
        Some("7z")
    } else if lower_path.ends_with(".zip") {
        Some("zip")
    } else if lower_path.ends_with(".rar") {
        Some("rar")
    } else if lower_path.ends_with(".tar") {
        Some("tar")
    } else if lower_path.ends_with(".gz") || lower_path.ends_with(".tgz") {
        Some("gzip")
    } else if lower_path.ends_with(".bz2") || lower_path.ends_with(".tbz2") {
        Some("bzip2")
    } else if lower_path.ends_with(".xz") || lower_path.ends_with(".txz") {
        Some("xz")
    } else {
        None
    }
}

fn starts_with_bytes(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len() && &bytes[..prefix.len()] == prefix
}

fn detect_archive_signature(bytes: &[u8]) -> Option<&'static str> {
    if starts_with_bytes(bytes, &[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return Some("7z");
    }
    if starts_with_bytes(bytes, &[0x50, 0x4B, 0x03, 0x04])
        || starts_with_bytes(bytes, &[0x50, 0x4B, 0x05, 0x06])
        || starts_with_bytes(bytes, &[0x50, 0x4B, 0x07, 0x08])
    {
        return Some("zip");
    }
    if starts_with_bytes(bytes, &[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])
        || starts_with_bytes(bytes, &[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00])
    {
        return Some("rar");
    }
    if starts_with_bytes(bytes, &[0x1F, 0x8B]) {
        return Some("gzip");
    }
    if starts_with_bytes(bytes, b"BZh") {
        return Some("bzip2");
    }
    if starts_with_bytes(bytes, &[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
        return Some("xz");
    }
    None
}

fn parse_tar_octal_field(field: &[u8]) -> Option<u64> {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    let text = String::from_utf8_lossy(&field[..end]).trim().to_string();
    if text.is_empty() {
        return None;
    }
    u64::from_str_radix(text.trim(), 8).ok()
}

fn is_valid_tar_typeflag(flag: u8) -> bool {
    matches!(
        flag,
        0
            | b'0'
            | b'1'
            | b'2'
            | b'3'
            | b'4'
            | b'5'
            | b'6'
            | b'7'
            | b'g'
            | b'x'
            | b'L'
            | b'K'
            | b'S'
            | b'V'
            | b'A'
            | b'D'
            | b'M'
            | b'N'
    )
}

fn is_ascii_printable_or_blank(field: &[u8]) -> bool {
    field
        .iter()
        .all(|byte| *byte == 0 || *byte == b' ' || (0x21..=0x7E).contains(byte))
}

fn has_tar_checksum(bytes: &[u8]) -> bool {
    if bytes.len() < 512 {
        return false;
    }

    if !is_valid_tar_typeflag(bytes[156]) {
        return false;
    }
    if !is_ascii_printable_or_blank(&bytes[0..100]) {
        return false;
    }
    if parse_tar_octal_field(&bytes[124..136]).is_none() {
        return false;
    }
    if parse_tar_octal_field(&bytes[136..148]).is_none() {
        return false;
    }

    let stored = match parse_tar_octal_field(&bytes[148..156]) {
        Some(value) => value,
        None => return false,
    };

    let mut computed: u64 = 0;
    for (index, byte) in bytes.iter().copied().take(512).enumerate() {
        if (148..156).contains(&index) {
            computed += 0x20;
        } else {
            computed += byte as u64;
        }
    }

    computed == stored
}

fn has_tar_signature(bytes: &[u8]) -> bool {
    if bytes.len() < 512 {
        return false;
    }
    bytes.get(257..262) == Some(b"ustar") || has_tar_checksum(bytes)
}

fn read_probe_bytes(path: &std::path::Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; max_bytes];
    let read = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(read);
    Ok(buf)
}

fn extension_mismatch_reason(expected: &str, detected: Option<&str>, tar: bool) -> String {
    if expected == "tar" && tar {
        return String::new();
    }

    match detected {
        Some(kind) => format!(
            "Extension indicates {expected} but header appears to be {kind}."
        ),
        None => format!("Extension indicates {expected} but the archive header is unrecognized."),
    }
}

fn validate_archive_path(path: &str) -> ArchivePathValidation {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return ArchivePathValidation {
            path: path.to_string(),
            valid: false,
            reason: Some("Path is empty.".to_string()),
        };
    }

    let lower = trimmed.to_lowercase();
    let fs_path = std::path::Path::new(trimmed);
    let meta = match std::fs::metadata(fs_path) {
        Ok(meta) => meta,
        Err(err) => {
            let reason = if err.kind() == std::io::ErrorKind::NotFound {
                "File does not exist.".to_string()
            } else {
                format!("Unable to read file metadata: {}", err)
            };
            return ArchivePathValidation {
                path: trimmed.to_string(),
                valid: false,
                reason: Some(reason),
            };
        }
    };
    if !meta.is_file() {
        return ArchivePathValidation {
            path: trimmed.to_string(),
            valid: false,
            reason: Some("Path is not a file.".to_string()),
        };
    }

    let bytes = match read_probe_bytes(fs_path, ARCHIVE_SIGNATURE_SCAN_BYTES) {
        Ok(bytes) => bytes,
        Err(err) => {
            return ArchivePathValidation {
                path: trimmed.to_string(),
                valid: false,
                reason: Some(format!("Unable to read file contents: {}", err)),
            };
        }
    };

    let signature = detect_archive_signature(&bytes);
    let tar = has_tar_signature(&bytes);
    let valid = match expected_archive_family(&lower) {
        Some("7z") => signature == Some("7z"),
        Some("zip") => signature == Some("zip"),
        Some("rar") => signature == Some("rar"),
        Some("gzip") => signature == Some("gzip"),
        Some("bzip2") => signature == Some("bzip2"),
        Some("xz") => signature == Some("xz"),
        Some("tar") => tar,
        _ => signature.is_some() || tar,
    };

    if valid {
        return ArchivePathValidation {
            path: trimmed.to_string(),
            valid: true,
            reason: None,
        };
    }

    let expected = expected_archive_family(&lower);
    let reason = match expected {
        Some(kind) => {
            let mismatch = extension_mismatch_reason(kind, signature, tar);
            if mismatch.is_empty() {
                "Archive header could not be validated.".to_string()
            } else {
                mismatch
            }
        }
        None => "File does not look like a supported archive.".to_string(),
    };

    ArchivePathValidation {
        path: trimmed.to_string(),
        valid: false,
        reason: Some(reason),
    }
}

#[tauri::command]
fn validate_archive_paths(paths: Vec<String>) -> Result<Vec<ArchivePathValidation>, String> {
    Ok(paths
        .into_iter()
        .map(|path| validate_archive_path(&path))
        .collect())
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
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;

    let command = app
        .shell()
        .sidecar("7z")
        .map_err(|e| e.to_string())?
        .args(args);

    let mut rx = {
        let mut process = lock_process(&state)?;
        ensure_idle(&*process)?;

        let (rx, child) = command.spawn().map_err(|e| e.to_string())?;
        process.child = Some(child);
        process.cancelling = false;
        rx
    };

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let chunk = String::from_utf8_lossy(&line);
                append_limited_output(&mut stdout, &chunk, MAX_OUTPUT_BYTES, &mut stdout_truncated);
            }
            CommandEvent::Stderr(line) => {
                let chunk = String::from_utf8_lossy(&line);
                append_limited_output(&mut stderr, &chunk, MAX_OUTPUT_BYTES, &mut stderr_truncated);
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
        process.child = None;
        process.cancelling = false;
    }

    Ok(RunResult {
        stdout: sanitize_output(&stdout),
        stderr: sanitize_output(&stderr),
        code: exit_code,
        stdout_truncated,
        stderr_truncated,
    })
}

#[tauri::command]
fn cancel_7z(state: tauri::State<'_, RunningProcess>) -> Result<(), String> {
    let child = {
        let mut process = lock_process(&state)?;
        match process.child.take() {
            Some(child) => {
                process.cancelling = true;
                Some(child)
            }
            None => {
                process.cancelling = false;
                None
            }
        }
    };

    if let Some(child) = child {
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
const ARCHIVE_EXTENSIONS: &[&str] = SUPPORTED_ARCHIVE_EXTENSIONS;

#[cfg(windows)]
fn notify_shell_association_changed() {
    #[allow(non_snake_case)]
    unsafe extern "system" {
        fn SHChangeNotify(
            wEventId: u32,
            uFlags: u32,
            dwItem1: *const std::ffi::c_void,
            dwItem2: *const std::ffi::c_void,
        );
    }

    const SHCNE_ASSOCCHANGED: u32 = 0x0800_0000;
    const SHCNF_IDLIST: u32 = 0x0000;

    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

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

        let icon_value = format!("\"{}\",0", exe_str);
        let compress_entries = [
            ("*\\shell\\Zinnia", "Compress with Zinnia"),
            ("Directory\\shell\\Zinnia", "Compress folder with Zinnia"),
        ];

        for (key_path, verb) in compress_entries {
            let (key, _) = classes.create_subkey(key_path).map_err(|e| e.to_string())?;
            key.set_value("MUIVerb", &verb).map_err(|e| e.to_string())?;
            key.set_value("Icon", &icon_value)
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
            key.set_value("Icon", &icon_value)
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
                .set_value("", &icon_value)
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

        notify_shell_association_changed();
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

        notify_shell_association_changed();
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

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_string();
        let icon_value = format!("{},0", exe_str);
        let compress_cmd = format!("\"{}\" \"%1\"", exe_str);
        let extract_cmd = format!("\"{}\" --extract \"%1\"", exe_str);

        let normalize = |value: &str| value.replace('"', "").replace(' ', "").to_ascii_lowercase();
        let icon_matches = |actual: &str| {
            let actual_norm = normalize(actual);
            actual_norm == normalize(&icon_value) || actual_norm == normalize(&exe_str)
        };

        for (path, expected_command) in [
            ("*\\shell\\Zinnia\\command", compress_cmd.as_str()),
            ("Directory\\shell\\Zinnia\\command", compress_cmd.as_str()),
            ("Zinnia.Archive\\shell\\open\\command", extract_cmd.as_str()),
        ] {
            let key = match classes.open_subkey(path) {
                Ok(key) => key,
                Err(_) => return Ok(false),
            };
            let command: String = match key.get_value("") {
                Ok(value) => value,
                Err(_) => return Ok(false),
            };
            if command.trim() != expected_command {
                return Ok(false);
            }
        }

        for path in ["*\\shell\\Zinnia", "Directory\\shell\\Zinnia", "Zinnia.Archive\\DefaultIcon"] {
            let key = match classes.open_subkey(path) {
                Ok(key) => key,
                Err(_) => return Ok(false),
            };
            let value_name = if path == "Zinnia.Archive\\DefaultIcon" { "" } else { "Icon" };
            let icon: String = match key.get_value(value_name) {
                Ok(value) => value,
                Err(_) => return Ok(false),
            };
            if !icon_matches(&icon) {
                return Ok(false);
            }
        }

        for ext in ARCHIVE_EXTENSIONS {
            let extract_base = format!("SystemFileAssociations\\{}\\shell\\Zinnia.Extract", ext);
            let extract_key = format!("{}\\command", extract_base);
            let command_key = match classes.open_subkey(&extract_key) {
                Ok(key) => key,
                Err(_) => return Ok(false),
            };
            let command: String = match command_key.get_value("") {
                Ok(value) => value,
                Err(_) => return Ok(false),
            };
            if command.trim() != extract_cmd {
                return Ok(false);
            }

            let icon_key = match classes.open_subkey(&extract_base) {
                Ok(key) => key,
                Err(_) => return Ok(false),
            };
            let icon: String = match icon_key.get_value("Icon") {
                Ok(value) => value,
                Err(_) => return Ok(false),
            };
            if !icon_matches(&icon) {
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
        let idle = ProcessState {
            child: None,
            cancelling: false,
        };
        let cancelling = ProcessState {
            child: None,
            cancelling: true,
        };

        assert!(ensure_idle(&idle).is_ok());
        assert!(ensure_idle(&cancelling).is_err());
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

    #[test]
    fn append_limited_output_marks_truncation_when_over_limit() {
        let mut out = String::new();
        let mut truncated = false;

        append_limited_output(&mut out, "abcdef", 4, &mut truncated);
        assert_eq!(out, "abcd");
        assert!(truncated);
    }

    #[test]
    fn append_limited_output_preserves_utf8_boundaries() {
        let mut out = String::new();
        let mut truncated = false;
        let chunk = "ééé";

        append_limited_output(&mut out, chunk, 5, &mut truncated);
        assert_eq!(out, "éé");
        assert!(truncated);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn detect_archive_signature_recognizes_known_headers() {
        assert_eq!(detect_archive_signature(&[0x50, 0x4B, 0x03, 0x04]), Some("zip"));
        assert_eq!(detect_archive_signature(&[0x1F, 0x8B, 0x08]), Some("gzip"));
        assert_eq!(
            detect_archive_signature(&[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]),
            Some("rar")
        );
        assert_eq!(detect_archive_signature(b"plain-text"), None);
    }

    #[test]
    fn has_tar_signature_accepts_checksum_valid_block() {
        let mut block = [0u8; 512];
        block[0..8].copy_from_slice(b"file.txt");
        block[124..136].copy_from_slice(b"00000000000\0");
        block[136..148].copy_from_slice(b"00000000000\0");
        block[156] = b'0';
        for byte in &mut block[148..156] {
            *byte = b' ';
        }
        let checksum: u64 = block.iter().map(|b| *b as u64).sum();
        let checksum_field = format!("{:06o}\0 ", checksum);
        block[148..156].copy_from_slice(checksum_field.as_bytes());

        assert!(has_tar_signature(&block));
    }

    #[test]
    fn has_tar_signature_rejects_invalid_typeflag() {
        let mut block = [0u8; 512];
        block[0..8].copy_from_slice(b"file.txt");
        block[124..136].copy_from_slice(b"00000000000\0");
        block[136..148].copy_from_slice(b"00000000000\0");
        block[156] = 0xFF;
        for byte in &mut block[148..156] {
            *byte = b' ';
        }
        let checksum: u64 = block.iter().map(|b| *b as u64).sum();
        let checksum_field = format!("{:06o}\0 ", checksum);
        block[148..156].copy_from_slice(checksum_field.as_bytes());

        assert!(!has_tar_signature(&block));
    }

    #[test]
    fn validate_archive_path_accepts_extensionless_zip_signature() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-archive-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("archive-without-extension");
        std::fs::write(&file_path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("probe file should be written");

        let path = file_path.to_string_lossy().to_string();
        assert!(validate_archive_path(&path).valid);

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn validate_archive_path_rejects_mislabeled_zip_file() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-archive-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("not-an-archive.zip");
        std::fs::write(&file_path, b"this is plain text").expect("probe file should be written");

        let path = file_path.to_string_lossy().to_string();
        let result = validate_archive_path(&path);
        assert!(!result.valid);
        assert!(result.reason.unwrap_or_default().contains("Extension indicates zip"));

        let _ = std::fs::remove_dir_all(base);
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
        .manage(RunningProcess(Mutex::new(ProcessState {
            child: None,
            cancelling: false,
        })))
        .invoke_handler(tauri::generate_handler![
            run_7z,
            cancel_7z,
            probe_7z,
            validate_archive_paths,
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
