//! Managed temp directories for multi-step operations (e.g. archive conversion).
//! Directories live under a single app-owned base so removal can be sandboxed:
//! `remove_managed_temp_dir` refuses any path outside that base.

use tauri::Manager;

fn managed_base(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("convert"))
}

/// If `path` lives under a managed `convert/tmp-*` directory, return that tmp root.
/// Used so convert recompress can store top-level symlink members with `-snl`.
pub fn managed_convert_tmp_root_for(
    app: &tauri::AppHandle,
    path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let base = managed_base(app).ok()?;
    let mut cursor = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    // Include the path itself when it is the tmp root.
    loop {
        let name = cursor.file_name()?.to_string_lossy();
        if name.starts_with("tmp-") && name.len() > 4 {
            let parent = cursor.parent()?;
            if parent == base
                || parent
                    .canonicalize()
                    .ok()
                    .zip(base.canonicalize().ok())
                    .is_some_and(|(p, b)| p == b)
            {
                return Some(cursor);
            }
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

/// Best-effort cleanup for conversion directories left behind by a crash or a
/// forced shutdown. Only direct `tmp-*` children older than 24 hours are
/// considered; symlinks and anything outside the managed base are ignored.
pub fn cleanup_stale_temp_dirs(app: &tauri::AppHandle) -> Result<(), String> {
    let base = managed_base(app)?;
    let entries = match std::fs::read_dir(&base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let max_age = std::time::Duration::from_secs(24 * 60 * 60);
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("tmp-") {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
            continue;
        }
        let old_enough = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= max_age);
        if old_enough {
            // Use the hardened cleanup helper (clears Windows read-only
            // attributes first and refuses to traverse a link/reparse point)
            // rather than a bare `remove_dir_all`.
            let _ = crate::fs_secure::remove_dir_all_for_cleanup(&entry.path());
        }
    }
    Ok(())
}

/// Age past which orphaned launch-handoff temp material is considered safe to
/// remove. Both the Windows shell handoff file and the private 7-Zip
/// selection-list directory are normally consumed and deleted within seconds
/// of being created; anything this old was orphaned by a hard kill / crash
/// between creation and consumption.
const STALE_LAUNCH_TEMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

fn is_older_than(metadata: &std::fs::Metadata, max_age: std::time::Duration) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age >= max_age)
}

/// Remove `%TEMP%\zinnia-shell-handoff-*.tmp` files left behind when Zinnia is
/// killed between the Windows shell extension writing a handoff and the app
/// consuming it (see `launch::open_routing::load_shell_handoff`). Every
/// candidate is opened without following a final-component link/reparse point
/// and its owner is verified against the current user before removal, so this
/// can never delete another user's file even if `%TEMP%` were ever shared.
#[cfg(windows)]
fn sweep_stale_shell_handoffs() {
    const PREFIX: &str = "zinnia-shell-handoff-";
    const SUFFIX: &str = ".tmp";

    let temp = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&temp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(PREFIX) || !name.ends_with(SUFFIX) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
            continue;
        }
        if !is_older_than(&metadata, STALE_LAUNCH_TEMP_MAX_AGE) {
            continue;
        }
        let Ok(file) = crate::path_safety::open_regular_file_nofollow_for_snapshot(&path) else {
            continue;
        };
        if crate::fs_secure::assert_handle_owned_by_current_user(&file).is_err() {
            continue;
        }
        drop(file);
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "Could not remove an orphaned Windows shell handoff {}: {error}",
                    path.display()
                );
            }
        }
    }
}

/// Remove `%TEMP%/zinnia-7z-list-*` directories left behind when Zinnia is
/// killed while a `run_7z` invocation's private selection-list directory
/// (`process::commands::ManagedListFile`) is still open; its `Drop` impl never
/// runs on a hard kill.
fn sweep_stale_7z_list_dirs() {
    const PREFIX: &str = "zinnia-7z-list-";

    let temp = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&temp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(PREFIX) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() {
            continue;
        }
        if !is_older_than(&metadata, STALE_LAUNCH_TEMP_MAX_AGE) {
            continue;
        }
        // Only remove our own leftover directories. On unix the shared temp
        // dir has sticky-bit protection, but a same-user planted prefix must
        // still not be walked/deleted by us.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let uid = unsafe { libc::geteuid() };
            if metadata.uid() != uid || metadata.gid() != unsafe { libc::getegid() } {
                continue;
            }
        }
        if let Err(error) = crate::fs_secure::remove_dir_all_for_cleanup(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "Could not remove an orphaned 7-Zip list directory {}: {error}",
                    path.display()
                );
            }
        }
    }
}

