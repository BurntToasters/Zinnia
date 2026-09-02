//! Cleanup journal I/O, pending-stages registry, and orphan stage cleanup.

use tauri::Manager;

use super::commit::{archive_backup_path, archive_destination_for, archive_family};
use super::CleanupPlan;

pub(crate) const MAX_RECOVERY_JOURNAL_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_PENDING_STAGES_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_MOVE_PLAN_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_MOVE_IDENTITY_LOG_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_MOVE_IDENTITY_RECORD_BYTES: usize = 64 * 1024;

/// Read a security-sensitive recovery file through one no-follow handle and a
/// hard byte cap. The preliminary metadata query only distinguishes absence;
/// the opened handle (not that path metadata) is authoritative for type/size.
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
    /// Creation-bound identity of the transaction stage captured before 7-Zip
    /// starts. The serialized field name is retained for compatibility with
    /// extraction journals written by earlier betas. New extraction and archive
    /// journals both require this immutable ownership evidence before destructive
    /// stage recovery. Missing remains deserializable only so legacy journals can
    /// fail closed.
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
        /// Strong snapshot of published contents. Missing identifies a legacy
        /// journal and is never sufficient for destructive crash recovery.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fingerprint: Option<ObjectFingerprint>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fingerprint: Option<ObjectFingerprint>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ObjectFingerprint {
    File { len: u64, sha256: [u8; 32] },
    Directory { sha256: [u8; 32] },
    Symlink { sha256: [u8; 32] },
}

impl FileIdentity {
    pub(crate) fn fingerprint(&self) -> Option<&ObjectFingerprint> {
        match self {
            Self::Unix { fingerprint, .. } | Self::Windows { fingerprint, .. } => {
                fingerprint.as_ref()
            }
        }
    }

    fn set_fingerprint(&mut self, value: ObjectFingerprint) {
        match self {
            Self::Unix { fingerprint, .. } | Self::Windows { fingerprint, .. } => {
                *fingerprint = Some(value);
            }
        }
    }
}

pub(crate) fn identity_with_fingerprint_from(
    mut identity: FileIdentity,
    expected: &FileIdentity,
) -> Result<FileIdentity, String> {
    let fingerprint = expected
        .fingerprint()
        .cloned()
        .ok_or_else(|| "Expected content fingerprint is missing.".to_string())?;
    identity.set_fingerprint(fingerprint);
    Ok(identity)
}

/// Attach a regular-file content fingerprint to an inode/file-id identity.
/// Used for archive destination backups so crash recovery can reject same-inode
/// rewrites that would otherwise restore attacker/corrupt bytes.
pub(crate) fn identity_with_file_content(
    mut identity: FileIdentity,
    len: u64,
    sha256: [u8; 32],
) -> FileIdentity {
    identity.set_fingerprint(ObjectFingerprint::File { len, sha256 });
    identity
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
                ..
            },
            FileIdentity::Unix {
                device: expected_device,
                inode: expected_inode,
                ..
            },
        ) => actual_device == expected_device && actual_inode == expected_inode,
        (
            FileIdentity::Windows {
                volume_serial_number: actual_volume,
                file_index: actual_index,
                volume_serial_number_64: actual_volume_64,
                file_id_128: actual_id_128,
                ..
            },
            FileIdentity::Windows {
                volume_serial_number: expected_volume,
                file_index: expected_index,
                volume_serial_number_64: expected_volume_64,
                file_id_128: expected_id_128,
                ..
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
            fingerprint: None,
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

/// Identity of one directory entry without following its final symlink.
/// Unix and Windows extraction may publish symbolic links, so recovery must
/// distinguish the exact link entry from a replacement before moving it back.
/// Non-symlink Windows reparse points (junctions, cloud placeholders) stay
/// rejected.
pub(crate) fn path_entry_identity(path: &std::path::Path) -> Result<FileIdentity, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !metadata.is_file() && !metadata.is_dir() && !metadata.file_type().is_symlink() {
            return Err(format!(
                "Expected a regular file, directory, or symbolic link: {}",
                path.display()
            ));
        }
        Ok(FileIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
            fingerprint: None,
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        let is_symlink = metadata.file_type().is_symlink();
        if !metadata.is_file() && !metadata.is_dir() && !is_symlink {
            return Err(format!(
                "Expected a regular file, directory, or symbolic link: {}",
                path.display()
            ));
        }
        if crate::path_safety::is_link_or_reparse(&metadata) && !is_symlink {
            return Err(format!(
                "Refusing a file identity for a non-symlink reparse point: {}",
                path.display()
            ));
        }
        let mut options = std::fs::OpenOptions::new();
        options
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            // OPEN_REPARSE_POINT keeps the symlink entry itself addressable so
            // merge publish / rollback can fingerprint and rename it.
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options.open(path).map_err(|error| error.to_string())?;
        file_identity_for_entry(&file, is_symlink)
    }
    #[cfg(not(any(unix, windows)))]
    {
        path_identity(path)
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
            fingerprint: None,
        })
    }
    #[cfg(windows)]
    {
        file_identity_for_entry(file, false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err("Stable file identities are unavailable on this platform.".to_string())
    }
}

