//! Stable archive-input snapshots shared by extraction preflight and 7-Zip.

#[cfg(windows)]
type WindowsSnapshotHandle = (std::path::PathBuf, std::sync::Arc<std::fs::File>);

#[cfg(windows)]
type WindowsSnapshotRegistry =
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Vec<WindowsSnapshotHandle>>>;

#[cfg(windows)]
static WINDOWS_SNAPSHOT_HANDLES: std::sync::OnceLock<WindowsSnapshotRegistry> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn windows_snapshot_handles() -> &'static WindowsSnapshotRegistry {
    WINDOWS_SNAPSHOT_HANDLES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(windows)]
pub(crate) fn release_snapshot_handles(stage: &std::path::Path) {
    if let Ok(mut handles) = windows_snapshot_handles().lock() {
        handles.remove(stage);
    }
}

#[cfg(windows)]
pub(super) fn archive_identity_from_snapshot_handle(
    path: &std::path::Path,
) -> Option<ArchiveFileIdentity> {
    let stage = path.parent()?;
    let handles = windows_snapshot_handles().lock().ok()?;
    handles
        .get(stage)?
        .iter()
        .find(|(snapshot, _)| snapshot == path)
        .and_then(|(_, file)| archive_file_identity_from_open_file(path, file).ok())
}

#[cfg(not(windows))]
pub(super) fn archive_identity_from_snapshot_handle(
    _path: &std::path::Path,
) -> Option<ArchiveFileIdentity> {
    None
}

#[cfg(not(windows))]
pub(crate) fn release_snapshot_handles(_stage: &std::path::Path) {}

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

    let family = archive_input_family(resolved)?;
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
    let after = archive_input_family(resolved)?;
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

/// A Windows hard link plus a source handle that denies write/delete sharing
/// gives 7-Zip stable, zero-copy input without weakening source replacement
/// protection. Unsupported filesystems fall back to ordinary snapshot copy.
#[cfg(windows)]
fn try_hardlink_snapshot_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<bool, String> {
    match std::fs::hard_link(source, destination) {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists
                    | std::io::ErrorKind::PermissionDenied
                    | std::io::ErrorKind::Unsupported
            ) =>
        {
            Ok(false)
        }
        Err(_) => Ok(false),
    }
}

#[cfg(windows)]
struct CopyFile2Context<'a> {
    should_cancel: &'a dyn Fn() -> bool,
    cancel: *mut windows_sys::core::BOOL,
}

#[cfg(windows)]
unsafe extern "system" fn copy_file2_progress(
    _message: *const windows_sys::Win32::Storage::FileSystem::COPYFILE2_MESSAGE,
    callback_context: *const std::ffi::c_void,
) -> windows_sys::Win32::Storage::FileSystem::COPYFILE2_MESSAGE_ACTION {
    use windows_sys::Win32::Storage::FileSystem::{
        COPYFILE2_PROGRESS_CANCEL, COPYFILE2_PROGRESS_CONTINUE,
    };
    if callback_context.is_null() {
        return COPYFILE2_PROGRESS_CONTINUE;
    }
    let context = &*(callback_context as *const CopyFile2Context<'_>);
    if (context.should_cancel)() {
        *context.cancel = 1;
        COPYFILE2_PROGRESS_CANCEL
    } else {
        COPYFILE2_PROGRESS_CONTINUE
    }
}

/// Use the Windows native copy engine when the hard-link snapshot is not
/// available. CopyFile2 keeps alternate data streams (including Zone.Identifier
/// / MOTW) and can use ReFS block cloning or storage offload. The destination
/// remains create-new and is removed on every failed native attempt before the
/// cancellable byte-copy fallback runs.
#[cfg(windows)]
fn try_copy_file2_snapshot<C>(
    source: &std::path::Path,
    destination: &std::path::Path,
    should_cancel: &C,
) -> Result<bool, String>
where
    C: Fn() -> bool,
{
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        CopyFile2, COPYFILE2_EXTENDED_PARAMETERS, COPY_FILE_FAIL_IF_EXISTS,
    };

    if should_cancel() {
        return Err("Archive operation was cancelled during input snapshot.".to_string());
    }
    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut cancel: windows_sys::core::BOOL = 0;
    let context = CopyFile2Context {
        should_cancel,
        cancel: &mut cancel,
    };
    let parameters = COPYFILE2_EXTENDED_PARAMETERS {
        dwSize: std::mem::size_of::<COPYFILE2_EXTENDED_PARAMETERS>() as u32,
        dwCopyFlags: COPY_FILE_FAIL_IF_EXISTS,
        pfCancel: &mut cancel,
        pProgressRoutine: Some(copy_file2_progress),
        pvCallbackContext: (&context as *const CopyFile2Context<'_>) as *mut std::ffi::c_void,
    };
    let result = unsafe { CopyFile2(source_wide.as_ptr(), destination_wide.as_ptr(), &parameters) };
    if result == 0 {
        return Ok(true);
    }
    if cancel != 0 || should_cancel() {
        let _ = crate::fs_secure::remove_file_for_cleanup(destination);
        return Err("Archive operation was cancelled during input snapshot.".to_string());
    }
    // CopyFile2 is an optimization, not a new failure mode. A filesystem may
    // reject offload/block-clone or an older Windows kernel may not implement
    // the API; clean any partial target and let the existing byte-copy path
    // preserve the private stage ACL and cancellation semantics.
    let _ = crate::fs_secure::remove_file_for_cleanup(destination);
    Ok(false)
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SnapshotStrategy {
    WindowsHardlink,
    CopyFile2,
    CowClone,
    ByteCopy,
    Mixed,
}

impl SnapshotStrategy {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::WindowsHardlink => "windows-hardlink-lock",
            Self::CopyFile2 => "windows-copyfile2",
            Self::CowClone => "cow-clone",
            Self::ByteCopy => "cancellable-byte-copy",
            Self::Mixed => "mixed-snapshot-strategies",
        }
    }

    fn merge(self, other: Self) -> Self {
        if self == other {
            self
        } else {
            Self::Mixed
        }
    }
}

