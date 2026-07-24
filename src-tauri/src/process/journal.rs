//! Cleanup journal I/O, pending-stages registry, and orphan stage cleanup.

use tauri::Manager;

use super::commit::{archive_destination_for, archive_family};
use super::staging::path_entry_exists;
use super::CleanupPlan;

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

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct CleanupJournal {
    pub(crate) stage: std::path::PathBuf,
    pub(crate) destination: std::path::PathBuf,
    pub(crate) archive: bool,
    /// Recorded extraction layout. Missing means a legacy sibling-stage journal.
    #[serde(default)]
    pub(crate) extract_stage_placement: Option<ExtractStagePlacement>,
    /// Newer extracts keep their move plan beside the stage. False means a
    /// legacy journal that may need the old in-payload recovery location.
    #[serde(default)]
    pub(crate) move_plan_sidecar: bool,
    pub(crate) previous_archive_family: Vec<std::path::PathBuf>,
    /// Stable identities for recovery backups, recorded immediately before each
    /// existing archive volume is moved aside and corrected from the open handle
    /// after rename when needed. Legacy journals deserialize as empty, but recovery
    /// refuses to restore or remove any present backup it cannot identify.
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
    /// Identity of an extraction stage captured before 7-Zip starts. This lets
    /// recovery recognize a sibling stage that was renamed into a brand-new
    /// destination immediately before a crash. Missing remains compatible with
    /// older journals and filesystems that do not expose stable identities.
    #[serde(default)]
    pub(crate) extract_stage_identity: Option<FileIdentity>,
    /// Explicit phase for extraction transactions. Missing means a legacy
    /// journal whose stage/move-plan state must be interpreted conservatively.
    #[serde(default)]
    pub(crate) extract_phase: Option<ExtractJournalPhase>,
    /// Explicit phase for B16+ archive transactions. `None` identifies a
    /// legacy journal whose completion must be inferred for compatibility.
    #[serde(default)]
    pub(crate) archive_phase: Option<ArchiveJournalPhase>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "platform", rename_all = "snake_case")]
pub(crate) enum FileIdentity {
    Unix {
        device: u64,
        inode: u64,
    },
    Windows {
        /// Legacy 32-bit volume serial retained for journals written by older betas
        /// and for filesystems that do not expose `FileIdInfo`.
        volume_serial_number: u32,
        /// Legacy 64-bit file index. Microsoft does not guarantee this identifier
        /// is unique on ReFS, so new journals also record the 128-bit ID when the
        /// filesystem or SMB server supports it.
        file_index: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume_serial_number_64: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id_128: Option<[u8; 16]>,
    },
}

/// Compare identities using the strongest representation captured in the
/// journal. New Windows records require the 128-bit ID when it was available;
/// older records remain compatible through the legacy volume/index pair.
pub(crate) fn file_identities_match(actual: &FileIdentity, expected: &FileIdentity) -> bool {
    match (actual, expected) {
        (
            FileIdentity::Unix {
                device: actual_device,
                inode: actual_inode,
            },
            FileIdentity::Unix {
                device: expected_device,
                inode: expected_inode,
            },
        ) => actual_device == expected_device && actual_inode == expected_inode,
        (
            FileIdentity::Windows {
                volume_serial_number: actual_volume,
                file_index: actual_index,
                volume_serial_number_64: actual_volume_64,
                file_id_128: actual_id_128,
            },
            FileIdentity::Windows {
                volume_serial_number: expected_volume,
                file_index: expected_index,
                volume_serial_number_64: expected_volume_64,
                file_id_128: expected_id_128,
            },
        ) => match (expected_volume_64, expected_id_128) {
            (Some(expected_volume_64), Some(expected_id_128)) => {
                actual_volume_64 == &Some(*expected_volume_64)
                    && actual_id_128 == &Some(*expected_id_128)
            }
            (None, None) => actual_volume == expected_volume && actual_index == expected_index,
            _ => false,
        },
        _ => false,
    }
}

