//! Move plan, rollback, and extract merge.

use super::super::journal::{
    ensure_path_entry_identity, ensure_path_identity, ensure_retract_path_matches,
    file_identities_match, file_identity, identity_with_file_content,
    mark_archive_journal_committed, mark_extract_journal_committed, move_identity_log_path,
    move_plan_path, path_identity, path_identity_with_fingerprint, record_archive_journal_backup,
    record_archive_journal_published, remove_directory_if_matches, remove_regular_file_if_matches,
    sync_directory, unregister_plan_stages, unregister_plan_stages_strict, update_archive_journal,
    FileIdentity, MoveRecord, MAX_MOVE_IDENTITY_LOG_BYTES, MAX_MOVE_IDENTITY_RECORD_BYTES,
    MAX_MOVE_PLAN_BYTES,
};
use super::super::quota::MAX_EXTRACT_ENTRIES;
use super::super::staging::assert_real_directory;
use super::super::staging::path_entry_exists;
use super::super::CleanupPlan;
use super::archive_promote::promote_archive_family_with_commit;
#[cfg(windows)]
use super::publish::copy_windows_directory_metadata;
use super::publish::{
    copy_file_no_replace_with_created, copy_tree_with_inherited_acl, rename_file_no_replace,
};
use super::staged_tree::{
    is_publish_temp_name, plan_staged_contents, sync_staged_tree_without_fingerprint,
    validate_and_sync_staged_tree, MAX_EXTRACTED_BYTES,
};
use super::sync_file_best_effort;
use super::{assert_safe_extract_target_ancestors, remove_plan_stage_if_owned, PublishStrategy};

fn prepare_target_local_publish_paths(
    plan: &mut [MoveRecord],
    reserved: &mut std::collections::HashSet<std::path::PathBuf>,
    allow_direct_root_rename: bool,
    destination: &std::path::Path,
) -> Result<(), String> {
    for record in plan {
        let metadata =
            std::fs::symlink_metadata(&record.source).map_err(|error| error.to_string())?;
        // Symlink/reparse roots cannot be ACL-copied as ordinary trees; rename
        // preserves the already-validated relative link after rewrite.
        if crate::path_safety::is_link_or_reparse(&metadata) {
            continue;
        }
        if allow_direct_root_rename && record.target.parent() == Some(destination) {
            // Stage was created under destination after link-free member
            // preflight. Root entries inherit destination policy already;
            // nested collision records still use target-local copies.
            continue;
        }
        let parent = record
            .target
            .parent()
            .ok_or_else(|| "Extraction target has no parent directory.".to_string())?;
        let mut publish_temp = None;
        for _ in 0..32 {
            let mut candidate_name = String::from(".zinnia-publish-");
            candidate_name.push_str(&super::super::staging::random_token()?);
            let candidate = parent.join(candidate_name);
            if !reserved.contains(&candidate) && !path_entry_exists(&candidate)? {
                publish_temp = Some(candidate);
                break;
            }
        }
        let publish_temp = publish_temp.ok_or_else(|| {
            "Could not reserve a unique extraction publish path under ".to_string()
                + &parent.display().to_string()
                + "."
        })?;
        reserved.insert(publish_temp.clone());
        record.publish_temp = Some(publish_temp);
    }
    Ok(())
}

fn remove_path_if_matches(path: &std::path::Path, identity: &FileIdentity) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) {
        return Err(format!(
            "Refusing to remove a publish path that became a link or reparse point: {}",
            path.display()
        ));
    }
    // Type dispatch only. Identity is bound by the quarantine helpers, which
    // preserve a same-name replacement instead of path-walking it.
    if metadata.is_dir() {
        remove_directory_if_matches(path, identity)
    } else if metadata.is_file() {
        remove_regular_file_if_matches(path, identity)
    } else {
        Err(format!(
            "Refusing to remove an unsupported publish path: {}",
            path.display()
        ))
    }
}

/// Append-only per-entry identity record. Used on every platform so
/// publishing a large extraction into an existing destination journals each
/// entry's identity in O(1) instead of rewriting the whole move-plan JSON
/// (`write_move_plan`) after every single file, which made a merge into an
/// existing destination with n entries cost O(n^2) I/O.
#[derive(serde::Serialize, serde::Deserialize)]
struct MoveIdentityLogRecord {
    index: usize,
    /// Target-local publish creates a temp object directly under the real
    /// target parent so the copy inherits that parent's ACL/mode policy;
    /// rename-only symlink roots leave this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    publish_temp: Option<std::path::PathBuf>,
    identity: FileIdentity,
}

struct MoveIdentityLogWriter {
    path: std::path::PathBuf,
    file: std::fs::File,
    creation_identity: FileIdentity,
    hasher: sha2::Sha256,
    bytes_written: u64,
    records_written: u64,
}