fn copy_archive_snapshot_file<C>(
    source: &mut std::fs::File,
    source_path: &std::path::Path,
    destination: &std::path::Path,
    should_cancel: &C,
) -> Result<SnapshotStrategy, String>
where
    C: Fn() -> bool,
{
    if should_cancel() {
        return Err("Archive operation was cancelled during input snapshot.".to_string());
    }
    #[cfg(windows)]
    {
        if try_copy_file2_snapshot(source_path, destination, should_cancel)? {
            return Ok(SnapshotStrategy::CopyFile2);
        }
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
                return Ok(SnapshotStrategy::CowClone);
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
                return Ok(SnapshotStrategy::CowClone);
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
    Ok(SnapshotStrategy::ByteCopy)
}

#[cfg(windows)]
pub(crate) fn copy_windows_zone_identifier(
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

    fn zone_text_is_valid(text: &str) -> bool {
        let trimmed = text.trim_start_matches('\u{feff}').trim_start();
        trimmed.starts_with("[ZoneTransfer]")
    }

    fn decode_zone_identifier(contents: &[u8]) -> Option<Vec<u8>> {
        if !contents.contains(&0) && zone_text_is_valid(std::str::from_utf8(contents).ok()?) {
            return Some(contents.to_vec());
        }
        let utf16 = if contents.starts_with(&[0xFF, 0xFE]) {
            let mut units = Vec::with_capacity(contents.len() / 2);
            for chunk in contents[2..].as_chunks::<2>().0 {
                units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            String::from_utf16(&units).ok()?
        } else if contents.len() >= 2 && contents.len().is_multiple_of(2) && contents.contains(&0) {
            let mut units = Vec::with_capacity(contents.len() / 2);
            for chunk in contents.as_chunks::<2>().0 {
                units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            String::from_utf16(&units).ok()?
        } else {
            return None;
        };
        if !zone_text_is_valid(&utf16) {
            return None;
        }
        Some(utf16.into_bytes())
    }

    let mut source_stream = match std::fs::File::open(stream_path(source)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            eprintln!("Could not read archive Mark-of-the-Web: {error}");
            return Ok(());
        }
    };
    let length = match source_stream.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            eprintln!("Could not inspect archive Mark-of-the-Web: {error}");
            return Ok(());
        }
    };
    if length > MAX_ZONE_BYTES {
        eprintln!("Archive Mark-of-the-Web is unexpectedly large; skipping copy.");
        return Ok(());
    }
    let mut contents = Vec::with_capacity(length as usize);
    if let Err(error) = source_stream.read_to_end(&mut contents) {
        eprintln!("Could not read archive Mark-of-the-Web: {error}");
        return Ok(());
    }
    let Some(payload) = decode_zone_identifier(&contents) else {
        eprintln!("Archive Mark-of-the-Web has an invalid format; skipping copy.");
        return Ok(());
    };
    let mut destination_stream = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(stream_path(destination))
        .map_err(|error| format!("Could not preserve archive Mark-of-the-Web: {error}"))?;
    destination_stream
        .write_all(&payload)
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
    let current = archive_identity_from_snapshot_handle(archive)
        .or_else(|| archive_file_identity(archive).ok())
        .ok_or_else(|| "Could not read archive identity after member preflight.".to_string())?;
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
                for later in index.saturating_add(1)..=MAX_ARCHIVE_VOLUMES.saturating_add(1) {
                    let later_candidate = parent.join(candidate_for(later));
                    if resolve_volume(&later_candidate, family_prefix, folded_siblings)?.is_some() {
                        return Err(format!(
                            "Archive volume family has a numbering gap before {}.",
                            later_candidate.display()
                        ));
                    }
                }
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
                    for later in index.saturating_add(1)..900u32 {
                        let later_letter = char::from(b'r' + (later / 100) as u8);
                        let later_candidate =
                            parent.join(format!("{base}.{later_letter}{:02}", later % 100));
                        if resolve_volume(&later_candidate, &family_prefix, &mut folded_siblings)?
                            .is_some()
                        {
                            return Err(format!(
                                "Archive volume family has a numbering gap before {}.",
                                later_candidate.display()
                            ));
                        }
                    }
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
    pub(super) stage_identity: super::journal::FileIdentity,
    pub(super) total_len: u64,
    pub(super) snapshot_strategy: SnapshotStrategy,
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
    let created_stage = match super::create_private_stage_dir(&archive, "input", cache_dir) {
        Ok(stage) => stage,
        Err(source_error) => {
            if super::staging::preparation_error_requires_recovery(&source_error) {
                return Err(source_error);
            }
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
    let stage = created_stage.path;
    let stage_identity = created_stage.identity;
    let cleanup_identity = stage_identity.clone();
    #[cfg(windows)]
    let mut hardlink_handles = Vec::new();
    #[cfg(windows)]
    let mut used_hardlink = false;
    #[cfg(not(windows))]
    let used_hardlink = false;
    let mut snapshot_strategy: Option<SnapshotStrategy> = None;
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
            #[cfg(windows)]
            let hardlinked = try_hardlink_snapshot_file(&source, &destination)?;
            #[cfg(not(windows))]
            let hardlinked = false;
            let strategy = if hardlinked {
                SnapshotStrategy::WindowsHardlink
            } else {
                copy_archive_snapshot_file(&mut source_file, &source, &destination, &should_cancel)
                    .map_err(|error| {
                        format!(
                            "Could not snapshot archive input {}: {error}",
                            source.display()
                        )
                    })?
            };
            snapshot_strategy = Some(match snapshot_strategy {
                Some(previous) => previous.merge(strategy),
                None => strategy,
            });
            let copied_identity = archive_file_identity_from_open_file(&source, &source_file)?;
            if copied_identity != expected {
                return Err(
                    "Archive changed while its private snapshot was being created; extraction was cancelled."
                        .to_string(),
                );
            }
            if !hardlinked {
                assert_archive_identity_unchanged(&source, &expected)?;
            }
            #[cfg(windows)]
            if hardlinked {
                used_hardlink = true;
                hardlink_handles.push((destination.clone(), std::sync::Arc::new(source_file)));
            }
        }
        if !used_hardlink && archive_identity_token(&archive)? != initial_token {
            return Err(
                "Archive changed while its private snapshot was being created; extraction was cancelled."
                    .to_string(),
            );
        }
        #[cfg(windows)]
        if !hardlink_handles.is_empty() {
            if let Ok(mut handles) = windows_snapshot_handles().lock() {
                handles.insert(stage.clone(), hardlink_handles);
            } else {
                return Err("Windows snapshot handle registry is unavailable.".to_string());
            }
        }
        Ok(StagedArchiveInput {
            path: stage.join(
                archive
                    .file_name()
                    .ok_or_else(|| "Archive input has no file name.".to_string())?,
            ),
            stage_identity,
            total_len,
            snapshot_strategy: snapshot_strategy.unwrap_or(SnapshotStrategy::ByteCopy),
        })
    })();
    match result {
        Ok(staged) => Ok(staged),
        Err(operation_error) => {
            // The handle registry is populated just before the staged-input
            // value is returned. If constructing that value ever fails, this
            // path runs before a CleanupPlan/SnapshotHandleGuard exists; do
            // not leave the source archive write/delete-locked while the
            // private stage is rolled back.
            #[cfg(windows)]
            release_snapshot_handles(&stage);
            let cleanup_result =
                super::journal::remove_directory_if_matches(&stage, &cleanup_identity).and_then(
                    |()| {
                        if let Some(cache) = cache_dir {
                            super::unregister_pending_stage(cache, &stage)
                        } else {
                            Ok(())
                        }
                    },
                );
            match cleanup_result {
                Ok(()) => Err(operation_error),
                Err(cleanup_error) => Err(super::staging::preparation_cleanup_failed(
                    operation_error,
                    cleanup_error,
                )),
            }
        }
    }
}

