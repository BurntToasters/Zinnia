//! Argv / file:// parsing and open-request routing.

use std::sync::atomic::Ordering;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::Url;
use tauri::{Emitter, Manager};

use super::extract_window::{
    has_extract_windows, leave_extract_warm, open_main_from_extract_warm, show_main_window,
    spawn_extract_window, EXTRACT_WARM_IDLE_ACTIVE,
};
use super::open_path::normalize_open_path_arg;
use super::{
    OpenPathsPayload, PendingPaths, EXTRACT_ONLY_LAUNCH, FILE_OPEN_SIGNAL,
    MAC_FALLBACK_MAIN_PENDING,
};

// Finder caps one request at 1,000 paths and Explorer may split one selection
// across several 1,000-path launches. Keep the aggregate aligned with archive
// validation's public ceiling so every accepted queue can actually execute.
const MAX_PENDING_PATHS: usize = 4_096;
#[cfg(any(windows, test))]
const MAX_SHELL_HANDOFF_BYTES: u64 = 4 * 1024 * 1024;
#[cfg(any(windows, test))]
const MAX_SHELL_HANDOFF_PATHS: usize = 4_096;
#[cfg(windows)]
const SHELL_HANDOFF_PREFIX: &str = "zinnia-shell-handoff-";
#[cfg(windows)]
const SHELL_HANDOFF_SUFFIX: &str = ".tmp";

pub(crate) fn enqueue_pending_batch(
    queue: &mut Vec<OpenPathsPayload>,
    paths: Vec<String>,
    mode: String,
) -> bool {
    // Deduplicate before capacity accounting. Shell integrations can resend a
    // batch after an activation race; a duplicate-only retry consumes no queue
    // space and must remain an accepted no-op.
    let mut known: std::collections::HashSet<String> = queue
        .iter()
        .flat_map(|item| item.paths.iter().cloned())
        .collect();
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|path| known.insert(path.clone()))
        .collect();
    if paths.is_empty() {
        return true;
    }
    let total_paths = known.len() - paths.len();
    if total_paths + paths.len() > MAX_PENDING_PATHS {
        return false;
    }
    if let Some(last) = queue.last_mut() {
        if last.mode == mode {
            last.paths.extend(paths);
            return true;
        }
    }
    if queue.len() >= 100 {
        return false;
    }
    queue.push(OpenPathsPayload { paths, mode });
    true
}

pub(crate) fn should_use_extract_window(paths: &[String], mode: &str) -> bool {
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

pub(crate) fn looks_like_archive_extension(lower: &str) -> bool {
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
}

pub(crate) fn looks_like_split_volume_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let Some((stem, suffix)) = lower.rsplit_once('.') else {
        return false;
    };
    if suffix.len() != 3 || !suffix.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    // Prefer archive.7z.001 / archive.zip.001 over bare notes.001.
    if looks_like_archive_extension(stem) {
        return true;
    }
    // Bare name.001: require the immediate second volume. Avoid probing 999
    // filesystem entries synchronously during process startup.
    if suffix != "001" {
        return false;
    }
    let fs_path = std::path::Path::new(path);
    let Some(parent) = fs_path.parent() else {
        return false;
    };
    let Some(stem_os) = fs_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
    else {
        return false;
    };
    parent.join(format!("{stem_os}.002")).exists()
}

pub(crate) fn looks_like_archive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    looks_like_archive_extension(&lower) || looks_like_split_volume_path(path)
}

/// Parse the UTF-8, newline-delimited payload produced by Zinnia's Windows
/// shell extension. Windows file names cannot contain CR/LF, making this a
/// lossless compact representation for an Explorer selection.
#[cfg(any(windows, test))]
pub(crate) fn parse_shell_handoff_contents(contents: &str) -> Result<Vec<String>, String> {
    if contents.len() as u64 > MAX_SHELL_HANDOFF_BYTES {
        return Err("Windows shell handoff exceeds the 4 MiB safety limit.".to_string());
    }
    if contents.contains('\0') {
        return Err("Windows shell handoff contains a NUL byte.".to_string());
    }
    let paths: Vec<String> = contents.lines().map(ToOwned::to_owned).collect();
    if paths.is_empty() || paths.len() > MAX_SHELL_HANDOFF_PATHS {
        return Err(format!(
            "Windows shell handoff must contain between 1 and {MAX_SHELL_HANDOFF_PATHS} paths."
        ));
    }
    if paths.iter().any(|path| {
        path.is_empty() || path.contains(['\r', '\n']) || !windows_path_is_absolute(path)
    }) {
        return Err("Windows shell handoff contains an invalid path.".to_string());
    }
    Ok(paths)
}

#[cfg(any(windows, test))]
fn windows_path_is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || path.starts_with(r"\\")
}

