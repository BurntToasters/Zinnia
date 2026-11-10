//! Settings persistence with atomic writes; only `_setupWizardVersion` is merged from disk.

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

/// Preferences for keeping Zinnia resident after quick-extract closes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuickExtractWarmPrefs {
    pub enabled: bool,
    pub idle_secs: u64,
}

impl Default for QuickExtractWarmPrefs {
    fn default() -> Self {
        Self {
            enabled: false,
            idle_secs: 10 * 60,
        }
    }
}

pub fn parse_quick_extract_warm_prefs(json: &str) -> QuickExtractWarmPrefs {
    let Ok(map) = parse_json_object(json) else {
        return QuickExtractWarmPrefs::default();
    };
    let enabled = map
        .get("quickExtractKeepWarm")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let minutes = map
        .get("quickExtractWarmIdleMinutes")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        })
        .unwrap_or(10);
    let minutes = match minutes {
        5 | 10 | 30 | 60 => minutes,
        _ => 10,
    };
    QuickExtractWarmPrefs {
        enabled,
        idle_secs: minutes.saturating_mul(60),
    }
}

/// Read warm-idle prefs from disk. Failures fall back to defaults.
pub fn quick_extract_warm_prefs(app: &tauri::AppHandle) -> QuickExtractWarmPrefs {
    let Ok(_guard) = lock_settings() else {
        return QuickExtractWarmPrefs::default();
    };
    let Ok(path) = settings_path(app) else {
        return QuickExtractWarmPrefs::default();
    };
    match read_bounded_settings_file(&path) {
        Ok(Some(raw)) => parse_quick_extract_warm_prefs(&raw),
        Ok(None) | Err(_) => QuickExtractWarmPrefs::default(),
    }
}

fn is_frontend_writable_reserved_key(key: &str) -> bool {
    key == "_setupWizardVersion"
}

/// Drop untrusted `_` keys from an incoming save so a first-run or hostile
/// payload cannot plant reserved state.
pub fn strip_untrusted_reserved_settings(
    incoming: &mut serde_json::Map<String, serde_json::Value>,
) {
    let hostile: Vec<String> = incoming
        .keys()
        .filter(|key| key.starts_with('_') && !is_frontend_writable_reserved_key(key))
        .cloned()
        .collect();
    for key in hostile {
        incoming.remove(&key);
    }
}

