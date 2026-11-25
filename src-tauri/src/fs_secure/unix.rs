//! Unix nofollow opens, quarantine helpers, and private directory create.

use std::io;
use std::path::Path;

#[cfg(unix)]
pub(crate) fn open_directory_nofollow(path: &Path) -> io::Result<std::fs::File> {
    use rustix::fs::OFlags;
    let directory = open_unix_path(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
    )?;
    if !directory.metadata()?.is_dir() {
        return Err(io::Error::other("Staging path is not a directory."));
    }
    Ok(directory)
}

#[cfg(unix)]
pub(crate) fn create_stage_directory_in_held_parent(
    parent: &Path,
    name: &std::ffi::OsStr,
    mode: libc::mode_t,
) -> io::Result<std::fs::File> {
    use rustix::fs::{Mode, OFlags};

    let parent_directory = open_unix_path(
        parent,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
    )?;
    let name = unix_component(name)?;
    rustix::fs::mkdirat(&parent_directory, &name, Mode::from_raw_mode(mode))?;
    // Directory creation has no portable create-and-return-handle operation.
    // Open immediately by one component relative to the still-held parent, then
    // prove that the public entry and returned handle identify the same object.
    // Ownership is recorded only from this handle, never from a later path stat.
    let directory = open_directory_relative(&parent_directory, &name)?;
    let opened = stat_open_file(&directory)?;
    let named = stat_named_entry(&parent_directory, &name)?;
    if !same_unix_object(&opened, &named) || opened.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::other(
            "New staging directory changed while its creation handle was acquired.",
        ));
    }
    Ok(directory)
}
#[cfg(unix)]
pub fn apply_parent_directory_mode(path: &Path) -> io::Result<()> {
    use rustix::fs::{Mode, OFlags};
    use std::os::unix::ffi::OsStrExt;

    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    if path.as_os_str().as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path has interior NUL",
        ));
    }
    // Re-open the publish target with O_NOFOLLOW and read its mode from that
    // fd, so a symlink swap after the rename cannot redirect the chmod to an
    // outside victim. Compare device/inode to reject a swapped path.
    let directory = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    copy_parent_mode_to_held_directory(&directory, parent)
}

#[cfg(unix)]
pub(crate) fn copy_parent_mode_to_held_directory(
    directory: &rustix::fd::OwnedFd,
    parent: &Path,
) -> io::Result<()> {
    use rustix::fs::Mode;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let st = rustix::fs::fstat(directory)?;
    if st.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::other("publish target is not a directory"));
    }
    let parent_metadata = std::fs::metadata(parent)?;
    // Refuse if `path` and `parent` are the same inode (path == parent).
    if parent_metadata.dev() as u64 == st.st_dev as u64
        && parent_metadata.ino() as u64 == st.st_ino as u64
    {
        return Err(io::Error::other(
            "publish target and its parent are the same directory",
        ));
    }
    let parent_mode = parent_metadata.permissions().mode();
    // mode_t is u16 on macOS; u32::from is a no-op on Linux.
    #[allow(clippy::useless_conversion)]
    let current_mode = u32::from(st.st_mode);
    let standard = current_mode & 0o777;
    // A stage root is created 0o700 and should adopt its published parent's
    // policy. Any other mode came from the archive itself and is preserved.
    let mode = if standard == 0o700 {
        parent_mode & 0o777
    } else {
        standard
    };
    let mode = mode | (current_mode & 0o7000);
    rustix::fs::fchmod(directory, Mode::from_raw_mode(mode as _))?;
    Ok(())
}
#[cfg(unix)]
pub(crate) fn unix_component(value: &std::ffi::OsStr) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt as _;
    let bytes = value.as_bytes();
    // mkdirat accepts "a/b"; reject anything that is not one safe component.
    if bytes.is_empty()
        || bytes.contains(&b'/')
        || value == std::ffi::OsStr::new(".")
        || value == std::ffi::OsStr::new("..")
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a single safe path component",
        ));
    }
    std::ffi::CString::new(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains NUL"))
}

/// Open a path-based entry with the exact flags supplied by the caller. A path
/// containing NUL is rejected before any syscall, with the same error kind and
/// message std uses for `OpenOptions::open`.
#[cfg(unix)]
pub(crate) fn open_unix_path(path: &Path, flags: rustix::fs::OFlags) -> io::Result<std::fs::File> {
    use std::os::unix::ffi::OsStrExt as _;
    if path.as_os_str().as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file name contained an unexpected NUL byte",
        ));
    }
    let fd = rustix::fs::open(path, flags, rustix::fs::Mode::empty())?;
    Ok(std::fs::File::from(fd))
}

