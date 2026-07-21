//! Managed temp directories for multi-step operations (e.g. archive conversion).
//! Directories live under a single app-owned base so removal can be sandboxed:
//! `remove_managed_temp_dir` refuses any path outside that base.

use tauri::Manager;

fn managed_base(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("convert"))
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
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
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

    std::fs::remove_dir_all(&canonical_target).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_managed_temp_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || remove_managed_temp_dir_blocking(&app, &path))
        .await
        .map_err(|error| format!("Temp-directory cleanup worker failed: {error}"))?
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
}
