//! Cleanup journal I/O, pending-stages registry, and orphan stage cleanup.

use tauri::Manager;

use super::commit::{archive_destination_for, archive_family};
use super::staging::path_entry_exists;
use super::CleanupPlan;

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct CleanupJournal {
    pub(crate) stage: std::path::PathBuf,
    pub(crate) destination: std::path::PathBuf,
    pub(crate) archive: bool,
    /// Newer extracts keep their move plan beside the stage. False means a
    /// legacy journal that may need the old in-payload recovery location.
    #[serde(default)]
    pub(crate) move_plan_sidecar: bool,
    pub(crate) previous_archive_family: Vec<std::path::PathBuf>,
    #[serde(default)]
    pub(crate) next_archive_family: Vec<std::path::PathBuf>,
    /// Explicit phase for B16+ archive transactions. `None` identifies a
    /// legacy journal whose completion must be inferred for compatibility.
    #[serde(default)]
    pub(crate) archive_phase: Option<ArchiveJournalPhase>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArchiveJournalPhase {
    InProgress,
    Committed,
}

/// Legacy in-payload location, retained only to recover transactions created
/// by older betas. New plans are always stored beside the private stage.
pub(crate) const LEGACY_MOVE_PLAN_FILE_NAME: &str = "move-plan.json";

pub(crate) fn move_plan_path(stage: &std::path::Path) -> std::path::PathBuf {
    let name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".zinnia-extract-unknown");
    stage.with_file_name(format!("{name}.move-plan.json"))
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct MoveRecord {
    pub(crate) source: std::path::PathBuf,
    pub(crate) target: std::path::PathBuf,
}

pub(crate) fn cleanup_journal_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("active-transaction.json"))
}

pub(crate) fn write_cleanup_journal(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<bool, String> {
    let journal = if let Some((stage, destination)) = &plan.staged_extract {
        Some(CleanupJournal {
            stage: stage.clone(),
            destination: destination.clone(),
            archive: false,
            move_plan_sidecar: true,
            previous_archive_family: Vec::new(),
            next_archive_family: Vec::new(),
            archive_phase: None,
        })
    } else if let Some((staged_archive, destination)) = &plan.staged_archive {
        Some(CleanupJournal {
            stage: staged_archive
                .parent()
                .ok_or_else(|| "Archive staging directory is missing.".to_string())?
                .to_path_buf(),
            destination: destination.clone(),
            archive: true,
            move_plan_sidecar: false,
            previous_archive_family: archive_family(destination)?,
            next_archive_family: Vec::new(),
            archive_phase: Some(ArchiveJournalPhase::InProgress),
        })
    } else {
        None
    };
    let Some(journal) = journal else {
        return Ok(false);
    };
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&cleanup_journal_path(app)?, &json)?;
    Ok(true)
}