/// Fingerprint a regular file through an already-held no-follow handle. The
/// caller retains the handle across creation, writes, and this verification so
/// a same-name replacement can never acquire the returned authority.
pub(crate) fn held_regular_file_identity_with_fingerprint(
    file: &mut std::fs::File,
) -> Result<FileIdentity, String> {
    use sha2::Digest as _;
    use std::io::{Read as _, Seek as _};

    let identity = file_identity(file)?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    let modified = before.modified().ok();
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let after_identity = file_identity(file)?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    if !file_identities_match(&after_identity, &identity)
        || before.len() != after.len()
        || modified != after.modified().ok()
    {
        return Err("Held recovery file changed while it was fingerprinted.".to_string());
    }
    Ok(identity_with_file_content(
        identity,
        before.len(),
        hasher.finalize().into(),
    ))
}

/// Read a recovery sidecar from the exact no-follow file whose durable identity
/// was recorded. Fingerprints are mandatory because a stable inode/file ID does
/// not detect an in-place rewrite.
pub(crate) fn read_bounded_nofollow_bytes_if_matches(
    path: &std::path::Path,
    max_bytes: u64,
    expected: &FileIdentity,
) -> Result<Option<Vec<u8>>, String> {
    use sha2::Digest as _;
    use std::io::Read as _;

    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let expected_fingerprint = expected.fingerprint().ok_or_else(|| {
        format!(
            "Refusing to read recovery sidecar {} without a recorded content fingerprint.",
            path.display()
        )
    })?;
    let ObjectFingerprint::File {
        len: expected_len,
        sha256: expected_sha256,
    } = expected_fingerprint
    else {
        return Err(format!(
            "Recovery sidecar has a non-file fingerprint: {}",
            path.display()
        ));
    };
    let mut file = crate::path_safety::open_regular_file_nofollow(path)?;
    let before_identity = file_identity(&file)?;
    if !file_identities_match(&before_identity, expected) {
        return Err(format!(
            "Recovery sidecar identity changed and was preserved: {}",
            path.display()
        ));
    }
    let before = file.metadata().map_err(|error| error.to_string())?;
    if before.len() > max_bytes || before.len() != *expected_len {
        return Err(format!(
            "Recovery sidecar length changed or exceeds its {max_bytes}-byte safety limit: {}",
            path.display()
        ));
    }
    let modified = before.modified().ok();
    let mut bytes = Vec::with_capacity(usize::try_from(before.len()).unwrap_or(usize::MAX));
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after_identity = file_identity(&file)?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    if bytes.len() as u64 != *expected_len
        || bytes.len() as u64 > max_bytes
        || !file_identities_match(&after_identity, expected)
        || before.len() != after.len()
        || modified != after.modified().ok()
        || sha2::Sha256::digest(&bytes).as_slice() != expected_sha256
    {
        return Err(format!(
            "Recovery sidecar changed in place and was preserved: {}",
            path.display()
        ));
    }
    let final_identity = path_identity(path)?;
    if !file_identities_match(&final_identity, expected) {
        return Err(format!(
            "Recovery sidecar final name was replaced and was preserved: {}",
            path.display()
        ));
    }
    Ok(Some(bytes))
}

