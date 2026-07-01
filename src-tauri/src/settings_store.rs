//! Settings persistence with atomic writes; preserves reserved `_`-prefixed keys.

use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

const MAX_SETTINGS_BYTES: usize = 512 * 1024;

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
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

    let seq = WRITE_SEQ.fetch_add(1, Ordering::SeqCst);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name in path".to_string())?;
    let tmp = path.with_file_name(format!(".{file_name}.{seq}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        // On Windows, rename over existing file fails. Use a two-step approach:
        // rename existing to .bak, rename tmp to target, then remove .bak.
        // This avoids the gap where the target doesn't exist.
        if path.exists() {
            let backup = path.with_extension("json.bak");
            // Remove any stale backup from a previous crash
            let _ = std::fs::remove_file(&backup);
            if let Err(e) = std::fs::rename(path, &backup) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Warning: could not backup existing file before rename: {e}");
                }
            }
            std::fs::rename(&tmp, path).map_err(|e| {
                // Attempt to restore from backup
                let _ = std::fs::rename(&backup, path);
                if let Err(cleanup_err) = std::fs::remove_file(&tmp) {
                    eprintln!(
                        "Warning: could not clean up temp file {}: {cleanup_err}",
                        tmp.display()
                    );
                }
                e.to_string()
            })?;
            let _ = std::fs::remove_file(&backup);
            return Ok(());
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

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
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
