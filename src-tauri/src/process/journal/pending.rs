//! Pending transaction stages registry and orphan cleanup.

use tauri::Manager;

use crate::process::CleanupPlan;

use super::cleanup_journal::{
    cleanup_transaction_artifacts, move_identity_log_path, move_plan_path,
    read_bounded_nofollow_text,
};
use super::identity::{ensure_path_identity, file_identities_match, FileIdentity};
use super::MAX_PENDING_STAGES_BYTES;
pub(crate) fn pending_stages_path(cache_dir: &std::path::Path) -> std::path::PathBuf {
    cache_dir.join("pending-stages.json")
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct PendingStageRecord {
    path: String,
    identity: FileIdentity,
    #[serde(default)]
    move_plan_identity: Option<FileIdentity>,
    #[serde(default)]
    move_identity_log_identity: Option<FileIdentity>,
    #[serde(default)]
    archive_backup_identities: Vec<Option<FileIdentity>>,
}

impl PendingStageRecord {
    fn path(&self) -> &str {
        &self.path
    }
}

fn read_pending_stage_records(
    cache_dir: &std::path::Path,
) -> Result<Vec<PendingStageRecord>, String> {
    let path = pending_stages_path(cache_dir);
    let Some(json) = read_bounded_nofollow_text(&path, MAX_PENDING_STAGES_BYTES)? else {
        return Ok(Vec::new());
    };
    let values: Vec<serde_json::Value> = match serde_json::from_str(&json) {
        Ok(values) => values,
        Err(_) => return Ok(Vec::new()),
    };
    if values.len() > 10_000 {
        return Err("Pending-stage registry exceeds its record safety limit.".to_string());
    }
    let mut records = Vec::with_capacity(values.len());
    for value in values {
        if let Ok(record) = serde_json::from_value::<PendingStageRecord>(value) {
            records.push(record);
        }
    }
    Ok(records)
}

#[cfg(test)]
pub(crate) fn read_pending_stages(cache_dir: &std::path::Path) -> Result<Vec<String>, String> {
    Ok(read_pending_stage_records(cache_dir)?
        .into_iter()
        .map(|record| record.path().to_string())
        .collect())
}

fn write_pending_stage_records(
    cache_dir: &std::path::Path,
    stages: &[PendingStageRecord],
) -> Result<(), String> {
    let path = pending_stages_path(cache_dir);
    if stages.is_empty() {
        crate::fs_secure::remove_regular_file_nofollow_if_exists(&path)
            .map(|_| ())
            .map_err(|error| error.to_string())
    } else {
        let json = serde_json::to_string(stages).map_err(|error| error.to_string())?;
        if json.len() as u64 > MAX_PENDING_STAGES_BYTES {
            return Err("Pending-stage registry exceeds its byte safety limit.".to_string());
        }
        crate::settings_store::atomic_write_text(&path, &json)
    }
}

pub(crate) fn register_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    identity: &FileIdentity,
) -> Result<(), String> {
    ensure_path_identity(stage, identity).map_err(|error| {
        format!(
            "Newly created stage {} changed before pending-stage registration: {error}",
            stage.display()
        )
    })?;
    let key = stage.to_string_lossy().to_string();
    let identity = identity.clone();
    let mut stages = read_pending_stage_records(cache_dir)?;
    if let Some(existing) = stages.iter_mut().find(|record| record.path() == key) {
        *existing = PendingStageRecord {
            path: key,
            identity,
            move_plan_identity: None,
            move_identity_log_identity: None,
            archive_backup_identities: Vec::new(),
        };
    } else {
        stages.push(PendingStageRecord {
            path: key,
            identity,
            move_plan_identity: None,
            move_identity_log_identity: None,
            archive_backup_identities: Vec::new(),
        });
    }
    write_pending_stage_records(cache_dir, &stages)
}