#[cfg(windows)]
fn file_identity_for_entry(
    file: &std::fs::File,
    allow_symlink_reparse: bool,
) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO,
    };
    let handle = file.as_raw_handle() as HANDLE;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let success = unsafe { GetFileInformationByHandle(handle, &mut info) };
    if success == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && !allow_symlink_reparse {
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
        fingerprint: None,
    })
}

fn os_value_bytes(value: &std::ffi::OsStr) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt as _;
        value.as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt as _;
        value
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    }
    #[cfg(not(any(unix, windows)))]
    {
        value.to_string_lossy().as_bytes().to_vec()
    }
}

fn hash_regular_file(path: &std::path::Path) -> Result<ObjectFingerprint, String> {
    use sha2::Digest as _;
    use std::io::Read as _;

    let mut file = crate::path_safety::open_regular_file_nofollow(path)?;
    let identity = file_identity(&file)?;
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
    let after_identity = file_identity(&file)?;
    let after_metadata = file.metadata().map_err(|error| error.to_string())?;
    if !file_identities_match(&identity, &after_identity)
        || len != after_metadata.len()
        || modified != after_metadata.modified().ok()
    {
        return Err(format!(
            "Path changed while it was being fingerprinted: {}",
            path.display()
        ));
    }
    Ok(ObjectFingerprint::File {
        len,
        sha256: hasher.finalize().into(),
    })
}

fn path_fingerprint(path: &std::path::Path) -> Result<ObjectFingerprint, String> {
    use sha2::Digest as _;

    let root_metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if root_metadata.is_file() && !crate::path_safety::is_link_or_reparse(&root_metadata) {
        return hash_regular_file(path);
    }
    if root_metadata.file_type().is_symlink() {
        let target = std::fs::read_link(path).map_err(|error| error.to_string())?;
        return Ok(ObjectFingerprint::Symlink {
            sha256: sha2::Sha256::digest(os_value_bytes(target.as_os_str())).into(),
        });
    }
    if !root_metadata.is_dir() || crate::path_safety::is_link_or_reparse(&root_metadata) {
        return Err(format!(
            "Expected a regular file, directory, or symbolic link: {}",
            path.display()
        ));
    }

    let mut pending = vec![path.to_path_buf()];
    let mut records = Vec::<(Vec<u8>, ObjectFingerprint)>::new();
    let mut observed = Vec::<(
        std::path::PathBuf,
        FileIdentity,
        u64,
        Option<std::time::SystemTime>,
    )>::new();
    while let Some(directory) = pending.pop() {
        let mut entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("Could not fingerprint {}: {error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| os_value_bytes(entry.file_name().as_os_str()));
        for entry in entries {
            let entry_path = entry.path();
            let relative = entry_path
                .strip_prefix(path)
                .map_err(|error| error.to_string())?;
            let relative_bytes = os_value_bytes(relative.as_os_str());
            let metadata =
                std::fs::symlink_metadata(&entry_path).map_err(|error| error.to_string())?;
            let identity = path_entry_identity(&entry_path)?;
            let len = metadata.len();
            let modified = metadata.modified().ok();
            let fingerprint = if metadata.file_type().is_symlink() {
                let target = std::fs::read_link(&entry_path).map_err(|error| error.to_string())?;
                ObjectFingerprint::Symlink {
                    sha256: sha2::Sha256::digest(os_value_bytes(target.as_os_str())).into(),
                }
            } else if metadata.is_file() && !crate::path_safety::is_link_or_reparse(&metadata) {
                hash_regular_file(&entry_path)?
            } else if metadata.is_dir() && !crate::path_safety::is_link_or_reparse(&metadata) {
                pending.push(entry_path.clone());
                ObjectFingerprint::Directory { sha256: [0; 32] }
            } else {
                return Err(format!(
                    "Unsupported entry while fingerprinting {}.",
                    entry_path.display()
                ));
            };
            observed.push((entry_path, identity, len, modified));
            records.push((relative_bytes, fingerprint));
        }
    }

    // Catch ordinary concurrent edits that happened after an entry was hashed.
    for (entry_path, identity, len, modified) in observed {
        let metadata = std::fs::symlink_metadata(&entry_path).map_err(|error| error.to_string())?;
        let actual_identity = path_entry_identity(&entry_path)?;
        if !file_identities_match(&actual_identity, &identity)
            || metadata.len() != len
            || metadata.modified().ok() != modified
        {
            return Err(format!(
                "Path changed while it was being fingerprinted: {}",
                entry_path.display()
            ));
        }
    }

    records.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = sha2::Sha256::new();
    for (relative, fingerprint) in records {
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative);
        match fingerprint {
            ObjectFingerprint::File { len, sha256 } => {
                hasher.update(*b"f");
                hasher.update(len.to_le_bytes());
                hasher.update(sha256);
            }
            ObjectFingerprint::Directory { .. } => hasher.update(*b"d"),
            ObjectFingerprint::Symlink { sha256 } => {
                hasher.update(*b"l");
                hasher.update(sha256);
            }
        }
    }
    Ok(ObjectFingerprint::Directory {
        sha256: hasher.finalize().into(),
    })
}

