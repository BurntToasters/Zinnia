//! Archive file identity and selection tokens.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ArchiveFileIdentity {
    canonical_path: std::path::PathBuf,
    pub(super) len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume_serial: u32,
    #[cfg(windows)]
    file_index: u64,
    #[cfg(windows)]
    volume_serial_64: Option<u64>,
    #[cfg(windows)]
    file_id_128: Option<[u8; 16]>,
}

pub(super) fn archive_file_identity_from_open_file(
    canonical_path: &std::path::Path,
    file: &std::fs::File,
) -> Result<ArchiveFileIdentity, String> {
    let metadata = file
        .metadata()
        .map_err(|e| format!("Could not read archive identity: {e}"))?;
    if !metadata.is_file() {
        return Err("Archive path is no longer a regular file.".to_string());
    }

    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt as _;
    #[cfg(windows)]
    let windows_identity = windows_file_identity(file)?;

    Ok(ArchiveFileIdentity {
        canonical_path: canonical_path.to_path_buf(),
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(windows)]
        volume_serial: windows_identity.volume_serial,
        #[cfg(windows)]
        file_index: windows_identity.file_index,
        #[cfg(windows)]
        volume_serial_64: windows_identity.volume_serial_64,
        #[cfg(windows)]
        file_id_128: windows_identity.file_id_128,
    })
}

#[cfg(windows)]
struct WindowsArchiveFileIdentity {
    volume_serial: u32,
    file_index: u64,
    volume_serial_64: Option<u64>,
    file_id_128: Option<[u8; 16]>,
}

#[cfg(windows)]
fn windows_file_identity(file: &std::fs::File) -> Result<WindowsArchiveFileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO,
    };

    let handle = file.as_raw_handle() as HANDLE;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` is the raw handle of `file`, which is borrowed for this call, and `info` is
    // a live, writable BY_HANDLE_FILE_INFORMATION that the API fills.
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
    if ok == 0 {
        return Err(format!(
            "Could not read Windows archive file identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    let file_index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);

    // ReFS uses 128-bit file IDs; the legacy 64-bit index is not guaranteed
    // unique there. Keep the legacy pair as a compatibility fallback for
    // filesystems and SMB servers that do not implement FileIdInfo.
    // SAFETY: FILE_ID_INFO holds only integers and byte arrays, so all-zero is valid. It is read
    // only when the call below succeeds.
    let mut extended: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` is still open. The pointer and size describe `extended`, a live
    // FILE_ID_INFO, and the API writes at most `size_of::<FILE_ID_INFO>()` bytes into it.
    let has_extended_id = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut extended as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } != 0;
    Ok(WindowsArchiveFileIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        file_index,
        volume_serial_64: has_extended_id.then_some(extended.VolumeSerialNumber),
        file_id_128: has_extended_id.then_some(extended.FileId.Identifier),
    })
}

pub(crate) fn archive_file_identity(path: &std::path::Path) -> Result<ArchiveFileIdentity, String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("Could not resolve archive identity: {e}"))?;
    let file = crate::path_safety::open_regular_file_nofollow(&canonical_path)
        .map_err(|e| format!("Could not open archive identity: {e}"))?;
    archive_file_identity_from_open_file(&canonical_path, &file)
}

fn hash_identity_bytes(hasher: &mut sha2::Sha256, bytes: &[u8]) {
    use sha2::Digest as _;

    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn hash_identity_time(hasher: &mut sha2::Sha256, value: Option<std::time::SystemTime>) {
    use sha2::Digest as _;

    let Some(value) = value else {
        hasher.update([0]);
        return;
    };
    match value.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => {
            hasher.update([1]);
            hasher.update(duration.as_secs().to_le_bytes());
            hasher.update(duration.subsec_nanos().to_le_bytes());
        }
        Err(error) => {
            let duration = error.duration();
            hasher.update([2]);
            hasher.update(duration.as_secs().to_le_bytes());
            hasher.update(duration.subsec_nanos().to_le_bytes());
        }
    }
}

fn hash_archive_file_identity(hasher: &mut sha2::Sha256, identity: &ArchiveFileIdentity) {
    use sha2::Digest as _;

    hash_identity_bytes(
        hasher,
        identity.canonical_path.as_os_str().as_encoded_bytes(),
    );
    hasher.update(identity.len.to_le_bytes());
    hash_identity_time(hasher, identity.modified);
    hash_identity_time(hasher, identity.created);
    #[cfg(unix)]
    {
        hasher.update(identity.device.to_le_bytes());
        hasher.update(identity.inode.to_le_bytes());
    }
    #[cfg(windows)]
    {
        hasher.update(identity.volume_serial.to_le_bytes());
        hasher.update(identity.file_index.to_le_bytes());
        match identity.volume_serial_64 {
            Some(value) => {
                hasher.update([1]);
                hasher.update(value.to_le_bytes());
            }
            None => hasher.update([0]),
        }
        match identity.file_id_128 {
            Some(value) => {
                hasher.update([1]);
                hasher.update(value);
            }
            None => hasher.update([0]),
        }
    }
}

fn archive_identity_token_from_family(
    resolved: &std::path::Path,
    selected_file: Option<&std::fs::File>,
) -> Result<String, String> {
    use sha2::Digest as _;

    let family = super::volumes::archive_input_family(resolved)?;
    let mut hasher = sha2::Sha256::new();
    let mut used_selected = false;
    for member in &family {
        let identity = if member == resolved {
            if let Some(file) = selected_file {
                used_selected = true;
                archive_file_identity_from_open_file(member, file)?
            } else {
                archive_file_identity(member)?
            }
        } else {
            archive_file_identity(member)?
        };
        hash_identity_bytes(&mut hasher, member.as_os_str().as_encoded_bytes());
        hash_archive_file_identity(&mut hasher, &identity);
    }
    if selected_file.is_some() && !used_selected {
        return Err("Selected archive is not a member of its resolved volume family.".to_string());
    }
    let after = super::volumes::archive_input_family(resolved)?;
    if after != family {
        return Err("Archive volume family changed while its identity was generated.".to_string());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn archive_identity_token_from_open_file(
    resolved: &std::path::Path,
    file: &std::fs::File,
) -> Result<String, String> {
    archive_identity_token_from_family(resolved, Some(file))
}

pub(crate) fn archive_identity_token(path: &std::path::Path) -> Result<String, String> {
    let resolved = crate::path_safety::resolve_regular_file_input(path)?;
    archive_identity_token_from_family(&resolved, None)
}
