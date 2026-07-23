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
    #[cfg(windows)]
    volume_serial_64: Option<u64>,
    #[cfg(windows)]
    file_id_128: Option<[u8; 16]>,
}

#[cfg(windows)]
fn windows_file_identity(
    file: &std::fs::File,
) -> Result<(u32, u64, Option<u64>, Option<[u8; 16]>), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetFileInformationByHandleEx, FileIdInfo,
        BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO,
    };

    let handle = file.as_raw_handle() as HANDLE;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
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
    let mut extended: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    let has_extended_id = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut extended as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } != 0;
    Ok((
        info.dwVolumeSerialNumber,
        file_index,
        has_extended_id.then_some(extended.VolumeSerialNumber),
        has_extended_id.then_some(extended.FileId.Identifier),
    ))
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
    let (volume_serial, file_index, volume_serial_64, file_id_128) =
        windows_file_identity(&file)?;

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
        #[cfg(windows)]
        volume_serial_64,
        #[cfg(windows)]
        file_id_128,
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
    const MAX_ARCHIVE_VOLUMES: u32 = 10_000;
    type FoldedSiblingIndex = std::collections::HashMap<String, Vec<std::path::PathBuf>>;

    fn checked_volume(path: &std::path::Path) -> Result<bool, String> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata)
                if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
            {
                Err(format!(
                    "Archive volume is not a regular file: {}",
                    path.display()
                ))
            }
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Could not inspect archive volume {}: {error}",
                path.display()
            )),
        }
    }

    fn resolve_volume(
        expected: &std::path::Path,
        family_prefix: &str,
        folded_siblings: &mut Option<FoldedSiblingIndex>,
    ) -> Result<Option<std::path::PathBuf>, String> {
        if folded_siblings.is_none() {
            let parent = expected
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            let mut index = FoldedSiblingIndex::new();
            let mut indexed = 0usize;
            for entry in std::fs::read_dir(parent).map_err(|error| {
                format!(
                    "Could not inspect archive volume directory {}: {error}",
                    parent.display()
                )
            })? {
                let entry = entry.map_err(|error| {
                    format!(
                        "Could not inspect an archive volume sibling in {}: {error}",
                        parent.display()
                    )
                })?;
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let folded = name.to_ascii_lowercase();
                if !folded.starts_with(family_prefix) {
                    continue;
                }
                indexed += 1;
                if indexed > (MAX_ARCHIVE_VOLUMES as usize * 2 + 2) {
                    return Err(format!(
                        "Archive volume family has too many case-insensitive sibling candidates (limit {}).",
                        MAX_ARCHIVE_VOLUMES as usize * 2 + 2
                    ));
                }
                index.entry(folded).or_default().push(entry.path());
            }
            *folded_siblings = Some(index);
        }

        let expected_name = expected
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Archive volume has an invalid file name.".to_string())?
            .to_ascii_lowercase();
        let Some(matches) = folded_siblings
            .as_ref()
            .and_then(|index| index.get(&expected_name))
        else {
            return Ok(None);
        };
        if matches.len() != 1 {
            return Err(format!(
                "Archive volume name is ambiguous when matched case-insensitively: {}",
                expected.display()
            ));
        }
        let resolved = &matches[0];
        if checked_volume(resolved)? {
            Ok(Some(resolved.clone()))
        } else {
            Ok(None)
        }
    }

    fn collect_numbered(
        parent: &std::path::Path,
        family_prefix: &str,
        folded_siblings: &mut Option<FoldedSiblingIndex>,
        mut candidate_for: impl FnMut(u32) -> std::path::PathBuf,
    ) -> Result<Vec<std::path::PathBuf>, String> {
        let mut family = Vec::new();
        for index in 1..=MAX_ARCHIVE_VOLUMES {
            let candidate = parent.join(candidate_for(index));
            let Some(candidate) = resolve_volume(&candidate, family_prefix, folded_siblings)?
            else {
                return Ok(family);
            };
            family.push(candidate);
        }
        let overflow = parent.join(candidate_for(MAX_ARCHIVE_VOLUMES + 1));
        if resolve_volume(&overflow, family_prefix, folded_siblings)?.is_some() {
            return Err(format!(
                "Archive has more than {MAX_ARCHIVE_VOLUMES} volumes."
            ));
        }
        Ok(family)
    }

    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Archive input has an invalid file name.".to_string())?;
    let lower = name.to_ascii_lowercase();
    let bytes = name.as_bytes();
    let split_base = (bytes.len() > 4
        && bytes[bytes.len() - 4] == b'.'
        && bytes[bytes.len() - 3..].iter().all(u8::is_ascii_digit))
    .then(|| &name[..name.len() - 4]);
    if let Some(base) = split_base {
        if !lower.ends_with(".001") {
            return Err("Select the first (.001) archive volume for extraction.".to_string());
        }
        let family_prefix = format!("{}.", base.to_ascii_lowercase());
        let mut folded_siblings = None;
        return collect_numbered(parent, &family_prefix, &mut folded_siblings, |index| {
            std::path::PathBuf::from(format!("{base}.{index:03}"))
        });
    }

    if lower.ends_with(".rar") {
        let rar_start = name.len() - 4;
        if let Some(part_start) = lower[..rar_start].rfind(".part") {
            let digits_start = part_start + ".part".len();
            let digits = &lower[digits_start..rar_start];
            if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                if digits.parse::<u32>().ok() != Some(1) {
                    return Err(
                        "Select the first (.part1.rar) RAR volume for extraction.".to_string()
                    );
                }
                let prefix = &name[..digits_start];
                let suffix = &name[rar_start..];
                let width = digits.len();
                let family_prefix = prefix.to_ascii_lowercase();
                let mut folded_siblings = None;
                return collect_numbered(parent, &family_prefix, &mut folded_siblings, |index| {
                    std::path::PathBuf::from(format!("{prefix}{index:0width$}{suffix}"))
                });
            }
        }

        // Legacy multi-volume RAR uses archive.rar followed by archive.r00,
        // archive.r01, ...; a missing .r00 means this is a single-volume RAR.
        let base = &name[..rar_start];
        let first_legacy = parent.join(format!("{base}.r00"));
        let family_prefix = format!("{}.", base.to_ascii_lowercase());
        let mut folded_siblings = None;
        if resolve_volume(&first_legacy, &family_prefix, &mut folded_siblings)?.is_some() {
            let mut family = vec![path.to_path_buf()];
            // Old RAR naming advances from .r00 through .r99, then .s00,
            // continuing through .z99.
            for index in 0..900u32 {
                let letter = char::from(b'r' + (index / 100) as u8);
                let candidate = parent.join(format!("{base}.{letter}{:02}", index % 100));
                let Some(candidate) =
                    resolve_volume(&candidate, &family_prefix, &mut folded_siblings)?
                else {
                    break;
                };
                family.push(candidate);
            }
            return Ok(family);
        }
    }

    // Reject selecting a non-first legacy RAR volume directly.
    if let Some(extension) = lower.rsplit_once('.').map(|(_, extension)| extension) {
        if extension.len() == 3
            && extension
                .as_bytes()
                .first()
                .is_some_and(|letter| (b'r'..=b'z').contains(letter))
            && extension[1..].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Select the first (.rar) legacy RAR volume for extraction.".to_string());
        }
    }

    if lower.ends_with(".zip") {
        let zip_start = name.len() - 4;
        let base = &name[..zip_start];
        let first_split = parent.join(format!("{base}.z01"));
        let family_prefix = format!("{}.", base.to_ascii_lowercase());
        let mut folded_siblings = None;
        if resolve_volume(&first_split, &family_prefix, &mut folded_siblings)?.is_some() {
            let mut family =
                collect_numbered(parent, &family_prefix, &mut folded_siblings, |index| {
                    std::path::PathBuf::from(format!("{base}.z{index:02}"))
                })?;
            family.push(path.to_path_buf());
            return Ok(family);
        }
    }

    if let Some(extension) = lower.rsplit_once('.').map(|(_, extension)| extension) {
        if extension.len() >= 3
            && extension.starts_with('z')
            && extension[1..].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Select the final (.zip) split ZIP volume for extraction.".to_string());
        }
    }

    Ok(vec![path.to_path_buf()])
}

