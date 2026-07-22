//! Promote/merge staged outputs, commit and rollback cleanup.

use super::journal::{
    sync_directory, unregister_plan_stages, update_archive_journal, MoveRecord, MOVE_PLAN_FILE_NAME,
};
use super::quota::MAX_EXTRACT_ENTRIES;
use super::staging::{assert_extract_parent_unchanged, assert_real_directory, path_entry_exists};
use super::CleanupPlan;

pub(crate) fn assert_safe_extract_target_ancestors(
    destination: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    assert_real_directory(destination)?;
    let Some(parent) = target.parent() else {
        return Ok(());
    };
    if parent == destination {
        return Ok(());
    }
    let relative = parent.strip_prefix(destination).map_err(|_| {
        format!(
            "Extraction target escaped destination: {}",
            target.display()
        )
    })?;
    let mut cursor = destination.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        assert_real_directory(&cursor)?;
    }
    Ok(())
}

pub(crate) fn archive_family(base: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let parent = base.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Archive output has an invalid file name.".to_string())?;
    let mut family = Vec::new();
    match std::fs::symlink_metadata(base) {
        Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_file() => {
            return Err(format!(
                "Archive output is not a regular file: {}",
                base.display()
            ));
        }
        Ok(_) => family.push(base.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // 7-Zip volumes are a contiguous sequence beginning at .001. Do not sweep
    // arbitrary numeric suffixes such as `archive.7z.2024`; those may be
    // unrelated user files.
    for index in 1..=1_000_000u32 {
        let candidate = parent.join(format!("{name}.{index:03}"));
        let meta = match std::fs::symlink_metadata(&candidate) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        };
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_file() {
            return Err(format!(
                "Archive volume is not a regular file: {}",
                candidate.display()
            ));
        }
        family.push(candidate);
    }
    family.sort();
    Ok(family)
}

pub(crate) fn archive_destination_for(
    staged_base: &std::path::Path,
    destination_base: &std::path::Path,
    staged_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if staged_path == staged_base {
        return Ok(destination_base.to_path_buf());
    }
    let staged_name = staged_base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid staged archive name.".to_string())?;
    let path_name = staged_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid staged volume name.".to_string())?;
    let suffix = path_name
        .strip_prefix(staged_name)
        .ok_or_else(|| "Staged volume does not match its archive basename.".to_string())?;
    let destination_name = destination_base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid destination archive name.".to_string())?;
    Ok(destination_base.with_file_name(format!("{destination_name}{suffix}")))
}

pub(crate) fn publish_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};

    let mut source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    // Same as directory fsync: some Windows setups deny FlushFileBuffers.
    sync_file_best_effort(&source_file)?;

    // Prefer hard_link while the nofollow handle is still held (narrows same-user
    // unlink windows on Unix). If hard links are unsupported, stream from this
    // handle so we never re-open the source by path (closes the copy-path TOCTOU).
    let linked = std::fs::hard_link(source, target).is_ok();
    if !linked {
        let copy_result = (|| -> Result<(), String> {
            source_file
                .seek(SeekFrom::Start(0))
                .map_err(|e| e.to_string())?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|e| {
                    format!("Could not reserve archive output {}: {e}", target.display())
                })?;
            std::io::copy(&mut source_file, &mut output).map_err(|e| e.to_string())?;
            sync_file_best_effort(&output)?;
            // Best-effort: copying permissions can be denied on Desktop / CFA.
            if let Ok(permissions) = std::fs::metadata(source).map(|meta| meta.permissions()) {
                let _ = std::fs::set_permissions(target, permissions);
            }
            Ok(())
        })();
        if let Err(error) = copy_result {
            let _ = std::fs::remove_file(target);
            return Err(error);
        }
    }
    drop(source_file);
    if let Err(error) = std::fs::remove_file(source) {
        let _ = std::fs::remove_file(target);
        return Err(format!(
            "Could not finish publishing archive output {}: {error}",
            target.display()
        ));
    }
    Ok(())
}

