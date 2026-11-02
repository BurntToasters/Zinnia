//! Promote/merge staged outputs, commit and rollback cleanup.

mod archive_promote;
mod extract_merge;
mod publish;
mod staged_tree;

#[cfg(test)]
pub(crate) use archive_promote::archive_stage_has_recovery_backups;
pub(crate) use archive_promote::commit_failure_should_scrub_staging;
#[cfg(test)]
pub(crate) use archive_promote::promote_archive_family;
pub(crate) use extract_merge::{
    clear_staged_directory_shell_attributes, commit_cleanup, ensure_extract_stage_has_output,
    rollback_persisted_move_plan,
};
#[cfg(test)]
pub(crate) use extract_merge::{
    merge_staged_extract, merge_staged_extract_with_commit, rollback_move_records,
};
#[cfg(test)]
pub(crate) use extract_merge::{validate_move_record, write_move_plan};
#[cfg(any(windows, test))]
pub(crate) use publish::copy_file_no_replace;
#[cfg(test)]
pub(crate) use publish::publish_file_no_replace;
pub(crate) use publish::rename_file_no_replace;
#[cfg(test)]
pub(crate) use staged_tree::staged_tree_contains_symlink;
pub(crate) use staged_tree::validate_staged_tree;
#[cfg(test)]
pub(crate) use staged_tree::MAX_EXTRACTED_BYTES;

pub(crate) use crate::fs_secure::sync_file_best_effort;

use super::journal::{file_identities_match, file_identity, unregister_plan_stages_strict};
use super::staging::{assert_real_directory, path_entry_exists};
use super::{ArchiveDestinationSnapshot, CleanupPlan};

pub(crate) fn archive_destination_snapshot(
    path: &std::path::Path,
) -> Result<ArchiveDestinationSnapshot, String> {
    let mut file = crate::path_safety::open_regular_file_nofollow(path)?;
    archive_destination_snapshot_from_open_file(path, &mut file)
}

pub(super) fn archive_destination_snapshot_from_open_file(
    path: &std::path::Path,
    file: &mut std::fs::File,
) -> Result<ArchiveDestinationSnapshot, String> {
    use sha2::Digest as _;
    use std::io::Read as _;

    let identity = file_identity(file)?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let len = metadata.len();
    let modified = metadata.modified().ok();
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not fingerprint {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let after_identity = file_identity(file)?;
    let after_metadata = file.metadata().map_err(|error| error.to_string())?;
    if !file_identities_match(&identity, &after_identity)
        || len != after_metadata.len()
        || modified != after_metadata.modified().ok()
    {
        return Err(format!(
            "Archive destination changed while it was being fingerprinted: {}",
            path.display()
        ));
    }
    Ok(ArchiveDestinationSnapshot {
        path: path.to_path_buf(),
        identity,
        len,
        modified,
        sha256: hasher.finalize().into(),
    })
}

pub(crate) fn archive_destination_family_snapshot(
    base: &std::path::Path,
) -> Result<Vec<ArchiveDestinationSnapshot>, String> {
    archive_family(base)?
        .iter()
        .map(|path| archive_destination_snapshot(path))
        .collect()
}

#[cfg(test)]
pub(crate) fn assert_archive_destination_unchanged(
    base: &std::path::Path,
    expected: &[ArchiveDestinationSnapshot],
) -> Result<(), String> {
    let current = archive_destination_family_snapshot(base)?;
    if current == expected {
        Ok(())
    } else {
        Err(
            "Archive destination changed while the operation was running; the new file was preserved."
                .to_string(),
        )
    }
}

pub(crate) fn archive_backup_path(stage_dir: &std::path::Path, index: usize) -> std::path::PathBuf {
    let name = stage_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".zinnia-archive-unknown");
    stage_dir.with_file_name(format!("{name}.backup-{index}"))
}

