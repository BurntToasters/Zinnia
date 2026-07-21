//! Stage directory create/rewrite, extract parent snapshot, and SLT member preflight.

use tauri_plugin_shell::ShellExt;

use crate::output::sanitize_output;
use crate::validation::archive_member_path_is_unsafe;

use super::archive_snapshot::{archive_file_identity, stage_extract_input, ArchiveFileIdentity};
use super::commands::collect_command_output;
use super::journal::{register_pending_stage, unregister_pending_stage};
use super::quota::available_space_for_path;
use super::{lock_process, CleanupPlan, RunningProcess};

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
                .find(|a| a.to_lowercase().starts_with("-o"))
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

pub(crate) fn create_private_stage_dir(
    target: &std::path::Path,
    purpose: &str,
    cache_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("output");
    for _ in 0..32 {
        let candidate = parent.join(format!(".{name}.zinnia-{purpose}-{}", random_token()?));
        match crate::fs_secure::create_private_dir(&candidate) {
            Ok(()) => {
                if let Some(cache_dir) = cache_dir {
                    if let Err(error) = register_pending_stage(cache_dir, &candidate) {
                        let _ = std::fs::remove_dir_all(&candidate);
                        return Err(format!(
                            "Could not register staging directory for recovery: {error}"
                        ));
                    }
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create secure staging directory: {error}"
                ))
            }
        }
    }
    Err("Could not reserve a unique staging directory.".to_string())
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
    create_private_stage_dir(target, "extract", cache_dir)
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

pub(crate) fn directory_entry_names(
    dir: &std::path::Path,
) -> Result<std::collections::HashSet<std::ffi::OsString>, String> {
    let mut names = std::collections::HashSet::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        names.insert(entry.file_name());
    }
    Ok(names)
}

pub(crate) fn assert_extract_parent_unchanged(
    stage: &std::path::Path,
    expected: &std::collections::HashSet<std::ffi::OsString>,
) -> Result<(), String> {
    let parent = stage
        .parent()
        .ok_or_else(|| "Staged extract has no parent directory.".to_string())?;
    let current = directory_entry_names(parent)?;
    for name in &current {
        if !expected.contains(name) {
            return Err(format!(
                "Extraction wrote outside the staging directory: {}",
                parent.join(name).display()
            ));
        }
    }
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
    Ok(list_args)
}

/// Inspect `7z l -slt` output and reject members that could escape `-o`.
pub(crate) fn assert_slt_archive_members_safe(
    slt_output: &str,
    archive_path: &str,
) -> Result<(), String> {
    let archive_name = std::path::Path::new(archive_path)
        .file_name()
        .and_then(|name| name.to_str());
    let mut seen_member = false;
    for line in slt_output.lines() {
        let Some(path) = line.strip_prefix("Path = ") else {
            continue;
        };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        // `-ba` suppresses the archive-container record, so every Path entry is
        // normally a member. Keep exact-container tolerance for older/future
        // sidecars without ever skipping an arbitrary first member.
        if path == archive_path || archive_name == Some(path) {
            continue;
        }
        seen_member = true;
        if archive_member_path_is_unsafe(path) {
            return Err(format!(
                "Archive contains an unsafe member path that could escape the extract folder: {path}"
            ));
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
    let command = app
        .shell()
        .sidecar("7z")
        .map_err(|e| e.to_string())?
        .args(list_args);
    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    {
        let mut process = lock_process(state)?;
        if process.cancelling {
            let _ = child.kill();
            return Err("Operation cancelled.".to_string());
        }
        process.child = Some(child);
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
            if let Ok(mut process) = lock_process(state) {
                if let Some(child) = process.child.take() {
                    let _ = child.kill();
                }
            }
            return Err("Archive member-safety preflight timed out after 120 seconds.".to_string());
        }
    };
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
    // 7-Zip uses exit code 1 for warnings (e.g. recoverable issues); still parse.
    if code != 0 && code != 1 {
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

pub(crate) fn prepare_cleanup_plan(
    args: &[String],
    cache_dir: Option<std::path::PathBuf>,
) -> Result<CleanupPlan, String> {
    let cache_ref = cache_dir.as_deref();
    let Some(target) = operation_output_path(args) else {
        return Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            staged_input_archive: None,
            extract_parent_names: None,
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
            let staged_input = match stage_extract_input(std::path::Path::new(archive), cache_ref) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let _ = std::fs::remove_dir_all(&stage);
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
                let parent = stage
                    .parent()
                    .ok_or_else(|| "Staged extract has no parent directory.".to_string())?;
                let extract_parent_names = directory_entry_names(parent)?;
                Ok((max_extract_bytes, reserve, extract_parent_names))
            })();
            let (max_extract_bytes, reserve, extract_parent_names) = match preparation {
                Ok(preparation) => preparation,
                Err(error) => {
                    let input_stage = staged_input.path.parent().map(std::path::Path::to_path_buf);
                    let _ = std::fs::remove_dir_all(&stage);
                    if let Some(input_stage) = &input_stage {
                        let _ = std::fs::remove_dir_all(input_stage);
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
                staged_input_archive: Some(staged_input.path),
                extract_parent_names: Some(extract_parent_names),
                cache_dir,
                max_extract_bytes: Some(max_extract_bytes),
                min_free_bytes: Some(reserve),
            })
        }
        Some("a") => {
            let target = if path_entry_exists(&target)? {
                resolve_existing_target(&target, false)?
            } else {
                resolve_new_target(&target)?
            };
            let stage_dir = create_private_stage_dir(&target, "archive", cache_ref)?;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                staged_input_archive: None,
                extract_parent_names: None,
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
            let stage_dir = create_private_stage_dir(&target, "archive", cache_ref)?;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            if let Err(error) = std::fs::copy(&target, &staged) {
                let _ = std::fs::remove_dir_all(&stage_dir);
                if let Some(cache_dir) = cache_ref {
                    let _ = unregister_pending_stage(cache_dir, &stage_dir);
                }
                return Err(format!("Could not stage the archive for update: {error}"));
            }
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                staged_input_archive: None,
                extract_parent_names: None,
                cache_dir,
                max_extract_bytes: None,
                min_free_bytes: None,
            })
        }
        _ => Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            staged_input_archive: None,
            extract_parent_names: None,
            cache_dir,
            max_extract_bytes: None,
            min_free_bytes: None,
        }),
    }
}