pub(crate) fn path_identity_with_fingerprint(
    path: &std::path::Path,
) -> Result<FileIdentity, String> {
    let mut identity = path_entry_identity(path)?;
    let fingerprint = path_fingerprint(path)?;
    let after_identity = path_entry_identity(path)?;
    if !file_identities_match(&after_identity, &identity) {
        return Err(format!(
            "Path changed while it was being fingerprinted: {}",
            path.display()
        ));
    }
    identity.set_fingerprint(fingerprint);
    Ok(identity)
}

pub(crate) fn regular_file_identity_with_fingerprint(
    path: &std::path::Path,
) -> Result<FileIdentity, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(format!("Expected a regular file: {}", path.display()));
    }
    path_identity_with_fingerprint(path)
}

pub(crate) fn ensure_recovery_path_unchanged(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    let Some(expected_fingerprint) = expected.fingerprint() else {
        return Err(format!(
            "Refusing destructive recovery of {} because its content fingerprint was not recorded.",
            path.display()
        ));
    };
    let actual = path_identity_with_fingerprint(path)?;
    if !file_identities_match(&actual, expected)
        || actual.fingerprint() != Some(expected_fingerprint)
    {
        return Err(format!(
            "Recovery target changed after publication and was preserved: {}",
            path.display()
        ));
    }
    Ok(())
}