pub(crate) fn assert_safe_extract_target_ancestors(
    destination: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    assert_real_directory(destination)?;
    if !crate::path_safety::path_is_under_or_equal(destination, target) {
        return Err(format!(
            "Extraction target escaped destination: {}",
            target.display()
        ));
    }
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
        match component {
            std::path::Component::Normal(_) => {
                cursor.push(component);
                assert_real_directory(&cursor)?;
            }
            _ => {
                return Err(format!(
                    "Extraction target escaped destination: {}",
                    target.display()
                ));
            }
        }
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
    const MAX_ARCHIVE_VOLUMES: u32 = 10_000;
    for index in 1..=MAX_ARCHIVE_VOLUMES {
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
    let overflow = parent.join(format!("{name}.{:03}", MAX_ARCHIVE_VOLUMES + 1));
    if path_entry_exists(&overflow)? {
        return Err(format!(
            "Archive output exceeds the {MAX_ARCHIVE_VOLUMES}-volume safety limit."
        ));
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
/// Publication paths are deliberately explicit so diagnostics and structural
/// checks describe the real branch taken. Journal wire data remains unchanged;
/// this is an in-memory classification only.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PublishStrategy {
    WholeStageRename,
    DirectRename,
    TargetLocalCopy,
    HardLinkFallback,
    CopyFallback,
    Mixed,
}

impl PublishStrategy {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::WholeStageRename => "whole-stage-rename",
            Self::DirectRename => "direct-rename",
            Self::TargetLocalCopy => "target-local-copy",
            Self::HardLinkFallback => "hard-link-fallback",
            Self::CopyFallback => "copy-fallback",
            Self::Mixed => "mixed-publish-paths",
        }
    }

    fn combine(self, other: Self) -> Self {
        if self == other {
            return self;
        }
        if matches!(self, Self::CopyFallback) || matches!(other, Self::CopyFallback) {
            return Self::CopyFallback;
        }
        if matches!(self, Self::TargetLocalCopy) || matches!(other, Self::TargetLocalCopy) {
            return Self::TargetLocalCopy;
        }
        if matches!(self, Self::HardLinkFallback) || matches!(other, Self::HardLinkFallback) {
            return Self::HardLinkFallback;
        }
        Self::Mixed
    }
}
pub(super) fn remove_plan_stage_if_owned(
    plan: &CleanupPlan,
    stage: &std::path::Path,
) -> Result<(), String> {
    let identity = plan.stage_identity(stage).ok_or_else(|| {
        format!(
            "Refusing staging cleanup without a creation-bound identity: {}",
            stage.display()
        )
    })?;
    let (move_plan_identity, move_identity_log_identity, archive_backup_identities) =
        if let Some(cache_dir) = &plan.cache_dir {
            super::journal::pending_artifact_identities(cache_dir, stage, identity)?
        } else {
            (None, None, Vec::new())
        };
    super::journal::cleanup_transaction_artifacts(
        stage,
        Some(identity),
        move_plan_identity.as_ref(),
        move_identity_log_identity.as_ref(),
        &archive_backup_identities,
    )
}

pub(crate) fn rollback_cleanup(plan: &CleanupPlan) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Some((staged, _)) = &plan.staged_extract {
        if let Err(e) = remove_plan_stage_if_owned(plan, staged) {
            failures.push(format!(
                "Could not remove partial extract transaction artifacts for {}: {e}",
                staged.display()
            ));
        }
    }
    if let Some((staged, _)) = &plan.staged_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = remove_plan_stage_if_owned(plan, stage_dir) {
            failures.push(format!(
                "Could not remove partial archive staging directory {}: {e}",
                stage_dir.display()
            ));
        }
    }
    if let Some(staged) = &plan.staged_input_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = remove_plan_stage_if_owned(plan, stage_dir) {
            failures.push(format!(
                "Could not remove archive input snapshot {}: {e}",
                stage_dir.display()
            ));
        }
    }
    if failures.is_empty() {
        unregister_plan_stages_strict(plan)
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
