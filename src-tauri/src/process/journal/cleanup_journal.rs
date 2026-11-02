//! Cleanup journal read, write, and recovery phases.

use tauri::Manager;

use super::identity::{
    ensure_path_identity, ensure_recovery_path_unchanged, file_identities_match, file_identity,
    identity_with_file_content, remove_directory_if_matches,
    remove_recovery_regular_file_if_matches, FileIdentity, ObjectFingerprint,
};
use super::{
    MAX_MOVE_IDENTITY_LOG_BYTES, MAX_MOVE_IDENTITY_RECORD_BYTES, MAX_RECOVERY_JOURNAL_BYTES,
};
use crate::process::commit::{archive_backup_path, archive_destination_for, archive_family};
use crate::process::CleanupPlan;

pub(crate) fn read_bounded_nofollow_bytes(
    path: &std::path::Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read as _;

    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let file = crate::path_safety::open_regular_file_nofollow(path)?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length > max_bytes {
        return Err(format!(
            "Recovery file exceeds its {max_bytes}-byte safety limit: {}",
            path.display()
        ));
    }
    let capacity = usize::try_from(length.min(max_bytes)).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "Recovery file exceeds its {max_bytes}-byte safety limit: {}",
            path.display()
        ));
    }
    Ok(Some(bytes))
}

pub(crate) fn read_bounded_nofollow_text(
    path: &std::path::Path,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    let Some(bytes) = read_bounded_nofollow_bytes(path, max_bytes)? else {
        return Ok(None);
    };
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| format!("Recovery file is not valid UTF-8: {}", path.display()))
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExtractStagePlacement {
    /// The destination did not exist when the transaction started, so the
    /// stage is beside it and can be renamed into place as a whole.
    Sibling,
    /// The destination already existed, so the stage is a hidden child whose
    /// contents inherit the destination's local or SMB security policy.
    InsideDestination,
}

impl ExtractStagePlacement {
    pub(crate) fn from_paths(
        stage: &std::path::Path,
        destination: &std::path::Path,
    ) -> Result<Self, String> {
        if stage.parent() == destination.parent() {
            return Ok(Self::Sibling);
        }
        if stage.parent() == Some(destination) {
            return Ok(Self::InsideDestination);
        }
        Err("Extraction stage is not in a supported publish location.".to_string())
    }

    pub(crate) fn matches_paths(
        self,
        stage: &std::path::Path,
        destination: &std::path::Path,
    ) -> bool {
        match self {
            Self::Sibling => stage.parent() == destination.parent(),
            Self::InsideDestination => stage.parent() == Some(destination),
        }
    }
}