#[cfg(windows)]
fn load_shell_handoff(path: &str) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(path);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Windows shell handoff has an invalid file name.".to_string())?;
    if !name.starts_with(SHELL_HANDOFF_PREFIX) || !name.ends_with(SHELL_HANDOFF_SUFFIX) {
        return Err("Refusing an unrecognized Windows shell handoff file.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Windows shell handoff has no parent directory.".to_string())?;
    let parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if parent != temp {
        return Err("Windows shell handoff is outside the temporary directory.".to_string());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err("Windows shell handoff is not a regular file.".to_string());
    }
    if metadata.len() > MAX_SHELL_HANDOFF_BYTES {
        return Err("Windows shell handoff exceeds the 4 MiB safety limit.".to_string());
    }
    let result = std::fs::read_to_string(path)
        .map_err(|error| error.to_string())
        .and_then(|contents| parse_shell_handoff_contents(&contents));
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Could not remove consumed Windows shell handoff: {error}");
        }
    }
    result
}

pub(crate) fn parse_open_request_args<I>(args: I) -> (Vec<String>, String)
where
    I: IntoIterator<Item = String>,
{
    let mut paths = Vec::new();
    let mut mode = String::new();

    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--extract" {
            mode = "extract-explicit".to_string();
            continue;
        }

        if arg == "--compress" {
            mode = "compress".to_string();
            continue;
        }

        if arg == "--zinnia-shell-handoff" {
            let Some(handoff) = args.next() else {
                eprintln!("Ignoring Windows shell handoff without a file path.");
                continue;
            };
            #[cfg(windows)]
            match load_shell_handoff(&handoff) {
                Ok(mut handoff_paths) => paths.append(&mut handoff_paths),
                Err(error) => eprintln!("Could not load Windows shell handoff: {error}"),
            }
            #[cfg(not(windows))]
            {
                let _ = handoff;
                eprintln!("Ignoring a Windows shell handoff outside Windows.");
            }
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

pub(crate) fn route_open_request(app: &tauri::AppHandle, paths: Vec<String>, mode: String) -> bool {
    if paths.is_empty() {
        // Second-instance activation with no paths while warm: reopen the UI.
        if EXTRACT_WARM_IDLE_ACTIVE.load(Ordering::SeqCst)
            || (EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) && !has_extract_windows(app))
        {
            open_main_from_extract_warm(app);
        }
        return true;
    }

    if should_use_extract_window(&paths, &mode) {
        // The backend intentionally owns one 7z job at a time. Route additional
        // open requests into the main window's existing pending FIFO instead of
        // creating a second quick window that can only fail as busy.
        if has_extract_windows(app) {
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            leave_extract_warm(app);
            let pending = app.state::<PendingPaths>();
            let accepted = if let Ok(mut queue) = pending.0.lock() {
                let accepted = enqueue_pending_batch(&mut queue, paths, "extract".to_string());
                if !accepted {
                    eprintln!("Pending extract queue full, dropping open request");
                    let _ = app.emit(
                        "open-paths-dropped",
                        "Zinnia is busy and the pending extract queue is full. Try again shortly.",
                    );
                }
                accepted
            } else {
                false
            };
            let _ = app.emit("pending-paths-changed", ());
            if let Err(e) = show_main_window(app) {
                eprintln!("Failed to show queued extraction in main window: {e}");
            }
            return accepted;
        }
        let fallback_main = MAC_FALLBACK_MAIN_PENDING.swap(false, Ordering::SeqCst);
        let had_main_window = app.get_webview_window("main").is_some() && !fallback_main;
        if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        let accepted = if let Err(e) = spawn_extract_window(app, paths) {
            eprintln!("Failed to open extract window: {e}");
            if let Err(main_error) = show_main_window(app) {
                eprintln!("Failed to open main window: {main_error}");
            }
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            leave_extract_warm(app);
            false
        } else if had_main_window {
            // Warm opens must not discard the user's active main workspace.
            EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
            leave_extract_warm(app);
            true
        } else {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.destroy();
            }
            EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
            true
        };
        return accepted;
    }

    EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
    leave_extract_warm(app);

    if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
        guard.take();
    }

    let pending = app.state::<PendingPaths>();
    let accepted = match pending.0.lock() {
        Ok(mut q) => {
            let accepted = enqueue_pending_batch(&mut q, paths, mode);
            if !accepted {
                eprintln!("Pending paths queue full, dropping open request");
                let _ = app.emit(
                    "open-paths-dropped",
                    "Zinnia could not accept more open requests. Finish the current job and try again.",
                );
            }
            accepted
        }
        Err(e) => {
            eprintln!("Failed to acquire pending paths lock: {e}");
            false
        }
    };

    if let Err(e) = app.emit("pending-paths-changed", ()) {
        eprintln!("Failed to emit pending-paths-changed: {e}");
    }

    if let Err(e) = show_main_window(app) {
        eprintln!("Failed to open main window: {e}");
    }
    accepted
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn emit_open_urls(app: &tauri::AppHandle, urls: Vec<Url>) {
    let paths: Vec<String> = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect();

    let _ = route_open_request(app, paths, String::new());
}

pub fn emit_open_paths(app: &tauri::AppHandle, argv: Vec<String>) -> bool {
    let (paths, mode) = parse_open_request_args(argv.into_iter().skip(1));
    route_open_request(app, paths, mode)
}

pub fn collect_cli_context() -> (Vec<String>, String) {
    parse_open_request_args(std::env::args().skip(1))
}
