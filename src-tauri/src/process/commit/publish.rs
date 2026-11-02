//! No-replace publish paths (rename, copy, tree).

use super::super::journal::{file_identity, remove_regular_file_if_matches, FileIdentity};
use super::sync_file_best_effort;
use super::PublishStrategy;

#[cfg(test)]
pub(crate) fn publish_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    publish_file_no_replace_with_created(source, target, |_, _| Ok(())).map(|_| ())
}
pub(super) fn publish_file_no_replace_with_created(
    source: &std::path::Path,
    target: &std::path::Path,
    on_created: impl FnOnce(&std::path::Path, &FileIdentity) -> Result<(), String>,
) -> Result<PublishStrategy, String> {
    let source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    // Same as directory fsync: some Windows setups deny FlushFileBuffers.
    sync_file_best_effort(&source_file)?;

    drop(source_file);

    // Stage directories are siblings of their destinations, so rename is a
    // same-filesystem atomic move. Every publication path refuses an existing
    // target, and no error path unlinks a pathname whose identity may have changed.
    // Only the final create-new copy fallback can expose bytes incrementally.
    match rename_file_no_replace(source, target) {
        Ok(()) => Ok(PublishStrategy::DirectRename),
        Err(rename_error) => {
            // Older Unix filesystems may not implement the exclusive-rename
            // syscall. A hard link is also atomic and no-replace. Once linked,
            // failure to remove the private source is cleanup-only; the stage
            // scrub will retry after the durable commit point.
            let strategy = if let Err(link_error) = std::fs::hard_link(source, target) {
                // Some removable, network, and userspace filesystems support
                // neither exclusive rename nor hard links. create_new still
                // guarantees that this compatibility path never overwrites an
                // existing destination. The recovery journal removes a partial
                // file after interruption; only this fallback loses atomic
                // visibility because the filesystem provides no atomic primitive.
                copy_file_no_replace_with_created(source, target, on_created).map_err(|copy_error| {
                    format!(
                        "Could not publish archive output {} without replacement: {rename_error}; hard-link fallback failed: {link_error}; exclusive-copy fallback failed: {copy_error}",
                        target.display()
                    )
                })?;
                PublishStrategy::CopyFallback
            } else {
                PublishStrategy::HardLinkFallback
            };
            if let Err(error) = std::fs::remove_file(source) {
                eprintln!(
                    "Archive output published; staged source cleanup failed for {}: {error}",
                    source.display()
                );
            }
            Ok(strategy)
        }
    }
}

#[cfg(any(windows, test))]
pub(crate) fn copy_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    copy_file_no_replace_with_created(source, target, |_, _| Ok(()))
}

pub(super) fn copy_file_no_replace_with_created(
    source: &std::path::Path,
    target: &std::path::Path,
    on_created: impl FnOnce(&std::path::Path, &FileIdentity) -> Result<(), String>,
) -> Result<(), String> {
    let mut source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    #[cfg(unix)]
    let source_metadata = source_file.metadata().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let source_permissions = source_metadata.permissions();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        options.mode(source_permissions.mode());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        // Keep the newly created object stable while its identity is journaled
        // and its bytes are copied. Readers are harmless; writers, renames, and
        // deletion stay blocked until the copy is durable.
        options.share_mode(FILE_SHARE_READ);
    }
    let mut target_file = options.open(target).map_err(|error| error.to_string())?;
    // Capture the identity while our exclusive create handle is still open.
    // If a later copy step fails, cleanup is allowed only for this exact file.
    let target_identity = file_identity(&target_file)?;
    let copy_result = (|| {
        on_created(target, &target_identity)?;
        std::io::copy(&mut source_file, &mut target_file).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            let times = std::fs::FileTimes::new()
                .set_accessed(
                    source_metadata
                        .accessed()
                        .map_err(|error| error.to_string())?,
                )
                .set_modified(
                    source_metadata
                        .modified()
                        .map_err(|error| error.to_string())?,
                );
            target_file
                .set_times(times)
                .map_err(|error| error.to_string())?;
            target_file
                .set_permissions(source_permissions)
                .map_err(|error| error.to_string())?;
        }
        #[cfg(windows)]
        copy_windows_times_and_attributes(source, &source_file, target, &target_file, false)?;
        sync_file_best_effort(&target_file)
    })();
    drop(target_file);
    if let Err(error) = copy_result {
        return exclusive_copy_cleanup_error(target, &target_identity, error);
    }
    let stamp_result = {
        #[cfg(windows)]
        {
            super::copy_windows_zone_identifier(source, target)
        }
        #[cfg(target_os = "macos")]
        {
            copy_macos_quarantine_xattr(source, target)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (source, target);
            Ok(())
        }
    };
    if let Err(error) = stamp_result {
        return exclusive_copy_cleanup_error(target, &target_identity, error);
    }
    Ok(())
}

fn exclusive_copy_cleanup_error(
    target: &std::path::Path,
    target_identity: &FileIdentity,
    error: String,
) -> Result<(), String> {
    if let Err(cleanup_error) = remove_regular_file_if_matches(target, target_identity) {
        return Err(format!(
            "{error}; partial destination cleanup failed: {cleanup_error}"
        ));
    }
    Err(error)
}