pub(crate) fn path_identity(path: &std::path::Path) -> Result<FileIdentity, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata)
        || (!metadata.is_file() && !metadata.is_dir())
    {
        return Err(format!(
            "Expected a regular file or directory: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        Ok(FileIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let mut options = std::fs::OpenOptions::new();
        options
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            // BACKUP_SEMANTICS is harmless for files and required for directories.
            // OPEN_REPARSE_POINT plus the handle-attribute check closes the final
            // component race between symlink_metadata and open.
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options.open(path).map_err(|error| error.to_string())?;
        file_identity(&file)
    }
}

pub(crate) fn file_identity(file: &std::fs::File) -> Result<FileIdentity, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        Ok(FileIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, GetFileInformationByHandleEx, FileIdInfo,
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO,
        };
        let handle = file.as_raw_handle() as HANDLE;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let success = unsafe { GetFileInformationByHandle(handle, &mut info) };
        if success == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Refusing a file identity for a link or reparse point.".to_string());
        }
        let mut extended: FILE_ID_INFO = unsafe { std::mem::zeroed() };
        let has_extended_id = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                (&mut extended as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } != 0;
        Ok(FileIdentity::Windows {
            volume_serial_number: info.dwVolumeSerialNumber,
            file_index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            volume_serial_number_64: has_extended_id.then_some(extended.VolumeSerialNumber),
            file_id_128: has_extended_id.then_some(extended.FileId.Identifier),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err("Stable file identities are unavailable on this platform.".to_string())
    }
}

pub(crate) fn regular_file_identity(path: &std::path::Path) -> Result<FileIdentity, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(format!("Expected a regular file: {}", path.display()));
    }
    path_identity(path)
}

pub(crate) fn ensure_path_identity(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    let actual = path_identity(path)?;
    if file_identities_match(&actual, expected) {
        Ok(())
    } else {
        Err(format!(
            "Refusing to remove or replace {} because its file identity changed.",
            path.display()
        ))
    }
}

pub(crate) fn ensure_regular_file_identity(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    let actual = regular_file_identity(path)?;
    if file_identities_match(&actual, expected) {
        Ok(())
    } else {
        Err(format!(
            "Refusing to remove or replace {} because its file identity changed.",
            path.display()
        ))
    }
}

