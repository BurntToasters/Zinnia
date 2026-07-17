//! Settings persistence with atomic writes; preserves reserved `_`-prefixed keys.

use tauri::Manager;

static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const MAX_SETTINGS_BYTES: usize = 512 * 1024;

fn lock_settings() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    SETTINGS_LOCK
        .lock()
        .map_err(|_| "Settings file lock poisoned".to_string())
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn backup_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

pub fn parse_json_object(json: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {e}"))?;
    match parsed {
        serde_json::Value::Object(map) => Ok(map),
        _ => Err("Settings JSON must be an object.".to_string()),
    }
}

pub fn merge_reserved_settings(
    existing: &serde_json::Map<String, serde_json::Value>,
    incoming: &mut serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in existing {
        if key.starts_with('_') && !incoming.contains_key(key) {
            incoming.insert(key.clone(), value.clone());
        }
    }
}

pub fn atomic_write_text(path: &std::path::Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name in path".to_string())?;
    use std::io::Write;
    let mut reserved = None;
    for _ in 0..32 {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|e| format!("Could not generate a secure temp file name: {e}"))?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let candidate = path.with_file_name(format!(".{file_name}.{token}.tmp"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => {
                reserved = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create a secure settings temp file: {error}"
                ));
            }
        }
    }
    let (tmp, mut file) =
        reserved.ok_or_else(|| "Could not reserve a unique settings temp file.".to_string())?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        if let Err(cleanup_error) = std::fs::remove_file(&tmp) {
            eprintln!(
                "Warning: could not clean up temp file {}: {cleanup_error}",
                tmp.display()
            );
        }
        return Err(error.to_string());
    }
    drop(file);

    #[cfg(windows)]
    {
        // On Windows, rename over existing file fails. Use a two-step approach:
        // rename existing to .bak, rename tmp to target, then remove .bak.
        // A recoverable .bak covers the short gap where the target does not exist.
        if path.exists() {
            let backup = backup_path(path);
            // A backup can be left by an interrupted previous promotion. The
            // current target is authoritative when it exists, so it is safe to
            // replace that stale recovery copy only after the new temp is durable.
            match std::fs::remove_file(&backup) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("Could not remove stale settings backup: {error}"));
                }
            }
            let backed_up = match std::fs::rename(path, &backup) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("Could not create settings backup: {error}"));
                }
            };
            if let Err(error) = std::fs::rename(&tmp, path) {
                let restore_error = if backed_up {
                    std::fs::rename(&backup, path).err()
                } else {
                    None
                };
                let _ = std::fs::remove_file(&tmp);
                return Err(match restore_error {
                    Some(restore_error) => format!(
                        "Could not promote settings: {error}; backup restore also failed: {restore_error}"
                    ),
                    None => format!("Could not promote settings: {error}"),
                });
            }
            if backed_up {
                std::fs::remove_file(&backup)
                    .map_err(|e| format!("Settings saved, but backup cleanup failed: {e}"))?;
            }
            return sync_parent_directory(path);
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
    })?;
    sync_parent_directory(path)
}

pub(crate) fn sync_parent_directory(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn reset_settings_file(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

fn reset_settings_files(path: &std::path::Path) -> Result<(), String> {
    reset_settings_file(path)?;
    reset_settings_file(&backup_path(path))?;
    sync_parent_directory(path)
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let _guard = lock_settings()?;
    let path = settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let backup = backup_path(&path);
            match std::fs::read_to_string(&backup) {
                Ok(contents) => {
                    // Recover the visible settings path when a Windows
                    // two-step replace was interrupted between renames.
                    std::fs::rename(&backup, &path).map_err(|e| {
                        format!("Settings backup exists but could not be restored: {e}")
                    })?;
                    Ok(contents)
                }
                Err(backup_err) if backup_err.kind() == std::io::ErrorKind::NotFound => {
                    Ok("{}".to_string())
                }
                Err(backup_err) => Err(backup_err.to_string()),
            }
        }
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _guard = lock_settings()?;
    if json.len() > MAX_SETTINGS_BYTES {
        return Err("Settings payload exceeds maximum allowed size.".to_string());
    }
    let path = settings_path(&app)?;

    let mut incoming = parse_json_object(&json)?;
    if path.exists() {
        let existing_raw = std::fs::read_to_string(&path).map_err(|e| {
            format!(
                "Failed to read existing settings for reserved-key preservation: {e}. \
                 Refusing to overwrite to avoid data loss."
            )
        })?;
        let existing = parse_json_object(&existing_raw).map_err(|e| {
            format!(
                "Existing settings file is corrupt ({e}). \
                 Refusing to overwrite to avoid losing reserved keys. \
                 Delete the file manually to reset."
            )
        })?;
        merge_reserved_settings(&existing, &mut incoming);
    }

    let merged = serde_json::Value::Object(incoming);
    let serialized = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
    atomic_write_text(&path, &serialized)
}

#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = lock_settings()?;
    let path = settings_path(&app)?;
    reset_settings_files(&path)
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
    fn reset_settings_file_deletes_existing_file_and_allows_missing() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-reset-settings-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("settings.json");
        std::fs::write(&file_path, r#"{"_setupComplete":true}"#)
            .expect("seed settings should be written");

        reset_settings_file(&file_path).expect("settings reset should delete file");
        assert!(!file_path.exists());
        reset_settings_file(&file_path).expect("missing settings file should be accepted");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn reset_settings_removes_recovery_backup_too() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-reset-backup-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("test directory");
        let path = base.join("settings.json");
        std::fs::write(&path, "{}").expect("settings");
        std::fs::write(backup_path(&path), "{}").expect("backup");
        reset_settings_files(&path).expect("reset settings and backup");
        assert!(!path.exists());
        assert!(!backup_path(&path).exists());
        let _ = std::fs::remove_dir_all(base);
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
}