/// Format version written into every cleanup journal by this build.
///
/// Rule: bump this constant whenever a change to `CleanupJournal` (a new field,
/// or a change in the meaning of an existing one) would make an older reader
/// misinterpret a journal it accepts, for example by treating a journal as
/// legacy when it is not. Readers refuse any journal whose `format_version` is
/// greater than this constant, so bumping it is what makes older builds fail
/// closed instead of running recovery with wrong assumptions. Journals whose
/// `format_version` is below this constant are refused the same way.
pub(crate) const CLEANUP_JOURNAL_FORMAT_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct CleanupJournal {
    /// Serialized format version. Missing (0) identifies a pre-0.7 journal that
    /// this build refuses before recovery. Versions above
    /// `CLEANUP_JOURNAL_FORMAT_VERSION` are refused by every reader.
    #[serde(default)]
    pub(crate) format_version: u32,
    pub(crate) stage: std::path::PathBuf,
    pub(crate) destination: std::path::PathBuf,
    pub(crate) archive: bool,
    #[serde(default)]
    pub(crate) extract_stage_placement: Option<ExtractStagePlacement>,
    /// Extraction journals must store the move plan beside the stage.
    #[serde(default)]
    pub(crate) move_plan_sidecar: bool,
    /// Creation-held, fingerprinted identity of the sibling move plan. Missing
    /// legacy identities never authorize reading or deleting a present sibling.
    #[serde(default)]
    pub(crate) move_plan_identity: Option<FileIdentity>,
    /// Creation-held identity of the append-only move identity log. Current
    /// writers persist its rolling fingerprint after every durable append and
    /// seal the final fingerprint before committing extraction publication.
    #[serde(default)]
    pub(crate) move_identity_log_identity: Option<FileIdentity>,
    pub(crate) previous_archive_family: Vec<std::path::PathBuf>,
    /// Stable identities for recovery backups, recorded immediately before each
    /// existing archive volume is moved aside and corrected from the open handle
    /// after rename when needed. Recovery refuses to restore or remove any
    /// present backup it cannot identify.
    #[serde(default)]
    pub(crate) previous_archive_identities: Vec<Option<FileIdentity>>,
    #[serde(default)]
    pub(crate) next_archive_family: Vec<std::path::PathBuf>,
    /// Stable identities recorded before each output becomes visible. Rename
    /// and hard-link publication preserve the staged identity; create-new copy
    /// publication replaces it while the new handle is still open. Recovery
    /// must never delete a same-name file it cannot identify as Zinnia's output.
    #[serde(default)]
    pub(crate) next_archive_identities: Vec<Option<FileIdentity>>,
    /// Creation-bound identity of the transaction stage captured before 7-Zip
    /// starts. Extraction and archive journals require this ownership evidence
    /// before destructive stage recovery.
    #[serde(default)]
    pub(crate) extract_stage_identity: Option<FileIdentity>,
    #[serde(default)]
    pub(crate) extract_phase: Option<ExtractJournalPhase>,
    #[serde(default)]
    pub(crate) archive_phase: Option<ArchiveJournalPhase>,
}
pub(crate) fn effective_move_identity_log_identity(
    stage: &std::path::Path,
    expected: Option<&FileIdentity>,
) -> Result<Option<FileIdentity>, String> {
    use sha2::Digest as _;
    use std::io::Read as _;

    let Some(expected) = expected else {
        return Ok(None);
    };
    let unchanged = Ok(Some(expected.clone()));
    let Some(ObjectFingerprint::File {
        len: expected_len,
        sha256: expected_sha256,
    }) = expected.fingerprint()
    else {
        return unchanged;
    };
    let path = move_identity_log_path(stage);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata)
            if !crate::path_safety::is_link_or_reparse(&metadata) && metadata.is_file() => {}
        Ok(_) => return unchanged,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return unchanged,
        Err(error) => return Err(error.to_string()),
    }
    let mut file = crate::path_safety::open_regular_file_nofollow(&path)?;
    let before_identity = file_identity(&file)?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    if !file_identities_match(&before_identity, expected)
        || before.len() <= *expected_len
        || before.len() > MAX_MOVE_IDENTITY_LOG_BYTES
    {
        return unchanged;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(before.len()).unwrap_or(0));
    file.by_ref()
        .take(MAX_MOVE_IDENTITY_LOG_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    if bytes.len() as u64 != before.len()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return unchanged;
    }
    let Ok(prefix_len) = usize::try_from(*expected_len) else {
        return unchanged;
    };
    let (prefix, suffix) = bytes.split_at(prefix_len);
    if sha2::Sha256::digest(prefix).as_slice() != expected_sha256
        || prefix.last().is_some_and(|byte| *byte != b'\n')
    {
        return unchanged;
    }
    // At most one record can be unjournaled: either torn (no newline yet) or
    // complete (exactly one newline, at the end).
    let newlines = suffix.iter().filter(|byte| **byte == b'\n').count();
    let one_record = match newlines {
        0 => true,
        1 => suffix.last() == Some(&b'\n'),
        _ => false,
    };
    if !one_record || suffix.len() > MAX_MOVE_IDENTITY_RECORD_BYTES.saturating_add(1) {
        return unchanged;
    }
    Ok(Some(identity_with_file_content(
        before_identity,
        before.len(),
        sha2::Sha256::digest(&bytes).into(),
    )))
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArchiveJournalPhase {
    InProgress,
    Committed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExtractJournalPhase {
    InProgress,
    Committed,
}

pub(crate) fn move_plan_path(stage: &std::path::Path) -> std::path::PathBuf {
    let name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".zinnia-extract-unknown");
    stage.with_file_name(format!("{name}.move-plan.json"))
}

pub(crate) fn move_identity_log_path(stage: &std::path::Path) -> std::path::PathBuf {
    let name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".zinnia-extract-unknown");
    stage.with_file_name(format!("{name}.move-identities.jsonl"))
}

#[derive(Debug)]
pub(crate) struct ValidatedTransactionArtifacts {
    pub(crate) stage_present: bool,
    pub(crate) move_plan_present: bool,
    pub(crate) move_identity_log_present: bool,
    pub(crate) archive_backups_present: Vec<bool>,
}