pub(crate) fn update_archive_journal(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<(), String> {
    let Some((staged, destination)) = &plan.staged_archive else {
        return Ok(());
    };
    let stage = staged
        .parent()
        .ok_or_else(|| "Archive staging directory is missing.".to_string())?
        .to_path_buf();
    let next_archive_family = archive_family(staged)?
        .iter()
        .map(|source| archive_destination_for(staged, destination, source))
        .collect::<Result<Vec<_>, _>>()?;
    let journal = CleanupJournal {
        stage,
        destination: destination.clone(),
        archive: true,
        move_plan_sidecar: false,
        previous_archive_family: archive_family(destination)?,
        next_archive_family,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&cleanup_journal_path(app)?, &json)
}

pub(crate) fn mark_archive_journal_committed(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<(), String> {
    let Some((staged, destination)) = &plan.staged_archive else {
        return Ok(());
    };
    let expected_stage = staged
        .parent()
        .ok_or_else(|| "Archive staging directory is missing.".to_string())?;
    let path = cleanup_journal_path(app)?;
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut journal: CleanupJournal = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if !journal.archive
        || journal.stage != expected_stage
        || journal.destination != *destination
        || journal.next_archive_family.is_empty()
    {
        return Err("Archive recovery journal changed before commit.".to_string());
    }
    journal.archive_phase = Some(ArchiveJournalPhase::Committed);
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&path, &json)
}

pub(crate) fn clear_cleanup_journal(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cleanup_journal_path(app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => crate::settings_store::sync_parent_directory(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn pending_stages_path(cache_dir: &std::path::Path) -> std::path::PathBuf {
    cache_dir.join("pending-stages.json")
}

pub(crate) fn read_pending_stages(cache_dir: &std::path::Path) -> Result<Vec<String>, String> {
    let path = pending_stages_path(cache_dir);
    match std::fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn write_pending_stages(
    cache_dir: &std::path::Path,
    stages: &[String],
) -> Result<(), String> {
    let path = pending_stages_path(cache_dir);
    if stages.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => crate::settings_store::sync_parent_directory(&path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    } else {
        let json = serde_json::to_string(stages).map_err(|e| e.to_string())?;
        crate::settings_store::atomic_write_text(&path, &json)
    }
}

pub(crate) fn register_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
) -> Result<(), String> {
    let key = stage.to_string_lossy().to_string();
    let mut stages = read_pending_stages(cache_dir)?;
    if !stages.iter().any(|existing| existing == &key) {
        stages.push(key);
        write_pending_stages(cache_dir, &stages)?;
    }
    Ok(())
}

pub(crate) fn unregister_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
) -> Result<(), String> {
    let key = stage.to_string_lossy().to_string();
    let mut stages = read_pending_stages(cache_dir)?;
    let before = stages.len();
    stages.retain(|existing| existing != &key);
    if stages.len() != before {
        write_pending_stages(cache_dir, &stages)?;
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

pub(crate) fn unregister_plan_stages(plan: &CleanupPlan) {
    let Some(cache_dir) = &plan.cache_dir else {
        return;
    };
    for stage in plan_stage_dirs(plan) {
        // After successful publish, promote may leave the stage (undeletable
        // backup-* / PermissionDenied). Keep the pending registration so
        // cleanup_orphan_stages can retry on the next launch; never drop
        // tracking while the directory may still exist.
        match path_entry_exists(&stage) {
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

fn cleanup_archive_backup_sidecars(stage: &std::path::Path) -> Result<(), String> {
    let Some(stage_name) = stage.file_name().and_then(|name| name.to_str()) else {
        return Err("Archive stage has an invalid name.".to_string());
    };
    if !stage_name.contains(".zinnia-archive-") {
        return Ok(());
    }
    let Some(parent) = stage.parent() else {
        return Err("Archive stage has no parent directory.".to_string());
    };
    let prefix = format!("{stage_name}.backup-");
    for entry in std::fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(index) = name.strip_prefix(&prefix) else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
            return Err(format!(
                "Refusing unexpected archive backup sidecar {}.",
                path.display()
            ));
        }
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    sync_directory(parent)
}

/// Remove stage directories left behind when a crash happened after create but
/// before (or without) a durable transaction journal. Safe names only.
pub fn cleanup_orphan_stages(app: &tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let stages = read_pending_stages(&cache_dir)?;
    if stages.is_empty() {
        return Ok(());
    }
    let mut remaining = Vec::new();
    for stage in stages {
        let path = std::path::PathBuf::from(&stage);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !is_safe_stage_dir_name(name) {
            remaining.push(stage);
            continue;
        }
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let _ = std::fs::remove_file(move_plan_path(&path));
                if cleanup_archive_backup_sidecars(&path).is_err() {
                    remaining.push(stage);
                }
            }
            Err(_) => {
                remaining.push(stage);
            }
            Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() => {
                remaining.push(stage);
            }
            Ok(_) => {
                if let Err(error) = std::fs::remove_dir_all(&path) {
                    eprintln!(
                        "Failed to remove orphan staging directory {}: {error}",
                        path.display()
                    );
                    remaining.push(stage);
                    continue;
                }
                let _ = std::fs::remove_file(move_plan_path(&path));
                if let Err(error) = cleanup_archive_backup_sidecars(&path) {
                    eprintln!(
                        "Failed to remove archive backup sidecars for {}: {error}",
                        path.display()
                    );
                    remaining.push(stage);
                    continue;
                }
                if let Some(parent) = path.parent() {
                    let _ = sync_directory(parent);
                }
            }
        }
    }
    write_pending_stages(&cache_dir, &remaining)
}

pub(crate) fn sync_directory(path: &std::path::Path) -> Result<(), String> {
    crate::fs_secure::sync_directory(path)
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

pub(crate) struct CleanupJournalGuard {
    app: tauri::AppHandle,
    active: bool,
}

impl CleanupJournalGuard {
    pub(crate) fn new(app: tauri::AppHandle, active: bool) -> Self {
        Self { app, active }
    }

    pub(crate) fn clear(&mut self) -> Result<(), String> {
        if self.active {
            clear_cleanup_journal(&self.app)?;
            self.active = false;
        }
        Ok(())
    }
}