/// Best-effort startup sweep for launch-handoff temp material orphaned by a
/// crash or hard kill between creation and normal (short-lived) consumption.
/// Never fails the caller; every step is independently best-effort.
pub fn sweep_stale_launch_temp_files() {
    #[cfg(windows)]
    sweep_stale_shell_handoffs();
    sweep_stale_7z_list_dirs();
}

#[tauri::command]
pub fn create_temp_extract_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = managed_base(&app)?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    for _ in 0..32 {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let dir = base.join(format!("tmp-{token}"));
        match crate::fs_secure::create_private_dir(&dir) {
            Ok(()) => return Ok(dir.to_string_lossy().to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a unique conversion directory.".to_string())
}

fn is_direct_managed_child(base: &std::path::Path, target: &std::path::Path) -> bool {
    target.parent() == Some(base)
        && target
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("tmp-") && name.len() > 4)
}

fn remove_managed_temp_dir_blocking(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let base = managed_base(app)?;
    let target = std::path::PathBuf::from(path);

    let raw_meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    crate::path_safety::reject_link_or_reparse(&target, &raw_meta)
        .map_err(|_| "Temp path cannot be a symbolic link or reparse point.".to_string())?;

    // Refuse anything outside the managed base.
    let canonical_base = base.canonicalize().unwrap_or(base.clone());
    let canonical_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !is_direct_managed_child(&canonical_base, &canonical_target) {
        return Err("Refusing to remove a path outside the managed temp area.".to_string());
    }
    if !canonical_target.is_dir() {
        return Err("Temp path is not a directory.".to_string());
    }

    crate::fs_secure::remove_dir_all_for_cleanup(&canonical_target).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_managed_temp_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || remove_managed_temp_dir_blocking(&app, &path))
        .await
        .map_err(|error| format!("Temp-directory cleanup worker failed: {error}"))?
}

/// List direct children of a managed conversion temp dir (includes dotfiles).
#[tauri::command]
pub fn list_managed_temp_children(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<String>, String> {
    let base = managed_base(&app)?;
    let target = std::path::PathBuf::from(&path);
    let raw_meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    crate::path_safety::reject_link_or_reparse(&target, &raw_meta)
        .map_err(|_| "Temp path cannot be a symbolic link or reparse point.".to_string())?;
    let canonical_base = base.canonicalize().unwrap_or(base.clone());
    let canonical_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !is_direct_managed_child(&canonical_base, &canonical_target) {
        return Err("Refusing to list a path outside the managed temp area.".to_string());
    }
    if !canonical_target.is_dir() {
        return Err("Temp path is not a directory.".to_string());
    }
    let mut children = Vec::new();
    for entry in std::fs::read_dir(&canonical_target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        children.push(entry.path().to_string_lossy().to_string());
    }
    children.sort();
    Ok(children)
}

#[cfg(test)]
mod tests {
    use super::is_direct_managed_child;

    #[test]
    fn starts_with_guards_outside_base() {
        let base = std::path::Path::new("/cache/convert");
        let inside = std::path::Path::new("/cache/convert/tmp-1");
        let outside = std::path::Path::new("/etc");
        assert!(inside.starts_with(base));
        assert!(!outside.starts_with(base));
    }

    #[test]
    fn removal_scope_requires_a_named_direct_child() {
        let base = std::path::Path::new("/cache/convert");
        assert!(!is_direct_managed_child(base, base));
        assert!(is_direct_managed_child(
            base,
            std::path::Path::new("/cache/convert/tmp-random")
        ));
        assert!(!is_direct_managed_child(
            base,
            std::path::Path::new("/cache/convert/tmp-random/nested")
        ));
        assert!(!is_direct_managed_child(
            base,
            std::path::Path::new("/cache/convert/unrelated")
        ));
    }

    #[test]
    fn convert_tmp_root_naming_walk_finds_tmp_ancestor() {
        use std::path::Path;
        let path = Path::new("/cache/convert/tmp-abc123/link");
        let mut cursor = path.to_path_buf();
        let mut found = None;
        loop {
            let name = cursor.file_name().unwrap().to_string_lossy();
            if name.starts_with("tmp-")
                && name.len() > 4
                && cursor.parent() == Some(Path::new("/cache/convert"))
            {
                found = Some(cursor.clone());
                break;
            }
            if !cursor.pop() {
                break;
            }
        }
        assert_eq!(
            found,
            Some(Path::new("/cache/convert/tmp-abc123").to_path_buf())
        );
    }
}
