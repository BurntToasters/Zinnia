//! Startup recovery for interrupted archive transactions.

use super::commit::{archive_backup_path, archive_family, rollback_persisted_move_plan};
use super::journal::{
    cleanup_journal_path, clear_cleanup_journal, ensure_regular_file_identity,
    is_safe_stage_dir_name, move_plan_path, remove_move_plan_sidecars,
    remove_recovery_regular_file_if_matches, remove_regular_file_if_matches, sync_directory,
    ArchiveJournalPhase, CleanupJournal, ExtractJournalPhase, FileIdentity,
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

pub(crate) fn extract_journal_is_committed(journal: &CleanupJournal) -> bool {
    matches!(journal.extract_phase, Some(ExtractJournalPhase::Committed))
}

pub(crate) fn cleanup_extract_journal_artifacts(journal: &CleanupJournal) -> Result<(), String> {
    // Remove the durable rollback description before deleting the source stage.
    // If sidecar cleanup fails, leaving the stage intact lets the next recovery
    // pass repeat safely instead of seeing a missing stage with a stale plan.
    remove_move_plan_sidecars(&journal.stage)?;
    match crate::fs_secure::remove_dir_all_for_cleanup(&journal.stage) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    if let Some(parent) = journal.stage.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn extraction_move_plan_exists(journal: &CleanupJournal) -> Result<bool, String> {
    let mut candidates = vec![move_plan_path(&journal.stage)];
    if !journal.move_plan_sidecar {
        candidates.push(
            journal
                .stage
                .join(super::journal::LEGACY_MOVE_PLAN_FILE_NAME),
        );
    }
    for path in candidates {
        match std::fs::symlink_metadata(&path) {
            Ok(metadata)
                if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
            {
                return Err(format!(
                    "Refusing unexpected extraction recovery sidecar {}.",
                    path.display()
                ));
            }
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(false)
}

pub(crate) fn recover_missing_extract_stage(journal: &CleanupJournal) -> Result<(), String> {
    if extract_journal_is_committed(journal) || journal.extract_phase.is_none() {
        // Committed outputs must be preserved. Legacy journals had no explicit
        // phase and historically treated a missing stage as completion.
        return remove_move_plan_sidecars(&journal.stage);
    }

    if extraction_move_plan_exists(journal)? {
        rollback_persisted_move_plan(
            &journal.stage,
            &journal.destination,
            !journal.move_plan_sidecar,
        )?;
        return cleanup_extract_journal_artifacts(journal);
    }

    let destination_metadata = match std::fs::symlink_metadata(&journal.destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return remove_move_plan_sidecars(&journal.stage);
        }
        Err(error) => return Err(error.to_string()),
    };
    if crate::path_safety::is_link_or_reparse(&destination_metadata)
        || !destination_metadata.is_dir()
    {
        return Err(
            "Refusing to recover a missing extraction stage through an unexpected destination."
                .to_string(),
        );
    }

    match journal.extract_stage_placement {
        Some(super::journal::ExtractStagePlacement::InsideDestination) => {
            // No move plan means publication never started. The destination
            // predated the transaction, so preserve it and clear only sidecars.
            remove_move_plan_sidecars(&journal.stage)
        }
        Some(super::journal::ExtractStagePlacement::Sibling) => {
            // A whole-stage publish can make the stage disappear before its
            // committed phase reaches disk. Do not infer that the destination
            // still belongs to this transaction from a filesystem identity:
            // Unix inodes (and filesystem file IDs generally) can be reused
            // after deletion. Preserve a destination in this ambiguous state;
            // retaining a possibly completed extraction is safe, while moving
            // and deleting a replacement directory can destroy user data.
            remove_move_plan_sidecars(&journal.stage)
        }
        None => remove_move_plan_sidecars(&journal.stage),
    }
}

fn archive_backup_identity(
    journal: &CleanupJournal,
    index: usize,
) -> Result<&FileIdentity, String> {
    if journal.previous_archive_identities.len() != journal.previous_archive_family.len() {
        return Err("Archive recovery journal has invalid backup identity records.".to_string());
    }
    journal.previous_archive_identities[index]
        .as_ref()
        .ok_or_else(|| {
            format!(
                "Archive recovery journal did not record the identity of backup volume {index}."
            )
        })
}

fn validate_archive_backup(
    journal: &CleanupJournal,
    index: usize,
    backup: &std::path::Path,
) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(backup) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(format!(
            "Refusing unexpected archive recovery backup {}.",
            backup.display()
        ));
    }
    let identity = archive_backup_identity(journal, index)?;
    ensure_regular_file_identity(backup, identity)?;
    Ok(true)
}

pub(crate) fn cleanup_committed_archive_journal(journal: &CleanupJournal) -> Result<(), String> {
    for (index, _) in journal.previous_archive_family.iter().enumerate() {
        let backup = archive_backup_path(&journal.stage, index);
        if !validate_archive_backup(journal, index, &backup)? {
            continue;
        }
        let identity = archive_backup_identity(journal, index)?;
        remove_regular_file_if_matches(&backup, identity)?;
    }
    match crate::fs_secure::remove_dir_all_for_cleanup(&journal.stage) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    if let Some(parent) = journal.stage.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

/// Fail closed when a scrub must retract partial archive output recorded in the
/// recovery journal path. Missing journals are fine; corrupt ones must not be
/// cleared silently by the caller.
pub(crate) fn retract_scrub_archive_journal_at(path: &std::path::Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not inspect recovery journal for scrub: {error}"
            ));
        }
        Ok(metadata) => metadata,
    };
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err("Recovery journal is not a regular file.".to_string());
    }
    let json = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read recovery journal for scrub: {error}"))?;
    let journal = serde_json::from_str::<CleanupJournal>(&json)
        .map_err(|error| format!("Could not parse recovery journal for scrub: {error}"))?;
    if journal.archive && !archive_journal_is_committed(&journal) {
        rollback_archive_journal(&journal)?;
    }
    Ok(())
}

