//! Startup recovery for interrupted archive transactions.

use super::commit::{archive_backup_path, archive_family, rollback_persisted_move_plan};
use super::journal::{
    cleanup_journal_path, clear_cleanup_journal, ensure_path_identity,
    ensure_recovery_path_unchanged, is_safe_stage_dir_name, move_plan_path,
    read_cleanup_journal_at, remove_recovery_regular_file_if_matches, ArchiveJournalPhase,
    CleanupJournal, ExtractJournalPhase, FileIdentity,
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
    let expected = journal.extract_stage_identity.as_ref().ok_or_else(|| {
        "Refusing extraction cleanup because the journal has no stage identity.".to_string()
    })?;
    super::journal::cleanup_transaction_artifacts(
        &journal.stage,
        Some(expected),
        journal.move_plan_identity.as_ref(),
        journal.move_identity_log_identity.as_ref(),
        &[],
    )
}

fn extraction_move_plan_exists(journal: &CleanupJournal) -> Result<bool, String> {
    let path = move_plan_path(&journal.stage);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            let expected = journal.move_plan_identity.as_ref().ok_or_else(|| {
                format!(
                    "Refusing present extraction move plan {} without its recorded identity.",
                    path.display()
                )
            })?;
            super::journal::read_bounded_nofollow_bytes_if_matches(
                &path,
                super::journal::MAX_MOVE_PLAN_BYTES,
                expected,
            )?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn recover_missing_extract_stage(journal: &CleanupJournal) -> Result<(), String> {
    let _stage_identity = journal.extract_stage_identity.as_ref().ok_or_else(|| {
        "Refusing extraction recovery because the journal has no stage identity.".to_string()
    })?;
    if journal.extract_phase.is_none() {
        return Err(
            "Refusing destructive recovery of a legacy extraction journal without an explicit phase."
                .to_string(),
        );
    }

    if extraction_move_plan_exists(journal)? {
        rollback_persisted_move_plan(
            &journal.stage,
            &journal.destination,
            !journal.move_plan_sidecar,
            journal.move_plan_identity.as_ref(),
            journal.move_identity_log_identity.as_ref(),
        )?;
        return cleanup_extract_journal_artifacts(journal);
    }

    let destination_metadata = match std::fs::symlink_metadata(&journal.destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(
                "Extraction stage and destination are both missing; preserving the recovery journal."
                    .to_string(),
            );
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
            if !extract_journal_is_committed(journal) {
                // No move plan means publication never started. The destination
                // predated the transaction, so preserve it and clear only sidecars.
            }
            cleanup_extract_journal_artifacts(journal)
        }
        Some(super::journal::ExtractStagePlacement::Sibling) => {
            if !extract_journal_is_committed(journal) {
                // The rename and committed-marker write cannot be one durable
                // operation. Once an in-progress sibling stage is missing, no
                // destination identity or content fingerprint can prove that
                // Zinnia published the live name rather than another actor
                // installing a replacement. Preserve both it and the journal.
                return Err(
                    "Extraction stage is missing before its sibling publish was durably committed; the destination and recovery journal were preserved."
                        .to_string(),
                );
            }
            // A durable commit marker authorizes cleanup of Zinnia's sidecars,
            // but never removal, movement, or ownership claims for destination.
            cleanup_extract_journal_artifacts(journal)
        }
        None => Err(
            "Refusing recovery of a legacy extraction journal without recorded stage placement."
                .to_string(),
        ),
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
    // Content fingerprint is required: inode/file-id alone cannot detect an
    // in-place rewrite of the stage backup before crash recovery runs.
    ensure_recovery_path_unchanged(backup, identity)?;
    Ok(true)
}

pub(crate) fn cleanup_committed_archive_journal(journal: &CleanupJournal) -> Result<(), String> {
    let stage_identity = journal.extract_stage_identity.as_ref().ok_or_else(|| {
        "Refusing archive cleanup because the journal has no stage identity.".to_string()
    })?;
    super::journal::cleanup_transaction_artifacts(
        &journal.stage,
        Some(stage_identity),
        journal.move_plan_identity.as_ref(),
        journal.move_identity_log_identity.as_ref(),
        &journal.previous_archive_identities,
    )
}

/// Fail closed when a scrub must retract partial archive output recorded in the
/// recovery journal path. Missing journals are fine; corrupt ones must not be
/// cleared silently by the caller.
pub(crate) fn retract_scrub_archive_journal_at(path: &std::path::Path) -> Result<(), String> {
    let Some(journal) = read_cleanup_journal_at(path)
        .map_err(|error| format!("Could not read recovery journal for scrub: {error}"))?
    else {
        return Ok(());
    };
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
    let stage_identity = journal.extract_stage_identity.as_ref().ok_or_else(|| {
        "Refusing archive rollback because the journal has no stage identity.".to_string()
    })?;
    if journal.previous_archive_identities.len() != journal.previous_archive_family.len() {
        return Err("Archive recovery journal has invalid backup identity records.".to_string());
    }
    let validated = super::journal::validate_transaction_artifacts(
        &journal.stage,
        Some(stage_identity),
        journal.move_plan_identity.as_ref(),
        journal.move_identity_log_identity.as_ref(),
        &journal.previous_archive_identities,
    )?;
    // Validate every recovery backup and every other sibling before deleting
    // any partially published output.
    let backup_presence = validated.archive_backups_present;

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
        ensure_recovery_path_unchanged(target, identity)?;
    }
    Ok(())
}