pub(super) struct StagedArchiveInput {
    pub(super) path: std::path::PathBuf,
    pub(super) total_len: u64,
}

pub(super) fn stage_extract_input(
    archive: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
) -> Result<StagedArchiveInput, String> {
    let archive = super::resolve_existing_target(archive, false)?;
    let anchor = cache_dir
        .map(|cache| cache.join(archive.file_name().unwrap_or_default()))
        .unwrap_or_else(|| archive.clone());
    if let Some(cache) = cache_dir {
        std::fs::create_dir_all(cache)
            .map_err(|error| format!("Could not create archive snapshot cache: {error}"))?;
    }
    let sources = archive_input_family(&archive)?;
    let mut inputs = Vec::with_capacity(sources.len());
    let mut total_len = 0u64;
    for source in sources {
        let identity = archive_file_identity(&source)?;
        total_len = total_len
            .checked_add(identity.len)
            .ok_or_else(|| "Archive volume family size overflowed.".to_string())?;
        inputs.push((source, identity));
    }
    const MIN_SNAPSHOT_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
    let free_space = super::available_space_for_path(&anchor)?;
    let reserve = (free_space / 10).max(MIN_SNAPSHOT_DISK_RESERVE_BYTES);
    if total_len > free_space.saturating_sub(reserve) {
        return Err(format!(
            "Not enough free space to snapshot the complete archive volume family ({} MiB required, {} MiB available).",
            total_len / (1024 * 1024),
            free_space / (1024 * 1024)
        ));
    }
    let stage = super::create_private_stage_dir(&anchor, "input", cache_dir)?;
    let result = (|| {
        for (source, expected) in inputs {
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
        Ok(StagedArchiveInput {
            path: stage.join(
                archive
                    .file_name()
                    .ok_or_else(|| "Archive input has no file name.".to_string())?,
            ),
            total_len,
        })
    })();
    if result.is_err() {
        let _ = crate::fs_secure::remove_dir_all_for_cleanup(&stage);
        if let Some(cache) = cache_dir {
            let _ = super::unregister_pending_stage(cache, &stage);
        }
    }
    result
}