/// Flush file data; on Windows, PermissionDenied from FlushFileBuffers is ignored
/// (same policy as [`crate::fs_secure::sync_directory`]).
pub(crate) fn sync_file_best_effort(file: &std::fs::File) -> Result<(), String> {
    match file.sync_all() {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn promote_archive_family(
    staged: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let staged_family = archive_family(staged)?;
    if staged_family.is_empty() {
        return Err("7z reported success but produced no staged archive output.".to_string());
    }

    let stage_dir = staged
        .parent()
        .ok_or_else(|| "Staged archive has no parent directory.".to_string())?;
    let existing = archive_family(destination)?;
    let mut backups: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for (index, path) in existing.into_iter().enumerate() {
        let backup = stage_dir.join(format!("backup-{index}"));
        if let Err(e) = std::fs::rename(&path, &backup) {
            let mut restore_errors = Vec::new();
            for (previous_backup, previous_path) in backups.into_iter().rev() {
                if let Err(restore_error) = std::fs::rename(&previous_backup, &previous_path) {
                    restore_errors.push(format!(
                        "Could not restore {}: {restore_error}",
                        previous_path.display()
                    ));
                }
            }
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
        backups.push((backup, path));
    }
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    sync_directory(stage_dir)?;

    let mut promoted = Vec::new();
    let result = (|| {
        for source in staged_family {
            let target = archive_destination_for(staged, destination, &source)?;
            publish_file_no_replace(&source, &target)?;
            promoted.push((target, source));
        }
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        let mut recovery_errors = Vec::new();
        for (target, source) in promoted.into_iter().rev() {
            if let Err(e) = std::fs::rename(&target, &source) {
                recovery_errors.push(format!(
                    "Could not return {} to staging: {e}",
                    target.display()
                ));
            }
        }
        for (backup, target) in backups.into_iter().rev() {
            if let Err(e) = std::fs::rename(&backup, &target) {
                recovery_errors.push(format!("Could not restore {}: {e}", target.display()));
            }
        }
        return if recovery_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}; recovery also failed: {}",
                recovery_errors.join("; ")
            ))
        };
    }

    // Destination already holds the new archive(s). Nothing after this point may
    // return Err: leftover backups/stage dirs are cleaned best-effort only.
    if let Some(parent) = destination.parent() {
        if let Err(error) = sync_directory(parent) {
            eprintln!(
                "Archive published; destination parent sync failed for {}: {error}",
                parent.display()
            );
        }
    }

    for (backup, _) in backups {
        if let Err(error) = std::fs::remove_file(&backup) {
            eprintln!(
                "Archive published; leftover backup cleanup failed for {}: {error}",
                backup.display()
            );
        }
    }
    if let Err(error) = sync_directory(stage_dir) {
        eprintln!(
            "Archive published; staging directory sync failed for {}: {error}",
            stage_dir.display()
        );
    }
    // Never remove_dir_all while recovery backups may remain; that can partially
    // wipe a multi-volume restore set while the journal still looks in-flight.
    // Leave the dir in place; unregister_plan_stages keeps pending-stages tracking
    // so cleanup_orphan_stages retries after the journal is cleared.
    if archive_stage_has_recovery_backups(stage_dir) {
        eprintln!(
            "Archive published; leaving staging directory {} for later cleanup (recovery backups remain).",
            stage_dir.display()
        );
    } else if let Err(error) = std::fs::remove_dir(stage_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            // Empty-dir remove failed (e.g. PermissionDenied). Try a full scrub only
            // when we already know there are no backup-* files.
            if let Err(scrub_error) = std::fs::remove_dir_all(stage_dir) {
                if scrub_error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "Archive published; staging directory cleanup failed for {}: {scrub_error}",
                        stage_dir.display()
                    );
                }
            }
        }
    }
    if let Some(parent) = destination.parent() {
        let _ = sync_directory(parent);
    }
    Ok(())
}

/// True when the archive stage still holds `backup-*` files needed for journal recovery.
/// Fail closed: if the directory cannot be listed, assume backups may exist.
pub(crate) fn archive_stage_has_recovery_backups(stage_dir: &std::path::Path) -> bool {
    match std::fs::read_dir(stage_dir) {
        Ok(entries) => entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with("backup-")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// After a failed commit, only scrub staging when it cannot be needed for recovery.
pub(crate) fn commit_failure_should_scrub_staging(plan: &CleanupPlan, error: &str) -> bool {
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

pub(crate) fn rollback_cleanup(plan: &CleanupPlan) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Some((staged, _)) = &plan.staged_extract {
        if let Err(e) = std::fs::remove_dir_all(staged) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove partial extract directory {}: {e}",
                    staged.display()
                ));
            }
        }
    }
    if let Some((staged, _)) = &plan.staged_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = std::fs::remove_dir_all(stage_dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove partial archive staging directory {}: {e}",
                    stage_dir.display()
                ));
            }
        }
    }
    if let Some(staged) = &plan.staged_input_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = std::fs::remove_dir_all(stage_dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove archive input snapshot {}: {e}",
                    stage_dir.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        unregister_plan_stages(plan);
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub(crate) fn auto_rename_path(
    path: &std::path::Path,
    reserved: &std::collections::HashSet<std::path::PathBuf>,
) -> Result<std::path::PathBuf, String> {
    if !reserved.contains(path) && !path_entry_exists(path)? {
        return Ok(path.to_path_buf());
    }
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("file");
    let extension = path.extension().and_then(|v| v.to_str());
    for index in 1..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem}_{index}.{extension}"),
            None => format!("{stem}_{index}"),
        };
        let candidate = parent.join(name);
        if !reserved.contains(&candidate) && !path_entry_exists(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not find a free conflict-safe name for {}.",
        path.display()
    ))
}

