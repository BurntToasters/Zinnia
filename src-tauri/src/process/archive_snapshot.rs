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

fn archive_file_identity_from_open_file(
    path: &std::path::Path,
    file: &std::fs::File,
) -> Result<ArchiveFileIdentity, String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("Could not resolve archive identity: {e}"))?;
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
        canonical_path,
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
    Ok(WindowsArchiveFileIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        file_index,
        volume_serial_64: has_extended_id.then_some(extended.VolumeSerialNumber),
        file_id_128: has_extended_id.then_some(extended.FileId.Identifier),
    })
}

pub(super) fn archive_file_identity(path: &std::path::Path) -> Result<ArchiveFileIdentity, String> {
    let file = crate::path_safety::open_regular_file_nofollow(path)
        .map_err(|e| format!("Could not open archive identity: {e}"))?;
    archive_file_identity_from_open_file(path, &file)
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

pub(crate) fn archive_identity_token(path: &std::path::Path) -> Result<String, String> {
    use sha2::Digest as _;

    let resolved = crate::path_safety::resolve_regular_file_input(path)?;
    let family = archive_input_family(&resolved)?;
    let mut hasher = sha2::Sha256::new();
    for member in family {
        let identity = archive_file_identity(&member)?;
        hash_identity_bytes(&mut hasher, member.as_os_str().as_encoded_bytes());
        hash_archive_file_identity(&mut hasher, &identity);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Attempt a copy-on-write clone of `source` into the already-created,
/// still-empty `destination` file. Returns `Ok(true)` on a successful clone,
/// `Ok(false)` when the filesystem/platform does not support cloning here
/// (different filesystem, unsupported fs, no kernel support, etc: the plain
/// byte copy remains correct in every one of those cases), and `Err` only for
/// an I/O failure that is not a "clone unsupported" signal.
///
/// This exists because extraction snapshots the *entire* input archive (and
/// every volume of a split family) into a private staging copy before 7-Zip
/// ever touches it, so a byte-for-byte `io::copy` of a large archive read and
/// wrote its full size again for every extraction. APFS/Btrfs/XFS clone
/// primitives make the snapshot instant and use no extra disk space until a
/// write actually diverges the two files, while keeping the exact same
/// TOCTOU-safe identity checks around this call unchanged.
#[cfg(target_os = "macos")]
fn try_clone_snapshot_file(
    source: &std::fs::File,
    destination: &std::path::Path,
) -> Result<bool, String> {
    use std::os::fd::AsRawFd as _;

    // `fclonefileat` clones from an already-open source handle (closing the
    // TOCTOU window between the caller's earlier identity check and this
    // call) into a path that must not already exist, matching `create_new`.
    let dest_c = std::ffi::CString::new(destination.as_os_str().as_encoded_bytes())
        .map_err(|_| "Snapshot destination path contains a NUL byte.".to_string())?;
    let result =
        unsafe { libc::fclonefileat(source.as_raw_fd(), libc::AT_FDCWD, dest_c.as_ptr(), 0) };
    if result == 0 {
        return Ok(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        // Cross-device, unsupported filesystem, or no kernel/fs clone
        // support: fall back to the byte copy. Anything else (e.g. the
        // destination unexpectedly already existing) is a real error.
        // `EINVAL` / `EOPNOTSUPP` cover FUSE and shared-folder clone refusals
        // (on Darwin `ENOTSUP` and `EOPNOTSUPP` are distinct values).
        Some(libc::EXDEV | libc::ENOTSUP | libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL) => {
            Ok(false)
        }
        _ => Err(std::io::Error::last_os_error().to_string()),
    }
}

#[cfg(target_os = "linux")]
fn try_clone_snapshot_file(
    source: &std::fs::File,
    destination_file: &std::fs::File,
) -> Result<bool, String> {
    use std::os::fd::AsRawFd as _;

    // linux/fs.h: `#define FICLONE _IOW(0x94, 9, int)`. Not exposed by the
    // `libc` crate; the encoding is a stable kernel UAPI constant.
    const FICLONE: libc::c_ulong = 0x4004_9409;
    let result = unsafe {
        libc::ioctl(
            destination_file.as_raw_fd(),
            FICLONE as _,
            source.as_raw_fd(),
        )
    };
    if result == 0 {
        return Ok(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        // Cross-device, unsupported filesystem, or no kernel/fs clone
        // support: fall back to the byte copy.
        Some(libc::EXDEV | libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL) => Ok(false),
        _ => Err(std::io::Error::last_os_error().to_string()),
    }
}

fn copy_archive_snapshot_file<C>(
    source: &mut std::fs::File,
    source_path: &std::path::Path,
    destination: &std::path::Path,
    should_cancel: &C,
) -> Result<(), String>
where
    C: Fn() -> bool,
{
    if should_cancel() {
        return Err("Archive operation was cancelled during input snapshot.".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        match try_clone_snapshot_file(source, destination) {
            Ok(true) => {
                // `clonefile`/`fclonefileat` preserves the *source* archive's
                // mode bits, which can be more permissive than the private
                // snapshot's 0o600. Force it back down so the clone fast path
                // never weakens the private-snapshot guarantee the byte-copy
                // path provides via `create_new` + `mode(0o600)`.
                use std::os::unix::fs::PermissionsExt as _;
                let finalize = (|| {
                    std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o600))
                        .map_err(|error| error.to_string())?;
                    // APFS clone creation is atomic, but fsync the snapshot inode
                    // before 7-Zip reads it so this path matches Linux CoW + copy.
                    let synced = std::fs::OpenOptions::new()
                        .read(true)
                        .open(destination)
                        .map_err(|error| error.to_string())?;
                    super::commit::sync_file_best_effort(&synced)?;
                    Ok(())
                })();
                if let Err(error) = finalize {
                    let cleanup = crate::fs_secure::remove_file_for_cleanup(destination);
                    return Err(match cleanup {
                        Ok(()) => error,
                        Err(cleanup_error)
                            if cleanup_error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            error
                        }
                        Err(cleanup_error) => {
                            format!(
                                "{error}; partial snapshot cleanup also failed: {cleanup_error}"
                            )
                        }
                    });
                }
                return Ok(());
            }
            Ok(false) => {}
            Err(error) => return Err(error),
        }
        ensure_snapshot_byte_copy_space(source, destination)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    ensure_snapshot_byte_copy_space(source, destination)?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        // Keep the private snapshot stable while it is populated. More
        // importantly, creating it here lets it inherit the private stage DACL
        // instead of CopyFileEx copying the source archive's security descriptor.
        options.share_mode(FILE_SHARE_READ);
    }

    let mut destination_file = options
        .open(destination)
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "linux")]
    {
        match try_clone_snapshot_file(source, &destination_file) {
            Ok(true) => {
                let result = super::commit::sync_file_best_effort(&destination_file);
                drop(destination_file);
                if let Err(error) = result {
                    let cleanup = crate::fs_secure::remove_file_for_cleanup(destination);
                    return Err(match cleanup {
                        Ok(()) => error,
                        Err(cleanup_error)
                            if cleanup_error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            error
                        }
                        Err(cleanup_error) => {
                            format!(
                                "{error}; partial snapshot cleanup also failed: {cleanup_error}"
                            )
                        }
                    });
                }
                return Ok(());
            }
            Ok(false) => {
                if let Err(error) = ensure_snapshot_byte_copy_space(source, destination) {
                    drop(destination_file);
                    let _ = crate::fs_secure::remove_file_for_cleanup(destination);
                    return Err(error);
                }
            }
            Err(error) => {
                drop(destination_file);
                let cleanup = crate::fs_secure::remove_file_for_cleanup(destination);
                return Err(match cleanup {
                    Ok(()) => error,
                    Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
                        error
                    }
                    Err(cleanup_error) => {
                        format!("{error}; partial snapshot cleanup also failed: {cleanup_error}")
                    }
                });
            }
        }
    }

    // Chunked copy keeps Cancel responsive on Windows, network shares, and
    // filesystems where CoW cloning is unavailable.
    let result = (|| {
        use std::io::{Read as _, Write as _};

        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            if should_cancel() {
                return Err("Archive operation was cancelled during input snapshot.".to_string());
            }
            let read = source
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            destination_file
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
        }
        if should_cancel() {
            return Err("Archive operation was cancelled during input snapshot.".to_string());
        }
        super::commit::sync_file_best_effort(&destination_file)
    })();
    drop(destination_file);

    if let Err(error) = result {
        let cleanup = crate::fs_secure::remove_file_for_cleanup(destination);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => error,
            Err(cleanup_error) => {
                format!("{error}; partial snapshot cleanup also failed: {cleanup_error}")
            }
        });
    }
    #[cfg(windows)]
    copy_windows_zone_identifier(source_path, destination)?;
    #[cfg(not(windows))]
    let _ = source_path;
    Ok(())
}