impl MoveIdentityLogWriter {
    fn create(staged: &std::path::Path) -> Result<Self, String> {
        use sha2::Digest as _;

        let path = move_identity_log_path(staged);
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt as _;
            use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
            // Recovery readers are harmless. Deny concurrent writers, rename,
            // and deletion for the lifetime of this extraction commit.
            options.share_mode(FILE_SHARE_READ);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|error| error.to_string())?;
        sync_file_best_effort(&file)?;
        let creation_identity = file_identity(&file)?;
        ensure_path_identity(&path, &creation_identity)?;
        let empty_identity = identity_with_file_content(
            creation_identity.clone(),
            0,
            sha2::Sha256::digest([]).into(),
        );
        if super::super::journal::held_regular_file_identity_with_fingerprint(&mut file)?
            != empty_identity
        {
            return Err("Extraction identity log changed during creation.".to_string());
        }
        if let Some(parent) = path.parent() {
            sync_directory(parent)?;
        }
        Ok(Self {
            path,
            file,
            creation_identity,
            hasher: sha2::Sha256::new(),
            bytes_written: 0,
            records_written: 0,
        })
    }

    fn current_identity(&self) -> FileIdentity {
        use sha2::Digest as _;

        identity_with_file_content(
            self.creation_identity.clone(),
            self.bytes_written,
            self.hasher.clone().finalize().into(),
        )
    }

    fn append(&mut self, record: &MoveIdentityLogRecord) -> Result<FileIdentity, String> {
        use sha2::Digest as _;
        use std::io::Write as _;

        let mut json = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        if json.len() > MAX_MOVE_IDENTITY_RECORD_BYTES {
            return Err(
                "Extraction identity log record exceeds its byte safety limit.".to_string(),
            );
        }
        json.push(b'\n');
        let next_bytes = self.bytes_written.saturating_add(json.len() as u64);
        let next_records = self.records_written.saturating_add(1);
        if next_bytes > MAX_MOVE_IDENTITY_LOG_BYTES
            || next_records > MAX_EXTRACT_ENTRIES.saturating_mul(2)
        {
            return Err("Extraction identity log exceeds its safety limit.".to_string());
        }
        self.file
            .write_all(&json)
            .map_err(|error| error.to_string())?;
        sync_file_best_effort(&self.file)?;
        self.hasher.update(&json);
        self.bytes_written = next_bytes;
        self.records_written = next_records;
        let identity = self.current_identity();
        let actual = file_identity(&self.file)?;
        let metadata = self.file.metadata().map_err(|error| error.to_string())?;
        if !file_identities_match(&actual, &identity) || metadata.len() != self.bytes_written {
            return Err("Extraction identity log changed during append.".to_string());
        }
        ensure_path_identity(&self.path, &identity)?;
        Ok(identity)
    }

    fn seal(mut self) -> Result<FileIdentity, String> {
        sync_file_best_effort(&self.file)?;
        let expected = self.current_identity();
        let held =
            super::super::journal::held_regular_file_identity_with_fingerprint(&mut self.file)?;
        if held != expected {
            return Err("Extraction identity log changed before it was sealed.".to_string());
        }
        ensure_path_identity(&self.path, &expected)?;
        Ok(expected)
    }
}

fn hydrate_move_plan_identities(
    contents: Option<&[u8]>,
    plan: &mut [MoveRecord],
) -> Result<(), String> {
    let Some(contents) = contents else {
        return Ok(());
    };
    let mut records = 0u64;
    for raw_line in contents.split_inclusive(|byte| *byte == b'\n') {
        if !raw_line.ends_with(b"\n") {
            // A crash can leave one torn append. Ignore only the incomplete
            // final record; complete malformed records remain a hard error.
            break;
        }
        if raw_line.len() > MAX_MOVE_IDENTITY_RECORD_BYTES.saturating_add(1) {
            return Err(
                "Extraction identity log record exceeds its byte safety limit.".to_string(),
            );
        }
        records = records.saturating_add(1);
        if records > MAX_EXTRACT_ENTRIES.saturating_mul(2) {
            return Err("Extraction identity log exceeds its record safety limit.".to_string());
        }
        let mut line = &raw_line[..raw_line.len() - 1];
        if line.ends_with(b"\r") {
            line = &line[..line.len() - 1];
        }
        if line.is_empty() {
            return Err("Extraction identity log contains an empty record.".to_string());
        }
        let record: MoveIdentityLogRecord =
            serde_json::from_slice(line).map_err(|error| error.to_string())?;
        let Some(planned) = plan.get_mut(record.index) else {
            return Err("Extraction identity log references an invalid move index.".to_string());
        };
        if planned.publish_temp != record.publish_temp {
            return Err("Extraction identity log does not match its move plan.".to_string());
        }
        // Append-only log: a later record for the same index replaces an
        // earlier one (copy-fallback publish corrections journal the post-copy
        // identity after the pre-publish source identity).
        planned.publish_identity = Some(record.identity);
    }
    Ok(())
}

trait ExtractArtifactRecorder {
    fn record_move_plan(&mut self, identity: &FileIdentity) -> Result<(), String>;
    fn record_move_identity_log(&mut self, identity: &FileIdentity) -> Result<(), String>;
}

/// Journal a publish identity in the append-only log and mirror it into the
/// in-memory plan. The updated log fingerprint is persisted before the
/// corresponding object can be published.
fn record_publish_identity<R: ExtractArtifactRecorder>(
    recorder: &mut R,
    identity_log: &mut MoveIdentityLogWriter,
    plan: &mut [MoveRecord],
    index: usize,
    identity: &FileIdentity,
) -> Result<(), String> {
    let publish_temp = plan
        .get(index)
        .and_then(|record| record.publish_temp.clone());
    let log_identity = identity_log.append(&MoveIdentityLogRecord {
        index,
        publish_temp,
        identity: identity.clone(),
    })?;
    recorder.record_move_identity_log(&log_identity)?;
    plan[index].publish_identity = Some(identity.clone());
    Ok(())
}

