#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

static EXTRACT_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);
static EXTRACT_ONLY_LAUNCH: AtomicBool = AtomicBool::new(false);
use tauri::Emitter;
use tauri::Manager;
use tauri::Url;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;
const MAX_7Z_ARGS: usize = 256;
const MAX_7Z_ARG_BYTES: usize = 8192;
const LOG_FILE_NAME: &str = "zinnia.log";
const LOG_EXPORT_FILE_NAME: &str = "zinnia-logs.txt";
const ARCHIVE_SIGNATURE_SCAN_BYTES: usize = 512;

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
struct ExtractQueue(Mutex<HashMap<String, Vec<String>>>);
struct PendingPaths(Mutex<Vec<OpenPathsPayload>>);
struct ProcessState {
    child: Option<CommandChild>,
    cancelling: bool,
    owner_label: Option<String>,
}

struct RunningProcess(Mutex<ProcessState>);
struct LogFileLock(Mutex<()>);

static FILE_OPEN_SIGNAL: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

fn lock_process(state: &RunningProcess) -> Result<std::sync::MutexGuard<'_, ProcessState>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Process lock poisoned".to_string())
}

fn lock_log_file(state: &LogFileLock) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Log file lock poisoned".to_string())
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
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

    let seq = WRITE_SEQ.fetch_add(1, Ordering::SeqCst);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name in path".to_string())?;
    let tmp = path.with_file_name(format!(".{file_name}.{seq}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        if let Err(e) = std::fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Warning: could not remove existing file before rename: {e}");
            }
        }
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        if let Err(cleanup_err) = std::fs::remove_file(&tmp) {
            eprintln!(
                "Warning: could not clean up temp file {}: {cleanup_err}",
                tmp.display()
            );
        }
        e.to_string()
    })
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

fn ensure_idle(state: &ProcessState) -> Result<(), String> {
    if state.child.is_some() || state.cancelling {
        Err("Another archive operation is already running.".to_string())
    } else {
        Ok(())
    }
}

fn is_non_running_kill_error(message: &str) -> bool {
    message.contains("finished")
        || message.contains("not running")
        || message.contains("No such process")
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
        0 | b'0'
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
        Some(kind) => format!("Extension indicates {expected} but header appears to be {kind}."),
        None => format!("Extension indicates {expected} but the archive header is unrecognized."),
    }
}

fn validate_archive_path(path: &str) -> ArchivePathValidation {
    let trimmed = path.trim();

    let invalid = |reason: &str| ArchivePathValidation {
        path: trimmed.to_string(),
        valid: false,
        reason: Some(reason.to_string()),
    };

    if trimmed.is_empty() {
        return invalid("Path is empty.");
    }
    if trimmed.contains('\0') {
        return invalid("Path contains invalid characters.");
    }
    if trimmed.len() > 4096 {
        return invalid("Path exceeds maximum length.");
    }

    let lower = trimmed.to_lowercase();
    let fs_path = std::path::Path::new(trimmed);

    let meta = match std::fs::symlink_metadata(fs_path) {
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
    if meta.is_symlink() {
        return invalid("Path is a symbolic link.");
    }
    if !meta.is_file() {
        return invalid("Path is not a file.");
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
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    const MAX_SETTINGS_BYTES: usize = 512 * 1024;
    if json.len() > MAX_SETTINGS_BYTES {
        return Err("Settings payload exceeds maximum allowed size.".to_string());
    }
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
fn append_local_log(
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
fn get_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = ensure_logs_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn export_logs(app: tauri::AppHandle, lock: tauri::State<'_, LogFileLock>) -> Result<bool, String> {
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
fn clear_logs(app: tauri::AppHandle, lock: tauri::State<'_, LogFileLock>) -> Result<(), String> {
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
fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = ensure_logs_dir(&app)?;
    let dir_str = dir.to_string_lossy().to_string();
    app.shell().open(&dir_str, None).map_err(|e| e.to_string())
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
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
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
async fn probe_7z(app: tauri::AppHandle) -> Result<(), String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    const PROBE_OUTPUT_LIMIT: usize = 4096;

    let command = app
        .shell()
        .sidecar("7z")
        .map_err(|e| e.to_string())?
        .args(["i"]);

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    let probe = async {
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut stdout_truncated = false;
        let mut stderr_truncated = false;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let chunk = String::from_utf8_lossy(&line);
                    append_limited_output(
                        &mut stdout,
                        &chunk,
                        PROBE_OUTPUT_LIMIT,
                        &mut stdout_truncated,
                    );
                }
                CommandEvent::Stderr(line) => {
                    let chunk = String::from_utf8_lossy(&line);
                    append_limited_output(
                        &mut stderr,
                        &chunk,
                        PROBE_OUTPUT_LIMIT,
                        &mut stderr_truncated,
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload.code.unwrap_or(-1);
                    if code == 0 || code == 1 {
                        return Ok(());
                    }

                    let mut message = format!("7z probe exited with code {code}.");
                    let clean_stderr = sanitize_output(stderr.trim());
                    let clean_stdout = sanitize_output(stdout.trim());
                    if !clean_stderr.is_empty() {
                        message.push_str(&format!(" stderr: {clean_stderr}"));
                    } else if !clean_stdout.is_empty() {
                        message.push_str(&format!(" output: {clean_stdout}"));
                    }
                    return Err(message);
                }
                _ => {}
            }
        }

        Err("7z probe exited before reporting status.".to_string())
    };

    match tokio::time::timeout(PROBE_TIMEOUT, probe).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill();
            Err("7z runtime probe timed out.".to_string())
        }
    }
}

fn sanitize_output(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || matches!(*c, '\n' | '\t'))
        .collect()
}