pub(crate) const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

pub(crate) fn assert_path_under_root(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("Staged path escaped the extract root: {}", path.display()))?;
    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Staged path escaped the extract root: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn validate_staged_tree(root: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut entries = 0u64;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        assert_path_under_root(root, &directory)?;
        let meta = std::fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
            return Err(format!("Unsafe staged directory: {}", directory.display()));
        }
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            entries = entries.saturating_add(1);
            if entries > MAX_EXTRACT_ENTRIES {
                return Err(format!(
                    "Archive exceeds the {MAX_EXTRACT_ENTRIES}-entry safety limit."
                ));
            }
            let path = entry.path();
            assert_path_under_root(root, &path)?;
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                crate::path_safety::assert_relative_symlink_within_root(root, &path)?;
                continue;
            }
            if crate::path_safety::is_link_or_reparse(&meta) {
                return Err(format!(
                    "Archive contains a symbolic link or reparse point: {}",
                    path.display()
                ));
            }
            if meta.is_dir() {
                pending.push(path);
            } else if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
                if bytes > max_bytes {
                    return Err(format!(
                        "Archive exceeds its {:.1} GiB expanded-size safety limit.",
                        max_bytes as f64 / 1_073_741_824.0
                    ));
                }
            } else {
                return Err(format!(
                    "Archive contains an unsupported entry: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn plan_staged_contents(
    staged: &std::path::Path,
    destination: &std::path::Path,
    reserved: &mut std::collections::HashSet<std::path::PathBuf>,
    plan: &mut Vec<MoveRecord>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(staged).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let meta = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
        let requested_target = destination.join(entry.file_name());
        if meta.is_dir() {
            match std::fs::symlink_metadata(&requested_target) {
                Ok(target_meta)
                    if target_meta.is_dir()
                        && !crate::path_safety::is_link_or_reparse(&target_meta) =>
                {
                    plan_staged_contents(&source, &requested_target, reserved, plan)?;
                    continue;
                }
                Ok(_) => {
                    // Existing symlinks, reparse points, files, and special
                    // nodes are conflicts. Never recurse through them.
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let target = auto_rename_path(&requested_target, reserved)?;
        reserved.insert(target.clone());
        plan.push(MoveRecord { source, target });
    }
    Ok(())
}

pub(crate) fn write_move_plan(staged: &std::path::Path, plan: &[MoveRecord]) -> Result<(), String> {
    let json = serde_json::to_string(plan).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&staged.join(MOVE_PLAN_FILE_NAME), &json)
}

pub(crate) fn validate_move_record(
    staged: &std::path::Path,
    destination: &std::path::Path,
    record: &MoveRecord,
) -> Result<(), String> {
    if !record.source.starts_with(staged) || !record.target.starts_with(destination) {
        return Err("Refusing unsafe extraction recovery move plan.".to_string());
    }
    Ok(())
}

pub(crate) fn rollback_move_records(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<(), String> {
    let mut failures = Vec::new();
    for record in plan.iter().rev() {
        if let Err(error) = validate_move_record(staged, destination, record) {
            failures.push(error);
            continue;
        }
        let source_exists = path_entry_exists(&record.source)?;
        let target_metadata = match std::fs::symlink_metadata(&record.target) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                failures.push(error.to_string());
                continue;
            }
        };
        let Some(target_metadata) = target_metadata else {
            if !source_exists {
                failures.push(format!(
                    "Both extraction source and promoted target are missing: {}",
                    record.target.display()
                ));
            }
            continue;
        };
        if source_exists {
            // The move was planned but never executed.
            continue;
        }
        if crate::path_safety::is_link_or_reparse(&target_metadata) {
            failures.push(format!(
                "Refusing to roll back a symbolic-link or reparse-point target: {}",
                record.target.display()
            ));
            continue;
        }
        if let Some(parent) = record.source.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                failures.push(error.to_string());
                continue;
            }
        }
        if let Err(error) = std::fs::rename(&record.target, &record.source) {
            failures.push(format!(
                "Could not roll back {}: {error}",
                record.target.display()
            ));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub(crate) fn rollback_persisted_move_plan(
    staged: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let path = staged.join(MOVE_PLAN_FILE_NAME);
    let json = match std::fs::read_to_string(path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let plan: Vec<MoveRecord> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    rollback_move_records(staged, destination, &plan)
}

pub(crate) fn merge_staged_extract(
    staged: &std::path::Path,
    destination: &std::path::Path,
    max_bytes: u64,
) -> Result<(), String> {
    // Always enforce the operation-specific limit immediately before publish.
    // Fast extractions can finish before the live monitor's first poll.
    validate_staged_tree(staged, max_bytes)?;
    if !path_entry_exists(destination)? {
        if let Some(parent) = destination.parent() {
            assert_real_directory(parent)?;
        }
        // Re-check immediately before rename: a symlink/reparse point must never
        // be published as the destination root.
        match std::fs::symlink_metadata(destination) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) => {
                return Err(
                    "Extraction destination became a symbolic link or reparse point during commit."
                        .to_string(),
                );
            }
            Ok(_) => {
                return Err("Extraction destination appeared during commit.".to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
        std::fs::rename(staged, destination).map_err(|e| e.to_string())?;
        if let Some(parent) = destination.parent() {
            sync_directory(parent)?;
        }
        return Ok(());
    }
    assert_real_directory(destination)?;
    let mut reserved = std::collections::HashSet::new();
    let mut plan = Vec::new();
    plan_staged_contents(staged, destination, &mut reserved, &mut plan)?;
    write_move_plan(staged, &plan)?;
    for record in &plan {
        validate_move_record(staged, destination, record)?;
        if let Err(error) = assert_safe_extract_target_ancestors(destination, &record.target) {
            let rollback = rollback_move_records(staged, destination, &plan);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
        if path_entry_exists(&record.target)? {
            let error = format!(
                "Extraction destination changed during commit: {}",
                record.target.display()
            );
            let rollback = rollback_move_records(staged, destination, &plan);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
        let metadata = std::fs::symlink_metadata(&record.source).map_err(|e| e.to_string())?;
        let result = if metadata.is_file() {
            publish_file_no_replace(&record.source, &record.target)
        } else {
            std::fs::rename(&record.source, &record.target).map_err(|e| e.to_string())
        };
        if let Err(error) = result {
            let rollback = rollback_move_records(staged, destination, &plan);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
    }
    std::fs::remove_dir_all(staged).map_err(|e| e.to_string())?;
    sync_directory(destination)?;
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

pub(crate) struct CommitOutcome {
    pub cleared_quarantine_apps: u32,
    pub restored_execute_bits: u32,
}

pub(crate) fn commit_cleanup(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<CommitOutcome, String> {
    let mut cleared_quarantine_apps = 0u32;
    let mut restored_execute_bits = 0u32;
    if let Some(staged) = &plan.staged_input_archive {
        std::fs::remove_dir_all(staged.parent().unwrap_or(staged))
            .map_err(|e| format!("Could not remove archive input snapshot: {e}"))?;
    }
    if let Some((staged, destination)) = &plan.staged_extract {
        if let Some(expected) = &plan.extract_parent_names {
            assert_extract_parent_unchanged(staged, expected)
                .map_err(|e| format!("Could not promote staged extraction safely: {e}"))?;
        }
        merge_staged_extract(
            staged,
            destination,
            plan.max_extract_bytes.unwrap_or(MAX_EXTRACTED_BYTES),
        )
        .map_err(|e| format!("Could not promote staged extraction safely: {e}"))?;
        let fixups = super::post_extract::apply_post_extract_fixups(destination);
        cleared_quarantine_apps = fixups.cleared_quarantine_apps;
        restored_execute_bits = fixups.restored_execute_bits;
        crate::launch::remember_openable_directory(app, destination);
    }
    if let Some((staged, destination)) = &plan.staged_archive {
        update_archive_journal(app, plan)?;
        promote_archive_family(staged, destination)?;
        if let Some(parent) = destination.parent() {
            crate::launch::remember_openable_directory(app, parent);
        }
    }
    unregister_plan_stages(plan);
    Ok(CommitOutcome {
        cleared_quarantine_apps,
        restored_execute_bits,
    })
}