fn publish_target_local_copy<R: ExtractArtifactRecorder>(
    recorder: &mut R,
    identity_log: &mut MoveIdentityLogWriter,
    plan: &mut [MoveRecord],
    index: usize,
) -> Result<(), String> {
    let source = plan[index].source.clone();
    let target = plan[index].target.clone();
    let expected_source = path_identity_with_fingerprint(&source)?;
    let publish_temp = plan[index]
        .publish_temp
        .clone()
        .ok_or_else(|| "Extraction publish path was not planned.".to_string())?;
    let metadata = std::fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) {
        return Err(format!(
            "Archive contains a symbolic link or reparse point: {}",
            source.display()
        ));
    }

    let copy_result = if metadata.is_file() {
        copy_file_no_replace_with_created(&source, &publish_temp, |_, identity| {
            record_publish_identity(recorder, identity_log, plan, index, identity)
        })
    } else if metadata.is_dir() {
        // Create under the final parent so default ACL / setgid / NTFS policy
        // inherit. Windows uses the inheriting helper for SMB-safe DACLs;
        // Unix uses plain mkdir (explicit 0o700 would defeat inheritance).
        #[cfg(windows)]
        crate::fs_secure::create_inheriting_stage_dir(&publish_temp)
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        std::fs::create_dir(&publish_temp).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        crate::fs_secure::apply_parent_directory_mode(&publish_temp)
            .map_err(|error| error.to_string())?;
        let identity = path_identity(&publish_temp)?;
        let journal_result =
            record_publish_identity(recorder, identity_log, plan, index, &identity);
        if let Err(error) = journal_result {
            let cleanup = remove_path_if_matches(&publish_temp, &identity);
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => {
                    format!("{error}; publish-temp cleanup also failed: {cleanup_error}")
                }
            });
        }
        let copied = copy_tree_with_inherited_acl(&source, &publish_temp);
        #[cfg(windows)]
        let copied = copied.and_then(|()| copy_windows_directory_metadata(&source, &publish_temp));
        let result = copied.and_then(|()| sync_directory(&publish_temp));
        if let Err(error) = result {
            let cleanup = remove_path_if_matches(&publish_temp, &identity);
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => {
                    format!("{error}; publish-temp cleanup also failed: {cleanup_error}")
                }
            });
        }
        Ok(())
    } else {
        Err(format!(
            "Archive contains an unsupported entry: {}",
            source.display()
        ))
    };
    copy_result?;
    let published_snapshot = path_identity_with_fingerprint(&publish_temp)?;
    if published_snapshot.fingerprint() != expected_source.fingerprint() {
        return Err(format!(
            "Extraction publish copy changed during commit: {}",
            publish_temp.display()
        ));
    }
    record_publish_identity(recorder, identity_log, plan, index, &published_snapshot)?;

    // Created under the final parent, so rename preserves inherited ACL/mode
    // and still refuses an existing destination.
    rename_file_no_replace(&publish_temp, &target)?;
    if let Some(parent) = target.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn resolve_staged_symlink_target(
    staged: &std::path::Path,
    link: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    crate::path_safety::resolve_relative_symlink_within_root(staged, link)
}

fn final_path_for_staged_source(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
    source: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let mapped = plan
        .iter()
        .filter(|record| source == record.source || source.starts_with(&record.source))
        .max_by_key(|record| record.source.components().count());
    if let Some(record) = mapped {
        let suffix = source
            .strip_prefix(&record.source)
            .map_err(|error| error.to_string())?;
        return Ok(record.target.join(suffix));
    }
    Ok(destination.join(
        source
            .strip_prefix(staged)
            .map_err(|error| error.to_string())?,
    ))
}

fn relative_path_between(
    from_directory: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let from: Vec<_> = from_directory.components().collect();
    let to: Vec<_> = target.components().collect();
    let shared = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    if shared == 0 {
        return Err("Could not preserve an archive symbolic link across filesystems.".to_string());
    }
    let mut relative = std::path::PathBuf::new();
    for _ in shared..from.len() {
        relative.push("..");
    }
    for component in &to[shared..] {
        relative.push(component.as_os_str());
    }
    if relative.as_os_str().is_empty() {
        return Err("Archive contains a self-referential symbolic link.".to_string());
    }
    Ok(relative)
}

