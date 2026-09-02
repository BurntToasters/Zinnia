//! Disk-space and extract-size quota monitoring.

use tauri::Manager;

use super::{commands::terminate_registered_child, lock_process, RunningProcess};

// Large SDK/source/app archives routinely exceed 25k entries. Keep a high
// anti-DoS ceiling and enforce it during member listing before extraction, then
// again while writing/publishing.
pub(crate) const MAX_EXTRACT_ENTRIES: u64 = 1_000_000;
pub(crate) const MAX_EXTRACT_PATH_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) fn available_space_for_path(path: &std::path::Path) -> Result<u64, String> {
    // Do not follow directory symlinks: free-space for a redirected mount could
    // disagree with where staged output actually lands.
    let existing = path
        .ancestors()
        .find(|candidate| {
            std::fs::symlink_metadata(candidate)
                .map(|meta| meta.is_dir() && !crate::path_safety::is_link_or_reparse(&meta))
                .unwrap_or(false)
        })
        .ok_or_else(|| "Could not find an existing extraction parent directory.".to_string())?;
    available_space(existing)
}

#[cfg(unix)]
pub(crate) fn available_space(path: &std::path::Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "Extraction path contains an invalid NUL byte.".to_string())?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL terminated and `stats` points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(format!(
            "Could not query free disk space: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: statvfs initialized the structure after returning success.
    let stats = unsafe { stats.assume_init() };
    let available = (stats.f_bavail as u128).saturating_mul(stats.f_frsize as u128);
    Ok(available.min(u64::MAX as u128) as u64)
}

#[cfg(windows)]
pub(crate) fn available_space(path: &std::path::Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let has_trailing_separator = wide
        .last()
        .is_some_and(|last| *last == u16::from(b'\\') || *last == u16::from(b'/'));
    if !has_trailing_separator {
        wide.push(b'\\' as u16);
    }
    wide.push(0);
    let mut available = 0u64;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available: *mut u64,
            total_bytes: *mut u64,
            total_free_bytes: *mut u64,
        ) -> i32;
    }
    // SAFETY: `wide` is NUL terminated and the output pointer is valid.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "Could not query free disk space: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(available)
}

/// Walk a staged extract tree. On success returns `(files, bytes)` counted so far
/// so callers can back off scan frequency when usage is still well under limits.
pub(crate) fn staged_tree_usage(
    root: &std::path::Path,
    max_files: u64,
    max_bytes: u64,
) -> Result<(u64, u64), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut path_bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            path_bytes = path_bytes.saturating_add(
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .as_os_str()
                    .as_encoded_bytes()
                    .len() as u64,
            );
            if path_bytes > MAX_EXTRACT_PATH_BYTES {
                return Err(format!(
                    "Extraction exceeded the {} MiB aggregate path-name safety limit.",
                    MAX_EXTRACT_PATH_BYTES / (1024 * 1024)
                ));
            }
            let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                crate::path_safety::assert_relative_symlink_during_write(root, &path)?;
                files = files.saturating_add(1);
                if files > max_files {
                    return Err(format!(
                        "Extraction exceeded the safety limit of {max_files} entries."
                    ));
                }
                continue;
            }
            if crate::path_safety::is_link_or_reparse(&metadata) {
                return Err(
                    "Extraction created a symbolic link or reparse point; operation stopped."
                        .to_string(),
                );
            }
            files = files.saturating_add(1);
            bytes = bytes.saturating_add(metadata.len());
            if files > max_files {
                return Err(format!(
                    "Extraction exceeded the safety limit of {max_files} entries."
                ));
            }
            if bytes > max_bytes {
                return Err(format!(
                    "Extraction exceeded its {:.1} GiB safety limit.",
                    max_bytes as f64 / 1_073_741_824.0
                ));
            }
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok((files, bytes))
}

