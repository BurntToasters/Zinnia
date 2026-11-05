//! 7-Zip SLT member listing and path-safety preflight.

use crate::output::sanitize_output;
use crate::validation::archive_member_path_is_unsafe;

use crate::process::archive_snapshot::{archive_file_identity, ArchiveFileIdentity};
use crate::process::commands::{
    collect_command_output, extract_warning_is_metadata_only, terminate_registered_child_async,
    CollectedOutput,
};
use crate::process::{lock_process, ArchiveManifestSummary, RunningProcess};

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
    crate::process::commands::harden_7z_args(&mut list_args);
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

/// True for a 10-character `ls`-style mode string whose type is a symlink,
/// as 7-Zip prints for archive members that carry Unix attributes.
fn unix_mode_is_symlink(mode: &str) -> bool {
    let bytes = mode.as_bytes();
    bytes.len() == 10
        && bytes[0] == b'l'
        && bytes[1..]
            .iter()
            .all(|byte| matches!(byte, b'r' | b'w' | b'x' | b'-' | b's' | b'S' | b't' | b'T'))
}

fn parse_slt_archive_manifest(
    slt_output: &str,
    archive_path: &str,
    max_bytes: Option<u64>,
) -> Result<ArchiveManifestSummary, String> {
    let mut seen_member = false;
    let mut current_member: Option<&str> = None;
    let mut summary = ArchiveManifestSummary::default();
    for line in slt_output.lines() {
        if let Some(path) = line.strip_prefix("Path = ") {
            if path.is_empty() {
                continue;
            }
            // `-ba` suppresses the archive-container record, so every Path entry is
            // normally a member. Keep exact full-path container tolerance for older
            // sidecars without `-ba`. Never skip a member that only matches the
            // archive basename; that name is a legal archive member.
            if path == archive_path {
                current_member = None;
                continue;
            }
            seen_member = true;
            summary.entry_count = summary.entry_count.saturating_add(1);
            if summary.entry_count > crate::process::quota::MAX_EXTRACT_ENTRIES {
                return Err(format!(
                    "Archive exceeds the safety limit of {} entries.",
                    crate::process::quota::MAX_EXTRACT_ENTRIES
                ));
            }
            summary.path_bytes = summary
                .path_bytes
                .checked_add(path.len() as u64)
                .ok_or_else(|| "Archive path-name safety counter overflowed.".to_string())?;
            if summary.path_bytes > crate::process::quota::MAX_EXTRACT_PATH_BYTES {
                return Err(format!(
                    "Archive exceeds the {} MiB aggregate path-name safety limit.",
                    crate::process::quota::MAX_EXTRACT_PATH_BYTES / (1024 * 1024)
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
        // ZIP keeps a symlink's target in the member data, so the listing has no
        // `Symbolic Link =` line, only a Unix `l` mode as the last `Attributes`
        // token. Flag it so extraction keeps link-bearing staging and scans;
        // `-snld10` and staged-tree validation still judge the target.
        if let Some(attributes) = line.strip_prefix("Attributes = ") {
            if attributes
                .split_whitespace()
                .next_back()
                .is_some_and(unix_mode_is_symlink)
            {
                summary.has_symbolic_links = true;
            }
            continue;
        }
        if let Some(target) = line.strip_prefix("Symbolic Link = ") {
            summary.has_symbolic_links = true;
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
            summary.has_hard_links = true;
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
        if current_member.is_some() {
            if let Some(size) = line.strip_prefix("Size = ") {
                let size = size.parse::<u64>().map_err(|_| {
                    "Archive listing contains an invalid declared member size.".to_string()
                })?;
                summary.declared_bytes =
                    summary.declared_bytes.checked_add(size).ok_or_else(|| {
                        "Archive declared size overflowed its safety counter.".to_string()
                    })?;
                if let Some(max_bytes) = max_bytes {
                    if summary.declared_bytes > max_bytes {
                        return Err(format!(
                            "Archive declares more than {:.1} GiB of extracted data.",
                            max_bytes as f64 / 1_073_741_824.0
                        ));
                    }
                }
            }
        }
    }
    // Empty archives legitimately produce no records. Non-empty output with no
    // Path records means the machine-readable schema was not understood; fail
    // closed instead of silently bypassing the safety check.
    if !seen_member && !slt_output.trim().is_empty() {
        return parse_pathless_single_stream_record(slt_output, archive_path, max_bytes);
    }
    Ok(summary)
}

/// bzip2, xz and similar single-stream formats store no member name, so
/// `-ba -slt` prints one record without `Path =`. 7-Zip derives the output
/// name from the archive file name, which cannot escape the destination.
/// Accept exactly one such key/value record with a `Size` field; anything
/// else still fails closed.
fn parse_pathless_single_stream_record(
    slt_output: &str,
    archive_path: &str,
    max_bytes: Option<u64>,
) -> Result<ArchiveManifestSummary, String> {
    let unparsed = || "Could not parse archive member paths from 7-Zip listing.".to_string();
    // Group by blank lines; `lines()` and `trim_end` also cover CRLF output.
    let mut records: Vec<Vec<&str>> = vec![Vec::new()];
    for line in slt_output.lines().map(str::trim_end) {
        match records.last_mut() {
            Some(current) if !line.is_empty() => current.push(line),
            Some(current) if !current.is_empty() => records.push(Vec::new()),
            _ => {}
        }
    }
    records.retain(|lines| !lines.is_empty());
    let [record] = records.as_slice() else {
        return Err(unparsed());
    };
    let mut size = None;
    for line in record {
        let (key, value) = line.split_once(" =").ok_or_else(unparsed)?;
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ') {
            return Err(unparsed());
        }
        match key {
            "Path" | "Symbolic Link" | "Hard Link" => return Err(unparsed()),
            "Size" => size = Some(value.trim()),
            _ => {}
        }
    }
    let size = size.ok_or_else(unparsed)?;
    let mut summary = ArchiveManifestSummary {
        entry_count: 1,
        declared_size_untrusted: true,
        ..ArchiveManifestSummary::default()
    };
    // The derived output name is at most the archive's own file name.
    summary.path_bytes = std::path::Path::new(archive_path)
        .file_name()
        .map_or(0, |name| name.len() as u64);
    if !size.is_empty() {
        summary.declared_bytes = size
            .parse::<u64>()
            .map_err(|_| "Archive listing contains an invalid declared member size.".to_string())?;
        if let Some(max_bytes) = max_bytes {
            if summary.declared_bytes > max_bytes {
                return Err(format!(
                    "Archive declares more than {:.1} GiB of extracted data.",
                    max_bytes as f64 / 1_073_741_824.0
                ));
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
pub(crate) fn assert_slt_archive_members_safe(
    slt_output: &str,
    archive_path: &str,
) -> Result<(), String> {
    parse_slt_archive_manifest(slt_output, archive_path, None).map(|_| ())
}

#[cfg(test)]
pub(crate) fn slt_manifest_has_links(slt_output: &str, archive_path: &str) -> Result<bool, String> {
    parse_slt_archive_manifest(slt_output, archive_path, None).map(|summary| summary.has_links())
}

#[cfg(test)]
pub(crate) fn assert_slt_declared_size_within_limit(
    slt_output: &str,
    archive_path: &str,
    max_bytes: u64,
) -> Result<(), String> {
    parse_slt_archive_manifest(slt_output, archive_path, Some(max_bytes)).map(|_| ())
}

/// Output of a backend-owned preflight 7-Zip child (listing or test).
#[derive(Debug)]
pub(crate) struct PreflightOutput {
    pub(crate) code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Convert a collected child result only when both pipe streams and process
/// termination are complete. Listing callers still classify accepted exit-1
/// metadata warnings after this boundary.
pub(crate) fn checked_preflight_output(
    collected: CollectedOutput,
    label: &str,
) -> Result<PreflightOutput, String> {
    if collected.stdout_truncated || collected.stderr_truncated {
        return Err(format!(
            "{label} exceeded its output limit; the operation was cancelled."
        ));
    }
    if !collected.output_is_complete() {
        if let Some(error) = collected.stream_error.as_deref() {
            return Err(format!(
                "{label} could not read the complete output stream: {}",
                sanitize_output(error)
            ));
        }
        if collected.exit.is_none() {
            return Err(format!("{label} ended without a termination event."));
        }
        return Err(format!("{label} produced incomplete output."));
    }
    let code = collected.exit_code();
    if code < 0
        || collected
            .exit
            .as_ref()
            .is_some_and(|termination| termination.signal.is_some())
    {
        return Err(format!("{label} did not produce a valid exit status."));
    }
    Ok(PreflightOutput {
        code,
        stdout: collected.stdout,
        stderr: collected.stderr,
    })
}

/// Run a short backend-owned 7-Zip child under the current operation slot.
/// The child is registered before password transport so Cancel can stop it,
/// and the slot's child is cleared again before returning.
pub(crate) async fn run_registered_preflight_7z(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: Vec<String>,
    timeout: std::time::Duration,
    label: &str,
    #[cfg_attr(not(feature = "e2e"), allow(unused_variables))] pause_point: &str,
) -> Result<PreflightOutput, String> {
    let (mut rx, child, pending_password) =
        crate::process::commands::spawn_7z_noninteractive(app, args, state)?;
    #[cfg(feature = "e2e")]
    crate::process::e2e_crash::pause_point(pause_point).await;
    {
        // Check cancelling and register the child under one lock so cancel_7z
        // cannot run between the two and miss the child.
        let cancelling = {
            let mut process = lock_process(state)?;
            if !process.cancelling {
                // Register before password stdin so cancel can kill a blocked write.
                process.child = Some(child.clone());
            }
            process.cancelling
        };
        if cancelling {
            terminate_registered_child_async(app, &child).await?;
            return Err("Operation cancelled.".to_string());
        }
    }
    if let Some(pending_password) = pending_password {
        if let Err(error) =
            crate::process::commands::complete_password_transport(&child, pending_password).await
        {
            let cancelled = lock_process(state)
                .map(|process| process.cancelling)
                .unwrap_or(false);
            terminate_registered_child_async(app, &child).await?;
            return Err(if cancelled {
                "Operation cancelled.".to_string()
            } else {
                error
            });
        }
        if lock_process(state)?.cancelling {
            terminate_registered_child_async(app, &child).await?;
            return Err("Operation cancelled.".to_string());
        }
    }
    const LIST_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
    let collected = match tokio::time::timeout(
        timeout,
        collect_command_output(&mut rx, LIST_OUTPUT_LIMIT, |_| {}),
    )
    .await
    {
        Ok(collected) => collected,
        Err(_) => {
            terminate_registered_child_async(app, &child).await?;
            return Err(format!(
                "{label} timed out after {} seconds.",
                timeout.as_secs()
            ));
        }
    };
    if collected.stream_error.is_some() || collected.exit.is_none() {
        terminate_registered_child_async(app, &child).await?;
    }
    {
        let mut process = lock_process(state)?;
        process.child = None;
        if process.cancelling {
            return Err("Operation cancelled.".to_string());
        }
    }
    checked_preflight_output(collected, label)
}

/// Sanitized 7-Zip failure detail (stderr first, then stdout).
pub(crate) fn preflight_failure_detail(output: &PreflightOutput) -> String {
    let detail = sanitize_output(output.stderr.trim());
    if detail.is_empty() {
        sanitize_output(output.stdout.trim())
    } else {
        detail
    }
}

pub(crate) async fn assert_extract_archive_members_safe_with_summary(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: &[String],
    max_declared_bytes: Option<u64>,
) -> Result<
    (
        std::path::PathBuf,
        ArchiveFileIdentity,
        ArchiveManifestSummary,
    ),
    String,
> {
    let list_args = extract_member_list_args(args)?;
    let archive = list_args
        .last()
        .cloned()
        .ok_or_else(|| "Extraction member list is missing an archive path.".to_string())?;
    let archive_path = std::path::PathBuf::from(&archive);
    let identity =
        crate::process::archive_snapshot::archive_identity_from_snapshot_handle(&archive_path)
            .or_else(|| archive_file_identity(&archive_path).ok())
            .ok_or_else(|| "Could not read archive identity for member preflight.".to_string())?;
    let output = run_registered_preflight_7z(
        app,
        state,
        list_args,
        std::time::Duration::from_secs(120),
        "Archive member-safety preflight",
        "member-preflight-spawned",
    )
    .await?;
    let code = output.code;
    if !listing_preflight_exit_is_acceptable(code, &output.stdout, &output.stderr) {
        let detail = preflight_failure_detail(&output);
        return Err(if detail.is_empty() {
            format!("Could not list archive members for path safety (exit {code}).")
        } else {
            format!("Could not list archive members for path safety: {detail}")
        });
    }
    let mut manifest = parse_slt_archive_manifest(&output.stdout, &archive, max_declared_bytes)?;
    let lower = archive.to_ascii_lowercase();
    if [".gz", ".bz2", ".xz", ".tgz", ".tbz2", ".txz"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        manifest.declared_size_untrusted = true;
    }
    Ok((archive_path, identity, manifest))
}

pub(crate) const UPDATE_PASSWORD_REQUIRED: &str =
    "A password is required to add files to this encrypted archive. Files were not added.";
pub(crate) const UPDATE_WRONG_PASSWORD: &str =
    "Wrong password for this encrypted archive. Files were not added.";
pub(crate) const ZIPCRYPTO_UPDATE_REFUSED: &str =
    "This ZIP still has ZipCrypto members. Convert it to a new AES-256 ZIP instead of adding files in place.";

/// Encryption facts about the members of an existing archive.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct UpdateEncryptionFacts {
    pub(crate) has_encrypted_members: bool,
    pub(crate) has_zipcrypto_members: bool,
    /// Smallest encrypted regular file, used to verify a supplied password
    /// without decrypting the whole archive.
    pub(crate) smallest_encrypted_file: Option<String>,
    /// True when another member has the same displayed name, so this selector
    /// may resolve to a different record after 7-Zip normalizes the name.
    pub(crate) smallest_encrypted_file_ambiguous: bool,
}

/// Read per-member `Encrypted`, `Method`, `Folder`, and `Size` from
/// `7z l -slt -ba` output. 7-Zip reports ZIP encryption methods only on
/// member records, never on the archive record.
pub(crate) fn parse_update_encryption_facts(slt_output: &str) -> UpdateEncryptionFacts {
    #[derive(Default)]
    struct Member<'a> {
        path: Option<&'a str>,
        encrypted: bool,
        folder: bool,
        size: Option<u64>,
    }
    let mut facts = UpdateEncryptionFacts::default();
    let mut smallest: Option<(u64, String)> = None;
    let mut displayed_name_counts = std::collections::HashMap::<String, usize>::new();
    let mut flush = |member: &Member<'_>, facts: &mut UpdateEncryptionFacts| {
        if let Some(path) = member.path {
            *displayed_name_counts.entry(path.to_string()).or_default() += 1;
        }
        if !member.encrypted {
            return;
        }
        facts.has_encrypted_members = true;
        let (Some(path), false) = (member.path, member.folder) else {
            return;
        };
        let size = member.size.unwrap_or(u64::MAX);
        if smallest.as_ref().is_none_or(|(best, _)| size < *best) {
            smallest = Some((size, path.to_string()));
        }
    };
    let mut current = Member::default();
    for line in slt_output.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(path) = line.strip_prefix("Path = ") {
            flush(&current, &mut facts);
            current = Member {
                path: Some(path),
                ..Member::default()
            };
        } else if let Some(value) = line.strip_prefix("Encrypted = ") {
            current.encrypted |= value.trim() == "+";
        } else if let Some(value) = line.strip_prefix("Folder = ") {
            current.folder = value.trim() == "+";
        } else if let Some(value) = line.strip_prefix("Size = ") {
            current.size = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("Method = ") {
            let lower = value.to_ascii_lowercase();
            if lower.contains("zipcrypto") {
                facts.has_zipcrypto_members = true;
                current.encrypted = true;
            }
            if lower.contains("aes") {
                current.encrypted = true;
            }
        }
    }
    flush(&current, &mut facts);
    if let Some((_, path)) = smallest {
        facts.smallest_encrypted_file_ambiguous =
            displayed_name_counts.get(&path).copied().unwrap_or(0) > 1;
        facts.smallest_encrypted_file = Some(path);
    }
    facts
}

fn preflight_test_reports_no_files(output: &PreflightOutput) -> bool {
    output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .any(|line| line.trim().to_ascii_lowercase().starts_with("no files"))
}

fn preflight_test_reports_processed_file(output: &PreflightOutput) -> bool {
    let no_files_reported = preflight_test_reports_no_files(output);
    if no_files_reported {
        return false;
    }
    let files_count = output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .map(|line| line.trim().to_ascii_lowercase())
        .find_map(|line| {
            line.strip_prefix("files:")
                .and_then(|count| count.trim().parse::<u64>().ok())
        });
    if let Some(files_count) = files_count {
        return files_count > 0;
    }
    output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .map(|line| line.trim().to_ascii_lowercase())
        .any(|line| {
            line.strip_prefix("size:")
                .is_some_and(|size| size.trim().parse::<u64>().is_ok())
        })
}

pub(crate) fn member_password_test_needs_full_archive_check(
    facts: &UpdateEncryptionFacts,
    member_test: &PreflightOutput,
) -> bool {
    if facts.smallest_encrypted_file_ambiguous {
        return true;
    }
    if preflight_test_reports_no_files(member_test) {
        return true;
    }
    member_test.code == 0 && !preflight_test_reports_processed_file(member_test)
}

async fn run_update_password_check(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    archive: &str,
    password: &str,
    types: &[String],
    member: Option<&str>,
) -> Result<PreflightOutput, String> {
    let mut test_args = vec!["t".to_string(), password.to_string()];
    if member.is_some() {
        // 7-Zip's default case matching varies by platform. Keep a lossy
        // displayed name from selecting a differently cased plaintext alias.
        test_args.push("-ssc".to_string());
    }
    test_args.extend(types.iter().cloned());
    test_args.push("--".to_string());
    test_args.push(archive.to_string());
    if let Some(member) = member {
        test_args.push(member.to_string());
    }
    crate::process::commands::harden_7z_args(&mut test_args);
    run_registered_preflight_7z(
        app,
        state,
        test_args,
        std::time::Duration::from_secs(120),
        "Archive password check",
        "update-password-check-spawned",
    )
    .await
}

fn password_and_type_switches(args: &[String]) -> (Option<String>, Vec<String>) {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let mut password = None;
    let mut types = Vec::new();
    for arg in &args[1..separator] {
        let lower = arg.to_ascii_lowercase();
        if lower.starts_with("-p") && arg.len() > 2 {
            password = Some(arg.clone());
        } else if lower.starts_with("-t") && lower != "-stl" && !lower.starts_with("-stx") {
            types.push(arg.clone());
        }
    }
    (password, types)
}

/// Refuse an update that would add unencrypted or differently encrypted files
/// to an encrypted archive, or mix AES with ZipCrypto members.
///
/// `7z u` copies existing members without decrypting them, so it succeeds with
/// no password (new files are stored in plaintext) and with a wrong password
/// (new files use a different key). Lists the archive 7-Zip will read, then
/// tests the smallest unambiguous encrypted file. If the listed selector is
/// ambiguous or the test proves it processed no data, tests the whole archive.
pub(crate) async fn assert_update_encryption_policy(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: &[String],
    archive: &std::path::Path,
) -> Result<(), String> {
    let archive = archive
        .to_str()
        .ok_or_else(|| "Archive path is not valid UTF-8.".to_string())?
        .to_string();
    let (password, types) = password_and_type_switches(args);
    let mut list_args = vec!["l".to_string(), "-slt".to_string(), "-ba".to_string()];
    list_args.extend(password.iter().cloned());
    list_args.extend(types.iter().cloned());
    list_args.push("--".to_string());
    list_args.push(archive.clone());
    crate::process::commands::harden_7z_args(&mut list_args);
    let listing = run_registered_preflight_7z(
        app,
        state,
        list_args,
        std::time::Duration::from_secs(120),
        "Archive encryption preflight",
        "update-encryption-preflight-spawned",
    )
    .await?;
    if !listing_preflight_exit_is_acceptable(listing.code, &listing.stdout, &listing.stderr) {
        let detail = preflight_failure_detail(&listing);
        return Err(if detail.is_empty() {
            format!(
                "Could not inspect the archive before updating it (exit {}).",
                listing.code
            )
        } else {
            format!("Could not inspect the archive before updating it: {detail}")
        });
    }
    let facts = parse_update_encryption_facts(&listing.stdout);
    if facts.has_zipcrypto_members {
        return Err(ZIPCRYPTO_UPDATE_REFUSED.to_string());
    }
    if !facts.has_encrypted_members {
        return Ok(());
    }
    let Some(password) = password else {
        return Err(UPDATE_PASSWORD_REQUIRED.to_string());
    };
    let Some(member) = facts.smallest_encrypted_file.as_deref() else {
        return Err(
            "Could not verify the archive password because no encrypted file was available to test."
                .to_string(),
        );
    };
    let test = if facts.smallest_encrypted_file_ambiguous {
        run_update_password_check(app, state, &archive, &password, &types, None).await?
    } else {
        let member_test =
            run_update_password_check(app, state, &archive, &password, &types, Some(member))
                .await?;
        if member_password_test_needs_full_archive_check(&facts, &member_test) {
            run_update_password_check(app, state, &archive, &password, &types, None).await?
        } else {
            member_test
        }
    };
    if test.code == 0 && preflight_test_reports_processed_file(&test) {
        return Ok(());
    }
    if test.code == 0 {
        return Err(
            "Could not verify the archive password because 7-Zip did not test any files."
                .to_string(),
        );
    }
    let detail = preflight_failure_detail(&test);
    if detail.to_ascii_lowercase().contains("wrong password") {
        return Err(UPDATE_WRONG_PASSWORD.to_string());
    }
    Err(if detail.is_empty() {
        format!(
            "Could not verify the archive password before updating (exit {}).",
            test.code
        )
    } else {
        format!("Could not verify the archive password before updating: {detail}")
    })
}
