//! Managed temp directories for multi-step operations (e.g. archive conversion).
//! Directories live under a single app-owned base so removal can be sandboxed:
//! `remove_managed_temp_dir` refuses any path outside that base.

use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn managed_base(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("convert"))
}

#[tauri::command]
pub fn create_temp_extract_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = managed_base(&app)?;
    let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = base.join(format!("tmp-{now}-{seq}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_managed_temp_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let base = managed_base(&app)?;
    let target = std::path::PathBuf::from(&path);

    // Refuse anything outside the managed base.
    let canonical_base = base.canonicalize().unwrap_or(base.clone());
    let canonical_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_target.starts_with(&canonical_base) {
        return Err("Refusing to remove a path outside the managed temp area.".to_string());
    }
    if !canonical_target.is_dir() {
        return Err("Temp path is not a directory.".to_string());
    }

    std::fs::remove_dir_all(&canonical_target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn starts_with_guards_outside_base() {
        let base = std::path::Path::new("/cache/convert");
        let inside = std::path::Path::new("/cache/convert/tmp-1");
        let outside = std::path::Path::new("/etc");
        assert!(inside.starts_with(base));
        assert!(!outside.starts_with(base));
    }
}