#[cfg(windows)]
fn copy_windows_zone_identifier(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use std::io::{Read as _, Write as _};

    const MAX_ZONE_BYTES: u64 = 64 * 1024;
    fn stream_path(path: &std::path::Path) -> std::path::PathBuf {
        let mut value = path.as_os_str().to_os_string();
        value.push(":Zone.Identifier");
        value.into()
    }

    let mut source_stream = match std::fs::File::open(stream_path(source)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read archive Mark-of-the-Web: {error}")),
    };
    let length = source_stream
        .metadata()
        .map_err(|error| format!("Could not inspect archive Mark-of-the-Web: {error}"))?
        .len();
    if length > MAX_ZONE_BYTES {
        return Err("Archive Mark-of-the-Web is unexpectedly large.".to_string());
    }
    let mut contents = Vec::with_capacity(length as usize);
    source_stream
        .read_to_end(&mut contents)
        .map_err(|error| format!("Could not read archive Mark-of-the-Web: {error}"))?;
    if contents.contains(&0) || !contents.starts_with(b"[ZoneTransfer]") {
        return Err("Archive Mark-of-the-Web has an invalid format.".to_string());
    }
    let mut destination_stream = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(stream_path(destination))
        .map_err(|error| format!("Could not preserve archive Mark-of-the-Web: {error}"))?;
    destination_stream
        .write_all(&contents)
        .and_then(|()| destination_stream.sync_all())
        .map_err(|error| format!("Could not preserve archive Mark-of-the-Web: {error}"))
}