fn pending_record_mut<'a>(
    records: &'a mut [PendingStageRecord],
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
) -> Result<&'a mut PendingStageRecord, String> {
    ensure_path_identity(stage, expected_stage_identity).map_err(|error| {
        format!("Transaction stage changed before its pending recovery record was updated: {error}")
    })?;
    let key = stage.to_string_lossy();
    let record = records
        .iter_mut()
        .find(|record| record.path() == key)
        .ok_or_else(|| {
            "Pending-stage recovery record disappeared during publication.".to_string()
        })?;
    if !file_identities_match(&record.identity, expected_stage_identity) {
        return Err("Pending-stage recovery record changed stage identity.".to_string());
    }
    Ok(record)
}

pub(crate) fn record_pending_move_plan_identity(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    artifact_identity: &FileIdentity,
) -> Result<(), String> {
    let mut records = read_pending_stage_records(cache_dir)?;
    let record = pending_record_mut(&mut records, stage, expected_stage_identity)?;
    record.move_plan_identity = Some(artifact_identity.clone());
    write_pending_stage_records(cache_dir, &records)
}

pub(crate) fn record_pending_move_identity_log_identity(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    artifact_identity: &FileIdentity,
) -> Result<(), String> {
    let mut records = read_pending_stage_records(cache_dir)?;
    let record = pending_record_mut(&mut records, stage, expected_stage_identity)?;
    record.move_identity_log_identity = Some(artifact_identity.clone());
    write_pending_stage_records(cache_dir, &records)
}

pub(crate) fn record_pending_archive_backup_identity(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    index: usize,
    backup_count: usize,
    artifact_identity: &FileIdentity,
) -> Result<(), String> {
    let mut records = read_pending_stage_records(cache_dir)?;
    let record = pending_record_mut(&mut records, stage, expected_stage_identity)?;
    if record.archive_backup_identities.is_empty() {
        record.archive_backup_identities.resize(backup_count, None);
    }
    if record.archive_backup_identities.len() != backup_count || index >= backup_count {
        return Err("Pending-stage archive backup identities are not index-aligned.".to_string());
    }
    record.archive_backup_identities[index] = Some(artifact_identity.clone());
    write_pending_stage_records(cache_dir, &records)
}

type PendingArtifactIdentities = (
    Option<FileIdentity>,
    Option<FileIdentity>,
    Vec<Option<FileIdentity>>,
);

pub(crate) fn pending_artifact_identities(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
) -> Result<PendingArtifactIdentities, String> {
    let key = stage.to_string_lossy();
    let records = read_pending_stage_records(cache_dir)?;
    let record = records
        .iter()
        .find(|record| record.path() == key)
        .ok_or_else(|| "Pending-stage recovery record disappeared before cleanup.".to_string())?;
    if !file_identities_match(&record.identity, expected_stage_identity) {
        return Err("Pending-stage recovery record changed stage identity.".to_string());
    }
    Ok((
        record.move_plan_identity.clone(),
        record.move_identity_log_identity.clone(),
        record.archive_backup_identities.clone(),
    ))
}

pub(crate) fn unregister_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
) -> Result<(), String> {
    let key = stage.to_string_lossy().to_string();
    let mut stages = read_pending_stage_records(cache_dir)?;
    let before = stages.len();
    stages.retain(|existing| existing.path() != key);
    if stages.len() != before {
        write_pending_stage_records(cache_dir, &stages)?;
    }
    Ok(())
}