fn prepare_planned_links(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<(), String> {
    struct PlannedLinkRewrite {
        link: std::path::PathBuf,
        original_target: std::path::PathBuf,
        rewritten_target: std::path::PathBuf,
        #[cfg(windows)]
        was_directory_link: bool,
    }

    // Resolve and validate every link against the untouched staged tree. A
    // link can point through another staged link, so rewriting one while this
    // pass is still discovering targets would change the meaning of later
    // links in the plan.
    let mut rewrites = Vec::new();
    for record in plan {
        let mut pending = vec![record.source.clone()];
        while let Some(path) = pending.pop() {
            let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if crate::path_safety::is_link_or_reparse(&metadata) {
                let original_target =
                    std::fs::read_link(&path).map_err(|error| error.to_string())?;
                let source_target = resolve_staged_symlink_target(staged, &path)?;
                if std::fs::read_link(&path).map_err(|error| error.to_string())? != original_target
                {
                    return Err(format!(
                        "Extraction link changed while its publish target was being planned: {}",
                        path.display()
                    ));
                }
                let final_target =
                    final_path_for_staged_source(staged, destination, plan, &source_target)?;
                crate::path_safety::assert_path_resolves_within_root_or_missing(
                    destination,
                    &final_target,
                )?;
                let final_link = final_path_for_staged_source(staged, destination, plan, &path)?;
                let final_parent = final_link
                    .parent()
                    .ok_or_else(|| "Archive symbolic link target has no parent.".to_string())?;
                let rewritten_target = relative_path_between(final_parent, &final_target)?;
                if original_target != rewritten_target {
                    rewrites.push(PlannedLinkRewrite {
                        link: path,
                        original_target,
                        rewritten_target,
                        #[cfg(windows)]
                        was_directory_link: {
                            use std::os::windows::fs::FileTypeExt as _;
                            metadata.file_type().is_symlink_dir()
                        },
                    });
                }
                continue;
            }
            if metadata.is_dir() {
                for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                    pending.push(entry.map_err(|e| e.to_string())?.path());
                }
            }
        }
    }

    // Only mutate after every source target and final destination has passed
    // the same containment and mapping checks used by the original publish.
    for rewrite in rewrites {
        if std::fs::read_link(&rewrite.link).map_err(|error| error.to_string())?
            != rewrite.original_target
        {
            return Err(format!(
                "Extraction link changed before it could be rewritten: {}",
                rewrite.link.display()
            ));
        }
        let metadata =
            std::fs::symlink_metadata(&rewrite.link).map_err(|error| error.to_string())?;
        if !crate::path_safety::is_link_or_reparse(&metadata) {
            return Err(format!(
                "Extraction link changed before it could be rewritten: {}",
                rewrite.link.display()
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt as _;
            if metadata.file_type().is_symlink_dir() != rewrite.was_directory_link {
                return Err(format!(
                    "Extraction link type changed before it could be rewritten: {}",
                    rewrite.link.display()
                ));
            }
        }
        #[cfg(unix)]
        std::fs::remove_file(&rewrite.link).map_err(|error| error.to_string())?;
        #[cfg(windows)]
        if rewrite.was_directory_link {
            std::fs::remove_dir(&rewrite.link).map_err(|error| error.to_string())?;
        } else {
            std::fs::remove_file(&rewrite.link).map_err(|error| error.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&rewrite.rewritten_target, &rewrite.link)
            .map_err(|error| error.to_string())?;
        #[cfg(windows)]
        if rewrite.was_directory_link {
            std::os::windows::fs::symlink_dir(&rewrite.rewritten_target, &rewrite.link)
                .map_err(|error| error.to_string())?;
        } else {
            std::os::windows::fs::symlink_file(&rewrite.rewritten_target, &rewrite.link)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn write_move_plan(
    staged: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<FileIdentity, String> {
    use sha2::Digest as _;
    use std::io::Write as _;

    if plan.len() as u64 > MAX_EXTRACT_ENTRIES {
        return Err("Extraction move plan exceeds its record safety limit.".to_string());
    }
    let bytes = serde_json::to_vec(plan).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MOVE_PLAN_BYTES {
        return Err("Extraction move plan exceeds its byte safety limit.".to_string());
    }
    let path = move_plan_path(staged);
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    let mut file = options.open(&path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    sync_file_best_effort(&file)?;
    let expected = identity_with_file_content(
        file_identity(&file)?,
        bytes.len() as u64,
        sha2::Sha256::digest(&bytes).into(),
    );
    let held = super::super::journal::held_regular_file_identity_with_fingerprint(&mut file)?;
    if held != expected {
        return Err("Extraction move plan changed while it was installed.".to_string());
    }
    ensure_path_identity(&path, &expected).map_err(|error| {
        format!("Extraction move plan final name changed during creation: {error}")
    })?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(expected)
}

pub(crate) fn validate_move_record(
    staged: &std::path::Path,
    destination: &std::path::Path,
    record: &MoveRecord,
) -> Result<(), String> {
    if !crate::path_safety::path_is_under_or_equal(staged, &record.source)
        || !crate::path_safety::path_is_under_or_equal(destination, &record.target)
    {
        return Err("Refusing unsafe extraction recovery move plan.".to_string());
    }
    if let Some(publish_temp) = &record.publish_temp {
        if publish_temp.parent() != record.target.parent()
            || !crate::path_safety::path_is_under_or_equal(destination, publish_temp)
            || !is_publish_temp_name(publish_temp)
        {
            return Err("Refusing unsafe extraction publish path.".to_string());
        }
    } else if record.publish_identity.is_some() {
        #[cfg(windows)]
        {
            // New Windows publishes normally set publish_temp for non-link
            // roots. The one safe exception is a link-free stage created
            // directly under the existing destination: root entries inherit
            // the validated destination policy and are intentionally renamed
            // in place. Nested records still require target-local staging.
            let allows_rename_publish = |path: &std::path::Path| -> bool {
                std::fs::symlink_metadata(path)
                    .map(|metadata| crate::path_safety::is_link_or_reparse(&metadata))
                    .unwrap_or(false)
            };
            let allows_direct_root_rename =
                staged.parent() == Some(destination) && record.target.parent() == Some(destination);
            if !allows_rename_publish(&record.source)
                && !allows_rename_publish(&record.target)
                && !allows_direct_root_rename
            {
                return Err(
                    "Refusing extraction publish identity without a publish path.".to_string(),
                );
            }
        }
        // Link-root and direct sibling renames still publish without
        // publish_temp on Unix; validate_move_record allows that path.
    }
    Ok(())
}

fn rollback_target_local_record(record: &MoveRecord, crash_recovery: bool) -> Result<(), String> {
    let publish_temp = record
        .publish_temp
        .as_ref()
        .ok_or_else(|| "Extraction publish path is missing.".to_string())?;
    let source_exists = path_entry_exists(&record.source)?;
    let temp_exists = path_entry_exists(publish_temp)?;
    let target_exists = path_entry_exists(&record.target)?;
    let Some(identity) = &record.publish_identity else {
        if temp_exists {
            return Err(format!(
                "Refusing to remove unverified extraction publish path: {}",
                publish_temp.display()
            ));
        }
        return if source_exists {
            Ok(())
        } else {
            Err(format!(
                "Extraction source disappeared before its publish identity was recorded: {}",
                record.source.display()
            ))
        };
    };

    if source_exists {
        // A target-local publish is a copy, so the source remains until the
        // whole stage is committed. Quarantine-delete only the recorded object;
        // a same-name replacement is preserved.
        if target_exists && ensure_path_identity(&record.target, identity).is_ok() {
            if crash_recovery {
                ensure_retract_path_matches(&record.target, identity)?;
            }
            remove_path_if_matches(&record.target, identity)?;
        }
        if temp_exists {
            if crash_recovery {
                ensure_retract_path_matches(publish_temp, identity)?;
            }
            remove_path_if_matches(publish_temp, identity)?;
        }
        return Ok(());
    }

    // This state is not expected during normal copy publishing, but supporting
    // it makes recovery safe if a future implementation retires the source
    // before commit or a manual repair moved it.
    if target_exists && ensure_path_identity(&record.target, identity).is_ok() {
        if crash_recovery {
            ensure_retract_path_matches(&record.target, identity)?;
        }
        if let Some(parent) = record.source.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        return rename_file_no_replace(&record.target, &record.source);
    }
    if temp_exists && ensure_path_identity(publish_temp, identity).is_ok() {
        if crash_recovery {
            ensure_retract_path_matches(publish_temp, identity)?;
        }
        if let Some(parent) = record.source.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        return rename_file_no_replace(publish_temp, &record.source);
    }
    Err(format!(
        "Extraction source and its verified publish object are missing: {}",
        record.source.display()
    ))
}

#[cfg(test)]
pub(crate) fn rollback_move_records(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<(), String> {
    rollback_move_records_impl(staged, destination, plan, false)
}

fn rollback_move_records_impl(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
    crash_recovery: bool,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for record in plan.iter().rev() {
        if let Err(error) = validate_move_record(staged, destination, record) {
            failures.push(error);
            continue;
        }
        if let Err(error) = assert_safe_extract_target_ancestors(destination, &record.target) {
            failures.push(error);
            continue;
        }
        if record.publish_temp.is_some() {
            if let Err(error) = rollback_target_local_record(record, crash_recovery) {
                failures.push(error);
            }
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
        let Some(_target_metadata) = target_metadata else {
            if !source_exists {
                failures.push(format!(
                    "Both extraction source and promoted target are missing: {}",
                    record.target.display()
                ));
            }
            continue;
        };
        if source_exists {
            // Hard-link / exclusive-copy publish can leave the stage source while
            // the target is already visible. Retract the published target so a
            // failed commit does not leave partial extract output behind.
            // (Rename-only publishes remove the source, so both existing means
            // a non-move publish path ran.)
            if path_entry_exists(&record.target).unwrap_or(false) {
                let Some(identity) = &record.publish_identity else {
                    failures.push(format!(
                        "Refusing to retract published extraction target without a recorded identity: {}",
                        record.target.display()
                    ));
                    continue;
                };
                if crash_recovery {
                    if let Err(error) = ensure_retract_path_matches(&record.target, identity) {
                        failures.push(error);
                        continue;
                    }
                }
                if let Err(error) = remove_path_if_matches(&record.target, identity) {
                    failures.push(format!(
                        "Could not retract published extraction target {}: {error}",
                        record.target.display()
                    ));
                }
            }
            continue;
        }
        // Rename operates on the link/reparse entry itself and does not follow
        // it. Ancestors were verified above, so links are safe to roll back.
        let Some(identity) = &record.publish_identity else {
            failures.push(format!(
                "Refusing to roll back an extraction target without a recorded identity: {}",
                record.target.display()
            ));
            continue;
        };
        let unchanged = if crash_recovery {
            ensure_retract_path_matches(&record.target, identity)
        } else {
            ensure_path_entry_identity(&record.target, identity)
        };
        if let Err(error) = unchanged {
            failures.push(format!(
                "Extraction target changed after publication and was preserved: {} ({error})",
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
        if let Err(error) = rename_file_no_replace(&record.target, &record.source) {
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
    move_plan_identity: Option<&FileIdentity>,
    move_identity_log_identity: Option<&FileIdentity>,
) -> Result<(), String> {
    let plan_path = move_plan_path(staged);
    let sibling_plan = match std::fs::symlink_metadata(&plan_path) {
        Ok(_) => {
            let expected = move_plan_identity.ok_or_else(|| {
                format!(
                    "Refusing to read present move-plan sibling {} without its recorded identity.",
                    plan_path.display()
                )
            })?;
            super::super::journal::read_bounded_nofollow_bytes_if_matches(
                &plan_path,
                MAX_MOVE_PLAN_BYTES,
                expected,
            )?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let plan_bytes = sibling_plan;

    let log_path = move_identity_log_path(staged);
    let move_identity_log_identity = super::super::journal::effective_move_identity_log_identity(
        staged,
        move_identity_log_identity,
    )?;
    let log_bytes = match std::fs::symlink_metadata(&log_path) {
        Ok(_) => {
            let expected = move_identity_log_identity.as_ref().ok_or_else(|| {
                format!(
                    "Refusing to read present move-identity-log sibling {} without its recorded identity.",
                    log_path.display()
                )
            })?;
            super::super::journal::read_bounded_nofollow_bytes_if_matches(
                &log_path,
                MAX_MOVE_IDENTITY_LOG_BYTES,
                expected,
            )?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let Some(plan_bytes) = plan_bytes else {
        if log_bytes.is_some() {
            return Err(
                "Extraction identity log is present without an authenticated move plan."
                    .to_string(),
            );
        }
        return Ok(());
    };
    let mut plan: Vec<MoveRecord> =
        serde_json::from_slice(&plan_bytes).map_err(|error| error.to_string())?;
    if plan.len() as u64 > MAX_EXTRACT_ENTRIES {
        return Err("Extraction move plan exceeds its record safety limit.".to_string());
    }
    hydrate_move_plan_identities(log_bytes.as_deref(), &mut plan)?;
    rollback_move_records_impl(staged, destination, &plan, true)
}

#[cfg(windows)]
pub(crate) fn clear_staged_directory_shell_attributes(
    root: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::fs::MetadataExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM,
    };

    let shell_bits = FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let meta = std::fs::symlink_metadata(&directory)
            .map_err(|error| format!("Could not inspect {}: {error}", directory.display()))?;
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("Could not read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_dir() && !file_type.is_symlink() {
                pending.push(entry.path());
            }
        }
        let attributes = meta.file_attributes();
        if attributes & shell_bits == 0 {
            continue;
        }
        let mut cleared = attributes & !shell_bits;
        if cleared == 0 {
            cleared = FILE_ATTRIBUTE_NORMAL;
        }
        let wide: Vec<u16> = directory
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is NUL-terminated (`chain(once(0))`) and alive for the call.
        if unsafe { SetFileAttributesW(wide.as_ptr(), cleared) } == 0 {
            return Err(format!(
                "Could not clear folder attributes on {}: {}",
                directory.display(),
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn clear_staged_directory_shell_attributes(
    _root: &std::path::Path,
) -> Result<(), String> {
    Ok(())
}

/// Fail closed on silent no-output: an exit-0 run that leaves an empty stage
/// (skip-all, killed writer) must not publish as success. An archive whose
/// manifest declares zero entries legitimately produces no files, so only a
/// declared non-empty archive (or an unknown manifest) requires output.
pub(crate) fn ensure_extract_stage_has_output(
    staged: &std::path::Path,
    manifest_entry_count: Option<u64>,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(staged)
        .map_err(|error| format!("Could not inspect extraction stage: {error}"))?;
    if entries.next().is_some() || manifest_entry_count == Some(0) {
        return Ok(());
    }
    Err("Extraction produced no files; output was not published.".to_string())
}

fn merge_staged_extract_recorded<R, F>(
    staged: &std::path::Path,
    destination: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    max_bytes: u64,
    recorder: &mut R,
    mark_committed: F,
) -> Result<(Vec<std::path::PathBuf>, PublishStrategy), String>
where
    R: ExtractArtifactRecorder,
    F: FnOnce() -> Result<(), String>,
{
    ensure_path_identity(staged, expected_stage_identity).map_err(|error| {
        format!("Extraction stage changed after creation and was preserved: {error}")
    })?;
    // Always enforce the operation-specific limit immediately before publish,
    // and make every regular file plus directory entry durable before any
    // staged object becomes visible at the destination.
    let destination_preexisting = path_entry_exists(destination)?;
    let publish_identity = if destination_preexisting {
        // Existing destinations use the per-record target-local plan below;
        // hashing the entire staged tree here would duplicate those file
        // fingerprints. If the destination disappears during validation, the
        // whole-stage branch obtains the one required tree fingerprint below.
        sync_staged_tree_without_fingerprint(staged, max_bytes)?;
        None
    } else {
        Some(validate_and_sync_staged_tree(staged, max_bytes)?)
    };
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
        let publish_identity = match publish_identity {
            Some(identity) => identity,
            None => path_identity_with_fingerprint(staged)?,
        };
        if !file_identities_match(&publish_identity, expected_stage_identity) {
            return Err(
                "Extraction stage changed before whole-stage publication and was preserved."
                    .to_string(),
            );
        }
        // `validate_and_sync_staged_tree` completed after 7-Zip exited, and
        // this first fingerprint is immediately followed by no-write rename.
        // Post-rename fingerprint below remains authoritative. A second full
        // pre-rename tree hash only reread every extracted byte.
        rename_file_no_replace(staged, destination)?;
        let verification_error = match path_identity_with_fingerprint(destination) {
            Ok(actual)
                if file_identities_match(&actual, expected_stage_identity)
                    && actual.fingerprint() == publish_identity.fingerprint() =>
            {
                None
            }
            Ok(_) => Some("published stage identity changed".to_string()),
            Err(error) => Some(error),
        };
        if let Some(verification_error) = verification_error {
            return Err(format!(
                "Extraction destination did not retain the creation-bound stage identity and was preserved for recovery: {verification_error}"
            ));
        }
        if let Err(error) = crate::fs_secure::apply_parent_directory_mode(destination) {
            return Err(format!(
                "{error}; the published extraction destination was preserved for journal recovery"
            ));
        }
        let durability = if let Some(parent) = destination.parent() {
            sync_directory(parent)
        } else {
            Ok(())
        };
        if let Err(error) = durability {
            return Err(format!(
                "{error}; the published extraction destination was preserved for journal recovery"
            ));
        }
        if let Err(error) = mark_committed() {
            return Err(format!(
                "{error}; the published extraction destination was preserved for journal recovery"
            ));
        }
        #[cfg(feature = "e2e")]
        crate::process::e2e_crash::crash_point("after-commit");
        return Ok((
            vec![destination.to_path_buf()],
            PublishStrategy::WholeStageRename,
        ));
    }
    assert_real_directory(destination)?;
    let mut reserved = std::collections::HashSet::new();
    let mut plan = Vec::new();
    plan_staged_contents(staged, destination, &mut reserved, &mut plan)?;
    prepare_planned_links(staged, destination, &plan)?;
    prepare_target_local_publish_paths(
        &mut plan,
        &mut reserved,
        staged.parent() == Some(destination),
        destination,
    )?;
    let publish_strategy = if plan.iter().any(|record| record.publish_temp.is_some()) {
        PublishStrategy::TargetLocalCopy
    } else {
        PublishStrategy::DirectRename
    };
    // Install both recovery siblings with create-new semantics. Each identity is
    // persisted to the active journal and exact pending record before any
    // destination publication begins.
    let move_plan_identity = write_move_plan(staged, &plan)?;
    recorder.record_move_plan(&move_plan_identity)?;
    let mut identity_log = MoveIdentityLogWriter::create(staged)?;
    let mut move_identity_log_identity = identity_log.current_identity();
    recorder.record_move_identity_log(&move_identity_log_identity)?;
    for index in 0..plan.len() {
        let mut publish_one = || -> Result<(), String> {
            validate_move_record(staged, destination, &plan[index])?;
            let source = plan[index].source.clone();
            let target = plan[index].target.clone();
            assert_safe_extract_target_ancestors(destination, &target)?;
            if path_entry_exists(&target)? {
                return Err(format!(
                    "Extraction destination changed during commit: {}",
                    target.display()
                ));
            }
            if plan[index].publish_temp.is_some() {
                return publish_target_local_copy(recorder, &mut identity_log, &mut plan, index);
            }
            let metadata = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
            if !crate::path_safety::is_link_or_reparse(&metadata)
                && !metadata.is_file()
                && !metadata.is_dir()
            {
                return Err(format!(
                    "Extraction publish path is unsupported: {}",
                    source.display()
                ));
            }
            let expected = path_identity_with_fingerprint(&source)?;
            record_publish_identity(recorder, &mut identity_log, &mut plan, index, &expected)?;
            rename_file_no_replace(&source, &target)?;
            let actual = path_identity_with_fingerprint(&plan[index].target)?;
            if actual.fingerprint() != expected.fingerprint() {
                return Err(format!(
                    "Extraction link changed during commit: {}",
                    plan[index].target.display()
                ));
            }
            if !file_identities_match(&actual, &expected) {
                record_publish_identity(recorder, &mut identity_log, &mut plan, index, &actual)?;
            }
            // Direct directory renames preserve the private staging mode;
            // normalize the published directory to its destination parent.
            // The Unix helper re-opens the target without following links,
            // and any failure still reaches the enclosing rollback path.
            #[cfg(unix)]
            if metadata.is_dir() {
                crate::fs_secure::apply_parent_directory_mode(&target).map_err(|error| {
                    format!(
                        "Could not apply destination parent mode to published directory {}: {error}",
                        target.display()
                    )
                })?;
            }
            Ok(())
        };
        if let Err(error) = publish_one() {
            let rollback = rollback_move_records_impl(staged, destination, &plan, true);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
        #[cfg(feature = "e2e")]
        if index == 0 {
            crate::process::e2e_crash::crash_point("mid-promotion");
        }
    }
    move_identity_log_identity = match identity_log.seal().and_then(|identity| {
        recorder.record_move_identity_log(&identity)?;
        Ok(identity)
    }) {
        Ok(identity) => identity,
        Err(error) => {
            let rollback = rollback_move_records_impl(staged, destination, &plan, true);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}; extraction seal rollback also failed: {rollback_error}")
                }
            });
        }
    };
    let promoted: Vec<_> = plan.iter().map(|record| record.target.clone()).collect();
    let durability = sync_directory(destination).and_then(|()| {
        if let Some(parent) = destination.parent() {
            sync_directory(parent)?;
        }
        Ok(())
    });
    if let Err(error) = durability {
        let rollback =
            rollback_move_records_impl(staged, destination, &plan, true).and_then(|()| {
                sync_directory(destination)?;
                if let Some(parent) = destination.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            });
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; extraction durability rollback also failed: {rollback_error}")
            }
        });
    }
    if let Err(error) = mark_committed() {
        let rollback =
            rollback_move_records_impl(staged, destination, &plan, true).and_then(|()| {
                sync_directory(destination)?;
                if let Some(parent) = destination.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            });
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; extraction commit rollback also failed: {rollback_error}")
            }
        });
    }
    #[cfg(feature = "e2e")]
    crate::process::e2e_crash::crash_point("after-commit");

    // The journal now records a durable extraction commit. Cleanup remains an
    // owned recovery operation: return failure while preserving publication so
    // the journal, pending record, and process slot stay available for retry.
    super::super::journal::cleanup_transaction_artifacts(
        staged,
        Some(expected_stage_identity),
        Some(&move_plan_identity),
        Some(&move_identity_log_identity),
        &[],
    )
    .map_err(|error| {
        format!(
            "Extraction was committed, but recovery artifact cleanup failed; published files were preserved: {error}"
        )
    })?;
    Ok((promoted, publish_strategy))
}

struct JournalExtractArtifactRecorder<'a> {
    app: &'a tauri::AppHandle,
    plan: &'a CleanupPlan,
}

impl ExtractArtifactRecorder for JournalExtractArtifactRecorder<'_> {
    fn record_move_plan(&mut self, identity: &FileIdentity) -> Result<(), String> {
        super::super::journal::record_extract_move_plan_identity(self.app, self.plan, identity)
    }

    fn record_move_identity_log(&mut self, identity: &FileIdentity) -> Result<(), String> {
        super::super::journal::record_extract_move_identity_log_identity(
            self.app, self.plan, identity,
        )
    }
}

#[cfg(test)]
struct TestExtractArtifactRecorder;

#[cfg(test)]
impl ExtractArtifactRecorder for TestExtractArtifactRecorder {
    fn record_move_plan(&mut self, _identity: &FileIdentity) -> Result<(), String> {
        Ok(())
    }

    fn record_move_identity_log(&mut self, _identity: &FileIdentity) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn merge_staged_extract_with_commit<F>(
    staged: &std::path::Path,
    destination: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    max_bytes: u64,
    mark_committed: F,
) -> Result<Vec<std::path::PathBuf>, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let mut recorder = TestExtractArtifactRecorder;
    merge_staged_extract_recorded(
        staged,
        destination,
        expected_stage_identity,
        max_bytes,
        &mut recorder,
        mark_committed,
    )
    .map(|(promoted, _)| promoted)
}

#[cfg(test)]
pub(crate) fn merge_staged_extract(
    staged: &std::path::Path,
    destination: &std::path::Path,
    max_bytes: u64,
) -> Result<Vec<std::path::PathBuf>, String> {
    let stage_identity = path_identity(staged)?;
    merge_staged_extract_with_commit(staged, destination, &stage_identity, max_bytes, || Ok(()))
}

pub(crate) fn commit_cleanup(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<Option<PublishStrategy>, String> {
    let mut publish_strategy = None;
    let input_only = plan.staged_input_archive.is_some()
        && plan.staged_extract.is_none()
        && plan.staged_archive.is_none();
    if let Some(staged) = &plan.staged_input_archive {
        remove_plan_stage_if_owned(plan, staged.parent().unwrap_or(staged))
            .map_err(|e| format!("Could not remove archive input snapshot: {e}"))?;
        if input_only {
            super::super::journal::unregister_plan_stages(plan);
        }
    }
    if let Some((staged, destination)) = &plan.staged_extract {
        let stage_identity = plan.stage_identity(staged).ok_or_else(|| {
            "Extraction stage has no creation-bound ownership identity.".to_string()
        })?;
        let mut recorder = JournalExtractArtifactRecorder { app, plan };
        let (_, extraction_strategy) = merge_staged_extract_recorded(
            staged,
            destination,
            stage_identity,
            plan.max_extract_bytes.unwrap_or(MAX_EXTRACTED_BYTES),
            &mut recorder,
            || mark_extract_journal_committed(app, plan),
        )
        .map_err(|e| format!("Could not promote staged extraction safely: {e}"))?;
        publish_strategy = Some(extraction_strategy);
        crate::launch::remember_openable_directory(app, destination);
    }
    if let Some((staged, destination)) = &plan.staged_archive {
        update_archive_journal(app, plan)
            .map_err(|error| format!("Archive recovery ownership update failed: {error}"))?;
        let stage = staged
            .parent()
            .ok_or_else(|| "Archive staging directory is missing.".to_string())?;
        let stage_identity = plan
            .stage_identity(stage)
            .ok_or_else(|| "Archive stage has no creation-bound ownership identity.".to_string())?;
        let archive_strategy = promote_archive_family_with_commit(
            staged,
            destination,
            &plan.expected_archive_family,
            stage_identity,
            |original, identity| {
                record_archive_journal_backup(app, plan, original, identity)
                    .map_err(|error| format!("Archive recovery ownership update failed: {error}"))
            },
            |published, identity| {
                record_archive_journal_published(app, plan, published, identity)
                    .map_err(|error| format!("Archive recovery ownership update failed: {error}"))
            },
            || {
                mark_archive_journal_committed(app, plan)
                    .map_err(|error| format!("Archive recovery ownership update failed: {error}"))
            },
        )?;
        publish_strategy = Some(archive_strategy);
        if let Some(parent) = destination.parent() {
            crate::launch::remember_openable_directory(app, parent);
        }
    }
    if plan.staged_extract.is_some() || plan.staged_archive.is_some() {
        unregister_plan_stages_strict(plan).map_err(|error| {
            format!(
                "Transaction was committed, but recovery artifact cleanup failed; published output was preserved: {error}"
            )
        })?;
    } else {
        unregister_plan_stages(plan);
    }
    Ok(publish_strategy)
}