pub fn merge_reserved_settings(
    existing: &serde_json::Map<String, serde_json::Value>,
    incoming: &mut serde_json::Map<String, serde_json::Value>,
) {
    strip_untrusted_reserved_settings(incoming);
    for (key, value) in existing {
        if !key.starts_with('_') {
            continue;
        }
        // Only `_setupWizardVersion` is carried forward from disk when absent
        // from the incoming payload. Other legacy `_` keys are dropped on save.
        if is_frontend_writable_reserved_key(key) && !incoming.contains_key(key) {
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
        .map_err(|error| error.to_string())
        .and_then(|()| crate::fs_secure::sync_file_best_effort(&file))
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

    // `std::fs::rename` replaces an existing destination on every platform we
    // ship for, including Windows: it calls `MoveFileExW` with
    // `MOVEFILE_REPLACE_EXISTING` and falls back to `FileRenameInfoEx` with
    // `POSIX_SEMANTICS` on access-denied. A separate rename-to-.bak dance is
    // unnecessary and was itself a durability hazard: it left a window where
    // the settings path did not exist, and treated backup-file cleanup
    // failure as an overall failure even though the new settings were already
    // durably in place by that point.
    std::fs::rename(&tmp, path).map_err(|e| {
        if let Err(cleanup_err) = std::fs::remove_file(&tmp) {
            eprintln!(
                "Warning: could not clean up temp file {}: {cleanup_err}",
                tmp.display()
            );
        }
        e.to_string()
    })?;
    tolerate_post_rename_sync(sync_parent_directory(path))
}

pub(crate) fn sync_parent_directory(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        crate::fs_secure::sync_directory(parent)?;
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

fn read_bounded_settings_file(path: &std::path::Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err("Settings path is not a regular file.".to_string());
    }
    if metadata.len() > MAX_SETTINGS_BYTES as u64 {
        return Err("Settings file exceeds maximum allowed size.".to_string());
    }
    let file = crate::path_safety::open_regular_file_nofollow(path)?;
    let mut raw = String::new();
    use std::io::Read as _;
    file.take((MAX_SETTINGS_BYTES + 1) as u64)
        .read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    if raw.len() > MAX_SETTINGS_BYTES {
        return Err("Settings file exceeds maximum allowed size.".to_string());
    }
    Ok(Some(raw))
}

#[tauri::command(async)]
pub fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let _guard = lock_settings()?;
    let path = settings_path(&app)?;
    match read_bounded_settings_file(&path)? {
        Some(contents) => Ok(contents),
        None => Ok("{}".to_string()),
    }
}

/// Format a UTC instant as `YYYYMMDDTHHMMSSZ` for quarantine file names.
fn utc_compact_timestamp(now: std::time::SystemTime) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Move an unparsable settings file aside as `settings.json.corrupt-<UTC>`.
/// A same-second collision gets a numeric suffix instead of overwriting.
fn quarantine_unparsable_settings(
    path: &std::path::Path,
    now: std::time::SystemTime,
) -> Result<std::path::PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name in path".to_string())?;
    let stamp = utc_compact_timestamp(now);
    for attempt in 0..1000u32 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let target = path.with_file_name(format!("{file_name}.corrupt-{stamp}{suffix}"));
        if std::fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        std::fs::rename(path, &target).map_err(|e| e.to_string())?;
        return Ok(target);
    }
    Err("Could not find a free name for the unreadable settings file.".to_string())
}

/// The rename has already put the new settings in place, so a failed
/// directory sync is logged and the save still reports success.
fn tolerate_post_rename_sync(result: Result<(), String>) -> Result<(), String> {
    if let Err(error) = result {
        eprintln!("Warning: settings were saved but the folder sync failed: {error}");
    }
    Ok(())
}

/// Merge an incoming payload into the settings file at `path`.
fn save_settings_to_path(
    path: &std::path::Path,
    json: &str,
    now: std::time::SystemTime,
) -> Result<(), String> {
    if json.len() > MAX_SETTINGS_BYTES {
        return Err("Settings payload exceeds maximum allowed size.".to_string());
    }
    let mut incoming = parse_json_object(json)?;
    match read_bounded_settings_file(path).map_err(|e| {
        format!(
            "Failed to read existing settings for reserved-key preservation: {e}. \
             Refusing to overwrite to avoid data loss."
        )
    })? {
        None => {
            // First save: still reject planted backend-owned `_` keys.
            strip_untrusted_reserved_settings(&mut incoming);
        }
        Some(existing_raw) => match serde_json::from_str::<serde_json::Value>(&existing_raw) {
            Ok(serde_json::Value::Object(existing)) => {
                merge_reserved_settings(&existing, &mut incoming);
            }
            _ => {
                // Unparsable, or valid JSON that is not an object: there are no
                // reserved keys to keep, so move the file aside and start over.
                let moved = quarantine_unparsable_settings(path, now)?;
                eprintln!(
                    "Warning: settings.json could not be read; moved it to {} and wrote new settings.",
                    moved.display()
                );
                strip_untrusted_reserved_settings(&mut incoming);
            }
        },
    }

    let merged = serde_json::Value::Object(incoming);
    let serialized = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
    atomic_write_text(path, &serialized)
}

#[tauri::command(async)]
pub fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _guard = lock_settings()?;
    let path = settings_path(&app)?;
    save_settings_to_path(&path, &json, std::time::SystemTime::now())
}