fn ensure_snapshot_byte_copy_space(
    source: &std::fs::File,
    destination: &std::path::Path,
) -> Result<(), String> {
    const MIN_SNAPSHOT_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
    let required = source.metadata().map_err(|error| error.to_string())?.len();
    let free_space = super::available_space_for_path(destination)?;
    let reserve = (free_space / 10).max(MIN_SNAPSHOT_DISK_RESERVE_BYTES);
    if required > free_space.saturating_sub(reserve) {
        return Err(format!(
            "Not enough free space to copy the archive snapshot ({} MiB required, {} MiB available).",
            required / (1024 * 1024),
            free_space / (1024 * 1024)
        ));
    }
    Ok(())
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
    let numeric_suffix = bytes.len() > 4
        && bytes[bytes.len() - 4] == b'.'
        && bytes[bytes.len() - 3..].iter().all(u8::is_ascii_digit);
    // A bare `name.123`-shaped file is only a 7-Zip split-volume member when
    // its base ends in a recognized archive extension (`archive.7z.001`) or a
    // sibling `.002` volume actually exists next to it. Without one of those,
    // an ordinary numbered file like `photo.123` or `backup.100` was rejected
    // outright with "Select the first (.001) archive volume", even though it
    // is not part of any split archive at all.
    let split_base = numeric_suffix
        .then(|| &name[..name.len() - 4])
        .filter(|base| {
            const KNOWN_ARCHIVE_SUFFIXES: &[&str] = &[".7z", ".zip", ".tar", ".gz", ".bz2", ".xz"];
            let base_lower = base.to_ascii_lowercase();
            if KNOWN_ARCHIVE_SUFFIXES
                .iter()
                .any(|suffix| base_lower.ends_with(suffix))
            {
                return true;
            }
            parent.join(format!("{base}.002")).is_file()
        });
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

#[derive(Debug)]
pub(super) struct StagedArchiveInput {
    pub(super) path: std::path::PathBuf,
    pub(super) total_len: u64,
}

#[cfg(test)]
pub(super) fn stage_extract_input(
    archive: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
    expected_identity: Option<&str>,
) -> Result<StagedArchiveInput, String> {
    stage_extract_input_with_cancel(archive, cache_dir, expected_identity, || false)
}

pub(super) fn stage_extract_input_with_cancel<C>(
    archive: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
    expected_identity: Option<&str>,
    should_cancel: C,
) -> Result<StagedArchiveInput, String>
where
    C: Fn() -> bool,
{
    let archive = crate::path_safety::resolve_regular_file_input(archive)?;
    let initial_token = archive_identity_token(&archive)?;
    if expected_identity.is_some_and(|expected| expected != initial_token) {
        return Err(
            "Archive changed after it was browsed; review the new contents before extracting."
                .to_string(),
        );
    }
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
    // Prefer a private sibling of the archive. That keeps snapshots on the
    // source filesystem, enabling APFS/Btrfs/XFS CoW and avoiding a mandatory
    // full copy onto the system/app-cache disk. Read-only source locations fall
    // back to app cache.
    let stage = match super::create_private_stage_dir(&archive, "input", cache_dir) {
        Ok(stage) => stage,
        Err(source_error) => {
            let Some(cache) = cache_dir else {
                return Err(source_error);
            };
            let cache_anchor = cache.join(archive.file_name().unwrap_or_default());
            super::create_private_stage_dir(&cache_anchor, "input", cache_dir).map_err(
                |cache_error| {
                    format!(
                        "Could not create archive snapshot beside the input ({source_error}) or in app cache ({cache_error})."
                    )
                },
            )?
        }
    };
    let result = (|| {
        for (source, expected) in inputs {
            if should_cancel() {
                return Err("Archive operation was cancelled during input snapshot.".to_string());
            }
            let destination = stage.join(
                source
                    .file_name()
                    .ok_or_else(|| "Archive volume has no file name.".to_string())?,
            );
            let mut source_file =
                crate::path_safety::open_regular_file_nofollow_for_snapshot(&source).map_err(
                    |error| format!("Could not open archive input {}: {error}", source.display()),
                )?;
            let opened_identity = archive_file_identity_from_open_file(&source, &source_file)?;
            if opened_identity != expected {
                return Err(
                    "Archive changed before its private snapshot could be created; extraction was cancelled."
                        .to_string(),
                );
            }
            copy_archive_snapshot_file(&mut source_file, &source, &destination, &should_cancel)
                .map_err(|error| {
                    format!(
                        "Could not snapshot archive input {}: {error}",
                        source.display()
                    )
                })?;
            let copied_identity = archive_file_identity_from_open_file(&source, &source_file)?;
            if copied_identity != expected {
                return Err(
                    "Archive changed while its private snapshot was being created; extraction was cancelled."
                        .to_string(),
                );
            }
            assert_archive_identity_unchanged(&source, &expected)?;
        }
        if archive_identity_token(&archive)? != initial_token {
            return Err(
                "Archive changed while its private snapshot was being created; extraction was cancelled."
                    .to_string(),
            );
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