pub(crate) fn plan_stage_dirs(plan: &CleanupPlan) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some((staged, _)) = &plan.staged_extract {
        dirs.push(staged.clone());
    }
    if let Some((staged, _)) = &plan.staged_archive {
        if let Some(parent) = staged.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    if let Some(staged) = &plan.staged_input_archive {
        if let Some(parent) = staged.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    dirs
}

pub(crate) fn unregister_plan_stages_strict(plan: &CleanupPlan) -> Result<(), String> {
    let Some(cache_dir) = &plan.cache_dir else {
        return Ok(());
    };
    let mut failures = Vec::new();
    for stage in plan_stage_dirs(plan) {
        match transaction_artifacts_present(&stage) {
            Ok(false) => {
                if let Err(error) = unregister_pending_stage(cache_dir, &stage) {
                    failures.push(format!(
                        "Could not unregister cleaned stage {}: {error}",
                        stage.display()
                    ));
                }
            }
            Ok(true) => failures.push(format!(
                "Cleaned stage still exists and remains registered: {}",
                stage.display()
            )),
            Err(error) => failures.push(format!(
                "Could not verify cleaned stage {} before unregistering it: {error}",
                stage.display()
            )),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub(crate) fn unregister_plan_stages(plan: &CleanupPlan) {
    let Some(cache_dir) = &plan.cache_dir else {
        return;
    };
    for stage in plan_stage_dirs(plan) {
        // After successful publish, promote may leave the stage (undeletable
        // backup-* / PermissionDenied). Keep the pending registration so
        // cleanup_orphan_stages can retry on the next launch; never drop
        // tracking while the directory may still exist.
        match transaction_artifacts_present(&stage) {
            Ok(false) => {
                let _ = unregister_pending_stage(cache_dir, &stage);
            }
            Ok(true) => {
                eprintln!(
                    "Keeping pending-stage registration for {}; startup orphan cleanup will retry.",
                    stage.display()
                );
            }
            Err(error) => {
                eprintln!(
                    "Keeping pending-stage registration for {} (could not probe: {error}).",
                    stage.display()
                );
            }
        }
    }
}

fn transaction_artifacts_present(stage: &std::path::Path) -> Result<bool, String> {
    for path in [
        stage.to_path_buf(),
        move_plan_path(stage),
        move_identity_log_path(stage),
    ] {
        match std::fs::symlink_metadata(&path) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let parent = stage
        .parent()
        .ok_or_else(|| "Transaction stage has no parent directory.".to_string())?;
    let stage_name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Transaction stage has an invalid name.".to_string())?;
    let prefix = format!("{stage_name}.backup-");
    for entry in std::fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Remove stage directories left behind when a crash happened after create but
/// before (or without) a durable transaction journal. Safe names only.
pub fn cleanup_orphan_stages(app: &tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    cleanup_orphan_stages_in(&cache_dir)
}

#[cfg(test)]
pub(crate) fn cleanup_orphan_stages_at(cache_dir: &std::path::Path) -> Result<(), String> {
    cleanup_orphan_stages_in(cache_dir)
}

fn cleanup_orphan_stages_in(cache_dir: &std::path::Path) -> Result<(), String> {
    let stages = read_pending_stage_records(cache_dir)?;
    if stages.is_empty() {
        return Ok(());
    }
    let mut remaining = Vec::new();
    for stage in stages {
        let path = std::path::PathBuf::from(stage.path());
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !is_safe_stage_dir_name(name) {
            remaining.push(stage);
            continue;
        }
        let cleanup = cleanup_transaction_artifacts(
            &path,
            Some(&stage.identity),
            stage.move_plan_identity.as_ref(),
            stage.move_identity_log_identity.as_ref(),
            &stage.archive_backup_identities,
        );
        if let Err(error) = cleanup {
            eprintln!(
                "Keeping pending transaction artifacts for {} because cleanup failed closed: {error}",
                path.display()
            );
            remaining.push(stage);
        }
    }
    write_pending_stage_records(cache_dir, &remaining)
}
pub(crate) fn is_safe_stage_dir_name(name: &str) -> bool {
    for prefix in [".zinnia-extract-", ".zinnia-archive-", ".zinnia-input-"] {
        if let Some(token) = name.strip_prefix(prefix) {
            return token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit());
        }
    }
    // Accept pre-B16 stage names for safe startup recovery.
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    for marker in [".zinnia-extract-", ".zinnia-archive-", ".zinnia-input-"] {
        if let Some(idx) = rest.rfind(marker) {
            let token = &rest[idx + marker.len()..];
            return token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit());
        }
    }
    false
}