const ALLOWED_7Z_COMMANDS: &[&str] = &["a", "x", "l", "t"];
const BLOCKED_7Z_ARGS: &[&str] = &["-si", "-so"];

fn validate_run_7z_args(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        return Err("Missing 7z arguments".to_string());
    }
    if args.len() > MAX_7Z_ARGS {
        return Err("Too many 7z arguments.".to_string());
    }
    if args.iter().any(|arg| arg.len() > MAX_7Z_ARG_BYTES) {
        return Err("A 7z argument exceeds maximum length.".to_string());
    }
    if args.iter().any(|arg| arg.contains('\0')) {
        return Err("7z arguments contain invalid characters.".to_string());
    }

    let cmd = args[0].as_str();
    if !ALLOWED_7Z_COMMANDS.contains(&cmd) {
        return Err(format!("7z command '{cmd}' is not permitted."));
    }

    let mut separator_index = None;
    let mut positional_before_separator = 0usize;
    let mut positional_after_separator = 0usize;

    for (idx, arg) in args.iter().enumerate().skip(1) {
        if arg == "--" {
            if separator_index.is_some() {
                return Err("7z argument separator '--' may appear only once.".to_string());
            }
            separator_index = Some(idx);
            continue;
        }

        let lower = arg.to_lowercase();
        if BLOCKED_7Z_ARGS.iter().any(|b| lower.starts_with(b)) {
            return Err(format!("7z argument '{arg}' is not permitted."));
        }
        if lower.starts_with("-sdel") && cmd != "a" {
            return Err(format!(
                "7z argument '{arg}' is only permitted for compression."
            ));
        }

        if separator_index.is_some() {
            positional_after_separator += 1;
        } else if !arg.starts_with('-') {
            positional_before_separator += 1;
        }
    }

    match cmd {
        "a" => {
            let separator = separator_index
                .ok_or_else(|| "Compression arguments must include '--'.".to_string())?;
            if separator + 1 >= args.len() {
                return Err("Missing compression input path(s) after '--'.".to_string());
            }
            if positional_before_separator != 1 {
                return Err(
                    "Compression command must include exactly one output archive path before '--'."
                        .to_string(),
                );
            }
        }
        "x" => {
            let separator = separator_index
                .ok_or_else(|| "Extraction arguments must include '--'.".to_string())?;
            if separator + 1 >= args.len() {
                return Err("Missing extraction archive path after '--'.".to_string());
            }
            if positional_before_separator > 0 {
                return Err(
                    "Extraction command cannot include positional arguments before '--'."
                        .to_string(),
                );
            }
        }
        "l" | "t" => {
            if let Some(separator) = separator_index {
                if separator + 1 >= args.len() {
                    return Err("Missing archive path after '--'.".to_string());
                }
            } else if positional_before_separator == 0 {
                return Err("Missing archive path.".to_string());
            }
        }
        _ => {}
    }

    if (cmd == "a" || cmd == "x") && positional_after_separator == 0 {
        return Err("Missing archive path(s) after '--'.".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn run_7z(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: Vec<String>,
    state: tauri::State<'_, RunningProcess>,
) -> Result<RunResult, String> {
    validate_run_7z_args(&args)?;

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
        ensure_idle(&process)?;

        let (rx, child) = command.spawn().map_err(|e| e.to_string())?;
        process.child = Some(child);
        process.cancelling = false;
        process.owner_label = Some(window.label().to_string());
        rx
    };

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let chunk = String::from_utf8_lossy(&line);
                let _ = window.emit("7z-progress", chunk.to_string());
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
        process.owner_label = None;
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
fn cancel_7z(window: tauri::Window, state: tauri::State<'_, RunningProcess>) -> Result<(), String> {
    let child = {
        let mut process = lock_process(&state)?;
        if let Some(owner) = &process.owner_label {
            if owner != window.label() {
                return Err(
                    "Only the window that started this operation can cancel it.".to_string()
                );
            }
        }
        match process.child.take() {
            Some(child) => {
                process.cancelling = true;
                Some(child)
            }
            None => {
                process.cancelling = false;
                process.owner_label = None;
                None
            }
        }
    };

    if let Some(child) = child {
        match child.kill() {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                let mut process = lock_process(&state)?;
                if is_non_running_kill_error(&msg) {
                    process.cancelling = false;
                    process.owner_label = None;
                    Ok(())
                } else {
                    eprintln!("Failed to kill 7z process: {msg}");
                    process.cancelling = false;
                    process.owner_label = None;
                    Err(msg)
                }
            }
        }
    } else {
        Ok(())
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
fn drain_pending_paths(
    state: tauri::State<'_, PendingPaths>,
) -> Result<Vec<OpenPathsPayload>, String> {
    let mut q = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(std::mem::take(&mut *q))
}

#[tauri::command]
fn get_extract_paths(
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

fn has_extract_windows(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| is_extract_window_label(label))
}

fn first_extract_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_iter().find_map(|(label, window)| {
        if is_extract_window_label(&label) {
            Some(window)
        } else {
            None
        }
    })
}

#[tauri::command]
fn close_extract_window(window: tauri::Window, app: tauri::AppHandle) -> Result<(), String> {
    if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.destroy();
        }
        return window.destroy().map_err(|e| e.to_string());
    }

    window.destroy().map_err(|e| e.to_string())
}