#[cfg(target_os = "macos")]
fn copy_macos_quarantine_xattr(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    fn c_path(path: &std::path::Path) -> Result<CString, String> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "Path contains an interior NUL.".to_string())
    }

    let source_c = c_path(source)?;
    let target_c = c_path(target)?;
    let name = CString::new("com.apple.quarantine").expect("static xattr name");
    // SAFETY: `source_c` and `name` are live NUL-terminated CStrings. A null buffer with size 0 is
    // getxattr's documented size query, which writes nothing.
    let size = unsafe {
        libc::getxattr(
            source_c.as_ptr(),
            name.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        )
    };
    if size < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOATTR) {
            return Ok(());
        }
        eprintln!("Could not read com.apple.quarantine: {error}");
        return Ok(());
    }
    let mut buffer = vec![0u8; size as usize];
    // SAFETY: `buffer` is a live allocation of exactly `buffer.len()` bytes, the same length passed
    // to getxattr, so the kernel writes only inside it. `source_c` and `name` are live
    // NUL-terminated CStrings.
    let read = unsafe {
        libc::getxattr(
            source_c.as_ptr(),
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            0,
            0,
        )
    };
    if read < 0 {
        eprintln!(
            "Could not read com.apple.quarantine: {}",
            std::io::Error::last_os_error()
        );
        return Ok(());
    }
    buffer.truncate(read as usize);
    // SAFETY: `target_c` and `name` are live NUL-terminated CStrings. `buffer` holds the
    // `buffer.len()` bytes read above, and setxattr only reads them.
    let written = unsafe {
        libc::setxattr(
            target_c.as_ptr(),
            name.as_ptr(),
            buffer.as_ptr().cast(),
            buffer.len(),
            0,
            0,
        )
    };
    if written != 0 {
        return Err(format!(
            "Could not preserve com.apple.quarantine: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn copy_windows_times_and_attributes(
    source_path: &std::path::Path,
    source: &std::fs::File,
    target_path: &std::path::Path,
    target: &std::fs::File,
    directory: bool,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::fs::MetadataExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::{FILETIME, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileTime, SetFileAttributesW, SetFileTime, FILE_ATTRIBUTE_ARCHIVE,
        FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_NOT_CONTENT_INDEXED,
        FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM,
    };

    let mut created = FILETIME::default();
    let mut accessed = FILETIME::default();
    let mut modified = FILETIME::default();
    // SAFETY: `source` is a live File borrowed for this call, so its raw handle is valid. The three
    // FILETIME out-pointers refer to live locals.
    if unsafe {
        GetFileTime(
            source.as_raw_handle() as HANDLE,
            &mut created,
            &mut accessed,
            &mut modified,
        )
    } == 0
    {
        return Err(format!(
            "Could not read extracted {} timestamps: {}",
            source_path.display(),
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `target` is a live File borrowed for this call, so its handle is valid. The FILETIME
    // arguments point at live locals and are only read. If the handle lacks write access, the call
    // fails and that error is returned.
    if unsafe {
        SetFileTime(
            target.as_raw_handle() as HANDLE,
            &created,
            &accessed,
            &modified,
        )
    } == 0
    {
        return Err(format!(
            "Could not preserve extracted {} timestamps: {}",
            target_path.display(),
            std::io::Error::last_os_error()
        ));
    }

    let source_attributes = std::fs::symlink_metadata(source_path)
        .map_err(|error| error.to_string())?
        .file_attributes();
    let allowed = FILE_ATTRIBUTE_READONLY
        | FILE_ATTRIBUTE_HIDDEN
        | FILE_ATTRIBUTE_SYSTEM
        | FILE_ATTRIBUTE_ARCHIVE
        | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
    let mut target_attributes = source_attributes & allowed;
    if directory {
        target_attributes &= !(FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM);
    }
    if target_attributes == 0 {
        target_attributes = FILE_ATTRIBUTE_NORMAL;
    }
    let target_wide: Vec<u16> = target_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `target_wide` is NUL-terminated (`chain(once(0))`) and alive for the call.
    if unsafe { SetFileAttributesW(target_wide.as_ptr(), target_attributes) } == 0 {
        return Err(format!(
            "Could not preserve extracted {} attributes: {}",
            target_path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn open_directory_for_metadata(
    path: &std::path::Path,
    write: bool,
) -> Result<std::fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
    };

    let mut options = std::fs::OpenOptions::new();
    options
        .access_mode(if write {
            FILE_WRITE_ATTRIBUTES
        } else {
            FILE_READ_ATTRIBUTES
        })
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path).map_err(|error| error.to_string())
}

#[cfg(windows)]
pub(super) fn copy_windows_directory_metadata(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    let source_file = open_directory_for_metadata(source, false)?;
    let target_file = open_directory_for_metadata(target, true)?;
    copy_windows_times_and_attributes(source, &source_file, target, &target_file, true)
}

pub(super) fn copy_tree_with_inherited_acl(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        let metadata =
            std::fs::symlink_metadata(&source_child).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            // Recreate already-validated relative links under the final parent
            // so the containing tree inherits destination ACL/mode policy.
            let link_target =
                std::fs::read_link(&source_child).map_err(|error| error.to_string())?;
            #[cfg(windows)]
            {
                let is_directory_link = {
                    use std::os::windows::fs::FileTypeExt as _;
                    metadata.file_type().is_symlink_dir()
                };
                if is_directory_link {
                    std::os::windows::fs::symlink_dir(&link_target, &target_child)
                        .map_err(|error| error.to_string())?;
                } else {
                    std::os::windows::fs::symlink_file(&link_target, &target_child)
                        .map_err(|error| error.to_string())?;
                }
            }
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&link_target, &target_child)
                    .map_err(|error| error.to_string())?;
            }
            continue;
        }
        if crate::path_safety::is_link_or_reparse(&metadata) {
            return Err(format!(
                "Archive contains a symbolic link or reparse point: {}",
                source_child.display()
            ));
        }
        if metadata.is_dir() {
            // Create restrictive first, then relax to the parent policy: never
            // leave a brief world-readable window on shared parents.
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&target_child)
                    .map_err(|error| error.to_string())?;
            }
            #[cfg(not(unix))]
            {
                std::fs::create_dir(&target_child).map_err(|error| error.to_string())?;
            }
            // Plain create inherits default ACL / setgid from `target`. Apply
            // parent mode before recursing so nested creates see the corrected
            // policy, not a brief umask-only mode.
            #[cfg(unix)]
            crate::fs_secure::apply_parent_directory_mode(&target_child)
                .map_err(|error| error.to_string())?;
            copy_tree_with_inherited_acl(&source_child, &target_child)?;
            #[cfg(windows)]
            copy_windows_directory_metadata(&source_child, &target_child)?;
        } else if metadata.is_file() {
            copy_file_no_replace_with_created(&source_child, &target_child, |_, _| Ok(()))?;
        } else {
            return Err(format!(
                "Archive contains an unsupported entry: {}",
                source_child.display()
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn rename_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::MoveFileW;

    // `std::fs::rename` can replace an existing destination on Windows. Use
    // MoveFileW instead: unlike MoveFileEx with MOVEFILE_REPLACE_EXISTING, it
    // fails when the target already exists.
    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target_wide: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both wide paths are NUL-terminated and alive for the call. MoveFileW only reads them,
    // and without MOVEFILE_REPLACE_EXISTING it fails rather than overwriting.
    if unsafe { MoveFileW(source_wide.as_ptr(), target_wide.as_ptr()) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn rename_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt as _;

    // SAFETY: matches macOS `int renamex_np(const char *, const char *, unsigned int)`. Callers
    // pass NUL-terminated CStrings that live across the call.
    unsafe extern "C" {
        fn renamex_np(
            old: *const std::ffi::c_char,
            new: *const std::ffi::c_char,
            flags: u32,
        ) -> std::ffi::c_int;
    }

    const RENAME_EXCL: u32 = 0x0000_0004;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())
        .map_err(|_| "Archive staging path contains a NUL byte.".to_string())?;
    let target = std::ffi::CString::new(target.as_os_str().as_bytes())
        .map_err(|_| "Archive output path contains a NUL byte.".to_string())?;
    // SAFETY: `source` and `target` are NUL-terminated CStrings alive for the call. The declaration
    // matches macOS `renamex_np(const char *, const char *, unsigned int)`. RENAME_EXCL makes the
    // call fail, not replace, when the target exists.
    let result = unsafe { renamex_np(source.as_ptr(), target.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) fn rename_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt as _;

    // SAFETY: matches the renameat2(2) prototype that glibc exports (2.28+). Callers pass
    // NUL-terminated CStrings that live across the call, and AT_FDCWD for path-based (cwd-relative)
    // operation.
    unsafe extern "C" {
        fn renameat2(
            olddirfd: std::ffi::c_int,
            oldpath: *const std::ffi::c_char,
            newdirfd: std::ffi::c_int,
            newpath: *const std::ffi::c_char,
            flags: u32,
        ) -> std::ffi::c_int;
    }

    const AT_FDCWD: std::ffi::c_int = -100;
    const RENAME_NOREPLACE: u32 = 1;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())
        .map_err(|_| "Archive staging path contains a NUL byte.".to_string())?;
    let target = std::ffi::CString::new(target.as_os_str().as_bytes())
        .map_err(|_| "Archive output path contains a NUL byte.".to_string())?;
    // SAFETY: `source` and `target` are NUL-terminated CStrings alive for the call. AT_FDCWD
    // resolves both paths relative to the working directory, as the path-based API does. The
    // declaration matches renameat2(2), and RENAME_NOREPLACE makes the call fail, not replace, when
    // the target exists.
    let result = unsafe {
        renameat2(
            AT_FDCWD,
            source.as_ptr(),
            AT_FDCWD,
            target.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
)))]
pub(crate) fn rename_file_no_replace(
    _source: &std::path::Path,
    _target: &std::path::Path,
) -> Result<(), String> {
    Err("Atomic no-replace rename is unavailable on this platform.".to_string())
}