fn validate_recorded_sibling(
    path: &std::path::Path,
    expected: Option<&FileIdentity>,
    label: &str,
) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(format!(
            "Refusing unexpected {label} artifact {}.",
            path.display()
        ));
    }
    let expected = expected.ok_or_else(|| {
        format!(
            "Refusing to remove present {label} artifact {} because its identity was not recorded.",
            path.display()
        )
    })?;
    ensure_recovery_path_unchanged(path, expected)?;
    Ok(true)
}

/// Authenticate the complete sibling recovery set before any artifact is
/// deleted. This prevents a valid plan or backup zero from being removed before
/// a later replacement, in-place edit, malformed index, or unexpected type is
/// discovered.
pub(crate) fn validate_transaction_artifacts(
    stage: &std::path::Path,
    stage_identity: Option<&FileIdentity>,
    move_plan_identity: Option<&FileIdentity>,
    move_identity_log_identity: Option<&FileIdentity>,
    archive_backup_identities: &[Option<FileIdentity>],
) -> Result<ValidatedTransactionArtifacts, String> {
    let stage_present = match std::fs::symlink_metadata(stage) {
        Ok(metadata) => {
            if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() {
                return Err(format!(
                    "Refusing unexpected transaction stage {}.",
                    stage.display()
                ));
            }
            let expected = stage_identity.ok_or_else(|| {
                format!(
                    "Refusing to remove present transaction stage {} because its identity was not recorded.",
                    stage.display()
                )
            })?;
            ensure_path_identity(stage, expected)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };

    let move_plan_present =
        validate_recorded_sibling(&move_plan_path(stage), move_plan_identity, "move-plan")?;
    let move_identity_log_present = validate_recorded_sibling(
        &move_identity_log_path(stage),
        move_identity_log_identity,
        "move-identity-log",
    )?;

    let parent = stage
        .parent()
        .ok_or_else(|| "Transaction stage has no parent directory.".to_string())?;
    let stage_name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Transaction stage has an invalid name.".to_string())?;
    let prefix = format!("{stage_name}.backup-");
    let mut archive_backups_present = vec![false; archive_backup_identities.len()];
    for entry in std::fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(raw_index) = name.strip_prefix(&prefix) else {
            continue;
        };
        let index = raw_index.parse::<usize>().map_err(|_| {
            format!(
                "Refusing unexpected archive backup artifact {}.",
                entry.path().display()
            )
        })?;
        if raw_index != index.to_string() || index >= archive_backup_identities.len() {
            return Err(format!(
                "Refusing unexpected archive backup index at {}.",
                entry.path().display()
            ));
        }
        let expected = archive_backup_identities[index].as_ref().ok_or_else(|| {
            format!(
                "Refusing to remove archive backup {} because its identity was not recorded.",
                entry.path().display()
            )
        })?;
        if !validate_recorded_sibling(&entry.path(), Some(expected), "archive-backup")? {
            return Err(format!(
                "Archive backup disappeared during validation: {}",
                entry.path().display()
            ));
        }
        archive_backups_present[index] = true;
    }

    Ok(ValidatedTransactionArtifacts {
        stage_present,
        move_plan_present,
        move_identity_log_present,
        archive_backups_present,
    })
}