/// Atomically rename one component to another across two held directories with
/// no-replace semantics: Linux `RENAME_NOREPLACE`, macOS `RENAME_EXCL`.
#[cfg(unix)]
fn rename_between_no_replace(
    source_directory: &std::fs::File,
    source: &std::ffi::CStr,
    target_directory: &std::fs::File,
    target: &std::ffi::CStr,
) -> io::Result<()> {
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    ))]
    {
        use rustix::fs::{renameat_with, RenameFlags};
        Ok(renameat_with(
            source_directory,
            source,
            target_directory,
            target,
            RenameFlags::NOREPLACE,
        )?)
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = (source_directory, source, target_directory, target);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "exclusive descriptor-relative rename is unavailable",
        ))
    }
}

/// No-replace rename across two held directories with a compatibility fallback
/// for filesystems that reject `RENAME_NOREPLACE`/`RENAME_EXCL` (for example
/// FAT/exFAT via msdosfs). The primary exclusive syscall is always tried first
/// so APFS/HFS+ behavior is unchanged. The fallback proves the target is absent,
/// performs a plain rename, then proves the moved object is the one recorded
/// before the rename. Cross-device renames fail with EXDEV and are never copied.
#[cfg(unix)]
pub(crate) fn rename_between_no_replace_with_fallback(
    source_directory: &std::fs::File,
    source: &std::ffi::CStr,
    target_directory: &std::fs::File,
    target: &std::ffi::CStr,
) -> io::Result<()> {
    match rename_between_no_replace(source_directory, source, target_directory, target) {
        Ok(()) => Ok(()),
        Err(error)
            if is_unsupported_file_flush(&error) || error.kind() == io::ErrorKind::Unsupported =>
        {
            rename_between_compatibility_fallback(
                source_directory,
                source,
                target_directory,
                target,
            )
        }
        Err(error) => Err(error),
    }
}

/// Same-directory form of [`rename_between_no_replace_with_fallback`].
#[cfg(unix)]
pub(crate) fn rename_relative_no_replace_with_fallback(
    directory: &std::fs::File,
    source: &std::ffi::CStr,
    target: &std::ffi::CStr,
) -> io::Result<()> {
    rename_between_no_replace_with_fallback(directory, source, directory, target)
}

#[cfg(unix)]
fn rename_between_compatibility_fallback(
    source_directory: &std::fs::File,
    source: &std::ffi::CStr,
    target_directory: &std::fs::File,
    target: &std::ffi::CStr,
) -> io::Result<()> {
    let source_stat = stat_named_entry(source_directory, source)?;
    match stat_named_entry(target_directory, target) {
        // Match the errno an exclusive rename reports for an existing target.
        Ok(_) => return Err(io::Error::from_raw_os_error(libc::EEXIST)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    rustix::fs::renameat(source_directory, source, target_directory, target)?;
    let target_stat = stat_named_entry(target_directory, target)?;
    if !same_unix_object(&source_stat, &target_stat) {
        return Err(io::Error::other(
            "cleanup compatibility rename target was replaced",
        ));
    }
    Ok(())
}

/// Path-based convenience for [`rename_between_no_replace_with_fallback`]: each
/// parent directory is opened separately with the same no-follow directory
/// flags used by the other cleanup helpers. Parents may differ when both are on
/// the same filesystem.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
))]
pub(crate) fn rename_no_replace_with_fallback(
    source_path: &Path,
    target_path: &Path,
) -> io::Result<()> {
    use rustix::fs::OFlags;

    let source_parent = source_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let target_parent = target_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let source = source_path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "source path has no file name")
    })?;
    let target = target_path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "target path has no file name")
    })?;
    let source = unix_component(source)?;
    let target = unix_component(target)?;
    let directory_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let source_directory = open_unix_path(source_parent, directory_flags)?;
    let target_directory = open_unix_path(target_parent, directory_flags)?;
    rename_between_no_replace_with_fallback(&source_directory, &source, &target_directory, &target)
}

