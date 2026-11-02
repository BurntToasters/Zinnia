//! Archive family backup and promote.

#[cfg(test)]
use super::super::journal::path_identity;
use super::super::journal::{
    ensure_path_identity, ensure_recovery_path_unchanged, file_identities_match, file_identity,
    identity_with_file_content, identity_with_fingerprint_from, regular_file_identity,
    regular_file_identity_with_fingerprint, remove_regular_file_if_matches, sync_directory,
    FileIdentity,
};
use super::super::staging::path_entry_exists;
use super::super::{ArchiveDestinationSnapshot, CleanupPlan};
#[cfg(test)]
use super::archive_destination_family_snapshot;
use super::publish::{publish_file_no_replace_with_created, rename_file_no_replace};
use super::PublishStrategy;
use super::{
    archive_backup_path, archive_destination_for, archive_destination_snapshot_from_open_file,
    archive_family,
};

fn restore_archive_backups(
    backups: Vec<(
        std::path::PathBuf,
        std::path::PathBuf,
        super::super::journal::FileIdentity,
    )>,
) -> Vec<String> {
    let mut restore_errors = Vec::new();
    for (backup, target, identity) in backups.into_iter().rev() {
        let restore = ensure_recovery_path_unchanged(&backup, &identity)
            .and_then(|()| rename_file_no_replace(&backup, &target));
        if let Err(error) = restore {
            restore_errors.push(format!("Could not restore {}: {error}", target.display()));
        }
    }
    restore_errors
}

