//! Rolling local diagnostics log under the app data dir, with size-based trimming.

use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::output::{redact_sensitive_text, truncate_for_bytes, MAX_LOG_ENTRY_BYTES};
use crate::settings_store::atomic_write_text;

const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const LOG_FILE_NAME: &str = "zinnia.log";
const LOG_EXPORT_FILE_NAME: &str = "zinnia-logs.txt";

fn resolve_log_export_parent(
    path: &std::path::Path,
) -> Result<(std::path::PathBuf, std::ffi::OsString), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("Could not resolve log export directory: {error}"))?;
    let metadata = std::fs::symlink_metadata(&parent).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err("Log export parent is not a real directory.".to_string());
    }
    let name = path
        .file_name()
        .ok_or_else(|| "Log export destination has no file name.".to_string())?
        .to_os_string();
    Ok((parent, name))
}

fn open_log_export_source(path: &std::path::Path) -> Result<Option<std::fs::File>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata)
            if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
        {
            Err("Log file path is not a regular file.".to_string())
        }
        Ok(_) => crate::path_safety::open_regular_file_nofollow(path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn create_log_export_temp(
    destination: &std::path::Path,
) -> Result<(std::path::PathBuf, std::fs::File), String> {
    let (parent, _) = resolve_log_export_parent(destination)?;
    for _ in 0..32 {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|error| format!("Could not generate a log export temp name: {error}"))?;
        let name = format!(
            ".zinnia-log-export-{}.tmp",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let path = parent.join(&name);

        #[cfg(unix)]
        let opened: Result<std::fs::File, String> = {
            use std::os::fd::{AsRawFd as _, FromRawFd as _};
            use std::os::unix::fs::OpenOptionsExt as _;

            let directory = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(&parent)
                .map_err(|error| error.to_string())?;
            let name = std::ffi::CString::new(name.as_bytes())
                .map_err(|_| "Log export file name contains a NUL byte.".to_string())?;
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    continue;
                }
                return Err(error.to_string());
            }
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            let file_meta = file.metadata().map_err(|error| error.to_string())?;
            if !file_meta.is_file() {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err("Log export temporary file is not a regular file.".to_string());
            }
            Ok(file)
        };

        #[cfg(windows)]
        let opened = {
            use std::os::windows::fs::OpenOptionsExt as _;
            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
            {
                Ok(file) => {
                    let file_meta = file.metadata().map_err(|error| error.to_string())?;
                    if crate::path_safety::is_link_or_reparse(&file_meta) || !file_meta.is_file() {
                        drop(file);
                        let _ = std::fs::remove_file(&path);
                        return Err("Log export temporary file is not a regular file.".to_string());
                    }
                    Ok(file)
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => Err(error.to_string()),
            }
        };

        #[cfg(not(any(unix, windows)))]
        let opened = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => Err(error.to_string()),
        };

        return Ok((path, opened?));
    }
    Err("Could not reserve a unique log export temp file.".to_string())
}

fn publish_log_export(temp: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            let _ = std::fs::remove_file(temp);
            return Err(error.to_string());
        }
        Ok(metadata) if metadata.is_dir() && !crate::path_safety::is_link_or_reparse(&metadata) => {
            let _ = std::fs::remove_file(temp);
            return Err("Destination path must be a file, not a directory.".to_string());
        }
        Ok(_) => {}
    }
    std::fs::rename(temp, destination).map_err(|error| {
        let _ = std::fs::remove_file(temp);
        error.to_string()
    })
}

fn export_log_contents(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let source_file = open_log_export_source(source)?;
    let (temp, mut output) = create_log_export_temp(destination)?;
    let copied = (|| {
        match source_file {
            Some(mut input) => std::io::copy(&mut input, &mut output)
                .map(|_| ())
                .map_err(|error| error.to_string()),
            None => output
                .write_all(b"No local logs have been recorded yet.\n")
                .map_err(|error| error.to_string()),
        }?;
        output.sync_all().map_err(|error| error.to_string())
    })();
    drop(output);
    if let Err(error) = copied {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    publish_log_export(&temp, destination)?;
    crate::settings_store::sync_parent_directory(destination)
}

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
    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() => {
            return Err("Log directory path is not a real directory.".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let metadata = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
            if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() {
                return Err("Log directory path is not a real directory.".to_string());
            }
        }
        Err(error) => return Err(error.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn trim_log_file_if_needed(path: &std::path::Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };

    if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_file() {
        return Err("Log file path is not a regular file.".to_string());
    }

    if meta.len() <= MAX_LOG_FILE_BYTES {
        return Ok(());
    }

    let mut source = crate::path_safety::open_regular_file_nofollow(path)?;
    let mut bytes = Vec::with_capacity(meta.len().min(usize::MAX as u64) as usize);
    use std::io::Read as _;
    source.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
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
    let line = redact_sensitive_text(&line);
    let line = truncate_for_bytes(&line, MAX_LOG_ENTRY_BYTES);

    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }

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
        export_log_contents(&source, &destination)?;

        Ok(true)
    }
}

#[tauri::command]
pub fn clear_logs(
    app: tauri::AppHandle,
    lock: tauri::State<'_, LogFileLock>,
) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::{export_log_contents, LOG_EXPORT_FILE_NAME};

    fn temp_root(prefix: &str) -> std::path::PathBuf {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random log export test suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
        std::fs::create_dir_all(&root).expect("log export test root");
        root
    }

    #[test]
    fn export_replaces_destination_only_after_source_copy() {
        let root = temp_root("zinnia-log-export-ok");
        let source = root.join("zinnia.log");
        let destination = root.join(LOG_EXPORT_FILE_NAME);
        std::fs::write(&source, b"recorded-log\n").expect("source log");
        std::fs::write(&destination, b"previous-export").expect("existing dest");
        export_log_contents(&source, &destination).expect("export");
        assert_eq!(
            std::fs::read(&destination).expect("exported"),
            b"recorded-log\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_preserves_destination_when_source_is_not_a_regular_file() {
        let root = temp_root("zinnia-log-export-invalid-source");
        let source = root.join("zinnia.log");
        let destination = root.join(LOG_EXPORT_FILE_NAME);
        std::fs::create_dir(&source).expect("directory disguised as log");
        std::fs::write(&destination, b"keep-me").expect("existing dest");
        let error = export_log_contents(&source, &destination).expect_err("invalid source");
        assert!(error.contains("regular file"), "{error}");
        assert_eq!(std::fs::read(&destination).expect("preserved"), b"keep-me");
        let leftover: Vec<_> = std::fs::read_dir(&root)
            .expect("export root")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".zinnia-log-export-")
            })
            .collect();
        assert!(
            leftover.is_empty(),
            "failed export must not leave a temp file"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn export_preserves_destination_when_source_is_a_symlink() {
        let root = temp_root("zinnia-log-export-symlink-source");
        let real = root.join("real.log");
        let source = root.join("zinnia.log");
        let destination = root.join(LOG_EXPORT_FILE_NAME);
        std::fs::write(&real, b"secret").expect("real log");
        std::os::unix::fs::symlink(&real, &source).expect("symlink log path");
        std::fs::write(&destination, b"keep-me").expect("existing dest");
        let error = export_log_contents(&source, &destination).expect_err("symlink source");
        assert!(error.contains("regular file"), "{error}");
        assert_eq!(std::fs::read(&destination).expect("preserved"), b"keep-me");
        let _ = std::fs::remove_dir_all(root);
    }
}