/// Remove an already authenticated sibling set first and its stage last. Every
/// destructive boundary rechecks identity/fingerprint through quarantine.
pub(crate) fn cleanup_transaction_artifacts(
    stage: &std::path::Path,
    stage_identity: Option<&FileIdentity>,
    move_plan_identity: Option<&FileIdentity>,
    move_identity_log_identity: Option<&FileIdentity>,
    archive_backup_identities: &[Option<FileIdentity>],
) -> Result<(), String> {
    let move_identity_log_identity =
        effective_move_identity_log_identity(stage, move_identity_log_identity)?;
    let move_identity_log_identity = move_identity_log_identity.as_ref();
    let present = validate_transaction_artifacts(
        stage,
        stage_identity,
        move_plan_identity,
        move_identity_log_identity,
        archive_backup_identities,
    )?;
    if present.move_plan_present {
        remove_recovery_regular_file_if_matches(
            &move_plan_path(stage),
            move_plan_identity.ok_or_else(|| "validated move-plan identity missing".to_string())?,
        )?;
    }
    if present.move_identity_log_present {
        remove_recovery_regular_file_if_matches(
            &move_identity_log_path(stage),
            move_identity_log_identity
                .ok_or_else(|| "validated identity-log identity missing".to_string())?,
        )?;
    }
    for (index, is_present) in present.archive_backups_present.iter().enumerate() {
        if *is_present {
            remove_recovery_regular_file_if_matches(
                &archive_backup_path(stage, index),
                archive_backup_identities[index]
                    .as_ref()
                    .ok_or_else(|| "validated archive backup identity missing".to_string())?,
            )?;
        }
    }
    if present.stage_present {
        remove_directory_if_matches(
            stage,
            stage_identity
                .ok_or_else(|| "validated transaction stage identity missing".to_string())?,
        )?;
    }
    if let Some(parent) = stage.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct MoveRecord {
    pub(crate) source: std::path::PathBuf,
    pub(crate) target: std::path::PathBuf,
    /// Windows publish copy created directly under the real target parent.
    /// Creating there lets NTFS or the SMB server assign the same inherited ACL
    /// as an ordinary extraction, while the final no-replace rename stays atomic.
    #[serde(default)]
    pub(crate) publish_temp: Option<std::path::PathBuf>,
    /// Stable identity captured immediately after `publish_temp` is created.
    /// Recovery never removes a same-name object without matching this value.
    #[serde(default)]
    pub(crate) publish_identity: Option<FileIdentity>,
}

pub(crate) fn cleanup_journal_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("active-transaction.json"))
}

/// Parse a journal without enforcing the format gate. Only the acknowledgment
/// path may use this, and it must check `format_version` before doing anything
/// else. Every other reader uses `read_cleanup_journal_at`.
pub(crate) fn read_cleanup_journal_any_version_at(
    path: &std::path::Path,
) -> Result<Option<CleanupJournal>, String> {
    let Some(json) = read_bounded_nofollow_text(path, MAX_RECOVERY_JOURNAL_BYTES)? else {
        return Ok(None);
    };
    serde_json::from_str(&json)
        .map(Some)
        .map_err(|error| format!("Could not parse recovery journal: {error}"))
}

/// Refuse a journal this build cannot interpret. The message says the journal
/// was preserved so the startup banner offers acknowledgment.
pub(crate) fn ensure_journal_format_supported(journal: &CleanupJournal) -> Result<(), String> {
    if journal.format_version > CLEANUP_JOURNAL_FORMAT_VERSION {
        return Err(format!(
            "The recovery journal was written by a newer Zinnia version (journal format {}; \
             this build supports up to {}). The journal was preserved and no files were \
             changed. Recover it with that newer Zinnia version, or accept it here to clear \
             the marker without changing files.",
            journal.format_version, CLEANUP_JOURNAL_FORMAT_VERSION
        ));
    }
    if journal.format_version < CLEANUP_JOURNAL_FORMAT_VERSION {
        return Err(format!(
            "The recovery journal was written by an older Zinnia version (journal format {}; \
             this build requires at least {}). The journal was preserved and no files were \
             changed. Recover it with Zinnia 0.6.2 or earlier, or accept it here to clear \
             the marker without changing files.",
            journal.format_version, CLEANUP_JOURNAL_FORMAT_VERSION
        ));
    }
    if !journal.archive && !journal.move_plan_sidecar {
        return Err(
            "The recovery journal has no durable sidecar move plan and was preserved. \
             No files were changed. Accept it here to clear the marker without changing files."
                .to_string(),
        );
    }
    if journal.archive && journal.archive_phase.is_none() {
        return Err(
            "The recovery journal was preserved because archive phase metadata is missing. \
             No files were changed. Accept it here to clear the marker without changing files."
                .to_string(),
        );
    }
    if !journal.archive
        && (journal.extract_phase.is_none() || journal.extract_stage_placement.is_none())
    {
        return Err(
            "The recovery journal was preserved because extraction phase or placement metadata is missing. \
             No files were changed. Accept it here to clear the marker without changing files."
                .to_string(),
        );
    }
    Ok(())
}

/// Read the active journal for recovery or mutation. Every caller that can
/// touch files or rewrite the journal goes through this gate, so a newer format
/// fails before any filesystem action.
pub(crate) fn read_cleanup_journal_at(
    path: &std::path::Path,
) -> Result<Option<CleanupJournal>, String> {
    let Some(journal) = read_cleanup_journal_any_version_at(path)? else {
        return Ok(None);
    };
    ensure_journal_format_supported(&journal)?;
    Ok(Some(journal))
}

