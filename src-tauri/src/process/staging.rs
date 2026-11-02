//! Stage directory create/rewrite, extract parent snapshot, and SLT member preflight.

mod plan;
mod slt;

use super::commit::archive_destination_family_snapshot;
use super::journal::{
    file_identity, register_pending_stage, unregister_pending_stage, FileIdentity,
};
use super::ArchiveDestinationSnapshot;

/// Selection token meaning "output path must still be absent at create time".
pub(crate) const ARCHIVE_OUTPUT_ABSENT_TOKEN: &str = "absent";

const PREPARATION_RECOVERY_REQUIRED_PREFIX: &str = "\0zinnia-recovery-required:";

#[derive(Debug)]
pub(crate) enum PreparationPlanError {
    CleanupComplete(String),
    RecoveryRequired(String),
}

impl PreparationPlanError {
    pub(crate) fn into_parts(self) -> (String, bool) {
        match self {
            Self::CleanupComplete(message) => (message, false),
            Self::RecoveryRequired(message) => (message, true),
        }
    }
}

pub(super) fn preparation_cleanup_failed(
    operation_error: impl AsRef<str>,
    cleanup_error: impl AsRef<str>,
) -> String {
    let operation_error = operation_error
        .as_ref()
        .strip_prefix(PREPARATION_RECOVERY_REQUIRED_PREFIX)
        .unwrap_or_else(|| operation_error.as_ref());
    format!(
        "{PREPARATION_RECOVERY_REQUIRED_PREFIX}{operation_error}; preparation cleanup also failed: {}",
        cleanup_error.as_ref()
    )
}

pub(super) fn preparation_error_requires_recovery(error: &str) -> bool {
    error.starts_with(PREPARATION_RECOVERY_REQUIRED_PREFIX)
}

fn classify_preparation_error(error: String) -> PreparationPlanError {
    match error.strip_prefix(PREPARATION_RECOVERY_REQUIRED_PREFIX) {
        Some(message) => PreparationPlanError::RecoveryRequired(message.to_string()),
        None => PreparationPlanError::CleanupComplete(error),
    }
}

/// Hash of the create destination family (base + contiguous `.001`…) at pick
/// time. Empty family is `ARCHIVE_OUTPUT_ABSENT_TOKEN`.
pub(crate) fn archive_output_family_token(path: &std::path::Path) -> Result<String, String> {
    let family = archive_destination_family_snapshot(path)?;
    Ok(archive_output_family_token_from_snapshots(&family))
}

fn archive_output_family_token_from_snapshots(family: &[ArchiveDestinationSnapshot]) -> String {
    use sha2::Digest as _;

    if family.is_empty() {
        return ARCHIVE_OUTPUT_ABSENT_TOKEN.to_string();
    }
    let mut hasher = sha2::Sha256::new();
    for member in family {
        hasher.update(member.path.as_os_str().as_encoded_bytes());
        hasher.update(member.len.to_le_bytes());
        hasher.update(member.sha256);
    }
    format!("{:x}", hasher.finalize())
}

fn archive_family_content_matches(
    left: &[ArchiveDestinationSnapshot],
    right: &[ArchiveDestinationSnapshot],
) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(a, b)| a.len == b.len && a.sha256 == b.sha256)
}

// For a compress/update command, the output archive is the single positional
// arg before `--`. For extract, the -o<dir> destination is returned.
pub(crate) fn operation_output_path(args: &[String]) -> Option<std::path::PathBuf> {
    let cmd = args.first().map(String::as_str)?;
    match cmd {
        "a" | "u" => {
            let separator = args.iter().position(|a| a == "--")?;
            args[1..separator]
                .iter()
                .find(|a| !a.starts_with('-'))
                .map(std::path::PathBuf::from)
        }
        "x" => {
            // Find -o<dir> in the args before --
            let separator = args.iter().position(|a| a == "--").unwrap_or(args.len());
            args[1..separator]
                .iter()
                .find(|a| a.to_ascii_lowercase().starts_with("-o"))
                .map(|a| std::path::PathBuf::from(&a[2..]))
        }
        _ => None,
    }
}

pub(crate) fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("Secure randomness unavailable: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn resolve_new_target(target: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !target.is_absolute() {
        return Err(
            "Choose a full output path (for example Desktop or Documents). Relative paths stage under the working directory and often fail with Access Denied."
                .to_string(),
        );
    }
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Could not resolve output parent directory: {e}"))?;
    let name = target
        .file_name()
        .ok_or_else(|| "Output path must have a file or directory name.".to_string())?;
    Ok(canonical_parent.join(name))
}

