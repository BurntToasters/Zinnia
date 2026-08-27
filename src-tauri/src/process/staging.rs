//! Stage directory create/rewrite, extract parent snapshot, and SLT member preflight.

use crate::output::sanitize_output;
use crate::validation::archive_member_path_is_unsafe;

use super::archive_snapshot::{
    archive_file_identity, archive_identity_token, stage_extract_input_with_cancel,
    ArchiveFileIdentity,
};
use super::commands::{
    collect_command_output, extract_warning_is_metadata_only, terminate_registered_child,
};
use super::commit::archive_destination_family_snapshot;
use super::journal::{register_pending_stage, unregister_pending_stage};
use super::quota::available_space_for_path;
use super::{lock_process, ArchiveDestinationSnapshot, CleanupPlan, RunningProcess};

/// Selection token meaning "output path must still be absent at create time".
pub(crate) const ARCHIVE_OUTPUT_ABSENT_TOKEN: &str = "absent";

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

fn create_stage_dir_under(
    parent: &std::path::Path,
    purpose: &str,
    cache_dir: Option<&std::path::Path>,
    create: impl Fn(&std::path::Path) -> std::io::Result<()>,
) -> Result<std::path::PathBuf, String> {
    // Keep the stage basename independent of the user destination. Besides
    // avoiding NAME_MAX failures, this prevents 7-Zip output-path wildcard
    // substitution from interpreting a literal `*` in a destination name.
    for _ in 0..32 {
        let candidate = parent.join(format!(".zinnia-{purpose}-{}", random_token()?));
        match create(&candidate) {
            Ok(()) => {
                if let Some(cache_dir) = cache_dir {
                    if let Err(error) = register_pending_stage(cache_dir, &candidate) {
                        let _ = crate::fs_secure::remove_dir_all_for_cleanup(&candidate);
                        return Err(format!(
                            "Could not register staging directory for recovery: {error}"
                        ));
                    }
                }
                return Ok(candidate);
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
) -> Result<std::path::PathBuf, String> {
    let parent = anchor.parent().unwrap_or_else(|| std::path::Path::new("."));
    create_stage_dir_under(
        parent,
        purpose,
        cache_dir,
        crate::fs_secure::create_private_dir,
    )
}

/// Create a publish stage beside the target so it inherits the target parent's
/// normal local or SMB security policy.
pub(crate) fn create_publish_stage_dir(
    target: &std::path::Path,
    purpose: &str,
    cache_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    create_stage_dir_under(
        parent,
        purpose,
        cache_dir,
        crate::fs_secure::create_inheriting_stage_dir,
    )
}

pub(crate) fn next_extract_stage_path(
    target: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    if path_entry_exists(target)? {
        let meta = std::fs::symlink_metadata(target).map_err(|e| e.to_string())?;
        crate::path_safety::reject_link_or_reparse(target, &meta).map_err(|_| {
            "Extraction destination cannot be a symbolic link or reparse point.".to_string()
        })?;
        if !meta.is_dir() {
            return Err("Extraction destination is not a directory.".to_string());
        }
    }

    // Always stage as a sibling of the destination (never inside it). Extract
    // uses `-snld10` for macOS `.framework` chains; an inside-destination stage
    // would let a crafted relative escape symlink write into the live user
    // folder during 7-Zip extract, before staged-tree validation. Existing
    // destinations still get correct ACLs/mode via target-local publish under
    // the final parent. Keep InsideDestination journal recovery for older
    // in-flight transactions.
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

/// Build `7z l -slt -ba` args from an extract command, copying switches that
/// affect whether/how the archive can be opened.
pub(crate) fn extract_member_list_args(args: &[String]) -> Result<Vec<String>, String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "Extraction command is missing '--'.".to_string())?;
    let archive = args
        .get(separator + 1)
        .ok_or_else(|| "Extraction command is missing an archive path.".to_string())?;
    let mut list_args = vec!["l".to_string(), "-slt".to_string(), "-ba".to_string()];
    for arg in &args[1..separator] {
        let lower = arg.to_ascii_lowercase();
        if lower.starts_with("-p") || lower.starts_with("-t") {
            list_args.push(arg.clone());
        }
    }
    list_args.push("--".to_string());
    list_args.push(archive.clone());
    super::commands::harden_7z_args(&mut list_args);
    Ok(list_args)
}

/// Inspect `7z l -slt` output and reject members that could escape `-o`.
///
/// Checks `Path =` member names and real 7-Zip `Symbolic Link =` / `Hard Link =`
/// target fields. Link targets are resolved lexically so safe contained links
/// such as `bin/tool -> ../lib/tool` remain supported.
fn link_target_is_absolute(target: &str) -> bool {
    let bytes = target.as_bytes();
    bytes
        .first()
        .is_some_and(|byte| matches!(byte, b'/' | b'\\'))
        || (bytes.len() >= 2 && bytes[1] == b':')
}

fn symbolic_link_target_is_unsafe(member_path: &str, target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    if link_target_is_absolute(target) {
        return true;
    }

    let mut resolved: Vec<&str> = member_path
        .split(['/', '\\'])
        .filter(|component| !component.is_empty() && *component != ".")
        .collect();
    // Symlink targets are relative to the directory containing the link.
    resolved.pop();
    for component in target.split(['/', '\\']) {
        match component {
            "" | "." => {}
            ".." => {
                if resolved.pop().is_none() {
                    return true;
                }
            }
            other => resolved.push(other),
        }
    }
    false
}

fn hard_link_target_is_unsafe(target: &str) -> bool {
    link_target_is_absolute(target) || archive_member_path_is_unsafe(target)
}

pub(crate) fn listing_preflight_exit_is_acceptable(code: i32, stdout: &str, stderr: &str) -> bool {
    code == 0 || (code == 1 && extract_warning_is_metadata_only(stdout, stderr))
}

pub(crate) fn assert_slt_archive_members_safe(
    slt_output: &str,
    archive_path: &str,
) -> Result<(), String> {
    let archive_name = std::path::Path::new(archive_path)
        .file_name()
        .and_then(|name| name.to_str());
    let mut seen_member = false;
    let mut member_count = 0u64;
    let mut current_member: Option<&str> = None;
    for line in slt_output.lines() {
        if let Some(path) = line.strip_prefix("Path = ") {
            if path.is_empty() {
                continue;
            }
            // `-ba` suppresses the archive-container record, so every Path entry is
            // normally a member. Keep exact-container tolerance for older/future
            // sidecars without ever skipping an arbitrary first member.
            if path == archive_path || archive_name == Some(path) {
                current_member = None;
                continue;
            }
            seen_member = true;
            member_count = member_count.saturating_add(1);
            if member_count > super::quota::MAX_EXTRACT_ENTRIES {
                return Err(format!(
                    "Archive exceeds the safety limit of {} entries.",
                    super::quota::MAX_EXTRACT_ENTRIES
                ));
            }
            current_member = Some(path);
            if archive_member_path_is_unsafe(path) {
                return Err(format!(
                    "Archive contains an unsafe member path that could escape the extract folder: {path}"
                ));
            }
            continue;
        }
        if let Some(target) = line.strip_prefix("Symbolic Link = ") {
            if target.is_empty() {
                continue;
            }
            let member = current_member.ok_or_else(|| {
                "Could not associate an archive symbolic-link target with a member path."
                    .to_string()
            })?;
            if symbolic_link_target_is_unsafe(member, target) {
                return Err(format!(
                    "Archive contains an unsafe link target that could escape the extract folder: {target}"
                ));
            }
            continue;
        }
        if let Some(target) = line.strip_prefix("Hard Link = ") {
            if target.is_empty() {
                continue;
            }
            if current_member.is_none() {
                return Err(
                    "Could not associate an archive hard-link target with a member path."
                        .to_string(),
                );
            }
            if hard_link_target_is_unsafe(target) {
                return Err(format!(
                    "Archive contains an unsafe link target that could escape the extract folder: {target}"
                ));
            }
        }
    }
    // Empty archives legitimately produce no records. Non-empty output with no
    // Path records means the machine-readable schema was not understood; fail
    // closed instead of silently bypassing the safety check.
    if !seen_member && !slt_output.trim().is_empty() {
        return Err("Could not parse archive member paths from 7-Zip listing.".to_string());
    }
    Ok(())
}

pub(crate) async fn assert_extract_archive_members_safe(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: &[String],
) -> Result<(std::path::PathBuf, ArchiveFileIdentity), String> {
    let list_args = extract_member_list_args(args)?;
    let archive = list_args
        .last()
        .cloned()
        .ok_or_else(|| "Extraction member list is missing an archive path.".to_string())?;
    let archive_path = std::path::PathBuf::from(&archive);
    let identity = archive_file_identity(&archive_path)?;
    let (mut rx, child, pending_password) =
        super::commands::spawn_7z_noninteractive(app, list_args, state)?;
    {
        let mut process = lock_process(state)?;
        if process.cancelling {
            drop(process);
            terminate_registered_child(state, &child)?;
            return Err("Operation cancelled.".to_string());
        }
        // Register before password stdin so cancel can kill a blocked write.
        process.child = Some(child.clone());
    }
    if let Some(pending_password) = pending_password {
        if let Err(error) =
            super::commands::complete_password_transport(&child, pending_password).await
        {
            let cancelled = lock_process(state)
                .map(|process| process.cancelling)
                .unwrap_or(false);
            terminate_registered_child(state, &child)?;
            return Err(if cancelled {
                "Operation cancelled.".to_string()
            } else {
                error
            });
        }
        let process = lock_process(state)?;
        if process.cancelling {
            drop(process);
            terminate_registered_child(state, &child)?;
            return Err("Operation cancelled.".to_string());
        }
    }
    const LIST_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
    const LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
    let collected = match tokio::time::timeout(
        LIST_TIMEOUT,
        collect_command_output(&mut rx, LIST_OUTPUT_LIMIT, |_| {}),
    )
    .await
    {
        Ok(collected) => collected,
        Err(_) => {
            terminate_registered_child(state, &child)?;
            return Err("Archive member-safety preflight timed out after 120 seconds.".to_string());
        }
    };
    if collected.stream_error.is_some() || collected.exit.is_none() {
        terminate_registered_child(state, &child)?;
    }
    {
        let mut process = lock_process(state)?;
        process.child = None;
        if process.cancelling {
            return Err("Operation cancelled.".to_string());
        }
    }
    let code = collected
        .exit
        .as_ref()
        .and_then(|payload| payload.code)
        .unwrap_or(-1);
    if collected.stdout_truncated || collected.stderr_truncated {
        return Err(
            "Archive member-safety listing exceeded its output limit; extraction was cancelled."
                .to_string(),
        );
    }
    if !listing_preflight_exit_is_acceptable(code, &collected.stdout, &collected.stderr) {
        let detail = sanitize_output(collected.stderr.trim());
        let detail = if detail.is_empty() {
            sanitize_output(collected.stdout.trim())
        } else {
            detail
        };
        return Err(if detail.is_empty() {
            format!("Could not list archive members for path safety (exit {code}).")
        } else {
            format!("Could not list archive members for path safety: {detail}")
        });
    }
    assert_slt_archive_members_safe(&collected.stdout, &archive)?;
    Ok((archive_path, identity))
}

#[cfg(test)]
pub(crate) fn prepare_cleanup_plan(
    args: &[String],
    cache_dir: Option<std::path::PathBuf>,
    expected_archive_identity: Option<&str>,
) -> Result<CleanupPlan, String> {
    prepare_cleanup_plan_with_cancel(args, cache_dir, expected_archive_identity, || false)
}

pub(crate) fn prepare_cleanup_plan_with_cancel<C>(
    args: &[String],
    cache_dir: Option<std::path::PathBuf>,
    expected_archive_identity: Option<&str>,
    should_cancel: C,
) -> Result<CleanupPlan, String>
where
    C: Fn() -> bool,
{
    let cache_ref = cache_dir.as_deref();
    let command = args.first().map(String::as_str);
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let compound_stream = args.get(separator + 1).is_some_and(|archive| {
        let lower = archive.to_ascii_lowercase();
        [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
    });
    let Some(target) = operation_output_path(args) else {
        if matches!(command, Some("l" | "t")) && compound_stream {
            const MAX_EXTRACT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
            const MIN_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
            let archive = args
                .get(separator + 1)
                .ok_or_else(|| "Archive command is missing an archive path.".to_string())?;
            let staged_input = stage_extract_input_with_cancel(
                std::path::Path::new(archive),
                cache_ref,
                expected_archive_identity,
                &should_cancel,
            )?;
            let preparation = (|| {
                let ratio_limit = staged_input
                    .total_len
                    .saturating_mul(1000)
                    .min(MAX_EXTRACT_BYTES);
                let free_space = available_space_for_path(&staged_input.path)?;
                let reserve = (free_space / 10).max(MIN_DISK_RESERVE_BYTES);
                let max_bytes = ratio_limit.min(free_space.saturating_sub(reserve));
                if max_bytes == 0 {
                    return Err(
                        "Not enough free space to inspect the compound TAR stream.".to_string()
                    );
                }
                Ok((max_bytes, reserve))
            })();
            return match preparation {
                Ok((max_extract_bytes, min_free_bytes)) => Ok(CleanupPlan {
                    staged_extract: None,
                    staged_archive: None,
                    expected_archive_family: Vec::new(),
                    staged_input_archive: Some(staged_input.path),
                    cache_dir,
                    max_extract_bytes: Some(max_extract_bytes),
                    min_free_bytes: Some(min_free_bytes),
                }),
                Err(error) => {
                    if let Some(parent) = staged_input.path.parent() {
                        let _ = crate::fs_secure::remove_dir_all_for_cleanup(parent);
                        if let Some(cache) = cache_ref {
                            let _ = unregister_pending_stage(cache, parent);
                        }
                    }
                    Err(error)
                }
            };
        }
        return Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            expected_archive_family: Vec::new(),
            staged_input_archive: None,
            cache_dir,
            max_extract_bytes: None,
            min_free_bytes: None,
        });
    };

    match args.first().map(String::as_str) {
        Some("x") => {
            let destination = if path_entry_exists(&target)? {
                resolve_existing_target(&target, true)
                    .map_err(|e| format!("Could not resolve the extraction destination: {e}"))?
            } else {
                resolve_new_target(&target)?
            };
            let separator = args
                .iter()
                .position(|arg| arg == "--")
                .unwrap_or(args.len());
            const MAX_EXTRACT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
            const MIN_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
            let stage = next_extract_stage_path(&destination, cache_ref)?;
            let archive = args
                .get(separator + 1)
                .ok_or_else(|| "Extraction command is missing an archive path.".to_string())?;
            let staged_input = match stage_extract_input_with_cancel(
                std::path::Path::new(archive),
                cache_ref,
                expected_archive_identity,
                &should_cancel,
            ) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let _ = crate::fs_secure::remove_dir_all_for_cleanup(&stage);
                    if let Some(cache) = cache_ref {
                        let _ = unregister_pending_stage(cache, &stage);
                    }
                    return Err(error);
                }
            };
            let preparation = (|| {
                let ratio_limit = staged_input
                    .total_len
                    .saturating_mul(1000)
                    .min(MAX_EXTRACT_BYTES);
                let free_space = available_space_for_path(&destination)?;
                let reserve = (free_space / 10).max(MIN_DISK_RESERVE_BYTES);
                let disk_limit = free_space.saturating_sub(reserve);
                if disk_limit == 0 {
                    return Err(format!(
                        "Not enough free space to extract safely ({} MiB available).",
                        free_space / (1024 * 1024)
                    ));
                }
                let max_extract_bytes = ratio_limit.min(disk_limit);
                Ok((max_extract_bytes, reserve))
            })();
            let (max_extract_bytes, reserve) = match preparation {
                Ok(preparation) => preparation,
                Err(error) => {
                    let input_stage = staged_input.path.parent().map(std::path::Path::to_path_buf);
                    let _ = crate::fs_secure::remove_dir_all_for_cleanup(&stage);
                    if let Some(input_stage) = &input_stage {
                        let _ = crate::fs_secure::remove_dir_all_for_cleanup(input_stage);
                    }
                    if let Some(cache) = cache_ref {
                        let _ = unregister_pending_stage(cache, &stage);
                        if let Some(input_stage) = &input_stage {
                            let _ = unregister_pending_stage(cache, input_stage);
                        }
                    }
                    return Err(error);
                }
            };
            Ok(CleanupPlan {
                staged_extract: Some((stage, destination)),
                staged_archive: None,
                expected_archive_family: Vec::new(),
                staged_input_archive: Some(staged_input.path),
                // Member preflight plus a fixed, wildcard-free stage
                // contains 7-Zip output. Unrelated siblings may legitimately
                // appear during a long extraction and must not abort commit.
                cache_dir,
                max_extract_bytes: Some(max_extract_bytes),
                min_free_bytes: Some(reserve),
            })
        }
        Some("a") => {
            let pre_family = archive_destination_family_snapshot(&target)?;
            if let Some(expected) = expected_archive_identity {
                let current = archive_output_family_token_from_snapshots(&pre_family);
                if expected == ARCHIVE_OUTPUT_ABSENT_TOKEN {
                    if current != ARCHIVE_OUTPUT_ABSENT_TOKEN {
                        return Err(
                            "Archive output appeared after it was selected; choose a different output path."
                                .to_string(),
                        );
                    }
                } else if current == ARCHIVE_OUTPUT_ABSENT_TOKEN {
                    return Err(
                        "Archive output disappeared after it was selected; choose a new output path."
                            .to_string(),
                    );
                } else if current != expected {
                    return Err(
                        "Archive output changed after it was selected; choose the current file again."
                            .to_string(),
                    );
                }
            }
            let target = if path_entry_exists(&target)? {
                resolve_existing_target(&target, false)?
            } else {
                resolve_new_target(&target)?
            };
            let expected_archive_family = archive_destination_family_snapshot(&target)?;
            if !archive_family_content_matches(&pre_family, &expected_archive_family) {
                return Err(
                    "Archive output changed after it was selected; choose the current file again."
                        .to_string(),
                );
            }
            let stage_dir = create_publish_stage_dir(&target, "archive", cache_ref)?;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                expected_archive_family,
                staged_input_archive: None,
                cache_dir,
                max_extract_bytes: None,
                min_free_bytes: None,
            })
        }
        Some("u") => {
            if !path_entry_exists(&target)? {
                return Err("Update requires an existing output archive file.".to_string());
            }
            let target = resolve_existing_target(&target, false)?;
            if let Some(expected) = expected_archive_identity {
                if archive_identity_token(&target)? != expected {
                    return Err(
                        "Archive changed after it was selected; review the current archive before updating it."
                            .to_string(),
                    );
                }
            }
            let expected_archive_family = archive_destination_family_snapshot(&target)?;
            if expected_archive_family.len() != 1 {
                return Err(
                    "Updating split or multi-volume archives is not supported by bundled 7-Zip. Create a new archive instead."
                        .to_string(),
                );
            }
            let stage_dir = create_publish_stage_dir(&target, "archive", cache_ref)?;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            if let Err(error) = std::fs::copy(&target, &staged) {
                let _ = crate::fs_secure::remove_dir_all_for_cleanup(&stage_dir);
                if let Some(cache_dir) = cache_ref {
                    let _ = unregister_pending_stage(cache_dir, &stage_dir);
                }
                return Err(format!("Could not stage the archive for update: {error}"));
            }
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                expected_archive_family,
                staged_input_archive: None,
                cache_dir,
                max_extract_bytes: None,
                min_free_bytes: None,
            })
        }
        _ => Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            expected_archive_family: Vec::new(),
            staged_input_archive: None,
            cache_dir,
            max_extract_bytes: None,
            min_free_bytes: None,
        }),
    }
}