pub(super) fn promote_archive_family_with_commit<F, B, R>(
    staged: &std::path::Path,
    destination: &std::path::Path,
    expected_existing: &[ArchiveDestinationSnapshot],
    expected_stage_identity: &FileIdentity,
    mut record_backup: B,
    mut record_published: R,
    mark_committed: F,
) -> Result<PublishStrategy, String>
where
    F: FnOnce() -> Result<(), String>,
    B: FnMut(&std::path::Path, &super::super::journal::FileIdentity) -> Result<(), String>,
    R: FnMut(&std::path::Path, &super::super::journal::FileIdentity) -> Result<(), String>,
{
    let staged_family = archive_family(staged)?;
    if staged_family.is_empty() {
        return Err("7z reported success but produced no staged archive output.".to_string());
    }

    let stage_dir = staged
        .parent()
        .ok_or_else(|| "Staged archive has no parent directory.".to_string())?;
    ensure_path_identity(stage_dir, expected_stage_identity).map_err(|error| {
        format!("Archive stage changed after creation and was preserved: {error}")
    })?;
    // Check family membership without rereading bytes. Each expected volume is
    // opened and fingerprinted once below while its handle remains held across
    // rename; an earlier full-family hash duplicated that I/O.
    let current_family = archive_family(destination)?;
    let expected_paths: Vec<_> = expected_existing
        .iter()
        .map(|snapshot| snapshot.path.clone())
        .collect();
    if current_family != expected_paths {
        return Err(
            "Archive destination changed while the operation was running; the new file was preserved."
                .to_string(),
        );
    }
    let mut backups: Vec<(
        std::path::PathBuf,
        std::path::PathBuf,
        super::super::journal::FileIdentity,
    )> = Vec::new();
    for (index, expected) in expected_existing.iter().enumerate() {
        let path = expected.path.clone();
        // Keep the original object open across the rename. Besides closing the
        // final path-component race, this lets filesystems such as FAT report a
        // changed stable ID after a longer backup name is assigned.
        let mut original_file = crate::path_safety::open_regular_file_nofollow(&path)?;
        let actual_snapshot =
            archive_destination_snapshot_from_open_file(&path, &mut original_file)?;
        let original_identity = identity_with_file_content(
            actual_snapshot.identity.clone(),
            actual_snapshot.len,
            actual_snapshot.sha256,
        );
        if actual_snapshot != *expected {
            let restore_errors = restore_archive_backups(backups);
            let error = format!(
                "Archive destination changed during commit: {}",
                path.display()
            );
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; recovery also failed: {}",
                    restore_errors.join("; ")
                ))
            };
        }
        // Persist an identity before moving the old volume aside. If the process
        // stops immediately after rename, recovery has a fail-closed record.
        record_backup(&path, &original_identity)?;
        let backup = archive_backup_path(stage_dir, index);
        if let Err(e) = rename_file_no_replace(&path, &backup) {
            let restore_errors = restore_archive_backups(backups);
            let error = format!(
                "Could not protect existing archive volume {}: {e}",
                path.display()
            );
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; recovery also failed: {}",
                    restore_errors.join("; ")
                ))
            };
        }
        backups.push((backup.clone(), path.clone(), original_identity.clone()));
        let post_rename = (|| {
            let backup_identity =
                identity_with_fingerprint_from(file_identity(&original_file)?, &original_identity)?;
            if let Some((_, _, rollback_identity)) = backups.last_mut() {
                *rollback_identity = backup_identity.clone();
            }
            // Always persist the final fingerprinted identity from the still-
            // open post-rename handle. Even filesystems whose stable ID did not
            // change need both active-journal and pending-registry ownership of
            // the sibling backup before commit can proceed.
            record_backup(&path, &backup_identity)?;
            ensure_recovery_path_unchanged(&backup, &backup_identity)
        })();
        if let Err(error) = post_rename {
            let restore_errors = restore_archive_backups(backups);
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; recovery also failed: {}",
                    restore_errors.join("; ")
                ))
            };
        }
    }
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    sync_directory(stage_dir)?;

    let mut promoted = Vec::new();
    let mut publish_strategy: Option<PublishStrategy> = None;
    let result = (|| {
        for source in staged_family {
            let target = archive_destination_for(staged, destination, &source)?;
            // Record the staged object's identity before its final pathname can
            // become visible. Rename and hard-link publication preserve identity.
            // A crash can therefore never leave a published target with a blank
            // identity record that recovery might mistake for safe to delete.
            let expected_identity = regular_file_identity_with_fingerprint(&source)?;
            record_published(&target, &expected_identity)?;
            let mut created_identity = None;
            let selected_strategy =
                publish_file_no_replace_with_created(&source, &target, |created, identity| {
                    // The compatibility copy path allocates a new object. Journal
                    // that identity while its create-new handle is still open and
                    // before any bytes are copied, closing the last crash window.
                    record_published(created, identity)?;
                    created_identity = Some(identity.clone());
                    Ok(())
                })?;
            publish_strategy = Some(match publish_strategy {
                Some(previous) => previous.combine(selected_strategy),
                None => selected_strategy,
            });

            // Register a rollback identity immediately after publication. If the
            // post-publish query below fails, rename/hard-link paths can still be
            // retracted with the pre-recorded identity, while copy publication
            // uses the exact identity captured from its open create-new handle.
            promoted.push((
                target.clone(),
                source.clone(),
                match created_identity.clone() {
                    Some(created) => identity_with_fingerprint_from(created, &expected_identity)?,
                    None => expected_identity.clone(),
                },
            ));
            let identity = regular_file_identity(&target)?;
            if !file_identities_match(&identity, &expected_identity) {
                let identity = regular_file_identity_with_fingerprint(&target)?;
                if identity.fingerprint() != expected_identity.fingerprint() {
                    return Err(format!(
                        "Published archive output changed during commit: {}",
                        target.display()
                    ));
                }
                if let Some((_, _, rollback_identity)) = promoted.last_mut() {
                    *rollback_identity = identity.clone();
                }
                // A filesystem may report a stronger or otherwise changed stable
                // identity after rename or hard-link publication. Correct the
                // pre-recorded value before continuing; live rollback already has
                // the actual identity in `promoted` if this journal update fails.
                record_published(&target, &identity)?;
            }
            #[cfg(feature = "e2e")]
            if promoted.len() == 1 {
                crate::process::e2e_crash::crash_point("mid-promotion");
            }
        }
        if let Some(parent) = destination.parent() {
            sync_directory(parent)?;
        }
        sync_directory(stage_dir)?;
        // This durable phase boundary is the transaction commit point. Before
        // it, recovery restores the complete old family. After it, recovery
        // preserves the complete new family and only removes backup leftovers.
        mark_committed()?;
        #[cfg(feature = "e2e")]
        crate::process::e2e_crash::crash_point("after-commit");
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        let mut recovery_errors = Vec::new();
        for (target, source, identity) in promoted.into_iter().rev() {
            let retract = (|| {
                ensure_recovery_path_unchanged(&target, &identity)?;
                // Hard-link / exclusive-copy publish can leave the staged source
                // in place. rename_file_no_replace then fails, so delete the
                // published identity instead when the stage copy still exists.
                if path_entry_exists(&source)? {
                    remove_regular_file_if_matches(&target, &identity)
                } else {
                    rename_file_no_replace(&target, &source)
                }
            })();
            if let Err(e) = retract {
                recovery_errors.push(format!(
                    "Could not return {} to staging: {e}",
                    target.display()
                ));
            }
        }
        recovery_errors.extend(restore_archive_backups(backups));
        return if recovery_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}; recovery also failed: {}",
                recovery_errors.join("; ")
            ))
        };
    }

    // The archive family is durably committed. Cleanup is still part of the
    // owned operation: validate the complete backup set before deleting backup
    // zero, remove all sibling artifacts before the stage, and report failure
    // while preserving the committed publication and recovery ownership.
    let backup_identities = backups
        .iter()
        .map(|(_, _, identity)| Some(identity.clone()))
        .collect::<Vec<_>>();
    super::super::journal::cleanup_transaction_artifacts(
        stage_dir,
        Some(expected_stage_identity),
        None,
        None,
        &backup_identities,
    )
    .map_err(|error| {
        format!(
            "Archive was committed, but recovery artifact cleanup failed; published archives were preserved: {error}"
        )
    })?;
    Ok(publish_strategy.unwrap_or(PublishStrategy::DirectRename))
}

