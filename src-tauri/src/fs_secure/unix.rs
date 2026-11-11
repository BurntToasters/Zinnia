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
    let mode = (parent_mode & 0o777) | (u32::from(st.st_mode) & 0o7000);
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

/// Atomically rename one component to another inside one held directory with
/// no-replace semantics: Linux `RENAME_NOREPLACE`, macOS `RENAME_EXCL`.
#[cfg(unix)]
pub(crate) fn rename_relative_no_replace(
    directory: &std::fs::File,
    source: &std::ffi::CStr,
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
            directory,
            source,
            directory,
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
        let _ = (directory, source, target);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "exclusive descriptor-relative rename is unavailable",
        ))
    }
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
    match rename_relative_no_replace(directory, quarantine, original) {
        Ok(()) => Err(io::Error::other(reason.to_string())),
        Err(restore_error) => Err(io::Error::other(format!(
            "{reason} The entry was preserved beside {} under {} because its original name could not be restored: {restore_error}",
            display_path.display(),
            quarantine.to_string_lossy()
        ))),
    }
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
