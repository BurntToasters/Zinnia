//! File and content identity fingerprints.

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
        /// 32-bit volume serial for filesystems that do not expose `FileIdInfo`.
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

pub(crate) fn identity_with_object_fingerprint(
    mut identity: FileIdentity,
    fingerprint: ObjectFingerprint,
) -> FileIdentity {
    identity.set_fingerprint(fingerprint);
    identity
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

/// The extraction publisher appends and fsyncs one identity record, then
/// journals the grown log's fingerprint. A crash between those two durable
/// writes leaves exactly one record (or a torn part of one) after the
/// journaled length. Its object has not been published yet, because
/// publication waits for the journal update.
///
/// Return the identity that describes the log as it is on disk when, and only
/// when, the journaled prefix is intact and the unjournaled suffix has that
/// shape. Otherwise return `expected` unchanged so the caller's strict check
/// fails closed. The suffix remains bounded by the move-plan checks applied
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
    // SAFETY: BY_HANDLE_FILE_INFORMATION is a plain C struct of integers and
    // FILETIME fields, so the all-zero bit pattern is valid. It is only read after
    // GetFileInformationByHandle reports success, and that call overwrites it.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` is the raw handle of `file`, which the caller keeps open and
    // which this call only borrows. `&mut info` is a valid, exclusive out-pointer
    // to a struct of the type the API writes.
    let success = unsafe { GetFileInformationByHandle(handle, &mut info) };
    if success == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && !allow_symlink_reparse {
        return Err("Refusing a file identity for a link or reparse point.".to_string());
    }
    // SAFETY: FILE_ID_INFO is a plain C struct of an integer and a 16-byte id, so
    // the all-zero bit pattern is valid. It is only read when the call below
    // reports success.
    let mut extended: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` is the same open handle as above. The FileIdInfo class
    // matches the FILE_ID_INFO buffer. The pointer refers to the local `extended`,
    // and the size argument equals its size, so the API writes only within it.
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

pub(crate) fn fingerprint_path_bytes(value: &std::ffi::OsStr) -> Vec<u8> {
    os_value_bytes(value)
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
    let root_metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if root_metadata.is_file() && !crate::path_safety::is_link_or_reparse(&root_metadata) {
        return hash_regular_file(path);
    }
    if root_metadata.file_type().is_symlink() {
        return fingerprint_symlink(path);
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
                fingerprint_symlink(&entry_path)?
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

    Ok(fingerprint_records(records))
}

pub(crate) fn fingerprint_symlink(path: &std::path::Path) -> Result<ObjectFingerprint, String> {
    use sha2::Digest as _;

    let target = std::fs::read_link(path).map_err(|error| error.to_string())?;
    Ok(ObjectFingerprint::Symlink {
        sha256: sha2::Sha256::digest(os_value_bytes(target.as_os_str())).into(),
    })
}

pub(crate) fn fingerprint_records(
    mut records: Vec<(Vec<u8>, ObjectFingerprint)>,
) -> ObjectFingerprint {
    use sha2::Digest as _;

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
    ObjectFingerprint::Directory {
        sha256: hasher.finalize().into(),
    }
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