pub(crate) fn path_entry_exists(path: &std::path::Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn assert_real_directory(path: &std::path::Path) -> Result<(), String> {
    crate::path_safety::assert_real_directory(path).map_err(|error| {
        if error.starts_with("Path is not a real directory") {
            format!(
                "Extraction path is not a real directory: {}",
                path.display()
            )
        } else {
            error
        }
    })
}

pub(crate) fn resolve_existing_target(
    target: &std::path::Path,
    expected_directory: bool,
) -> Result<std::path::PathBuf, String> {
    if expected_directory {
        crate::path_safety::assert_real_directory(target).map_err(|error| {
            if error.contains("not a real directory") {
                "Extraction destination is not a directory.".to_string()
            } else if error.contains("symbolic link") || error.contains("reparse") {
                "Output target cannot be a symbolic link or reparse point.".to_string()
            } else {
                error
            }
        })?;
    } else {
        crate::path_safety::assert_real_file(target).map_err(|error| {
            if error.contains("not a regular file") {
                "Archive output is not a regular file.".to_string()
            } else if error.contains("symbolic link") || error.contains("reparse") {
                "Output target cannot be a symbolic link or reparse point.".to_string()
            } else {
                error
            }
        })?;
    }
    target.canonicalize().map_err(|e| e.to_string())
}

#[derive(Debug)]
pub(crate) struct CreatedStageDir {
    pub(crate) path: std::path::PathBuf,
    pub(crate) identity: FileIdentity,
}

fn cleanup_owned_stage(
    stage: &std::path::Path,
    identity: &FileIdentity,
    cache_dir: Option<&std::path::Path>,
) -> Result<(), String> {
    // A Windows hard-link snapshot keeps the source handle alive until the
    // staged input is handed to the run plan. Preparation can still fail after
    // that handoff (for example, a free-space or ratio check), before the
    // caller has a CleanupPlan/SnapshotHandleGuard to release it. Unlock the
    // source before direct rollback so an aborted preparation cannot retain a
    // write/delete lock for the lifetime of the process.
    super::release_snapshot_handles(stage);
    super::journal::remove_directory_if_matches(stage, identity)?;
    if let Some(cache_dir) = cache_dir {
        unregister_pending_stage(cache_dir, stage)?;
    }
    Ok(())
}

fn create_stage_dir_under(
    parent: &std::path::Path,
    purpose: &str,
    cache_dir: Option<&std::path::Path>,
    create: impl Fn(&std::path::Path, &std::ffi::OsStr) -> std::io::Result<std::fs::File>,
) -> Result<CreatedStageDir, String> {
    // Keep the stage basename independent of the user destination. Besides
    // avoiding NAME_MAX failures, this prevents 7-Zip output-path wildcard
    // substitution from interpreting a literal `*` in a destination name.
    for _ in 0..32 {
        let candidate = parent.join(format!(".zinnia-{purpose}-{}", random_token()?));
        let name = candidate
            .file_name()
            .ok_or_else(|| "Staging directory has no file name.".to_string())?;
        match create(parent, name) {
            Ok(directory) => {
                // Capture ownership only from the handle returned by the held-
                // parent creation operation. The pathname is used below solely
                // to reject replacement before durable registration; it can
                // never manufacture a different ownership identity.
                let identity = match file_identity(&directory) {
                    Ok(identity) => identity,
                    Err(error) => {
                        drop(directory);
                        return Err(preparation_cleanup_failed(
                            format!(
                                "Could not identify newly created staging directory {}: {error}",
                                candidate.display()
                            ),
                            "ownership of the created directory could not be recorded",
                        ));
                    }
                };
                if let Some(cache_dir) = cache_dir {
                    if let Err(error) = register_pending_stage(cache_dir, &candidate, &identity) {
                        drop(directory);
                        return match super::journal::remove_directory_if_matches(
                            &candidate, &identity,
                        ) {
                            Ok(()) => Err(format!(
                                "Could not register staging directory for recovery: {error}"
                            )),
                            Err(cleanup_error) => Err(preparation_cleanup_failed(
                                format!(
                                    "Could not register staging directory for recovery: {error}"
                                ),
                                cleanup_error,
                            )),
                        };
                    }
                }
                drop(directory);
                return Ok(CreatedStageDir {
                    path: candidate,
                    identity,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create staging directory: {error}")),
        }
    }
    Err("Could not reserve a unique staging directory.".to_string())
}

/// Create an app-private stage beside an anchor path.
///
/// This is reserved for archive input snapshots and other internal material
/// that must not inherit a user-selected or remote share ACL.
pub(crate) fn create_private_stage_dir(
    anchor: &std::path::Path,
    purpose: &str,
    cache_dir: Option<&std::path::Path>,
) -> Result<CreatedStageDir, String> {
    let parent = anchor.parent().unwrap_or_else(|| std::path::Path::new("."));
    create_stage_dir_under(
        parent,
        purpose,
        cache_dir,
        crate::fs_secure::create_private_stage_dir_open,
    )
}

/// Create a publish stage beside the target so it inherits the target parent's
/// normal local or SMB security policy.
pub(crate) fn create_publish_stage_dir(
    target: &std::path::Path,
    purpose: &str,
    cache_dir: Option<&std::path::Path>,
) -> Result<CreatedStageDir, String> {
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    create_stage_dir_under(
        parent,
        purpose,
        cache_dir,
        crate::fs_secure::create_inheriting_stage_dir_open_in,
    )
}

/// Create an extraction stage as a hidden child of an already existing,
/// validated destination. Caller may use this only after member preflight
/// proves archive has no symbolic or hard links.
pub(crate) fn create_publish_stage_dir_inside(
    destination: &std::path::Path,
    purpose: &str,
    cache_dir: Option<&std::path::Path>,
) -> Result<CreatedStageDir, String> {
    create_stage_dir_under(
        destination,
        purpose,
        cache_dir,
        crate::fs_secure::create_inheriting_stage_dir_open_in,
    )
}

pub(crate) fn next_extract_stage_path(
    target: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
) -> Result<CreatedStageDir, String> {
    if path_entry_exists(target)? {
        let meta = std::fs::symlink_metadata(target).map_err(|e| e.to_string())?;
        crate::path_safety::reject_link_or_reparse(target, &meta).map_err(|_| {
            "Extraction destination cannot be a symbolic link or reparse point.".to_string()
        })?;
        if !meta.is_dir() {
            return Err("Extraction destination is not a directory.".to_string());
        }
    }

    // Start sibling staging. After member preflight proves no symbolic/hard
    // links, production may replace this empty stage with an inside-destination
    // stage so link-free output inherits destination ACL/mode directly. Link-
    // bearing archives always retain this sibling placement.
    create_publish_stage_dir(target, "extract", cache_dir)
}

pub(crate) fn rewrite_extract_output(
    args: &mut [String],
    staged_dir: &std::path::Path,
) -> Result<(), String> {
    let output = format!("-o{}", staged_dir.to_string_lossy());
    let Some(arg) = args
        .iter_mut()
        .find(|arg| arg.to_ascii_lowercase().starts_with("-o"))
    else {
        return Err("Extraction command is missing an output directory.".to_string());
    };
    *arg = output;
    Ok(())
}

pub(crate) fn rewrite_extract_archive(
    args: &mut [String],
    staged_archive: &std::path::Path,
) -> Result<(), String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "Extraction command is missing '--'.".to_string())?;
    let archive = args
        .get_mut(separator + 1)
        .ok_or_else(|| "Extraction command is missing an archive path.".to_string())?;
    *archive = staged_archive.to_string_lossy().to_string();
    Ok(())
}

pub(crate) fn rewrite_archive_output(
    args: &mut [String],
    staged: &std::path::Path,
) -> Result<(), String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "Compression command is missing '--'.".to_string())?;
    let Some(arg) = args[1..separator]
        .iter_mut()
        .find(|arg| !arg.starts_with('-'))
    else {
        return Err("Compression command is missing an output archive.".to_string());
    };
    *arg = staged.to_string_lossy().to_string();
    Ok(())
}

/// Keep update source archive read-only and ask 7-Zip to write complete output
/// into staged path. Existing callers that need ordinary output replacement
/// continue using `rewrite_archive_output`.
pub(crate) fn rewrite_archive_update_output(
    args: &mut Vec<String>,
    staged: &std::path::Path,
) -> Result<(), String> {
    if args.first().map(String::as_str) != Some("u") {
        return Err("Separate-output archive rewrite requires an update command.".to_string());
    }
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "Compression command is missing '--'.".to_string())?;
    if !args[1..separator].iter().any(|arg| !arg.starts_with('-')) {
        return Err("Compression command is missing an output archive.".to_string());
    }
    // 7-Zip's full update action set: preserve all old records unless input
    // selection replaces them, then write complete result to `staged`.
    let retained: Vec<String> = args[1..separator]
        .iter()
        .filter(|arg| {
            let lower = arg.to_ascii_lowercase();
            !lower.starts_with("-u")
        })
        .cloned()
        .collect();
    args.splice(1..separator, retained);
    args.insert(1, "-u-".to_string());
    args.insert(2, format!("-up1q1r2x1y2z1w2!{}", staged.to_string_lossy()));
    Ok(())
}

pub(crate) use plan::*;
pub(crate) use slt::*;
