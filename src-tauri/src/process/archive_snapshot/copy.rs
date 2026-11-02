//! Archive snapshot copy strategies.

#[cfg(windows)]
use super::motw::copy_windows_zone_identifier;

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
        // SAFETY: `source` is an open File, so its fd is valid for the call. `dest_c` is a live
        // NUL-terminated string. AT_FDCWD is the documented dirfd for a cwd-relative destination.
        // fclonefileat does not retain either pointer, and its create-new behavior comes from the
        // kernel (EEXIST).
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
    // SAFETY: `source` and `destination_file` are open Files, so both fds are valid for the call.
    // FICLONE takes the source fd as a plain int argument and does not retain it.
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
pub(super) fn try_hardlink_snapshot_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<bool, String> {
    // Attributes belong to the file, not the link. Stage cleanup clears the
    // read-only attribute before deleting, which would also strip it from the
    // user's archive. Copy read-only archives instead.
    match std::fs::metadata(source) {
        Ok(metadata) if !metadata.permissions().readonly() => {}
        _ => return Ok(false),
    }
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

/// # Safety
/// Called only by CopyFile2, synchronously, with `callback_context` set to the address of a live
/// `CopyFile2Context` whose `cancel` pointer refers to a live BOOL for the duration of the call.
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
    // SAFETY: both wide paths are NUL-terminated and alive for the call. `parameters` is fully
    // initialized, with dwSize set to its own size. `cancel` and `context` are locals that outlive
    // the call, and the progress routine runs only during it.
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
    pub(in crate::process) fn label(self) -> &'static str {
        match self {
            Self::WindowsHardlink => "windows-hardlink-lock",
            Self::CopyFile2 => "windows-copyfile2",
            Self::CowClone => "cow-clone",
            Self::ByteCopy => "cancellable-byte-copy",
            Self::Mixed => "mixed-snapshot-strategies",
        }
    }

    pub(super) fn merge(self, other: Self) -> Self {
        if self == other {
            self
        } else {
            Self::Mixed
        }
    }
}

pub(super) fn copy_archive_snapshot_file<C>(
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
                    crate::process::commit::sync_file_best_effort(&synced)?;
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
                let result = crate::process::commit::sync_file_best_effort(&destination_file);
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
        crate::process::commit::sync_file_best_effort(&destination_file)
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
fn ensure_snapshot_byte_copy_space(
    source: &std::fs::File,
    destination: &std::path::Path,
) -> Result<(), String> {
    const MIN_SNAPSHOT_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
    let required = source.metadata().map_err(|error| error.to_string())?.len();
    let free_space = crate::process::available_space_for_path(destination)?;
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