/// Ambiguous sibling-publish preserved state: in-progress, sibling, stage
/// gone, no move plan, plain directory destination. Gates the ack escape.
pub(crate) fn journal_is_preserved_ambiguous_publish(
    journal: &CleanupJournal,
) -> Result<bool, String> {
    if journal.archive {
        return Ok(false);
    }
    if !matches!(journal.extract_phase, Some(ExtractJournalPhase::InProgress)) {
        return Ok(false);
    }
    if journal.extract_stage_placement != Some(super::journal::ExtractStagePlacement::Sibling) {
        return Ok(false);
    }
    if extraction_move_plan_exists(journal)? {
        return Ok(false);
    }
    match std::fs::symlink_metadata(&journal.stage) {
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let destination = match std::fs::symlink_metadata(&journal.destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false);
        }
        Err(error) => return Err(error.to_string()),
    };
    if crate::path_safety::is_link_or_reparse(&destination) || !destination.is_dir() {
        return Ok(false);
    }
    // The original stage was created by this transaction. A same-name
    // destination may have been installed by another process after the stage
    // disappeared, so only offer acknowledgment when its stable identity is
    // still the creation-bound one recorded in the journal.
    let Some(expected_stage_identity) = journal.extract_stage_identity.as_ref() else {
        return Ok(false);
    };
    let actual_destination_identity = super::journal::path_identity(&journal.destination)?;
    if !super::journal::file_identities_match(&actual_destination_identity, expected_stage_identity)
    {
        return Ok(false);
    }
    Ok(true)
}

/// Accept a preserved destination as-is and drop only the recovery journal.
fn acknowledge_preserved_transaction_at(app: &tauri::AppHandle) -> Result<String, String> {
    let _recovery_guard = RECOVERY_LOCK
        .lock()
        .map_err(|_| "Archive recovery lock is unavailable.".to_string())?;
    let path = cleanup_journal_path(app)?;
    let Some(journal) = read_cleanup_journal_at(&path)? else {
        return Ok("No interrupted transaction requires acknowledgment.".to_string());
    };
    if !journal_is_preserved_ambiguous_publish(&journal)? {
        return Err(
            "The active recovery journal is not a preserved ambiguous publish; \
             let normal recovery resolve it."
                .to_string(),
        );
    }
    clear_cleanup_journal(app)?;
    set_startup_recovery_error(None);
    Ok("Preserved extraction destination accepted; the recovery journal was cleared.".to_string())
}

#[tauri::command]
pub async fn acknowledge_preserved_transaction(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || acknowledge_preserved_transaction_at(&app))
        .await
        .map_err(|error| format!("Acknowledgment task failed: {error}"))?
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
    if let Err(error) = wait_for_startup_recovery().await {
        return Some(error);
    }
    STARTUP_RECOVERY_ERROR
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

const STARTUP_RECOVERY_WAIT: std::time::Duration = std::time::Duration::from_secs(120);

pub(crate) async fn wait_for_startup_recovery() -> Result<(), String> {
    // Back off instead of a 1ms spin. Do not mark recovery done on timeout;
    // run_7z must fail closed instead of claiming the slot then blocking on
    // RECOVERY_LOCK with a misleading "busy" UI.
    let started = tokio::time::Instant::now();
    let mut delay_ms = 10u64;
    while !STARTUP_RECOVERY_DONE.load(std::sync::atomic::Ordering::Acquire) {
        if started.elapsed() >= STARTUP_RECOVERY_WAIT {
            return Err("Startup recovery is still running. Wait and try again.".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = (delay_ms + 10).min(50);
    }
    Ok(())
}

pub fn recover_interrupted_transaction(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cleanup_journal_path(app)?;
    let _recovery_guard = RECOVERY_LOCK
        .lock()
        .map_err(|_| "Archive recovery lock is unavailable.".to_string())?;
    let Some(journal) = read_cleanup_journal_at(&path)? else {
        return Ok(());
    };
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
    let stage_identity = journal.extract_stage_identity.as_ref().ok_or_else(|| {
        "Refusing interrupted-transaction recovery because the journal has no mandatory stage identity."
            .to_string()
    })?;
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
    ensure_path_identity(&journal.stage, stage_identity)?;

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
            journal.move_plan_identity.as_ref(),
            journal.move_identity_log_identity.as_ref(),
        )?;
    }
    if journal.archive {
        super::journal::cleanup_transaction_artifacts(
            &journal.stage,
            Some(stage_identity),
            journal.move_plan_identity.as_ref(),
            journal.move_identity_log_identity.as_ref(),
            &journal.previous_archive_identities,
        )?;
    } else {
        cleanup_extract_journal_artifacts(&journal)?;
    }
    clear_cleanup_journal(app)
}