pub(crate) fn remove_regular_file_if_matches(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    ensure_regular_file_identity(path, expected)?;
    crate::fs_secure::remove_file_for_cleanup(path).map_err(|error| error.to_string())
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

/// Legacy in-payload location, retained only to recover transactions created
/// by older betas. New plans are always stored beside the stage.
pub(crate) const LEGACY_MOVE_PLAN_FILE_NAME: &str = "move-plan.json";

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

pub(crate) fn remove_move_plan_sidecars(stage: &std::path::Path) -> Result<(), String> {
    let mut removed = false;
    for path in [move_plan_path(stage), move_identity_log_path(stage)] {
        match std::fs::remove_file(&path) {
            Ok(()) => removed = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    if removed {
        if let Some(parent) = stage.parent() {
            sync_directory(parent)?;
        }
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

pub(crate) fn write_cleanup_journal(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<bool, String> {
    let journal = if let Some((stage, destination)) = &plan.staged_extract {
        Some(CleanupJournal {
            stage: stage.clone(),
            destination: destination.clone(),
            archive: false,
            extract_stage_placement: Some(ExtractStagePlacement::from_paths(stage, destination)?),
            move_plan_sidecar: true,
            previous_archive_family: Vec::new(),
            previous_archive_identities: Vec::new(),
            next_archive_family: Vec::new(),
            next_archive_identities: Vec::new(),
            extract_stage_identity: match path_identity(stage) {
                Ok(identity) => Some(identity),
                Err(error) => {
                    eprintln!(
                        "Could not record extraction stage identity for {}: {error}. Crash recovery will remain conservative if the stage disappears before commit.",
                        stage.display()
                    );
                    None
                }
            },
            extract_phase: Some(ExtractJournalPhase::InProgress),
            archive_phase: None,
        })
    } else if let Some((staged_archive, destination)) = &plan.staged_archive {
        let previous_archive_family = archive_family(destination)?;
        let previous_archive_identities = vec![None; previous_archive_family.len()];
        Some(CleanupJournal {
            stage: staged_archive
                .parent()
                .ok_or_else(|| "Archive staging directory is missing.".to_string())?
                .to_path_buf(),
            destination: destination.clone(),
            archive: true,
            extract_stage_placement: None,
            move_plan_sidecar: false,
            previous_archive_family,
            previous_archive_identities,
            next_archive_family: Vec::new(),
            next_archive_identities: Vec::new(),
            extract_stage_identity: None,
            extract_phase: None,
            archive_phase: Some(ArchiveJournalPhase::InProgress),
        })
    } else {
        None
    };
    let Some(journal) = journal else {
        return Ok(false);
    };
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&cleanup_journal_path(app)?, &json)?;
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
    let next_archive_family = archive_family(staged)?
        .iter()
        .map(|source| archive_destination_for(staged, destination, source))
        .collect::<Result<Vec<_>, _>>()?;
    let previous_archive_family = archive_family(destination)?;
    let journal = CleanupJournal {
        stage,
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_identities: vec![None; previous_archive_family.len()],
        previous_archive_family,
        next_archive_identities: vec![None; next_archive_family.len()],
        next_archive_family,
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&cleanup_journal_path(app)?, &json)
}

pub(crate) fn mark_extract_journal_committed(
    app: &tauri::AppHandle,
    plan: &CleanupPlan,
) -> Result<(), String> {
    let Some((stage, destination)) = &plan.staged_extract else {
        return Ok(());
    };
    let path = cleanup_journal_path(app)?;
    let json = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut journal: CleanupJournal =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if journal.archive
        || journal.stage != *stage
        || journal.destination != *destination
        || journal.extract_phase != Some(ExtractJournalPhase::InProgress)
        || !journal
            .extract_stage_placement
            .map(|placement| placement.matches_paths(stage, destination))
            .unwrap_or_else(|| stage.parent() == destination.parent())
    {
        return Err("Extraction recovery journal changed before commit.".to_string());
    }
    journal.extract_phase = Some(ExtractJournalPhase::Committed);
    let json = serde_json::to_string(&journal).map_err(|error| error.to_string())?;
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
    let path = cleanup_journal_path(app)?;
    let json = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut journal: CleanupJournal =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if !journal.archive
        || journal.stage != expected_stage
        || journal.destination != *destination
        || journal.archive_phase != Some(ArchiveJournalPhase::InProgress)
    {
        return Err("Archive recovery journal changed during backup.".to_string());
    }
    if journal.previous_archive_identities.len() != journal.previous_archive_family.len() {
        return Err("Archive recovery journal has invalid backup identity records.".to_string());
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
    let json = serde_json::to_string(&journal).map_err(|error| error.to_string())?;
    crate::settings_store::atomic_write_text(&path, &json)
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
    let path = cleanup_journal_path(app)?;
    let json = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut journal: CleanupJournal =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if !journal.archive
        || journal.stage != expected_stage
        || journal.destination != *destination
        || journal.archive_phase != Some(ArchiveJournalPhase::InProgress)
    {
        return Err("Archive recovery journal changed during publish.".to_string());
    }
    if journal.next_archive_identities.len() != journal.next_archive_family.len() {
        return Err("Archive recovery journal has invalid identity records.".to_string());
    }
    let index = journal
        .next_archive_family
        .iter()
        .position(|path| path == published)
        .ok_or_else(|| "Published archive is missing from its recovery journal.".to_string())?;
    if let Some(existing) = &journal.next_archive_identities[index] {
        if !file_identities_match(existing, identity) {
            journal.next_archive_identities[index] = Some(identity.clone());
        }
    } else {
        journal.next_archive_identities[index] = Some(identity.clone());
    }
    let json = serde_json::to_string(&journal).map_err(|error| error.to_string())?;
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
    let path = cleanup_journal_path(app)?;
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut journal: CleanupJournal = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if !journal.archive
        || journal.stage != expected_stage
        || journal.destination != *destination
        || journal.next_archive_family.is_empty()
    {
        return Err("Archive recovery journal changed before commit.".to_string());
    }
    journal.archive_phase = Some(ArchiveJournalPhase::Committed);
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&path, &json)
}

pub(crate) fn clear_cleanup_journal(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cleanup_journal_path(app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => crate::settings_store::sync_parent_directory(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn pending_stages_path(cache_dir: &std::path::Path) -> std::path::PathBuf {
    cache_dir.join("pending-stages.json")
}

pub(crate) fn read_pending_stages(cache_dir: &std::path::Path) -> Result<Vec<String>, String> {
    let path = pending_stages_path(cache_dir);
    match std::fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn write_pending_stages(
    cache_dir: &std::path::Path,
    stages: &[String],
) -> Result<(), String> {
    let path = pending_stages_path(cache_dir);
    if stages.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => crate::settings_store::sync_parent_directory(&path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    } else {
        let json = serde_json::to_string(stages).map_err(|e| e.to_string())?;
        crate::settings_store::atomic_write_text(&path, &json)
    }
}

pub(crate) fn register_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
) -> Result<(), String> {
    let key = stage.to_string_lossy().to_string();
    let mut stages = read_pending_stages(cache_dir)?;
    if !stages.iter().any(|existing| existing == &key) {
        stages.push(key);
        write_pending_stages(cache_dir, &stages)?;
    }
    Ok(())
}

pub(crate) fn unregister_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
) -> Result<(), String> {
    let key = stage.to_string_lossy().to_string();
    let mut stages = read_pending_stages(cache_dir)?;
    let before = stages.len();
    stages.retain(|existing| existing != &key);
    if stages.len() != before {
        write_pending_stages(cache_dir, &stages)?;
    }
    Ok(())
}

pub(crate) fn plan_stage_dirs(plan: &CleanupPlan) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some((staged, _)) = &plan.staged_extract {
        dirs.push(staged.clone());
    }
    if let Some((staged, _)) = &plan.staged_archive {
        if let Some(parent) = staged.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    if let Some(staged) = &plan.staged_input_archive {
        if let Some(parent) = staged.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    dirs
}

pub(crate) fn unregister_plan_stages(plan: &CleanupPlan) {
    let Some(cache_dir) = &plan.cache_dir else {
        return;
    };
    for stage in plan_stage_dirs(plan) {
        // After successful publish, promote may leave the stage (undeletable
        // backup-* / PermissionDenied). Keep the pending registration so
        // cleanup_orphan_stages can retry on the next launch; never drop
        // tracking while the directory may still exist.
        match path_entry_exists(&stage) {
            Ok(false) => {
                let _ = unregister_pending_stage(cache_dir, &stage);
            }
            Ok(true) => {
                eprintln!(
                    "Keeping pending-stage registration for {}; startup orphan cleanup will retry.",
                    stage.display()
                );
            }
            Err(error) => {
                eprintln!(
                    "Keeping pending-stage registration for {} (could not probe: {error}).",
                    stage.display()
                );
            }
        }
    }
}

fn cleanup_archive_backup_sidecars(stage: &std::path::Path) -> Result<(), String> {
    let Some(stage_name) = stage.file_name().and_then(|name| name.to_str()) else {
        return Err("Archive stage has an invalid name.".to_string());
    };
    if !stage_name.contains(".zinnia-archive-") {
        return Ok(());
    }
    let Some(parent) = stage.parent() else {
        return Err("Archive stage has no parent directory.".to_string());
    };
    let prefix = format!("{stage_name}.backup-");
    for entry in std::fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(index) = name.strip_prefix(&prefix) else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
            return Err(format!(
                "Refusing unexpected archive backup sidecar {}.",
                path.display()
            ));
        }
        crate::fs_secure::remove_file_for_cleanup(&path).map_err(|e| e.to_string())?;
    }
    sync_directory(parent)
}

/// Remove stage directories left behind when a crash happened after create but
/// before (or without) a durable transaction journal. Safe names only.
pub fn cleanup_orphan_stages(app: &tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let stages = read_pending_stages(&cache_dir)?;
    if stages.is_empty() {
        return Ok(());
    }
    let mut remaining = Vec::new();
    for stage in stages {
        let path = std::path::PathBuf::from(&stage);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !is_safe_stage_dir_name(name) {
            remaining.push(stage);
            continue;
        }
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if remove_move_plan_sidecars(&path).is_err()
                    || cleanup_archive_backup_sidecars(&path).is_err()
                {
                    remaining.push(stage);
                }
            }
            Err(_) => {
                remaining.push(stage);
            }
            Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() => {
                remaining.push(stage);
            }
            Ok(_) => {
                // Clear recovery sidecars before deleting their source stage. If
                // sidecar cleanup fails, retaining the stage keeps the next pass
                // in a fully recoverable state instead of leaving a stale plan
                // that refers to a missing source tree.
                if let Err(error) = remove_move_plan_sidecars(&path) {
                    eprintln!(
                        "Failed to remove move-plan sidecars for {}: {error}",
                        path.display()
                    );
                    remaining.push(stage);
                    continue;
                }
                if let Err(error) = crate::fs_secure::remove_dir_all_for_cleanup(&path) {
                    eprintln!(
                        "Failed to remove orphan staging directory {}: {error}",
                        path.display()
                    );
                    remaining.push(stage);
                    continue;
                }
                if let Err(error) = cleanup_archive_backup_sidecars(&path) {
                    eprintln!(
                        "Failed to remove archive backup sidecars for {}: {error}",
                        path.display()
                    );
                    remaining.push(stage);
                    continue;
                }
                if let Some(parent) = path.parent() {
                    let _ = sync_directory(parent);
                }
            }
        }
    }
    write_pending_stages(&cache_dir, &remaining)
}

pub(crate) fn sync_directory(path: &std::path::Path) -> Result<(), String> {
    crate::fs_secure::sync_directory(path)
}

pub(crate) fn is_safe_stage_dir_name(name: &str) -> bool {
    for prefix in [".zinnia-extract-", ".zinnia-archive-", ".zinnia-input-"] {
        if let Some(token) = name.strip_prefix(prefix) {
            return token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit());
        }
    }
    // Accept pre-B16 stage names for safe startup recovery.
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    for marker in [".zinnia-extract-", ".zinnia-archive-", ".zinnia-input-"] {
        if let Some(idx) = rest.rfind(marker) {
            let token = &rest[idx + marker.len()..];
            return token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit());
        }
    }
    false
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