/// Refuse to replace an existing journal this build cannot read. A missing
/// journal is fine. Parse errors also fail closed, because recovery should
/// already have resolved any such journal before a new transaction starts.
pub(crate) fn ensure_journal_path_writable_at(path: &std::path::Path) -> Result<(), String> {
    read_cleanup_journal_at(path).map(|_| ())
}

/// Serialize a journal in the format this build writes. Every write stamps the
/// current format version, including rewrites of journals read from disk.
pub(crate) fn encode_cleanup_journal(journal: &mut CleanupJournal) -> Result<String, String> {
    journal.format_version = CLEANUP_JOURNAL_FORMAT_VERSION;
    serde_json::to_string(journal).map_err(|error| error.to_string())
}

pub(crate) fn captured_plan_stage_identity(
    plan: &CleanupPlan,
    stage: &std::path::Path,
) -> Result<FileIdentity, String> {
    let identity = plan.stage_identity(stage).ok_or_else(|| {
        format!(
            "Transaction plan has no creation-bound identity for stage {}.",
            stage.display()
        )
    })?;
    ensure_path_identity(stage, identity).map_err(|error| {
        format!("Transaction stage changed before its recovery identity was recorded: {error}")
    })?;
    Ok(identity.clone())
}

pub(crate) fn write_cleanup_journal(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<bool, String> {
    let journal = if let Some((stage, destination)) = &plan.staged_extract {
        Some(CleanupJournal {
            format_version: CLEANUP_JOURNAL_FORMAT_VERSION,
            stage: stage.clone(),
            destination: destination.clone(),
            archive: false,
            extract_stage_placement: Some(ExtractStagePlacement::from_paths(stage, destination)?),
            move_plan_sidecar: true,
            move_plan_identity: None,
            move_identity_log_identity: None,
            previous_archive_family: Vec::new(),
            previous_archive_identities: Vec::new(),
            next_archive_family: Vec::new(),
            next_archive_identities: Vec::new(),
            extract_stage_identity: Some(captured_plan_stage_identity(plan, stage)?),
            extract_phase: Some(ExtractJournalPhase::InProgress),
            archive_phase: None,
        })
    } else if let Some((staged_archive, destination)) = &plan.staged_archive {
        let stage = staged_archive
            .parent()
            .ok_or_else(|| "Archive staging directory is missing.".to_string())?
            .to_path_buf();
        let stage_identity = captured_plan_stage_identity(plan, &stage)?;
        let previous_archive_family = plan
            .expected_archive_family
            .iter()
            .map(|snapshot| snapshot.path.clone())
            .collect();
        let previous_archive_identities = plan
            .expected_archive_family
            .iter()
            .map(|snapshot| {
                Some(identity_with_file_content(
                    snapshot.identity.clone(),
                    snapshot.len,
                    snapshot.sha256,
                ))
            })
            .collect();
        Some(CleanupJournal {
            format_version: CLEANUP_JOURNAL_FORMAT_VERSION,
            stage,
            destination: destination.clone(),
            archive: true,
            extract_stage_placement: None,
            move_plan_sidecar: false,
            move_plan_identity: None,
            move_identity_log_identity: None,
            previous_archive_family,
            previous_archive_identities,
            next_archive_family: Vec::new(),
            next_archive_identities: Vec::new(),
            extract_stage_identity: Some(stage_identity),
            extract_phase: None,
            archive_phase: Some(ArchiveJournalPhase::InProgress),
        })
    } else {
        None
    };
    let Some(mut journal) = journal else {
        return Ok(false);
    };
    let journal_path = cleanup_journal_path(app)?;
    ensure_journal_path_writable_at(&journal_path)?;
    let json = encode_cleanup_journal(&mut journal)?;
    crate::settings_store::atomic_write_text(&journal_path, &json)?;
    Ok(true)
}

pub(crate) fn update_archive_journal(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<(), String> {
    let Some((staged, destination)) = &plan.staged_archive else {
        return Ok(());
    };
    let stage = staged
        .parent()
        .ok_or_else(|| "Archive staging directory is missing.".to_string())?
        .to_path_buf();
    let stage_identity = captured_plan_stage_identity(plan, &stage)?;
    let journal_path = cleanup_journal_path(app)?;
    let existing = read_cleanup_journal_at(&journal_path)?
        .ok_or_else(|| "Archive recovery journal disappeared before update.".to_string())?;
    if !existing.archive
        || existing.stage != stage
        || existing.destination != *destination
        || existing.archive_phase != Some(ArchiveJournalPhase::InProgress)
        || !existing
            .extract_stage_identity
            .as_ref()
            .is_some_and(|recorded| file_identities_match(recorded, &stage_identity))
    {
        return Err("Archive recovery journal changed before update.".to_string());
    }
    let next_archive_family = archive_family(staged)?
        .iter()
        .map(|source| archive_destination_for(staged, destination, source))
        .collect::<Result<Vec<_>, _>>()?;
    let previous_archive_family = plan
        .expected_archive_family
        .iter()
        .map(|snapshot| snapshot.path.clone())
        .collect::<Vec<_>>();
    let mut journal = CleanupJournal {
        format_version: CLEANUP_JOURNAL_FORMAT_VERSION,
        stage,
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_identities: plan
            .expected_archive_family
            .iter()
            .map(|snapshot| {
                Some(identity_with_file_content(
                    snapshot.identity.clone(),
                    snapshot.len,
                    snapshot.sha256,
                ))
            })
            .collect(),
        previous_archive_family,
        next_archive_identities: vec![None; next_archive_family.len()],
        next_archive_family,
        extract_stage_identity: Some(stage_identity),
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    let json = encode_cleanup_journal(&mut journal)?;
    crate::settings_store::atomic_write_text(&journal_path, &json)
}

pub(crate) fn validate_extract_journal_update<'a>(
    journal: &CleanupJournal,
    plan: &'a CleanupPlan,
) -> Result<(&'a std::path::Path, &'a std::path::Path, &'a FileIdentity), String> {
    let (stage, destination) = plan
        .staged_extract
        .as_ref()
        .ok_or_else(|| "Cleanup plan has no extraction transaction.".to_string())?;
    let stage_identity = plan
        .stage_identity(stage)
        .ok_or_else(|| "Extraction plan has no creation-bound stage identity.".to_string())?;
    let Some(placement) = journal.extract_stage_placement else {
        return Err(
            "Extraction recovery journal is missing its recorded stage placement.".to_string(),
        );
    };
    let placement_matches = placement.matches_paths(stage, destination);
    if journal.archive
        || journal.stage != *stage
        || journal.destination != *destination
        || journal.extract_phase != Some(ExtractJournalPhase::InProgress)
        || !journal
            .extract_stage_identity
            .as_ref()
            .is_some_and(|recorded| file_identities_match(recorded, stage_identity))
        || !placement_matches
    {
        return Err("Extraction recovery journal changed during publication.".to_string());
    }
    // A sibling stage is renamed to the new destination before the commit
    // marker is written. During that short window the original stage path is
    // absent, but the destination carries the same creation-bound directory
    // identity. Validate whichever owned location still exists; never accept
    // a missing stage or an unrelated destination.
    let identity_path = match std::fs::symlink_metadata(stage) {
        Ok(_) => stage,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if journal.extract_stage_placement == Some(ExtractStagePlacement::Sibling) {
                destination
            } else {
                return Err(
                    "Extraction stage is missing before its commit marker was durable.".to_string(),
                );
            }
        }
        Err(error) => return Err(error.to_string()),
    };
    ensure_path_identity(identity_path, stage_identity)?;
    Ok((stage, destination, stage_identity))
}

fn record_extract_artifact_identity(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
    identity: &FileIdentity,
    move_plan: bool,
) -> Result<(), String> {
    if identity.fingerprint().is_none() {
        return Err("Refusing to record an extraction sidecar without a fingerprint.".to_string());
    }
    let path = cleanup_journal_path(app)?;
    let mut journal = read_cleanup_journal_at(&path)?
        .ok_or_else(|| "Extraction recovery journal disappeared during publication.".to_string())?;
    let (stage, _, stage_identity) = validate_extract_journal_update(&journal, plan)?;
    if move_plan {
        journal.move_plan_identity = Some(identity.clone());
    } else {
        journal.move_identity_log_identity = Some(identity.clone());
    }
    let json = encode_cleanup_journal(&mut journal)?;
    crate::settings_store::atomic_write_text(&path, &json)?;
    if let Some(cache_dir) = &plan.cache_dir {
        if move_plan {
            super::pending::record_pending_move_plan_identity(
                cache_dir,
                stage,
                stage_identity,
                identity,
            )?;
        } else {
            super::pending::record_pending_move_identity_log_identity(
                cache_dir,
                stage,
                stage_identity,
                identity,
            )?;
        }
    }
    Ok(())
}

pub(crate) fn record_extract_move_plan_identity(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
    identity: &FileIdentity,
) -> Result<(), String> {
    record_extract_artifact_identity(app, plan, identity, true)
}

pub(crate) fn record_extract_move_identity_log_identity(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
    identity: &FileIdentity,
) -> Result<(), String> {
    record_extract_artifact_identity(app, plan, identity, false)
}

pub(crate) fn mark_extract_journal_committed(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<(), String> {
    if plan.staged_extract.is_none() {
        return Ok(());
    }
    let path = cleanup_journal_path(app)?;
    let mut journal = read_cleanup_journal_at(&path)?
        .ok_or_else(|| "Extraction recovery journal disappeared before commit.".to_string())?;
    validate_extract_journal_update(&journal, plan)
        .map_err(|_| "Extraction recovery journal changed before commit.".to_string())?;
    match (
        journal.move_plan_identity.as_ref(),
        journal.move_identity_log_identity.as_ref(),
    ) {
        (None, None) => {}
        (Some(plan_identity), Some(log_identity))
            if plan_identity.fingerprint().is_some() && log_identity.fingerprint().is_some() => {}
        _ => {
            return Err(
                "Extraction recovery sidecar identities were not durably sealed before commit."
                    .to_string(),
            )
        }
    }
    journal.extract_phase = Some(ExtractJournalPhase::Committed);
    let json = encode_cleanup_journal(&mut journal)?;
    crate::settings_store::atomic_write_text(&path, &json)
}

pub(crate) fn record_archive_journal_backup(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
    original: &std::path::Path,
    identity: &FileIdentity,
) -> Result<(), String> {
    let Some((staged, destination)) = &plan.staged_archive else {
        return Ok(());
    };
    let expected_stage = staged
        .parent()
        .ok_or_else(|| "Archive staging directory is missing.".to_string())?;
    let expected_stage_identity = plan
        .stage_identity(expected_stage)
        .ok_or_else(|| "Archive plan has no creation-bound stage identity.".to_string())?;
    let path = cleanup_journal_path(app)?;
    let mut journal = read_cleanup_journal_at(&path)?
        .ok_or_else(|| "Archive recovery journal disappeared during publication.".to_string())?;
    if !journal.archive
        || journal.stage != expected_stage
        || journal.destination != *destination
        || journal.archive_phase != Some(ArchiveJournalPhase::InProgress)
        || !journal
            .extract_stage_identity
            .as_ref()
            .is_some_and(|recorded| file_identities_match(recorded, expected_stage_identity))
    {
        return Err("Archive recovery journal changed during backup.".to_string());
    }
    ensure_path_identity(expected_stage, expected_stage_identity)?;
    if journal.previous_archive_identities.len() != journal.previous_archive_family.len() {
        return Err("Archive recovery journal has invalid backup identity records.".to_string());
    }
    if identity.fingerprint().is_none() {
        return Err(format!(
            "Refusing to journal archive backup {} without a content fingerprint.",
            original.display()
        ));
    }
    let index = journal
        .previous_archive_family
        .iter()
        .position(|path| path == original)
        .ok_or_else(|| {
            "Existing archive volume is missing from its recovery journal.".to_string()
        })?;
    // The caller records once before rename and may correct the value from a
    // still-open handle afterward. Some FAT-family filesystems can change their
    // legacy file ID when a rename uses a longer directory entry.
    journal.previous_archive_identities[index] = Some(identity.clone());
    let json = encode_cleanup_journal(&mut journal)?;
    crate::settings_store::atomic_write_text(&path, &json)?;
    if let Some(cache_dir) = &plan.cache_dir {
        super::pending::record_pending_archive_backup_identity(
            cache_dir,
            expected_stage,
            expected_stage_identity,
            index,
            journal.previous_archive_family.len(),
            identity,
        )?;
    }
    Ok(())
}

pub(crate) fn record_archive_journal_published(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
    published: &std::path::Path,
    identity: &FileIdentity,
) -> Result<(), String> {
    let Some((staged, destination)) = &plan.staged_archive else {
        return Ok(());
    };
    let expected_stage = staged
        .parent()
        .ok_or_else(|| "Archive staging directory is missing.".to_string())?;
    let expected_stage_identity = plan
        .stage_identity(expected_stage)
        .ok_or_else(|| "Archive plan has no creation-bound stage identity.".to_string())?;
    let path = cleanup_journal_path(app)?;
    let mut journal = read_cleanup_journal_at(&path)?
        .ok_or_else(|| "Archive recovery journal disappeared during publication.".to_string())?;
    if !journal.archive
        || journal.stage != expected_stage
        || journal.destination != *destination
        || journal.archive_phase != Some(ArchiveJournalPhase::InProgress)
        || !journal
            .extract_stage_identity
            .as_ref()
            .is_some_and(|recorded| file_identities_match(recorded, expected_stage_identity))
    {
        return Err("Archive recovery journal changed during publish.".to_string());
    }
    ensure_path_identity(expected_stage, expected_stage_identity)?;
    if journal.next_archive_identities.len() != journal.next_archive_family.len() {
        return Err("Archive recovery journal has invalid identity records.".to_string());
    }
    let index = journal
        .next_archive_family
        .iter()
        .position(|path| path == published)
        .ok_or_else(|| "Published archive is missing from its recovery journal.".to_string())?;
    if let Some(existing) = &journal.next_archive_identities[index] {
        if existing != identity {
            journal.next_archive_identities[index] = Some(identity.clone());
        }
    } else {
        journal.next_archive_identities[index] = Some(identity.clone());
    }
    let json = encode_cleanup_journal(&mut journal)?;
    crate::settings_store::atomic_write_text(&path, &json)
}

pub(crate) fn mark_archive_journal_committed(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<(), String> {
    let Some((staged, destination)) = &plan.staged_archive else {
        return Ok(());
    };
    let expected_stage = staged
        .parent()
        .ok_or_else(|| "Archive staging directory is missing.".to_string())?;
    let expected_stage_identity = plan
        .stage_identity(expected_stage)
        .ok_or_else(|| "Archive plan has no creation-bound stage identity.".to_string())?;
    let path = cleanup_journal_path(app)?;
    let mut journal = read_cleanup_journal_at(&path)?
        .ok_or_else(|| "Archive recovery journal disappeared before commit.".to_string())?;
    if !journal.archive
        || journal.stage != expected_stage
        || journal.destination != *destination
        || journal.archive_phase != Some(ArchiveJournalPhase::InProgress)
        || journal.next_archive_family.is_empty()
        || !journal
            .extract_stage_identity
            .as_ref()
            .is_some_and(|recorded| file_identities_match(recorded, expected_stage_identity))
    {
        return Err("Archive recovery journal changed before commit.".to_string());
    }
    ensure_path_identity(expected_stage, expected_stage_identity)?;
    journal.archive_phase = Some(ArchiveJournalPhase::Committed);
    let json = encode_cleanup_journal(&mut journal)?;
    crate::settings_store::atomic_write_text(&path, &json)
}

/// Remove the active journal after its transaction completed or was recovered.
/// A journal from a newer format is refused, because removing it would discard
/// state this build cannot interpret. Unreadable or corrupt journals are still
/// removed, as before, since clearing is the conservative response to them.
pub(crate) fn clear_cleanup_journal_at(path: &std::path::Path) -> Result<(), String> {
    if let Ok(Some(journal)) = read_cleanup_journal_any_version_at(path) {
        ensure_journal_format_supported(&journal)?;
    }
    remove_cleanup_journal_file(path)
}

/// Remove a journal that acknowledgment has already accepted as-is. This is the
/// only removal path that may delete a newer-format journal.
pub(crate) fn clear_acknowledged_cleanup_journal_at(path: &std::path::Path) -> Result<(), String> {
    remove_cleanup_journal_file(path)
}

fn remove_cleanup_journal_file(path: &std::path::Path) -> Result<(), String> {
    crate::fs_secure::remove_regular_file_nofollow_if_exists(path)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(crate) fn clear_cleanup_journal(app: &tauri::AppHandle) -> Result<(), String> {
    clear_cleanup_journal_at(&cleanup_journal_path(app)?)
}
pub(crate) fn sync_directory(path: &std::path::Path) -> Result<(), String> {
    crate::fs_secure::sync_directory(path)
}
pub(crate) struct CleanupJournalGuard {
    app: tauri::AppHandle,
    active: bool,
}

impl CleanupJournalGuard {
    pub(crate) fn new(app: tauri::AppHandle, active: bool) -> Self {
        Self { app, active }
    }

    pub(crate) fn clear(&mut self) -> Result<(), String> {
        if self.active {
            clear_cleanup_journal(&self.app)?;
            self.active = false;
        }
        Ok(())
    }
}