#[cfg(unix)]
pub(crate) fn stat_open_file(file: &std::fs::File) -> io::Result<rustix::fs::Stat> {
    Ok(rustix::fs::fstat(file)?)
}

#[cfg(unix)]
pub(crate) fn stat_named_entry(
    directory: &std::fs::File,
    name: &std::ffi::CStr,
) -> io::Result<rustix::fs::Stat> {
    Ok(rustix::fs::statat(
        directory,
        name,
        rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
    )?)
}

#[cfg(unix)]
pub(crate) fn same_unix_object(left: &rustix::fs::Stat, right: &rustix::fs::Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode & libc::S_IFMT == right.st_mode & libc::S_IFMT
}

#[cfg(unix)]
pub(crate) fn open_regular_relative(
    directory: &std::fs::File,
    name: &std::ffi::CStr,
) -> io::Result<std::fs::File> {
    use rustix::fs::{Mode, OFlags};
    let fd = rustix::fs::openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )?;
    let file = std::fs::File::from(fd);
    let stat = stat_open_file(&file)?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(io::Error::other("cleanup entry is not a regular file"));
    }
    let flags = rustix::fs::fcntl_getfl(&file)?;
    rustix::fs::fcntl_setfl(&file, flags.difference(OFlags::NONBLOCK))?;
    Ok(file)
}

#[cfg(unix)]
pub(crate) fn open_directory_relative(
    directory: &std::fs::File,
    name: &std::ffi::CStr,
) -> io::Result<std::fs::File> {
    use rustix::fs::{Mode, OFlags};
    let fd = rustix::fs::openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    Ok(std::fs::File::from(fd))
}

#[cfg(unix)]
pub(crate) fn restore_quarantine<T>(
    directory: &std::fs::File,
    quarantine: &std::ffi::CStr,
    original: &std::ffi::CStr,
    display_path: &Path,
    reason: &str,
) -> io::Result<T> {
    match rename_relative_no_replace_with_fallback(directory, quarantine, original) {
        Ok(()) => Err(io::Error::other(reason.to_string())),
        Err(restore_error) => Err(io::Error::other(format!(
            "{reason} The entry was preserved beside {} under {} because its original name could not be restored: {restore_error}",
            display_path.display(),
            quarantine.to_string_lossy()
        ))),
    }
}

const APPLE_DOUBLE_PREFIX: &[u8] = b"._";

#[cfg(unix)]
fn is_apple_double_name(name: &std::ffi::CStr) -> bool {
    name.to_bytes().starts_with(APPLE_DOUBLE_PREFIX)
}

#[cfg(unix)]
fn apple_double_sibling(name: &std::ffi::CStr) -> Option<std::ffi::CString> {
    let bytes = name.to_bytes();
    if is_apple_double_name(name) {
        return None;
    }
    let mut sibling = Vec::with_capacity(bytes.len() + APPLE_DOUBLE_PREFIX.len());
    sibling.extend_from_slice(APPLE_DOUBLE_PREFIX);
    sibling.extend_from_slice(bytes);
    std::ffi::CString::new(sibling).ok()
}

/// Remove the macOS `._name` AppleDouble sidecar for an owned entry. On FAT
/// volumes this is the filesystem's xattr storage for the base object, so it is
/// cleanup-only and never an error of its own.
#[cfg(unix)]
pub(crate) fn remove_apple_double_sibling(directory: &std::fs::File, name: &std::ffi::CStr) {
    let Some(sibling) = apple_double_sibling(name) else {
        return;
    };
    let _ = rustix::fs::unlinkat(directory, &sibling, rustix::fs::AtFlags::empty());
}