fn spawn_extract_window(app: &tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
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

#[derive(serde::Serialize, Clone)]
struct OpenPathsPayload {
    paths: Vec<String>,
    mode: String,
}

fn should_use_extract_window(paths: &[String], mode: &str) -> bool {
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

        let Some(path) = normalize_open_path_arg(&arg) else {
            continue;
        };

        if path.starts_with('-') && !std::path::Path::new(&path).exists() {
            continue;
        }

        paths.push(path);
    }

    if mode != "extract"
        && !paths.is_empty()
        && paths.iter().all(|path| validate_archive_path(path).valid)
    {
        mode = "extract".to_string();
    }

    if should_use_extract_window(&paths, &mode) {
        mode = "extract".to_string();
    } else if mode == "extract-explicit" {
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

fn emit_open_urls(app: &tauri::AppHandle, urls: Vec<Url>) {
    let paths: Vec<String> = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect();

    route_open_request(app, paths, String::new());
}

fn emit_open_paths(app: &tauri::AppHandle, argv: Vec<String>) {
    let (paths, mode) = parse_open_request_args(argv.into_iter().skip(1));
    route_open_request(app, paths, mode);
}

fn collect_cli_context() -> (Vec<String>, String) {
    parse_open_request_args(std::env::args().skip(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_object_rejects_invalid_payload() {
        let result = parse_json_object("{ not-valid-json }");
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
            owner_label: None,
        };
        let cancelling = ProcessState {
            child: None,
            cancelling: true,
            owner_label: None,
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
        let existing = parse_json_object(
            r#"{"theme":"dark","_integrationAutoEnabled":true,"_integrationUserDisabled":true}"#,
        )
        .expect("existing object should parse");
        let mut incoming =
            parse_json_object(r#"{"theme":"light"}"#).expect("incoming object should parse");

        merge_reserved_settings(&existing, &mut incoming);

        assert_eq!(
            incoming.get("theme"),
            Some(&serde_json::Value::String("light".to_string()))
        );
        assert_eq!(
            incoming.get("_integrationAutoEnabled"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            incoming.get("_integrationUserDisabled"),
            Some(&serde_json::Value::Bool(true))
        );
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
        assert_eq!(
            detect_archive_signature(&[0x50, 0x4B, 0x03, 0x04]),
            Some("zip")
        );
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
        assert!(result
            .reason
            .unwrap_or_default()
            .contains("Extension indicates zip"));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn should_use_extract_window_honors_explicit_extract_mode() {
        let paths = vec!["/tmp/not-an-archive.txt".to_string()];
        assert!(should_use_extract_window(&paths, "extract-explicit"));
    }

    #[test]
    fn should_use_extract_window_accepts_single_archive_path() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-extract-mode-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("archive.zip");
        std::fs::write(&file_path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("probe file should be written");

        let path = file_path.to_string_lossy().to_string();
        assert!(should_use_extract_window(&[path], ""));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn should_use_extract_window_rejects_non_archive_path() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-extract-mode-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("plain.txt");
        std::fs::write(&file_path, b"this is plain text").expect("probe file should be written");

        let path = file_path.to_string_lossy().to_string();
        assert!(!should_use_extract_window(&[path], ""));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn should_use_extract_window_rejects_multiple_paths_without_explicit_mode() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-extract-mode-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let one = base.join("one.zip");
        let two = base.join("two.zip");
        std::fs::write(&one, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("first probe file should be written");
        std::fs::write(&two, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("second probe file should be written");

        let paths = vec![
            one.to_string_lossy().to_string(),
            two.to_string_lossy().to_string(),
        ];
        assert!(!should_use_extract_window(&paths, ""));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parse_open_request_args_handles_file_urls() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-open-args-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("archive.zip");
        std::fs::write(&file_path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("probe file should be written");

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
        let base = std::env::temp_dir().join(format!(
            "zinnia-open-args-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("archive.zip");
        std::fs::write(&file_path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("probe file should be written");

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
        let base = std::env::temp_dir().join(format!(
            "zinnia-open-args-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("name..bak.zip");
        std::fs::write(&file_path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("probe file should be written");

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
        let base = std::env::temp_dir().join(format!(
            "zinnia-open-args-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let one = base.join("one.zip");
        let two = base.join("two.zip");
        std::fs::write(&one, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]).expect("one should be written");
        std::fs::write(&two, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]).expect("two should be written");

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
    fn validate_run_7z_args_allows_internal_delete_after_for_compress() {
        let args = vec![
            "a".to_string(),
            "-sdel".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_delete_after_outside_compress() {
        let args = vec![
            "x".to_string(),
            "-sdel".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[cfg(target_os = "linux")]
    fn escape_desktop_exec_arg(arg: &str) -> String {
        arg.chars()
            .fold(String::with_capacity(arg.len()), |mut out, c| {
                if matches!(
                    c,
                    ' ' | '"' | '\'' | '\\' | '`' | '$' | '>' | '<' | '~' | '|' | '&' | ';'
                ) {
                    out.push('\\');
                }
                out.push(c);
                out
            })
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_exec_escaping_quotes_spaces() {
        let escaped = escape_desktop_exec_arg("/tmp/My App/zinnia");
        assert_eq!(escaped, "/tmp/My\\ App/zinnia");
    }
}

fn main() {
    let ctx = collect_cli_context();
    let initial_paths = ctx.0;
    let initial_mode = ctx.1;

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
                emit_open_paths(app, argv);
            }))
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .manage(InitialPaths(Mutex::new(initial_paths.clone())))
        .manage(InitialMode(Mutex::new(initial_mode.clone())))
        .manage(ExtractQueue(Mutex::new(HashMap::new())))
        .manage(PendingPaths(Mutex::new(Vec::new())))
        .manage(LogFileLock(Mutex::new(())))
        .manage(RunningProcess(Mutex::new(ProcessState {
            child: None,
            cancelling: false,
            owner_label: None,
        })))
        .setup(move |app| {
            let launch_extract_window = initial_mode == "extract" && !initial_paths.is_empty();

            if launch_extract_window {
                spawn_extract_window(app.handle(), initial_paths.clone())
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
            } else if cfg!(target_os = "macos") && initial_paths.is_empty() {
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
                    *guard = Some(tx);
                }
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    match rx.recv_timeout(std::time::Duration::from_millis(750)) {
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst)
                                && !has_extract_windows(&handle)
                            {
                                if let Some(main_window) = handle.get_webview_window("main") {
                                    let _ = main_window.show();
                                    let _ = main_window.set_focus();
                                }
                            }
                        }
                        _ => {}
                    }
                });
            } else if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_7z,
            cancel_7z,
            probe_7z,
            validate_archive_paths,
            load_settings,
            save_settings,
            append_local_log,
            get_log_dir,
            export_logs,
            clear_logs,
            open_log_dir,
            open_path,
            get_initial_paths,
            get_initial_mode,
            drain_pending_paths,
            get_extract_paths,
            close_extract_window,
            get_platform_info,
            get_cpu_count,
            is_flatpak,
            is_packaged
        ])
        .build(tauri::generate_context!())
        .expect("failed to initialize Tauri application");

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Opened { urls } => {
            emit_open_urls(app_handle, urls);
        }
        tauri::RunEvent::Reopen { .. } => {
            if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                if let Some(extract_window) = first_extract_window(app_handle) {
                    let _ = extract_window.show();
                    let _ = extract_window.set_focus();
                } else {
                    app_handle.exit(0);
                }
            }
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) && !has_extract_windows(app_handle) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                app_handle.exit(0);
            }
        }
        _ => {}
    });

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    app.run(|app_handle, event| {
        if let tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } = event
        {
            if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) && !has_extract_windows(app_handle) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                app_handle.exit(0);
            }
        }
    });
}
