//! Stable archive-input snapshots shared by extraction preflight and 7-Zip.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ArchiveFileIdentity {
    canonical_path: std::path::PathBuf,
    len: u64,
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
}

#[cfg(windows)]
fn windows_file_identity(file: &std::fs::File) -> Result<(u32, u64), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(format!(
            "Could not read Windows archive file identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    let file_index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok((info.dwVolumeSerialNumber, file_index))
}

pub(super) fn archive_file_identity(path: &std::path::Path) -> Result<ArchiveFileIdentity, String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("Could not resolve archive identity: {e}"))?;
    let file = std::fs::File::open(&canonical_path)
        .map_err(|e| format!("Could not open archive identity: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Could not read archive identity: {e}"))?;
    if !metadata.is_file() {
        return Err("Archive path is no longer a regular file.".to_string());
    }

    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt as _;
    #[cfg(windows)]
    let (volume_serial, file_index) = windows_file_identity(&file)?;

    Ok(ArchiveFileIdentity {
        canonical_path,
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(windows)]
        volume_serial,
        #[cfg(windows)]
        file_index,
    })
}

pub(super) fn assert_archive_identity_unchanged(
    archive: &std::path::Path,
    expected: &ArchiveFileIdentity,
) -> Result<(), String> {
    let current = archive_file_identity(archive)?;
    if &current != expected {
        return Err(
            "Archive changed after its member-safety preflight; extraction was cancelled."
                .to_string(),
        );
    }
    Ok(())
}

pub(super) fn archive_input_family(
    path: &std::path::Path,
) -> Result<Vec<std::path::PathBuf>, String> {
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Archive input has an invalid file name.".to_string())?;
    let bytes = name.as_bytes();
    let split_base = (bytes.len() > 4
        && bytes[bytes.len() - 4] == b'.'
        && bytes[bytes.len() - 3..].iter().all(u8::is_ascii_digit))
    .then(|| &name[..name.len() - 4]);
    let Some(base) = split_base else {
        return Ok(vec![path.to_path_buf()]);
    };
    if !name.ends_with(".001") {
        return Err("Select the first (.001) archive volume for extraction.".to_string());
    }
    let mut family = Vec::new();
    for index in 1..=1_000_000u32 {
        let candidate = parent.join(format!("{base}.{index:03}"));
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata)
                if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
            {
                return Err(format!(
                    "Archive volume is not a regular file: {}",
                    candidate.display()
                ));
            }
            Ok(_) => family.push(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(family)
}

pub(super) fn stage_extract_input(
    archive: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let archive = super::resolve_existing_target(archive, false)?;
    let anchor = cache_dir
        .map(|cache| cache.join(archive.file_name().unwrap_or_default()))
        .unwrap_or_else(|| archive.clone());
    if let Some(cache) = cache_dir {
        std::fs::create_dir_all(cache)
            .map_err(|error| format!("Could not create archive snapshot cache: {error}"))?;
    }
    let stage = super::create_private_stage_dir(&anchor, "input", cache_dir)?;
    let result = (|| {
        for source in archive_input_family(&archive)? {
            let expected = archive_file_identity(&source)?;
            let destination = stage.join(
                source
                    .file_name()
                    .ok_or_else(|| "Archive volume has no file name.".to_string())?,
            );
            std::fs::copy(&source, &destination).map_err(|error| {
                format!(
                    "Could not snapshot archive input {}: {error}",
                    source.display()
                )
            })?;
            assert_archive_identity_unchanged(&source, &expected)?;
        }
        Ok(stage.join(
            archive
                .file_name()
                .ok_or_else(|| "Archive input has no file name.".to_string())?,
        ))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
        if let Some(cache) = cache_dir {
            let _ = super::unregister_pending_stage(cache, &stage);
        }
    }
    result
}