#[tauri::command(async)]
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
        std::fs::write(&file_path, r#"{"theme":"dark"}"#).expect("seed settings should be written");

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

    fn scratch_settings_dir(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "zinnia-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("scratch directory should be created");
        base
    }

    fn epoch_plus(secs: u64) -> std::time::SystemTime {
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs)
    }

    #[test]
    fn utc_compact_timestamp_formats_known_instants() {
        assert_eq!(utc_compact_timestamp(epoch_plus(0)), "19700101T000000Z");
        assert_eq!(
            utc_compact_timestamp(epoch_plus(1_709_164_800)),
            "20240229T000000Z"
        );
        assert_eq!(
            utc_compact_timestamp(epoch_plus(1_794_227_696)),
            "20261109T123456Z"
        );
    }

    #[test]
    fn quarantine_moves_unparsable_file_and_never_overwrites_a_previous_one() {
        let base = scratch_settings_dir("quarantine");
        let path = base.join("settings.json");
        std::fs::write(&path, "{ bad").expect("seed file should be written");

        let first = quarantine_unparsable_settings(&path, epoch_plus(1_794_227_696))
            .expect("quarantine should succeed");
        assert!(!path.exists(), "original settings path should be vacated");
        let first_name = first
            .file_name()
            .and_then(|n| n.to_str())
            .expect("quarantine name should be UTF-8")
            .to_string();
        assert!(
            first_name.starts_with("settings.json.corrupt-20261109T123456Z"),
            "unexpected quarantine name {first_name}"
        );
        assert_eq!(
            std::fs::read_to_string(&first).expect("quarantined"),
            "{ bad"
        );

        std::fs::write(&path, "{ worse").expect("second seed should be written");
        let second = quarantine_unparsable_settings(&path, epoch_plus(1_794_227_696))
            .expect("second quarantine should succeed");
        assert_ne!(first, second, "a same-second quarantine must not overwrite");
        assert_eq!(
            std::fs::read_to_string(&first).expect("first kept"),
            "{ bad"
        );
        assert_eq!(std::fs::read_to_string(&second).expect("second"), "{ worse");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn save_over_unparsable_file_quarantines_it_and_writes_new_settings() {
        let base = scratch_settings_dir("corrupt-save");
        let path = base.join("settings.json");
        std::fs::write(&path, "{ bad").expect("seed file should be written");

        save_settings_to_path(
            &path,
            r#"{"theme":"dark","_setupWizardVersion":3}"#,
            epoch_plus(1_794_227_696),
        )
        .expect("save over a corrupt file should succeed");

        let saved = std::fs::read_to_string(&path).expect("settings readable");
        assert!(saved.contains("\"theme\":\"dark\""), "saved: {saved}");
        // The bad file is unparsable, so there is no reserved key to keep;
        // the incoming payload's own value is what gets written.
        assert!(saved.contains("\"_setupWizardVersion\":3"));
        let quarantined: Vec<_> = std::fs::read_dir(&base)
            .expect("dir readable")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("settings.json.corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1, "expected one quarantined file");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn save_over_valid_file_keeps_wizard_version_and_does_not_quarantine() {
        let base = scratch_settings_dir("valid-save");
        let path = base.join("settings.json");
        std::fs::write(&path, r#"{"theme":"light","_setupWizardVersion":2}"#)
            .expect("seed file should be written");

        save_settings_to_path(&path, r#"{"theme":"dark"}"#, epoch_plus(1_794_227_696))
            .expect("valid save should succeed");

        let saved = std::fs::read_to_string(&path).expect("settings readable");
        assert!(
            saved.contains("\"_setupWizardVersion\":2"),
            "saved: {saved}"
        );
        assert!(saved.contains("\"theme\":\"dark\""));
        let names: Vec<_> = std::fs::read_dir(&base)
            .expect("dir readable")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(!names.iter().any(|n| n.contains("corrupt")));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn save_quarantines_valid_json_that_is_not_an_object() {
        let base = scratch_settings_dir("array-save");
        let path = base.join("settings.json");
        std::fs::write(&path, "[1,2]").expect("seed file should be written");

        save_settings_to_path(&path, r#"{"theme":"dark"}"#, epoch_plus(1_794_227_696))
            .expect("save over a non-object file should succeed");

        assert_eq!(
            std::fs::read_to_string(&path).expect("settings readable"),
            r#"{"theme":"dark"}"#
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn post_rename_directory_sync_failure_still_reports_success() {
        let result = tolerate_post_rename_sync(Err("fsync denied".to_string()));
        assert!(result.is_ok(), "rename already committed the new settings");
        assert!(tolerate_post_rename_sync(Ok(())).is_ok());
    }

    #[test]
    fn parse_quick_extract_warm_prefs_defaults_and_clamps() {
        assert_eq!(
            parse_quick_extract_warm_prefs("{}"),
            QuickExtractWarmPrefs::default()
        );
        assert!(!QuickExtractWarmPrefs::default().enabled);
        assert_eq!(
            parse_quick_extract_warm_prefs(
                r#"{"quickExtractKeepWarm":true,"quickExtractWarmIdleMinutes":30}"#
            ),
            QuickExtractWarmPrefs {
                enabled: true,
                idle_secs: 30 * 60,
            }
        );
        assert_eq!(
            parse_quick_extract_warm_prefs(r#"{"quickExtractWarmIdleMinutes":7}"#).idle_secs,
            10 * 60
        );
        assert_eq!(
            parse_quick_extract_warm_prefs(r#"{"quickExtractWarmIdleMinutes":"60"}"#).idle_secs,
            60 * 60
        );
    }

    #[test]
    fn strip_untrusted_reserved_settings_drops_planted_backend_keys() {
        let mut incoming = parse_json_object(
            r#"{"theme":"light","_integrationAutoEnabled":true,"_setupWizardVersion":2}"#,
        )
        .expect("incoming object should parse");
        strip_untrusted_reserved_settings(&mut incoming);
        assert!(incoming.get("_integrationAutoEnabled").is_none());
        assert_eq!(
            incoming.get("_setupWizardVersion"),
            Some(&serde_json::Value::Number(2.into()))
        );
    }

    #[test]
    fn merge_reserved_settings_drops_legacy_reserved_keys_from_existing() {
        let existing = parse_json_object(
            r#"{"theme":"dark","_integrationAutoEnabled":true,"_integrationUserDisabled":true,"_setupComplete":true}"#,
        )
        .expect("existing object should parse");
        let mut incoming =
            parse_json_object(r#"{"theme":"light","_integrationAutoEnabled":false}"#)
                .expect("incoming object should parse");

        merge_reserved_settings(&existing, &mut incoming);

        assert_eq!(
            incoming.get("theme"),
            Some(&serde_json::Value::String("light".to_string()))
        );
        assert!(incoming.get("_integrationAutoEnabled").is_none());
        assert!(incoming.get("_integrationUserDisabled").is_none());
        assert!(incoming.get("_setupComplete").is_none());
    }

    #[test]
    fn merge_reserved_settings_carries_setup_wizard_version_only() {
        let existing =
            parse_json_object(r#"{"_integrationAutoEnabled":true,"_setupWizardVersion":1}"#)
                .expect("existing object should parse");
        let mut incoming_with_version =
            parse_json_object(r#"{"theme":"system","_setupWizardVersion":3}"#)
                .expect("incoming object should parse");

        merge_reserved_settings(&existing, &mut incoming_with_version);

        assert!(incoming_with_version
            .get("_integrationAutoEnabled")
            .is_none());
        assert_eq!(
            incoming_with_version.get("_setupWizardVersion"),
            Some(&serde_json::Value::Number(3.into()))
        );

        let mut incoming_without_version =
            parse_json_object(r#"{"theme":"system"}"#).expect("incoming object should parse");
        merge_reserved_settings(&existing, &mut incoming_without_version);
        assert_eq!(
            incoming_without_version.get("_setupWizardVersion"),
            Some(&serde_json::Value::Number(1.into()))
        );
    }
}
