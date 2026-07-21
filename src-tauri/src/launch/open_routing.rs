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
    // Bare name.001: only when another volume sibling exists (name.002, …).
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
    for volume in 1u32..=999 {
        let candidate = parent.join(format!("{stem_os}.{volume:03}"));
        if candidate.as_os_str() == fs_path.as_os_str() {
            continue;
        }
        if candidate.exists() {
            return true;
        }
    }
    false
}

pub(crate) fn looks_like_archive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    looks_like_archive_extension(&lower) || looks_like_split_volume_path(path)
}

pub(crate) fn parse_open_request_args<I>(args: I) -> (Vec<String>, String)
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

pub(crate) fn route_open_request(app: &tauri::AppHandle, paths: Vec<String>, mode: String) {
    if paths.is_empty() {
        // Second-instance activation with no paths while warm: reopen the UI.
        if EXTRACT_WARM_IDLE_ACTIVE.load(Ordering::SeqCst)
            || (EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) && !has_extract_windows(app))
        {
            open_main_from_extract_warm(app);
        }
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

#[cfg(any(target_os = "macos", target_os = "ios"))]
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