/// Fail closed when a scrub must retract partial archive output recorded in the
/// active journal. Missing or corrupt journals must not be cleared silently.
pub(crate) fn retract_scrub_archive_journal_or_fail(app: &tauri::AppHandle) -> Result<(), String> {
    retract_scrub_archive_journal_at(&cleanup_journal_path(app)?)
}

pub(crate) fn rollback_archive_journal(journal: &CleanupJournal) -> Result<(), String> {
    // Validate every recovery backup before deleting any partially published
    // output. If a shared-folder race replaced a backup, preserve all paths and
    // fail closed rather than restoring an unrelated file as the user's archive.
    let mut backup_presence = Vec::with_capacity(journal.previous_archive_family.len());
    for (index, _) in journal.previous_archive_family.iter().enumerate() {
        let backup = archive_backup_path(&journal.stage, index);
        backup_presence.push(validate_archive_backup(journal, index, &backup)?);
    }

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
            Some(index) => backup_presence[index],
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
            let current_exists = match std::fs::symlink_metadata(&current) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.to_string()),
            };
            if !current_exists {
                // Publication may not have started yet, even though its staged
                // identity was pre-recorded. A missing target is safe to skip so
                // the old backup can be restored below.
                continue;
            }

            // Never delete a present path unless the journal recorded the exact
            // file identity before publication. Older or torn journals can have
            // a blank entry; fail closed rather than deleting a same-name file
            // that another process may have created after the crash.
            let Some(Some(identity)) = journal.next_archive_identities.get(index) else {
                return Err(format!(
                    "Refusing to roll back archive output {} because its published identity was not recorded.",
                    current.display()
                ));
            };
            remove_recovery_regular_file_if_matches(&current, identity)?;
        }
    }
    for (index, target) in journal.previous_archive_family.iter().enumerate() {
        let backup = archive_backup_path(&journal.stage, index);
        if !validate_archive_backup(journal, index, &backup)? {
            continue;
        }
        super::commit::rename_file_no_replace(&backup, target)?;
        let identity = archive_backup_identity(journal, index)?;
        ensure_regular_file_identity(target, identity)?;
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
pub async fn get_startup_recovery_status() -> Option<String> {
    // A one-shot read during UI initialization used to race the maintenance
    // thread: a later recovery failure was recorded but never surfaced. Make
    // the command resolve only once the authoritative pass has finished.
    wait_for_startup_recovery().await;
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
    let placement_is_valid = if journal.archive {
        journal.stage.parent() == journal.destination.parent()
    } else {
        // Legacy extract journals had only sibling stages. New journals record
        // whether the destination existed and therefore whether the stage was
        // placed beside it or inside it for ACL inheritance compatibility.
        journal
            .extract_stage_placement
            .map(|placement| placement.matches_paths(&journal.stage, &journal.destination))
            .unwrap_or_else(|| journal.stage.parent() == journal.destination.parent())
    };
    if !placement_is_valid || !is_safe_stage_dir_name(stage_name) {
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
            if !journal.archive {
                recover_missing_extract_stage(&journal)?;
            } else if !archive_journal_is_committed(&journal) {
                // Stage may have been scrubbed after a failed add-mode commit
                // while partial destinations remain. Retract them before drop.
                rollback_archive_journal(&journal)?;
            }
            return clear_cleanup_journal(app);
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
    } else if extract_journal_is_committed(&journal) {
        // All targets crossed the durable extraction commit point. Preserve
        // them and remove only the source stage and recovery sidecars.
        cleanup_extract_journal_artifacts(&journal)?;
        return clear_cleanup_journal(app);
    } else {
        rollback_persisted_move_plan(
            &journal.stage,
            &journal.destination,
            !journal.move_plan_sidecar,
        )?;
    }
    if journal.archive {
        crate::fs_secure::remove_dir_all_for_cleanup(&journal.stage).map_err(|e| e.to_string())?;
        match std::fs::remove_file(move_plan_path(&journal.stage)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        if let Some(parent) = journal.stage.parent() {
            sync_directory(parent)?;
        }
    } else {
        cleanup_extract_journal_artifacts(&journal)?;
    }
    clear_cleanup_journal(app)
}