pub(crate) async fn monitor_extract_quota(
    app: tauri::AppHandle,
    staged: std::path::PathBuf,
    max_bytes: u64,
    min_free_bytes: u64,
    finished: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let mut next_tree_scan = std::time::Instant::now();
    let mut poll_delay = std::time::Duration::from_millis(250);
    let mut first_poll = true;
    const TRANSIENT_FREE_SPACE_HEADROOM: u64 = 64 * 1024 * 1024;
    while !finished.load(std::sync::atomic::Ordering::Relaxed) {
        if !first_poll {
            tokio::time::sleep(poll_delay).await;
        }
        first_poll = false;
        if finished.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        // Free-space checks are constant-time and stay frequent. Full recursive scans are
        // adaptive so a very large extraction cannot spend most of its time repeatedly walking
        // the same tree; the mandatory pre-promotion scan remains the final authority.
        let free_path = staged.clone();
        let free_space = tokio::task::spawn_blocking(move || available_space(&free_path)).await;
        let low_space_reason = match free_space {
            Ok(Ok(bytes))
                if bytes
                    <= min_free_bytes.saturating_add(TRANSIENT_FREE_SPACE_HEADROOM) =>
            {
                Some(format!(
                    "Extraction stopped near its free-space reserve ({:.1} GiB plus transient headroom).",
                    min_free_bytes as f64 / 1_073_741_824.0
                ))
            }
            Ok(Err(error)) => Some(format!("Extraction disk-space check failed: {error}")),
            Err(error) => Some(format!("Extraction disk-space task failed: {error}")),
            Ok(Ok(_)) => None,
        };
        if let Some(reason) = low_space_reason {
            stop_extract_for_quota(&app, reason);
            break;
        }
        if std::time::Instant::now() < next_tree_scan {
            continue;
        }

        let scan_started = std::time::Instant::now();
        let scan_path = staged.clone();
        let scan = tokio::task::spawn_blocking(move || {
            staged_tree_usage(&scan_path, MAX_EXTRACT_ENTRIES, max_bytes)
        })
        .await;
        let reason = match scan {
            Ok(Err(reason)) => Some(reason),
            Err(error) => Some(format!("Extraction safety scan failed: {error}")),
            Ok(Ok((files, bytes))) => {
                // Poll aggressively near either limit. This reduces, but cannot
                // eliminate, transient overshoot while an external 7-Zip child
                // keeps writing between filesystem observations.
                let near_limit = files >= MAX_EXTRACT_ENTRIES.saturating_mul(3) / 4
                    || bytes >= max_bytes.saturating_mul(3) / 4;
                let under_half = files <= MAX_EXTRACT_ENTRIES / 2 && bytes <= max_bytes / 2;
                let (multiplier, min_delay, max_delay) = if near_limit {
                    poll_delay = std::time::Duration::from_millis(100);
                    (
                        1,
                        std::time::Duration::from_millis(250),
                        std::time::Duration::from_secs(1),
                    )
                } else if under_half {
                    poll_delay = std::time::Duration::from_millis(250);
                    (
                        8,
                        std::time::Duration::from_secs(2),
                        std::time::Duration::from_secs(15),
                    )
                } else {
                    poll_delay = std::time::Duration::from_millis(250);
                    (
                        3,
                        std::time::Duration::from_secs(1),
                        std::time::Duration::from_secs(5),
                    )
                };
                let scan_delay = scan_started
                    .elapsed()
                    .saturating_mul(multiplier)
                    .clamp(min_delay, max_delay);
                next_tree_scan = std::time::Instant::now() + scan_delay;
                None
            }
        };
        if let Some(reason) = reason {
            stop_extract_for_quota(&app, reason);
            break;
        }
    }
}

pub(crate) fn stop_extract_for_quota(app: &tauri::AppHandle, reason: String) {
    let state = app.state::<RunningProcess>();
    let child = match lock_process(&state) {
        Ok(mut process) => {
            process.cancelling = true;
            process.abort_reason = Some(reason);
            process.child.as_ref().map(std::sync::Arc::clone)
        }
        Err(_) => None,
    };
    if let Some(child) = child {
        if let Err(error) = terminate_registered_child(&state, &child) {
            if let Ok(mut process) = lock_process(&state) {
                let prior = process.abort_reason.take().unwrap_or_default();
                process.abort_reason = Some(if prior.is_empty() {
                    format!(
                        "Extraction exceeded a safety limit, but its process could not be stopped: {error}"
                    )
                } else {
                    format!("{prior}; process could not be stopped: {error}")
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::available_space_for_path;
    #[cfg(unix)]
    use super::staged_tree_usage;

    fn temp_root() -> std::path::PathBuf {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "zinnia-free-space-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos(),
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn free_space_probe_uses_an_existing_directory_ancestor() {
        let root = temp_root();
        std::fs::create_dir_all(&root).expect("root");
        let file = root.join("archive.7z");
        std::fs::write(&file, b"archive").expect("archive");

        assert!(available_space_for_path(&file).is_ok());
        assert!(available_space_for_path(&root.join("missing/output")).is_ok());

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn in_progress_quota_scan_allows_a_relative_link_before_its_target() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        std::fs::create_dir_all(&root).expect("root");
        symlink("target-created-later", root.join("pending-link")).expect("symlink");

        assert_eq!(
            staged_tree_usage(&root, 10, 1024).expect("in-progress scan"),
            (1, 0)
        );
        crate::path_safety::assert_relative_symlink_within_root(&root, &root.join("pending-link"))
            .expect("final validation accepts a contained dangling link");

        let _ = std::fs::remove_dir_all(root);
    }
}