#[cfg(test)]
pub(crate) fn promote_archive_family(
    staged: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let expected = archive_destination_family_snapshot(destination)?;
    let stage = staged
        .parent()
        .ok_or_else(|| "Staged archive has no parent directory.".to_string())?;
    let stage_identity = path_identity(stage)?;
    promote_archive_family_with_commit(
        staged,
        destination,
        &expected,
        &stage_identity,
        |_, _| Ok(()),
        |_, _| Ok(()),
        || Ok(()),
    )
    .map(|_| ())
}

/// True when the archive stage still holds `backup-*` files needed for journal recovery.
/// Fail closed: if the directory cannot be listed, assume backups may exist.
pub(crate) fn archive_stage_has_recovery_backups(stage_dir: &std::path::Path) -> bool {
    let Some(parent) = stage_dir.parent() else {
        return true;
    };
    let stage_name = stage_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".zinnia-archive-unknown");
    let prefix = format!("{stage_name}.backup-");
    match std::fs::read_dir(parent) {
        Ok(entries) => entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// After a failed commit, only scrub staging when it cannot be needed for recovery.
pub(crate) fn commit_failure_should_scrub_staging(plan: &CleanupPlan, error: &str) -> bool {
    // Once publication crossed its durable marker, any cleanup failure remains
    // recovery-owned even when all visible artifacts appear absent. The caller
    // must retain the journal, pending record, and operation slot for startup to
    // replay the identity-checked cleanup boundary.
    if error.contains("was committed, but recovery artifact cleanup failed")
        || error.contains("recovery ownership update failed")
    {
        return false;
    }
    // Extract merge/journal recovery needs the stage; never wipe it here.
    if plan.staged_extract.is_some() {
        return false;
    }
    if let Some((staged, _)) = &plan.staged_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if archive_stage_has_recovery_backups(stage_dir) {
            return false;
        }
    }
    // Add-mode orphan (no backups) or post-publish leftover: safe to remove.
    let _ = error;
    true
}