#[cfg(unix)]
pub(crate) fn remove_directory_contents_relative(directory: &std::fs::File) -> io::Result<()> {
    use rustix::fs::{AtFlags, Dir};

    // `Dir::read_from` opens its own descriptor for the held directory, so the
    // iteration state is independent of `directory` and closes on drop.
    let entries = Dir::read_from(directory)?;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        // msdosfs exposes xattrs as `._name` sidecars. They belong to the base
        // entry and may reject ordinary opens with EPERM, so never inspect them
        // as ordinary entries. Best-effort unlink also clears an orphan sidecar
        // so it cannot make the containing directory non-empty.
        if is_apple_double_name(name) {
            let _ = rustix::fs::unlinkat(directory, name, AtFlags::empty());
            continue;
        }
        let stat = stat_named_entry(directory, name)?;
        if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
            let child = open_directory_relative(directory, name)?;
            remove_directory_contents_relative(&child)?;
            let named_after = stat_named_entry(directory, name)?;
            let opened = stat_open_file(&child)?;
            if !same_unix_object(&named_after, &opened) {
                return Err(io::Error::other(
                    "Directory entry changed during quarantined cleanup.",
                ));
            }
            drop(child);
            rustix::fs::unlinkat(directory, name, AtFlags::REMOVEDIR)?;
        } else {
            rustix::fs::unlinkat(directory, name, AtFlags::empty())?;
        }
        remove_apple_double_sibling(directory, name);
    }
    Ok(())
}
#[cfg(unix)]
pub(crate) fn is_unsupported_file_flush(error: &std::io::Error) -> bool {
    let Some(code) = error.raw_os_error() else {
        return false;
    };
    // Compare with `==` (not an or-pattern): on Linux `ENOTSUP` and
    // `EOPNOTSUPP` are the same constant, which makes
    // `ENOTSUP | EOPNOTSUPP` an unreachable-pattern error under clippy.
    // On Darwin they are distinct (45 vs 102).
    use rustix::io::Errno;
    let errno = Errno::from_raw_os_error(code);
    errno == Errno::NOTTY
        || errno == Errno::NOTSUP
        || errno == Errno::OPNOTSUPP
        || errno == Errno::INVAL
}

/// Copy the macOS quarantine xattr to a published target. Prefer `fsetxattr` on
/// the still-open target handle so a renamed path cannot redirect the write.
/// A path fallback uses `XATTR_NOFOLLOW`. Quarantine is best effort: volumes
/// without xattr support and `._` AppleDouble targets are accepted without it.
#[cfg(target_os = "macos")]
pub(crate) fn copy_macos_quarantine_xattr(
    source: &Path,
    target: &Path,
    target_file: Option<&std::fs::File>,
) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::io::AsRawFd as _;

    const QUARANTINE_ATTRIBUTE: &std::ffi::CStr = c"com.apple.quarantine";

    fn c_path(path: &Path) -> io::Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
    }

    fn is_apple_double_target(path: &Path) -> bool {
        path.file_name()
            .is_some_and(|name| name.as_bytes().starts_with(APPLE_DOUBLE_PREFIX))
    }

    let source_c = c_path(source)?;
    let target_c = c_path(target)?;
    // SAFETY: `source_c` and the attribute name are live NUL-terminated
    // CStrings. A null buffer with size 0 is getxattr's size query.
    let size = unsafe {
        libc::getxattr(
            source_c.as_ptr(),
            QUARANTINE_ATTRIBUTE.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if size < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOATTR) || is_unsupported_file_flush(&error) {
            return Ok(());
        }
        eprintln!(
            "Could not read com.apple.quarantine from {}: {error}",
            source.display()
        );
        return Ok(());
    }
    let mut buffer = vec![0u8; size as usize];
    // SAFETY: `buffer` is writable for exactly `buffer.len()` bytes and the
    // attribute name is a live NUL-terminated CString.
    let read = unsafe {
        libc::getxattr(
            source_c.as_ptr(),
            QUARANTINE_ATTRIBUTE.as_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if read < 0 {
        eprintln!(
            "Could not read com.apple.quarantine from {}: {}",
            source.display(),
            io::Error::last_os_error()
        );
        return Ok(());
    }
    buffer.truncate(read as usize);
    let written = if let Some(file) = target_file {
        // SAFETY: the descriptor is open for the target object and `buffer`
        // holds the bytes read above; fsetxattr only reads them.
        unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                QUARANTINE_ATTRIBUTE.as_ptr(),
                buffer.as_ptr().cast(),
                buffer.len(),
                0,
                0,
            )
        }
    } else {
        // SAFETY: `target_c` and the attribute name are live NUL-terminated
        // CStrings. `buffer` holds the bytes read above and is only read.
        unsafe {
            libc::setxattr(
                target_c.as_ptr(),
                QUARANTINE_ATTRIBUTE.as_ptr(),
                buffer.as_ptr().cast(),
                buffer.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        }
    };
    if written == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if is_unsupported_file_flush(&error)
        || (error.raw_os_error() == Some(libc::EPERM) && is_apple_double_target(target))
    {
        return Ok(());
    }
    Err(error)
}
