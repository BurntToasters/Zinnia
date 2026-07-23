//! Startup recovery for interrupted archive transactions.

use super::commit::{archive_backup_path, archive_family, rollback_persisted_move_plan};
use super::journal::{
    cleanup_journal_path, clear_cleanup_journal, is_safe_stage_dir_name, move_plan_path,
    remove_regular_file_if_matches, sync_directory, ArchiveJournalPhase, CleanupJournal,
};

static RECOVERY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Set after the startup maintenance thread finishes its one-shot recovery pass.
/// `run_7z` waits for this so it cannot race startup recovery against a live journal.
static STARTUP_RECOVERY_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(cfg!(test));
/// Last startup recovery failure (cleared when recovery succeeds or was a no-op).
static STARTUP_RECOVERY_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub(crate) fn archive_journal_has_backups(journal: &CleanupJournal) -> bool {
    journal
        .previous_archive_family
        .iter()
        .enumerate()
        .any(|(index, _)| archive_backup_path(&journal.stage, index).is_file())
}

pub(crate) fn archive_journal_stage_retains_outputs(journal: &CleanupJournal) -> bool {
    journal.next_archive_family.iter().any(|destination| {
        destination
            .file_name()
            .map(|name| journal.stage.join(name).is_file())
            .unwrap_or(false)
    })
}

/// Promote finished successfully when next outputs are recorded, no backups remain,
/// and the stage no longer holds unpublished archive members. Leftover empty stage
/// dirs must not trigger destructive rollback of the published archive.
pub(crate) fn archive_journal_is_committed(journal: &CleanupJournal) -> bool {
    match journal.archive_phase {
        Some(ArchiveJournalPhase::Committed) => true,
        Some(ArchiveJournalPhase::InProgress) => false,
        None => {
            // Compatibility with pre-phase journals written by older betas.
            !journal.next_archive_family.is_empty()
                && !archive_journal_has_backups(journal)
                && !archive_journal_stage_retains_outputs(journal)
        }
    }
}

pub(crate) fn cleanup_committed_archive_journal(journal: &CleanupJournal) -> Result<(), String> {
    for (index, _) in journal.previous_archive_family.iter().enumerate() {
        remove_regular_file_if_present(&archive_backup_path(&journal.stage, index))?;
    }
    match std::fs::remove_dir_all(&journal.stage) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    if let Some(parent) = journal.stage.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

pub(crate) fn rollback_archive_journal(journal: &CleanupJournal) -> Result<(), String> {
    let candidates = if journal.next_archive_family.is_empty() {
        archive_family(&journal.destination)?
    } else {
        journal.next_archive_family.clone()
    };
    for current in candidates {
        let prior_index = journal
            .previous_archive_family
            .iter()
            .position(|target| target == &current);
        // Only delete a destination when we can restore a backup, or when it is a
        // newly published volume (not in previous family) during an incomplete promote.
        let should_remove = match prior_index {
            Some(index) => archive_backup_path(&journal.stage, index).is_file(),
            None => true,
        };
        if should_remove {
            let Some(index) = journal
                .next_archive_family
                .iter()
                .position(|target| target == &current)
            else {
                return Err(format!(
                    "Refusing to roll back unjournaled archive output {}.",
                    current.display()
                ));
            };
            let Some(Some(identity)) = journal.next_archive_identities.get(index) else {
                return Err(format!(
                    "Refusing to roll back archive output {} without a recorded file identity.",
                    current.display()
                ));
            };
            remove_regular_file_if_matches(&current, identity)?;
        }
    }
    for (index, target) in journal.previous_archive_family.iter().enumerate() {
        let backup = archive_backup_path(&journal.stage, index);
        if backup.is_file() {
            super::commit::rename_file_no_replace(&backup, target)?;
        }
    }
    Ok(())
}

/// Mark the one-shot startup recovery pass complete (success or failure).
pub fn mark_startup_recovery_done() {
    STARTUP_RECOVERY_DONE.store(true, std::sync::atomic::Ordering::Release);
}

pub fn set_startup_recovery_error(message: Option<String>) {
    if let Ok(mut guard) = STARTUP_RECOVERY_ERROR.lock() {
        *guard = message;
    }
}

#[tauri::command]
pub fn get_startup_recovery_status() -> Option<String> {
    STARTUP_RECOVERY_ERROR
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

pub(crate) async fn wait_for_startup_recovery() {
    // Back off instead of a 1ms spin. Do not force-complete on timeout; that let
    // run_7z claim the slot then block on RECOVERY_LOCK with a misleading "busy" UI.
    let mut delay_ms = 10u64;
    while !STARTUP_RECOVERY_DONE.load(std::sync::atomic::Ordering::Acquire) {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = (delay_ms + 10).min(50);
    }
}

pub fn recover_interrupted_transaction(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cleanup_journal_path(app)?;
    // Fast path: with no journal there is nothing to recover. Skip the lock so a
    // concurrent startup maintenance pass cannot delay the first extract.
    if !path.exists() {
        return Ok(());
    }
    let _recovery_guard = RECOVERY_LOCK
        .lock()
        .map_err(|_| "Archive recovery lock is unavailable.".to_string())?;
    // Re-check under the lock; another thread may have cleared it.
    let json = match std::fs::read_to_string(&path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let journal: CleanupJournal = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let stage_name = journal
        .stage
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if journal.stage.parent() != journal.destination.parent() || !is_safe_stage_dir_name(stage_name)
    {
        return Err("Refusing unsafe interrupted-transaction recovery path.".to_string());
    }
    let metadata = match std::fs::symlink_metadata(&journal.stage) {
        Ok(metadata) => metadata,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && journal.archive
                && archive_journal_is_committed(&journal) =>
        {
            cleanup_committed_archive_journal(&journal)?;
            return clear_cleanup_journal(app);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return clear_cleanup_journal(app)
        }
        Err(error) => return Err(error.to_string()),
    };
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err("Refusing unsafe interrupted-transaction staging directory.".to_string());
    }

    if journal.archive {
        if archive_journal_is_committed(&journal) {
            // Publish already crossed its durable commit point. Only remove
            // recovery leftovers; never delete or roll back destinations.
            cleanup_committed_archive_journal(&journal)?;
            return clear_cleanup_journal(app);
        }
        rollback_archive_journal(&journal)?;
    } else {
        rollback_persisted_move_plan(
            &journal.stage,
            &journal.destination,
            !journal.move_plan_sidecar,
        )?;
    }
    std::fs::remove_dir_all(&journal.stage).map_err(|e| e.to_string())?;
    match std::fs::remove_file(move_plan_path(&journal.stage)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    if let Some(parent) = journal.stage.parent() {
        sync_directory(parent)?;
    }
    clear_cleanup_journal(app)
}

pub(crate) fn remove_regular_file_if_present(path: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata)
            if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
        {
            Err(format!(
                "Refusing to remove unexpected recovery target {}.",
                path.display()
            ))
        }
        Ok(_) => std::fs::remove_file(path).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