#[cfg(test)]
mod strategy_tests {
    use super::SnapshotStrategy;

    #[test]
    fn snapshot_strategy_labels_and_mixed_classification_are_stable() {
        assert_eq!(
            SnapshotStrategy::WindowsHardlink.label(),
            "windows-hardlink-lock"
        );
        assert_eq!(SnapshotStrategy::CopyFile2.label(), "windows-copyfile2");
        assert_eq!(SnapshotStrategy::CowClone.label(), "cow-clone");
        assert_eq!(SnapshotStrategy::ByteCopy.label(), "cancellable-byte-copy");
        assert_eq!(
            SnapshotStrategy::CowClone.merge(SnapshotStrategy::ByteCopy),
            SnapshotStrategy::Mixed
        );
        assert_eq!(
            SnapshotStrategy::Mixed.merge(SnapshotStrategy::ByteCopy),
            SnapshotStrategy::Mixed
        );
    }
}

#[cfg(all(test, windows))]
mod windows_snapshot_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);

    struct SnapshotTestGuard {
        root: std::path::PathBuf,
        stage: Option<std::path::PathBuf>,
    }

    impl SnapshotTestGuard {
        fn new(root: std::path::PathBuf) -> Self {
            Self { root, stage: None }
        }

        fn retain_stage(&mut self, stage: &std::path::Path) {
            self.stage = Some(stage.to_path_buf());
        }
    }

    impl Drop for SnapshotTestGuard {
        fn drop(&mut self) {
            // Each test owns a distinct stage key. Release its entry before
            // removing the root so a parallel test cannot inherit a source
            // lock from this test's registry entry.
            if let Some(stage) = self.stage.take() {
                release_snapshot_handles(&stage);
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn test_root(prefix: &str) -> std::path::PathBuf {
        loop {
            let suffix = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("{prefix}-{}-{suffix}", std::process::id()));
            match std::fs::create_dir(&root) {
                Ok(()) => return root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create Windows snapshot test directory: {error}"),
            }
        }
    }

    fn zone_identifier_path(path: &std::path::Path) -> std::path::PathBuf {
        let mut stream = path.as_os_str().to_os_string();
        stream.push(":Zone.Identifier");
        stream.into()
    }

    fn hardlink_snapshot_or_skip(
    ) -> Option<(SnapshotTestGuard, StagedArchiveInput, std::path::PathBuf)> {
        let root = test_root("zinnia-windows-hardlink-snapshot");
        let mut cleanup = SnapshotTestGuard::new(root.clone());
        let source = root.join("archive.7z");
        std::fs::write(&source, b"archive payload").expect("archive");

        // Probe once before staging. A network share or a filesystem without
        // hard-link support is a valid deployment, so skip the hard-link-only
        // assertions there instead of making the test environment-dependent.
        let probe = root.join("hardlink-probe.7z");
        if !try_hardlink_snapshot_file(&source, &probe).expect("hard-link probe") {
            eprintln!("skipping Windows hard-link snapshot test: hard links unavailable");
            return None;
        }
        std::fs::remove_file(&probe).expect("remove hard-link probe");

        let staged = super::stage_extract_input(&source, None, None).expect("snapshot archive");
        assert_eq!(
            staged.snapshot_strategy,
            SnapshotStrategy::WindowsHardlink,
            "hard-link support probe succeeded but staging selected another strategy"
        );
        let stage = staged.path.parent().expect("snapshot stage");
        cleanup.retain_stage(stage);
        Some((cleanup, staged, source))
    }

    #[test]
    fn windows_hardlink_strategy_registers_snapshot_identity() {
        let Some((_cleanup, staged, _source)) = hardlink_snapshot_or_skip() else {
            return;
        };

        let registered = archive_identity_from_snapshot_handle(&staged.path)
            .expect("hard-link snapshot identity must be registered");
        let opened = crate::path_safety::open_regular_file_nofollow_for_snapshot(&staged.path)
            .expect("open staged hard-link");
        let direct = archive_file_identity_from_open_file(&staged.path, &opened)
            .expect("read staged hard-link identity");
        assert_eq!(registered, direct);
    }

    #[test]
    fn windows_hardlink_handle_blocks_source_mutation_until_release() {
        let Some((mut cleanup, staged, source)) = hardlink_snapshot_or_skip() else {
            return;
        };
        let stage = staged.path.parent().expect("snapshot stage");
        let renamed = source.with_file_name("renamed.7z");

        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&source)
                .is_err(),
            "held snapshot handle must deny source writes"
        );
        assert!(
            std::fs::rename(&source, &renamed).is_err(),
            "held snapshot handle must deny source renames"
        );
        assert!(
            std::fs::remove_file(&source).is_err(),
            "held snapshot handle must deny source deletion"
        );

        release_snapshot_handles(stage);
        assert!(
            archive_identity_from_snapshot_handle(&staged.path).is_none(),
            "released stage must be removed from the handle registry"
        );
        std::fs::write(&source, b"mutated after release").expect("write after release");
        std::fs::rename(&source, &renamed).expect("rename after release");
        std::fs::remove_file(&renamed).expect("delete after release");
        cleanup.stage = None;
        std::fs::remove_dir_all(stage).expect("remove released snapshot stage");
    }

    #[test]
    fn windows_hardlink_unavailable_uses_copy_fallback() {
        let root = test_root("zinnia-windows-hardlink-fallback");
        let cleanup = SnapshotTestGuard::new(root.clone());
        let source = root.join("archive.7z");
        let destination = root.join("snapshot.7z");
        std::fs::write(&source, b"archive payload").expect("archive");
        let zone_contents = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        let mut zone_file = match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(zone_identifier_path(&source))
        {
            Ok(file) => file,
            Err(error) => {
                eprintln!("skipping windows_hardlink_unavailable_uses_copy_fallback: {error}");
                return;
            }
        };
        use std::io::Write as _;
        zone_file
            .write_all(zone_contents)
            .expect("write source Zone.Identifier");
        zone_file.sync_all().expect("sync source Zone.Identifier");
        drop(zone_file);

        // An existing destination directory makes hard-link creation fail
        // deterministically without relying on a second volume or network
        // share. Remove it, then exercise the copy path used after that false
        // hard-link result.
        std::fs::create_dir(&destination).expect("hard-link fallback blocker");
        assert!(
            !try_hardlink_snapshot_file(&source, &destination).expect("hard-link fallback probe")
        );
        std::fs::remove_dir(&destination).expect("remove hard-link fallback blocker");

        let mut source_file = crate::path_safety::open_regular_file_nofollow_for_snapshot(&source)
            .expect("open source for copy fallback");
        let strategy =
            copy_archive_snapshot_file(&mut source_file, &source, &destination, &|| false)
                .expect("copy fallback");
        assert!(
            matches!(
                strategy,
                SnapshotStrategy::CopyFile2 | SnapshotStrategy::ByteCopy
            ),
            "copy fallback selected unexpected strategy: {strategy:?}"
        );
        assert_eq!(
            std::fs::read(&destination).expect("fallback snapshot"),
            b"archive payload"
        );
        assert_eq!(
            std::fs::read(zone_identifier_path(&destination))
                .expect("fallback snapshot Zone.Identifier"),
            zone_contents
        );
        drop(source_file);
        drop(cleanup);
        assert!(
            !root.exists(),
            "copy fallback test cleanup must remove the test root"
        );
    }

    #[test]
    fn windows_byte_copy_zone_identifier_helper_preserves_valid_stream() {
        let root = test_root("zinnia-windows-byte-copy-motw");
        let cleanup = SnapshotTestGuard::new(root.clone());
        let source = root.join("archive.7z");
        let destination = root.join("snapshot.7z");
        std::fs::write(&source, b"archive payload").expect("archive");
        std::fs::write(&destination, b"snapshot payload").expect("snapshot");

        let zone_contents = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        let mut zone_file = match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(zone_identifier_path(&source))
        {
            Ok(file) => file,
            Err(error) => {
                eprintln!(
                    "skipping windows_byte_copy_zone_identifier_helper_preserves_valid_stream: {error}"
                );
                return;
            }
        };
        use std::io::Write as _;
        zone_file
            .write_all(zone_contents)
            .expect("write source Zone.Identifier");
        zone_file.sync_all().expect("sync source Zone.Identifier");
        drop(zone_file);

        copy_windows_zone_identifier(&source, &destination).expect("copy Zone.Identifier");
        assert_eq!(
            std::fs::read(zone_identifier_path(&destination))
                .expect("manual byte-copy Zone.Identifier"),
            zone_contents
        );

        drop(cleanup);
        assert!(
            !root.exists(),
            "manual Zone.Identifier test cleanup must remove the test root"
        );
    }
}