/// Crash-recovery retract of a published object. Fingerprinted identities
/// still require an unchanged content hash. Copy-fallback journals the inode
/// before bytes are copied, so an unfingerprinted identity may be deleted
/// only when the inode still matches.
pub(crate) fn ensure_retract_path_matches(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    if expected.fingerprint().is_some() {
        ensure_recovery_path_unchanged(path, expected)
    } else {
        ensure_path_entry_identity(path, expected)
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

pub(crate) fn ensure_path_entry_identity(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    let actual = path_entry_identity(path)?;
    if file_identities_match(&actual, expected) {
        Ok(())
    } else {
        Err(format!(
            "Refusing to move {} because its entry identity changed.",
            path.display()
        ))
    }
}

fn quarantined_regular_file_matches(
    file: &mut std::fs::File,
    expected: &FileIdentity,
) -> Result<bool, String> {
    use sha2::Digest as _;
    use std::io::{Read as _, Seek as _};

    let before_identity = file_identity(file)?;
    if !file_identities_match(&before_identity, expected) {
        return Ok(false);
    }
    let Some(expected_fingerprint) = expected.fingerprint() else {
        return Ok(true);
    };
    let ObjectFingerprint::File {
        len: expected_len,
        sha256: expected_sha256,
    } = expected_fingerprint
    else {
        return Ok(false);
    };
    let before = file.metadata().map_err(|error| error.to_string())?;
    if before.len() != *expected_len {
        return Ok(false);
    }
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let after_identity = file_identity(file)?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    Ok(file_identities_match(&before_identity, &after_identity)
        && before.len() == after.len()
        && before.modified().ok() == after.modified().ok()
        && hasher.finalize().as_slice() == expected_sha256)
}

pub(crate) fn remove_regular_file_if_matches(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    let removed = crate::fs_secure::quarantine_regular_file_if(path, |file| {
        quarantined_regular_file_matches(file, expected).map_err(std::io::Error::other)
    })
    .map_err(|error| error.to_string())?;
    if removed {
        Ok(())
    } else {
        Err(format!("Cleanup file disappeared: {}", path.display()))
    }
}

pub(crate) fn remove_recovery_regular_file_if_matches(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    remove_regular_file_if_matches(path, expected)
}

pub(crate) fn remove_directory_if_matches(
    path: &std::path::Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    let removed = crate::fs_secure::quarantine_directory_if(path, |directory| {
        file_identity(directory)
            .map(|actual| file_identities_match(&actual, expected))
            .map_err(std::io::Error::other)
    })
    .map_err(|error| error.to_string())?;
    if removed {
        Ok(())
    } else {
        Err(format!(
            "Cleanup directory disappeared or changed identity and was preserved: {}",
            path.display()
        ))
    }
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
            move_plan_identity.expect("validated move-plan identity"),
        )?;
    }
    if present.move_identity_log_present {
        remove_recovery_regular_file_if_matches(
            &move_identity_log_path(stage),
            move_identity_log_identity.expect("validated identity-log identity"),
        )?;
    }
    for (index, is_present) in present.archive_backups_present.iter().enumerate() {
        if *is_present {
            remove_recovery_regular_file_if_matches(
                &archive_backup_path(stage, index),
                archive_backup_identities[index]
                    .as_ref()
                    .expect("validated archive backup identity"),
            )?;
        }
    }
    if present.stage_present {
        remove_directory_if_matches(
            stage,
            stage_identity.expect("validated transaction stage identity"),
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

pub(crate) fn read_cleanup_journal_at(
    path: &std::path::Path,
) -> Result<Option<CleanupJournal>, String> {
    let Some(json) = read_bounded_nofollow_text(path, MAX_RECOVERY_JOURNAL_BYTES)? else {
        return Ok(None);
    };
    serde_json::from_str(&json)
        .map(Some)
        .map_err(|error| format!("Could not parse recovery journal: {error}"))
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
    let journal = CleanupJournal {
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
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&journal_path, &json)
}

fn validate_extract_journal_update<'a>(
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
    if journal.archive
        || journal.stage != *stage
        || journal.destination != *destination
        || journal.extract_phase != Some(ExtractJournalPhase::InProgress)
        || !journal
            .extract_stage_identity
            .as_ref()
            .is_some_and(|recorded| file_identities_match(recorded, stage_identity))
        || !journal
            .extract_stage_placement
            .map(|placement| placement.matches_paths(stage, destination))
            .unwrap_or_else(|| stage.parent() == destination.parent())
    {
        return Err("Extraction recovery journal changed during publication.".to_string());
    }
    ensure_path_identity(stage, stage_identity)?;
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
    let json = serde_json::to_string(&journal).map_err(|error| error.to_string())?;
    crate::settings_store::atomic_write_text(&path, &json)?;
    if let Some(cache_dir) = &plan.cache_dir {
        if move_plan {
            record_pending_move_plan_identity(cache_dir, stage, stage_identity, identity)?;
        } else {
            record_pending_move_identity_log_identity(cache_dir, stage, stage_identity, identity)?;
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
    let json = serde_json::to_string(&journal).map_err(|error| error.to_string())?;
    crate::settings_store::atomic_write_text(&path, &json)?;
    if let Some(cache_dir) = &plan.cache_dir {
        record_pending_archive_backup_identity(
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
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&path, &json)
}

pub(crate) fn clear_cleanup_journal(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cleanup_journal_path(app)?;
    crate::fs_secure::remove_regular_file_nofollow_if_exists(&path)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(crate) fn pending_stages_path(cache_dir: &std::path::Path) -> std::path::PathBuf {
    cache_dir.join("pending-stages.json")
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant)]
enum PendingStageRecord {
    // Legacy path-only registries remain readable, but a present path cannot be
    // deleted because the old format did not bind it to an owned directory.
    Legacy(String),
    Current {
        path: String,
        identity: FileIdentity,
        #[serde(default)]
        move_plan_identity: Option<FileIdentity>,
        #[serde(default)]
        move_identity_log_identity: Option<FileIdentity>,
        #[serde(default)]
        archive_backup_identities: Vec<Option<FileIdentity>>,
    },
}

impl PendingStageRecord {
    fn path(&self) -> &str {
        match self {
            Self::Legacy(path) | Self::Current { path, .. } => path,
        }
    }
}

fn read_pending_stage_records(
    cache_dir: &std::path::Path,
) -> Result<Vec<PendingStageRecord>, String> {
    let path = pending_stages_path(cache_dir);
    let Some(json) = read_bounded_nofollow_text(&path, MAX_PENDING_STAGES_BYTES)? else {
        return Ok(Vec::new());
    };
    let records: Vec<PendingStageRecord> =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if records.len() > 10_000 {
        return Err("Pending-stage registry exceeds its record safety limit.".to_string());
    }
    Ok(records)
}

#[cfg(test)]
pub(crate) fn read_pending_stages(cache_dir: &std::path::Path) -> Result<Vec<String>, String> {
    Ok(read_pending_stage_records(cache_dir)?
        .into_iter()
        .map(|record| record.path().to_string())
        .collect())
}

fn write_pending_stage_records(
    cache_dir: &std::path::Path,
    stages: &[PendingStageRecord],
) -> Result<(), String> {
    let path = pending_stages_path(cache_dir);
    if stages.is_empty() {
        crate::fs_secure::remove_regular_file_nofollow_if_exists(&path)
            .map(|_| ())
            .map_err(|error| error.to_string())
    } else {
        let json = serde_json::to_string(stages).map_err(|error| error.to_string())?;
        if json.len() as u64 > MAX_PENDING_STAGES_BYTES {
            return Err("Pending-stage registry exceeds its byte safety limit.".to_string());
        }
        crate::settings_store::atomic_write_text(&path, &json)
    }
}

pub(crate) fn register_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    identity: &FileIdentity,
) -> Result<(), String> {
    ensure_path_identity(stage, identity).map_err(|error| {
        format!(
            "Newly created stage {} changed before pending-stage registration: {error}",
            stage.display()
        )
    })?;
    let key = stage.to_string_lossy().to_string();
    let identity = identity.clone();
    let mut stages = read_pending_stage_records(cache_dir)?;
    if let Some(existing) = stages.iter_mut().find(|record| record.path() == key) {
        *existing = PendingStageRecord::Current {
            path: key,
            identity,
            move_plan_identity: None,
            move_identity_log_identity: None,
            archive_backup_identities: Vec::new(),
        };
    } else {
        stages.push(PendingStageRecord::Current {
            path: key,
            identity,
            move_plan_identity: None,
            move_identity_log_identity: None,
            archive_backup_identities: Vec::new(),
        });
    }
    write_pending_stage_records(cache_dir, &stages)
}

fn pending_record_mut<'a>(
    records: &'a mut [PendingStageRecord],
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
) -> Result<&'a mut PendingStageRecord, String> {
    ensure_path_identity(stage, expected_stage_identity).map_err(|error| {
        format!("Transaction stage changed before its pending recovery record was updated: {error}")
    })?;
    let key = stage.to_string_lossy();
    let record = records
        .iter_mut()
        .find(|record| record.path() == key)
        .ok_or_else(|| {
            "Pending-stage recovery record disappeared during publication.".to_string()
        })?;
    let PendingStageRecord::Current { identity, .. } = record else {
        return Err("Legacy pending-stage record cannot acquire sibling ownership.".to_string());
    };
    if !file_identities_match(identity, expected_stage_identity) {
        return Err("Pending-stage recovery record changed stage identity.".to_string());
    }
    Ok(record)
}

pub(crate) fn record_pending_move_plan_identity(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    artifact_identity: &FileIdentity,
) -> Result<(), String> {
    let mut records = read_pending_stage_records(cache_dir)?;
    let record = pending_record_mut(&mut records, stage, expected_stage_identity)?;
    let PendingStageRecord::Current {
        move_plan_identity, ..
    } = record
    else {
        unreachable!("pending_record_mut accepted only current records")
    };
    *move_plan_identity = Some(artifact_identity.clone());
    write_pending_stage_records(cache_dir, &records)
}

pub(crate) fn record_pending_move_identity_log_identity(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    artifact_identity: &FileIdentity,
) -> Result<(), String> {
    let mut records = read_pending_stage_records(cache_dir)?;
    let record = pending_record_mut(&mut records, stage, expected_stage_identity)?;
    let PendingStageRecord::Current {
        move_identity_log_identity,
        ..
    } = record
    else {
        unreachable!("pending_record_mut accepted only current records")
    };
    *move_identity_log_identity = Some(artifact_identity.clone());
    write_pending_stage_records(cache_dir, &records)
}

pub(crate) fn record_pending_archive_backup_identity(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    index: usize,
    backup_count: usize,
    artifact_identity: &FileIdentity,
) -> Result<(), String> {
    let mut records = read_pending_stage_records(cache_dir)?;
    let record = pending_record_mut(&mut records, stage, expected_stage_identity)?;
    let PendingStageRecord::Current {
        archive_backup_identities,
        ..
    } = record
    else {
        unreachable!("pending_record_mut accepted only current records")
    };
    if archive_backup_identities.is_empty() {
        archive_backup_identities.resize(backup_count, None);
    }
    if archive_backup_identities.len() != backup_count || index >= backup_count {
        return Err("Pending-stage archive backup identities are not index-aligned.".to_string());
    }
    archive_backup_identities[index] = Some(artifact_identity.clone());
    write_pending_stage_records(cache_dir, &records)
}

type PendingArtifactIdentities = (
    Option<FileIdentity>,
    Option<FileIdentity>,
    Vec<Option<FileIdentity>>,
);

pub(crate) fn pending_artifact_identities(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
    expected_stage_identity: &FileIdentity,
) -> Result<PendingArtifactIdentities, String> {
    let key = stage.to_string_lossy();
    let records = read_pending_stage_records(cache_dir)?;
    let record = records
        .iter()
        .find(|record| record.path() == key)
        .ok_or_else(|| "Pending-stage recovery record disappeared before cleanup.".to_string())?;
    let PendingStageRecord::Current {
        identity,
        move_plan_identity,
        move_identity_log_identity,
        archive_backup_identities,
        ..
    } = record
    else {
        return Err("Legacy pending-stage record has no destructive authority.".to_string());
    };
    if !file_identities_match(identity, expected_stage_identity) {
        return Err("Pending-stage recovery record changed stage identity.".to_string());
    }
    Ok((
        move_plan_identity.clone(),
        move_identity_log_identity.clone(),
        archive_backup_identities.clone(),
    ))
}

pub(crate) fn unregister_pending_stage(
    cache_dir: &std::path::Path,
    stage: &std::path::Path,
) -> Result<(), String> {
    let key = stage.to_string_lossy().to_string();
    let mut stages = read_pending_stage_records(cache_dir)?;
    let before = stages.len();
    stages.retain(|existing| existing.path() != key);
    if stages.len() != before {
        write_pending_stage_records(cache_dir, &stages)?;
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

pub(crate) fn unregister_plan_stages_strict(plan: &CleanupPlan) -> Result<(), String> {
    let Some(cache_dir) = &plan.cache_dir else {
        return Ok(());
    };
    let mut failures = Vec::new();
    for stage in plan_stage_dirs(plan) {
        match transaction_artifacts_present(&stage) {
            Ok(false) => {
                if let Err(error) = unregister_pending_stage(cache_dir, &stage) {
                    failures.push(format!(
                        "Could not unregister cleaned stage {}: {error}",
                        stage.display()
                    ));
                }
            }
            Ok(true) => failures.push(format!(
                "Cleaned stage still exists and remains registered: {}",
                stage.display()
            )),
            Err(error) => failures.push(format!(
                "Could not verify cleaned stage {} before unregistering it: {error}",
                stage.display()
            )),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
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
        match transaction_artifacts_present(&stage) {
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

fn transaction_artifacts_present(stage: &std::path::Path) -> Result<bool, String> {
    for path in [
        stage.to_path_buf(),
        move_plan_path(stage),
        move_identity_log_path(stage),
    ] {
        match std::fs::symlink_metadata(&path) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let parent = stage
        .parent()
        .ok_or_else(|| "Transaction stage has no parent directory.".to_string())?;
    let stage_name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Transaction stage has an invalid name.".to_string())?;
    let prefix = format!("{stage_name}.backup-");
    for entry in std::fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Remove stage directories left behind when a crash happened after create but
/// before (or without) a durable transaction journal. Safe names only.
pub fn cleanup_orphan_stages(app: &tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    cleanup_orphan_stages_in(&cache_dir)
}

#[cfg(test)]
pub(crate) fn cleanup_orphan_stages_at(cache_dir: &std::path::Path) -> Result<(), String> {
    cleanup_orphan_stages_in(cache_dir)
}

fn cleanup_orphan_stages_in(cache_dir: &std::path::Path) -> Result<(), String> {
    let stages = read_pending_stage_records(cache_dir)?;
    if stages.is_empty() {
        return Ok(());
    }
    let mut remaining = Vec::new();
    for stage in stages {
        let path = std::path::PathBuf::from(stage.path());
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !is_safe_stage_dir_name(name) {
            remaining.push(stage);
            continue;
        }
        let cleanup = match &stage {
            PendingStageRecord::Legacy(_) => {
                cleanup_transaction_artifacts(&path, None, None, None, &[])
            }
            PendingStageRecord::Current {
                identity,
                move_plan_identity,
                move_identity_log_identity,
                archive_backup_identities,
                ..
            } => cleanup_transaction_artifacts(
                &path,
                Some(identity),
                move_plan_identity.as_ref(),
                move_identity_log_identity.as_ref(),
                archive_backup_identities,
            ),
        };
        if let Err(error) = cleanup {
            eprintln!(
                "Keeping pending transaction artifacts for {} because cleanup failed closed: {error}",
                path.display()
            );
            remaining.push(stage);
        }
    }
    write_pending_stage_records(cache_dir, &remaining)
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
