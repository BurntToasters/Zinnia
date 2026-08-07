//! Promote/merge staged outputs, commit and rollback cleanup.

use super::journal::move_identity_log_path;
use super::journal::{
    ensure_path_entry_identity, ensure_path_identity, ensure_recovery_path_unchanged,
    file_identities_match, file_identity, identity_with_file_content,
    identity_with_fingerprint_from, mark_archive_journal_committed, mark_extract_journal_committed,
    move_plan_path, path_identity, path_identity_with_fingerprint, record_archive_journal_backup,
    record_archive_journal_published, regular_file_identity,
    regular_file_identity_with_fingerprint, remove_move_plan_sidecars,
    remove_regular_file_if_matches, sync_directory, unregister_plan_stages, update_archive_journal,
    FileIdentity, MoveRecord, LEGACY_MOVE_PLAN_FILE_NAME,
};
use super::quota::{MAX_EXTRACT_ENTRIES, MAX_EXTRACT_PATH_BYTES};
use super::staging::{assert_real_directory, path_entry_exists};
use super::{ArchiveDestinationSnapshot, CleanupPlan};

pub(crate) fn archive_destination_snapshot(
    path: &std::path::Path,
) -> Result<ArchiveDestinationSnapshot, String> {
    let mut file = crate::path_safety::open_regular_file_nofollow(path)?;
    archive_destination_snapshot_from_open_file(path, &mut file)
}

fn archive_destination_snapshot_from_open_file(
    path: &std::path::Path,
    file: &mut std::fs::File,
) -> Result<ArchiveDestinationSnapshot, String> {
    use sha2::Digest as _;
    use std::io::Read as _;

    let identity = file_identity(file)?;
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
    let after_identity = file_identity(file)?;
    let after_metadata = file.metadata().map_err(|error| error.to_string())?;
    if !file_identities_match(&identity, &after_identity)
        || len != after_metadata.len()
        || modified != after_metadata.modified().ok()
    {
        return Err(format!(
            "Archive destination changed while it was being fingerprinted: {}",
            path.display()
        ));
    }
    Ok(ArchiveDestinationSnapshot {
        path: path.to_path_buf(),
        identity,
        len,
        modified,
        sha256: hasher.finalize().into(),
    })
}

pub(crate) fn archive_destination_family_snapshot(
    base: &std::path::Path,
) -> Result<Vec<ArchiveDestinationSnapshot>, String> {
    archive_family(base)?
        .iter()
        .map(|path| archive_destination_snapshot(path))
        .collect()
}

pub(crate) fn assert_archive_destination_unchanged(
    base: &std::path::Path,
    expected: &[ArchiveDestinationSnapshot],
) -> Result<(), String> {
    let current = archive_destination_family_snapshot(base)?;
    if current == expected {
        Ok(())
    } else {
        Err(
            "Archive destination changed while the operation was running; the new file was preserved."
                .to_string(),
        )
    }
}

pub(crate) fn archive_backup_path(stage_dir: &std::path::Path, index: usize) -> std::path::PathBuf {
    let name = stage_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".zinnia-archive-unknown");
    stage_dir.with_file_name(format!("{name}.backup-{index}"))
}

pub(crate) fn assert_safe_extract_target_ancestors(
    destination: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    assert_real_directory(destination)?;
    if !crate::path_safety::path_is_under_or_equal(destination, target) {
        return Err(format!(
            "Extraction target escaped destination: {}",
            target.display()
        ));
    }
    let Some(parent) = target.parent() else {
        return Ok(());
    };
    if parent == destination {
        return Ok(());
    }
    let relative = parent.strip_prefix(destination).map_err(|_| {
        format!(
            "Extraction target escaped destination: {}",
            target.display()
        )
    })?;
    let mut cursor = destination.to_path_buf();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(_) => {
                cursor.push(component);
                assert_real_directory(&cursor)?;
            }
            _ => {
                return Err(format!(
                    "Extraction target escaped destination: {}",
                    target.display()
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn archive_family(base: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let parent = base.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Archive output has an invalid file name.".to_string())?;
    let mut family = Vec::new();
    match std::fs::symlink_metadata(base) {
        Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_file() => {
            return Err(format!(
                "Archive output is not a regular file: {}",
                base.display()
            ));
        }
        Ok(_) => family.push(base.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // 7-Zip volumes are a contiguous sequence beginning at .001. Do not sweep
    // arbitrary numeric suffixes such as `archive.7z.2024`; those may be
    // unrelated user files.
    const MAX_ARCHIVE_VOLUMES: u32 = 10_000;
    for index in 1..=MAX_ARCHIVE_VOLUMES {
        let candidate = parent.join(format!("{name}.{index:03}"));
        let meta = match std::fs::symlink_metadata(&candidate) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        };
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_file() {
            return Err(format!(
                "Archive volume is not a regular file: {}",
                candidate.display()
            ));
        }
        family.push(candidate);
    }
    let overflow = parent.join(format!("{name}.{:03}", MAX_ARCHIVE_VOLUMES + 1));
    if path_entry_exists(&overflow)? {
        return Err(format!(
            "Archive output exceeds the {MAX_ARCHIVE_VOLUMES}-volume safety limit."
        ));
    }
    family.sort();
    Ok(family)
}

pub(crate) fn archive_destination_for(
    staged_base: &std::path::Path,
    destination_base: &std::path::Path,
    staged_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if staged_path == staged_base {
        return Ok(destination_base.to_path_buf());
    }
    let staged_name = staged_base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid staged archive name.".to_string())?;
    let path_name = staged_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid staged volume name.".to_string())?;
    let suffix = path_name
        .strip_prefix(staged_name)
        .ok_or_else(|| "Staged volume does not match its archive basename.".to_string())?;
    let destination_name = destination_base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid destination archive name.".to_string())?;
    Ok(destination_base.with_file_name(format!("{destination_name}{suffix}")))
}

pub(crate) fn publish_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    publish_file_no_replace_with_created(source, target, |_, _| Ok(()))
}

fn publish_file_no_replace_with_created(
    source: &std::path::Path,
    target: &std::path::Path,
    on_created: impl FnOnce(&std::path::Path, &FileIdentity) -> Result<(), String>,
) -> Result<(), String> {
    let source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    // Same as directory fsync: some Windows setups deny FlushFileBuffers.
    sync_file_best_effort(&source_file)?;

    drop(source_file);

    // Stage directories are siblings of their destinations, so rename is a
    // same-filesystem atomic move. Every publication path refuses an existing
    // target, and no error path unlinks a pathname whose identity may have changed.
    // Only the final create-new copy fallback can expose bytes incrementally.
    match rename_file_no_replace(source, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            // Older Unix filesystems may not implement the exclusive-rename
            // syscall. A hard link is also atomic and no-replace. Once linked,
            // failure to remove the private source is cleanup-only; the stage
            // scrub will retry after the durable commit point.
            if let Err(link_error) = std::fs::hard_link(source, target) {
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
            }
            if let Err(error) = std::fs::remove_file(source) {
                eprintln!(
                    "Archive output published; staged source cleanup failed for {}: {error}",
                    source.display()
                );
            }
            Ok(())
        }
    }
}

#[allow(dead_code)]
pub(crate) fn copy_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    copy_file_no_replace_with_created(source, target, |_, _| Ok(()))
}

fn copy_file_no_replace_with_created(
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
        if let Err(cleanup_error) = remove_regular_file_if_matches(target, &target_identity) {
            return Err(format!(
                "{error}; partial destination cleanup failed: {cleanup_error}"
            ));
        }
        return Err(error);
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
    if target_attributes == 0 {
        target_attributes = FILE_ATTRIBUTE_NORMAL;
    }
    // A directory's read-only bit is shell metadata rather than an access
    // control. Preserve it anyway because Explorer and archive users observe it.
    let _ = directory;
    let target_wide: Vec<u16> = target_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
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
fn copy_windows_directory_metadata(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    let source_file = open_directory_for_metadata(source, false)?;
    let target_file = open_directory_for_metadata(target, true)?;
    copy_windows_times_and_attributes(source, &source_file, target, &target_file, true)
}

#[cfg(windows)]
fn copy_tree_with_inherited_acl(
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
            // Defense in depth: symlink-bearing trees normally rename instead of
            // ACL-copying, but recreate contained links if this path is used.
            let link_target =
                std::fs::read_link(&source_child).map_err(|error| error.to_string())?;
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
            continue;
        }
        if crate::path_safety::is_link_or_reparse(&metadata) {
            return Err(format!(
                "Archive contains a symbolic link or reparse point: {}",
                source_child.display()
            ));
        }
        if metadata.is_dir() {
            std::fs::create_dir(&target_child).map_err(|error| error.to_string())?;
            copy_tree_with_inherited_acl(&source_child, &target_child)?;
            copy_windows_directory_metadata(&source_child, &target_child)?;
        } else if metadata.is_file() {
            copy_file_no_replace(&source_child, &target_child)?;
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

/// Errnos that mean "this mount cannot honor a durable flush ioctl", not that
/// the prior write failed. Used after a successful byte copy / clone when the
/// next reader is this process (private archive snapshots, publish temps).
#[cfg(unix)]
fn is_unsupported_file_flush(error: &std::io::Error) -> bool {
    let Some(code) = error.raw_os_error() else {
        return false;
    };
    // Compare with `==` (not an or-pattern): on Linux `ENOTSUP` and
    // `EOPNOTSUPP` are the same constant, which makes
    // `ENOTSUP | EOPNOTSUPP` an unreachable-pattern error under clippy.
    // On Darwin they are distinct (45 vs 102).
    code == libc::ENOTTY
        || code == libc::ENOTSUP
        || code == libc::EOPNOTSUPP
        || code == libc::EINVAL
}

/// Flush file data with mount-tolerant fallbacks.
///
/// - Windows: `PermissionDenied` from `FlushFileBuffers` is ignored (same
///   policy as [`crate::fs_secure::sync_directory`]).
/// - Unix/macOS: `File::sync_all` is `F_FULLFSYNC` on Darwin. VM shared folders
///   and SMB often reject that ioctl even after a successful write. Follow the
///   SQLite/LevelDB/Go pattern: fall back to plain `fsync` on any `sync_all`
///   failure, then treat only "flush unsupported" fsync errors as success.
///   Real I/O failures from `fsync` (for example `EIO`) still fail the caller.
pub(crate) fn sync_file_best_effort(file: &std::fs::File) -> Result<(), String> {
    match file.sync_all() {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(()),
        #[cfg(unix)]
        Err(_full_sync_error) => {
            use std::os::fd::AsRawFd as _;
            let rc = unsafe { libc::fsync(file.as_raw_fd()) };
            if rc == 0 {
                return Ok(());
            }
            let fsync_error = std::io::Error::last_os_error();
            if is_unsupported_file_flush(&fsync_error) {
                Ok(())
            } else {
                Err(fsync_error.to_string())
            }
        }
        #[cfg(not(unix))]
        Err(error) => Err(error.to_string()),
    }
}

fn restore_archive_backups(
    backups: Vec<(
        std::path::PathBuf,
        std::path::PathBuf,
        super::journal::FileIdentity,
    )>,
) -> Vec<String> {
    let mut restore_errors = Vec::new();
    for (backup, target, identity) in backups.into_iter().rev() {
        let restore = ensure_recovery_path_unchanged(&backup, &identity)
            .and_then(|()| rename_file_no_replace(&backup, &target));
        if let Err(error) = restore {
            restore_errors.push(format!("Could not restore {}: {error}", target.display()));
        }
    }
    restore_errors
}

fn promote_archive_family_with_commit<F, B, R>(
    staged: &std::path::Path,
    destination: &std::path::Path,
    expected_existing: &[ArchiveDestinationSnapshot],
    mut record_backup: B,
    mut record_published: R,
    mark_committed: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
    B: FnMut(&std::path::Path, &super::journal::FileIdentity) -> Result<(), String>,
    R: FnMut(&std::path::Path, &super::journal::FileIdentity) -> Result<(), String>,
{
    let staged_family = archive_family(staged)?;
    if staged_family.is_empty() {
        return Err("7z reported success but produced no staged archive output.".to_string());
    }

    let stage_dir = staged
        .parent()
        .ok_or_else(|| "Staged archive has no parent directory.".to_string())?;
    assert_archive_destination_unchanged(destination, expected_existing)?;
    let mut backups: Vec<(
        std::path::PathBuf,
        std::path::PathBuf,
        super::journal::FileIdentity,
    )> = Vec::new();
    for (index, expected) in expected_existing.iter().enumerate() {
        let path = expected.path.clone();
        // Keep the original object open across the rename. Besides closing the
        // final path-component race, this lets filesystems such as FAT report a
        // changed stable ID after a longer backup name is assigned.
        let mut original_file = crate::path_safety::open_regular_file_nofollow(&path)?;
        let actual_snapshot =
            archive_destination_snapshot_from_open_file(&path, &mut original_file)?;
        let original_identity = identity_with_file_content(
            actual_snapshot.identity.clone(),
            actual_snapshot.len,
            actual_snapshot.sha256,
        );
        if actual_snapshot != *expected {
            let restore_errors = restore_archive_backups(backups);
            let error = format!(
                "Archive destination changed during commit: {}",
                path.display()
            );
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; recovery also failed: {}",
                    restore_errors.join("; ")
                ))
            };
        }
        // Persist an identity before moving the old volume aside. If the process
        // stops immediately after rename, recovery has a fail-closed record.
        record_backup(&path, &original_identity)?;
        let backup = archive_backup_path(stage_dir, index);
        if let Err(e) = rename_file_no_replace(&path, &backup) {
            let restore_errors = restore_archive_backups(backups);
            let error = format!(
                "Could not protect existing archive volume {}: {e}",
                path.display()
            );
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; recovery also failed: {}",
                    restore_errors.join("; ")
                ))
            };
        }
        backups.push((backup.clone(), path.clone(), original_identity.clone()));
        let post_rename = (|| {
            let backup_identity =
                identity_with_fingerprint_from(file_identity(&original_file)?, &original_identity)?;
            if let Some((_, _, rollback_identity)) = backups.last_mut() {
                *rollback_identity = backup_identity.clone();
            }
            if !file_identities_match(&backup_identity, &original_identity) {
                // FAT-family filesystems can change their legacy file ID when a
                // rename requires a longer directory entry. Correct the journal
                // from the still-open handle before relying on the backup path.
                record_backup(&path, &backup_identity)?;
            }
            ensure_recovery_path_unchanged(&backup, &backup_identity)
        })();
        if let Err(error) = post_rename {
            let restore_errors = restore_archive_backups(backups);
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; recovery also failed: {}",
                    restore_errors.join("; ")
                ))
            };
        }
    }
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    sync_directory(stage_dir)?;

    let mut promoted = Vec::new();
    let result = (|| {
        for source in staged_family {
            let target = archive_destination_for(staged, destination, &source)?;
            // Record the staged object's identity before its final pathname can
            // become visible. Rename and hard-link publication preserve identity.
            // A crash can therefore never leave a published target with a blank
            // identity record that recovery might mistake for safe to delete.
            let expected_identity = regular_file_identity_with_fingerprint(&source)?;
            record_published(&target, &expected_identity)?;
            let mut created_identity = None;
            publish_file_no_replace_with_created(&source, &target, |created, identity| {
                // The compatibility copy path allocates a new object. Journal
                // that identity while its create-new handle is still open and
                // before any bytes are copied, closing the last crash window.
                record_published(created, identity)?;
                created_identity = Some(identity.clone());
                Ok(())
            })?;

            // Register a rollback identity immediately after publication. If the
            // post-publish query below fails, rename/hard-link paths can still be
            // retracted with the pre-recorded identity, while copy publication
            // uses the exact identity captured from its open create-new handle.
            promoted.push((
                target.clone(),
                source.clone(),
                match created_identity.clone() {
                    Some(created) => identity_with_fingerprint_from(created, &expected_identity)?,
                    None => expected_identity.clone(),
                },
            ));
            let identity = regular_file_identity(&target)?;
            if !file_identities_match(&identity, &expected_identity) {
                let identity = regular_file_identity_with_fingerprint(&target)?;
                if identity.fingerprint() != expected_identity.fingerprint() {
                    return Err(format!(
                        "Published archive output changed during commit: {}",
                        target.display()
                    ));
                }
                if let Some((_, _, rollback_identity)) = promoted.last_mut() {
                    *rollback_identity = identity.clone();
                }
                // A filesystem may report a stronger or otherwise changed stable
                // identity after rename or hard-link publication. Correct the
                // pre-recorded value before continuing; live rollback already has
                // the actual identity in `promoted` if this journal update fails.
                record_published(&target, &identity)?;
            }
        }
        if let Some(parent) = destination.parent() {
            sync_directory(parent)?;
        }
        sync_directory(stage_dir)?;
        // This durable phase boundary is the transaction commit point. Before
        // it, recovery restores the complete old family. After it, recovery
        // preserves the complete new family and only removes backup leftovers.
        mark_committed()?;
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        let mut recovery_errors = Vec::new();
        for (target, source, identity) in promoted.into_iter().rev() {
            let retract = (|| {
                ensure_recovery_path_unchanged(&target, &identity)?;
                // Hard-link / exclusive-copy publish can leave the staged source
                // in place. rename_file_no_replace then fails, so delete the
                // published identity instead when the stage copy still exists.
                if path_entry_exists(&source)? {
                    remove_regular_file_if_matches(&target, &identity)
                } else {
                    rename_file_no_replace(&target, &source)
                }
            })();
            if let Err(e) = retract {
                recovery_errors.push(format!(
                    "Could not return {} to staging: {e}",
                    target.display()
                ));
            }
        }
        recovery_errors.extend(restore_archive_backups(backups));
        return if recovery_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}; recovery also failed: {}",
                recovery_errors.join("; ")
            ))
        };
    }

    // Destination already holds the durable committed archive(s). Nothing after
    // this point may return Err: recovery treats backup files as cleanup-only.

    for (backup, _, identity) in backups {
        if let Err(error) = remove_regular_file_if_matches(&backup, &identity) {
            eprintln!(
                "Archive published; leftover backup cleanup failed for {}: {error}",
                backup.display()
            );
        }
    }
    if let Err(error) = sync_directory(stage_dir) {
        eprintln!(
            "Archive published; staging directory sync failed for {}: {error}",
            stage_dir.display()
        );
    }
    // Never remove_dir_all while recovery backups may remain; that can partially
    // wipe a multi-volume restore set while the journal still looks in-flight.
    // Leave the dir in place; unregister_plan_stages keeps pending-stages tracking
    // so cleanup_orphan_stages retries after the journal is cleared.
    if archive_stage_has_recovery_backups(stage_dir) {
        eprintln!(
            "Archive published; leaving staging directory {} for later cleanup (recovery backups remain).",
            stage_dir.display()
        );
    } else if let Err(error) = std::fs::remove_dir(stage_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            // Empty-dir remove failed (e.g. PermissionDenied). Try a full scrub only
            // when we already know there are no backup-* files.
            if let Err(scrub_error) = crate::fs_secure::remove_dir_all_for_cleanup(stage_dir) {
                if scrub_error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "Archive published; staging directory cleanup failed for {}: {scrub_error}",
                        stage_dir.display()
                    );
                }
            }
        }
    }
    if let Some(parent) = destination.parent() {
        let _ = sync_directory(parent);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn promote_archive_family(
    staged: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let expected = archive_destination_family_snapshot(destination)?;
    promote_archive_family_with_commit(
        staged,
        destination,
        &expected,
        |_, _| Ok(()),
        |_, _| Ok(()),
        || Ok(()),
    )
}

/// True when the archive stage still holds `backup-*` files needed for journal recovery.
/// Fail closed: if the directory cannot be listed, assume backups may exist.
pub(crate) fn archive_stage_has_recovery_backups(stage_dir: &std::path::Path) -> bool {
    let Some(parent) = stage_dir.parent() else {
        return true;
    };
    let stage_name = stage_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".zinnia-archive-unknown");
    let prefix = format!("{stage_name}.backup-");
    match std::fs::read_dir(parent) {
        Ok(entries) => entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// After a failed commit, only scrub staging when it cannot be needed for recovery.
pub(crate) fn commit_failure_should_scrub_staging(plan: &CleanupPlan, error: &str) -> bool {
    // Extract merge/journal recovery needs the stage; never wipe it here.
    if plan.staged_extract.is_some() {
        return false;
    }
    if let Some((staged, _)) = &plan.staged_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if archive_stage_has_recovery_backups(stage_dir) {
            return false;
        }
    }
    // Add-mode orphan (no backups) or post-publish leftover: safe to remove.
    let _ = error;
    true
}

pub(crate) fn rollback_cleanup(plan: &CleanupPlan) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Some((staged, _)) = &plan.staged_extract {
        if let Err(e) = crate::fs_secure::remove_dir_all_for_cleanup(staged) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove partial extract directory {}: {e}",
                    staged.display()
                ));
            }
        }
        if let Err(e) = remove_move_plan_sidecars(staged) {
            failures.push(format!("Could not remove extract move-plan sidecars: {e}"));
        }
    }
    if let Some((staged, _)) = &plan.staged_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = crate::fs_secure::remove_dir_all_for_cleanup(stage_dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove partial archive staging directory {}: {e}",
                    stage_dir.display()
                ));
            }
        }
    }
    if let Some(staged) = &plan.staged_input_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = crate::fs_secure::remove_dir_all_for_cleanup(stage_dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove archive input snapshot {}: {e}",
                    stage_dir.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        unregister_plan_stages(plan);
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub(crate) fn auto_rename_path(
    path: &std::path::Path,
    reserved: &std::collections::HashSet<std::path::PathBuf>,
) -> Result<std::path::PathBuf, String> {
    if !reserved.contains(path) && !path_entry_exists(path)? {
        return Ok(path.to_path_buf());
    }
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("file");
    let extension = path.extension().and_then(|v| v.to_str());
    for index in 1..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem}_{index}.{extension}"),
            None => format!("{stem}_{index}"),
        };
        let candidate = parent.join(name);
        if !reserved.contains(&candidate) && !path_entry_exists(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not find a free conflict-safe name for {}.",
        path.display()
    ))
}

pub(crate) const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

pub(crate) fn assert_path_under_root(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("Staged path escaped the extract root: {}", path.display()))?;
    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Staged path escaped the extract root: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn validate_staged_tree(root: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut entries = 0u64;
    let mut bytes = 0u64;
    let mut path_bytes = 0u64;
    // Defense in depth for hard links: 7-Zip may create them by default. If any
    // staged file's link count exceeds the number of names we observed for that
    // inode under the stage root, it aliases a path outside the extract tree.
    #[cfg(unix)]
    let mut hardlink_files: Vec<(std::path::PathBuf, u64, u64, u64)> = Vec::new();
    #[cfg(windows)]
    let mut hardlink_files: Vec<(std::path::PathBuf, u64, u64)> = Vec::new();
    while let Some(directory) = pending.pop() {
        assert_path_under_root(root, &directory)?;
        let meta = std::fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
            return Err(format!("Unsafe staged directory: {}", directory.display()));
        }
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            entries = entries.saturating_add(1);
            if entries > MAX_EXTRACT_ENTRIES {
                return Err(format!(
                    "Archive exceeds the {MAX_EXTRACT_ENTRIES}-entry safety limit."
                ));
            }
            let path = entry.path();
            path_bytes = path_bytes.saturating_add(
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .as_os_str()
                    .as_encoded_bytes()
                    .len() as u64,
            );
            if path_bytes > MAX_EXTRACT_PATH_BYTES {
                return Err(format!(
                    "Archive exceeds the {} MiB aggregate path-name safety limit.",
                    MAX_EXTRACT_PATH_BYTES / (1024 * 1024)
                ));
            }
            assert_path_under_root(root, &path)?;
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                crate::path_safety::assert_relative_symlink_within_root(root, &path)?;
                continue;
            }
            if crate::path_safety::is_link_or_reparse(&meta) {
                return Err(format!(
                    "Archive contains a symbolic link or reparse point: {}",
                    path.display()
                ));
            }
            if meta.is_dir() {
                pending.push(path);
            } else if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
                if bytes > max_bytes {
                    return Err(format!(
                        "Archive exceeds its {:.1} GiB expanded-size safety limit.",
                        max_bytes as f64 / 1_073_741_824.0
                    ));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt as _;
                    hardlink_files.push((path, meta.dev(), meta.ino(), meta.nlink()));
                }
                #[cfg(windows)]
                {
                    // `MetadataExt::{file_index,number_of_links}` need the
                    // unstable `windows_by_handle` feature. Use the same stable
                    // GetFileInformationByHandle path as journal identities.
                    use std::os::windows::io::AsRawHandle as _;
                    use windows_sys::Win32::Foundation::HANDLE;
                    use windows_sys::Win32::Storage::FileSystem::{
                        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
                    };
                    let file = crate::path_safety::open_regular_file_nofollow(&path).map_err(
                        |_| {
                            format!(
                                "Archive contains a hard link whose identity could not be verified: {}",
                                path.display()
                            )
                        },
                    )?;
                    let handle = file.as_raw_handle() as HANDLE;
                    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
                    let success = unsafe { GetFileInformationByHandle(handle, &mut info) };
                    if success == 0 {
                        return Err(format!(
                            "Archive contains a hard link whose identity could not be verified: {}",
                            path.display()
                        ));
                    }
                    let file_index =
                        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
                    let nlink = u64::from(info.nNumberOfLinks);
                    hardlink_files.push((path, file_index, nlink));
                }
            } else {
                return Err(format!(
                    "Archive contains an unsupported entry: {}",
                    path.display()
                ));
            }
        }
    }
    #[cfg(unix)]
    assert_staged_hardlinks_self_contained(&hardlink_files)?;
    #[cfg(windows)]
    assert_staged_hardlinks_self_contained(&hardlink_files)?;
    Ok(())
}

#[cfg(unix)]
fn assert_staged_hardlinks_self_contained(
    files: &[(std::path::PathBuf, u64, u64, u64)],
) -> Result<(), String> {
    use std::collections::HashMap;

    let mut staged_names: HashMap<(u64, u64), u64> = HashMap::new();
    for (_, dev, ino, _) in files {
        *staged_names.entry((*dev, *ino)).or_insert(0) += 1;
    }
    for (path, dev, ino, nlink) in files {
        let staged = staged_names.get(&(*dev, *ino)).copied().unwrap_or(0);
        if *nlink > staged {
            return Err(format!(
                "Archive contains a hard link that aliases a file outside the extract root: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn assert_staged_hardlinks_self_contained(
    files: &[(std::path::PathBuf, u64, u64)],
) -> Result<(), String> {
    use std::collections::HashMap;

    let mut staged_names: HashMap<u64, u64> = HashMap::new();
    for (_, file_index, _) in files {
        *staged_names.entry(*file_index).or_insert(0) += 1;
    }
    for (path, file_index, nlink) in files {
        let staged = staged_names.get(file_index).copied().unwrap_or(0);
        if *nlink > staged {
            return Err(format!(
                "Archive contains a hard link that aliases a file outside the extract root: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

pub(crate) fn plan_staged_contents(
    staged: &std::path::Path,
    destination: &std::path::Path,
    reserved: &mut std::collections::HashSet<std::path::PathBuf>,
    plan: &mut Vec<MoveRecord>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(staged).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let meta = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
        let requested_target = destination.join(entry.file_name());
        if meta.is_dir() {
            match std::fs::symlink_metadata(&requested_target) {
                Ok(target_meta)
                    if target_meta.is_dir()
                        && !crate::path_safety::is_link_or_reparse(&target_meta) =>
                {
                    plan_staged_contents(&source, &requested_target, reserved, plan)?;
                    continue;
                }
                Ok(_) => {
                    // Existing symlinks, reparse points, files, and special
                    // nodes are conflicts. Never recurse through them.
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let target = auto_rename_path(&requested_target, reserved)?;
        reserved.insert(target.clone());
        plan.push(MoveRecord {
            source,
            target,
            publish_temp: None,
            publish_identity: None,
        });
    }
    Ok(())
}

#[cfg(windows)]
fn is_publish_temp_name(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(token) = name.strip_prefix(".zinnia-publish-") else {
        return false;
    };
    token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// True when `root` contains any symbolic-link entry. Non-symlink reparse points
/// are rejected  -  staged trees should already have failed closed on those.
#[cfg(windows)]
pub(crate) fn staged_tree_contains_symlink(root: &std::path::Path) -> Result<bool, String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Ok(true);
            }
            if crate::path_safety::is_link_or_reparse(&metadata) {
                return Err(format!(
                    "Archive contains a symbolic link or reparse point: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(false)
}

#[cfg(windows)]
fn prepare_target_local_publish_paths(
    plan: &mut [MoveRecord],
    reserved: &mut std::collections::HashSet<std::path::PathBuf>,
) -> Result<(), String> {
    for record in plan {
        let metadata =
            std::fs::symlink_metadata(&record.source).map_err(|error| error.to_string())?;
        // Publish links (and directories that contain them) by renaming the
        // staged entry. Target-local ACL copy cannot move reparse points and
        // would otherwise reject nested `.framework`-style link trees.
        if crate::path_safety::is_link_or_reparse(&metadata) {
            continue;
        }
        if metadata.is_dir() && staged_tree_contains_symlink(&record.source)? {
            continue;
        }
        let parent = record
            .target
            .parent()
            .ok_or_else(|| "Extraction target has no parent directory.".to_string())?;
        let mut publish_temp = None;
        for _ in 0..32 {
            let candidate = parent.join(format!(
                ".zinnia-publish-{}",
                super::staging::random_token()?
            ));
            if !reserved.contains(&candidate) && !path_entry_exists(&candidate)? {
                publish_temp = Some(candidate);
                break;
            }
        }
        let publish_temp = publish_temp.ok_or_else(|| {
            format!(
                "Could not reserve a unique extraction publish path under {}.",
                parent.display()
            )
        })?;
        reserved.insert(publish_temp.clone());
        record.publish_temp = Some(publish_temp);
    }
    Ok(())
}

fn remove_path_if_matches(path: &std::path::Path, identity: &FileIdentity) -> Result<(), String> {
    ensure_path_identity(path, identity)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) {
        return Err(format!(
            "Refusing to remove a publish path that became a link or reparse point: {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        crate::fs_secure::remove_dir_all_for_cleanup(path).map_err(|error| error.to_string())
    } else if metadata.is_file() {
        crate::fs_secure::remove_file_for_cleanup(path).map_err(|error| error.to_string())
    } else {
        Err(format!(
            "Refusing to remove an unsupported publish path: {}",
            path.display()
        ))
    }
}

/// Append-only per-entry identity record. Used on every platform so
/// publishing a large extraction into an existing destination journals each
/// entry's identity in O(1) instead of rewriting the whole move-plan JSON
/// (`write_move_plan`) after every single file, which made a merge into an
/// existing destination with n entries cost O(n^2) I/O.
#[derive(serde::Serialize, serde::Deserialize)]
struct MoveIdentityLogRecord {
    index: usize,
    /// Windows target-local publish creates a temp object directly under the
    /// real target parent so a copy inherits that parent's ACL; every other
    /// publish path (rename / hard-link, on any platform) leaves this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    publish_temp: Option<std::path::PathBuf>,
    identity: FileIdentity,
}

struct MoveIdentityLogWriter {
    file: std::fs::File,
}

impl MoveIdentityLogWriter {
    fn create(staged: &std::path::Path) -> Result<Self, String> {
        let path = move_identity_log_path(staged);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt as _;
            use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
            // Recovery readers are harmless. Deny concurrent writers, rename,
            // and deletion for the lifetime of this extraction commit.
            options.share_mode(FILE_SHARE_READ);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|error| error.to_string())?;
        sync_file_best_effort(&file)?;
        if let Some(parent) = path.parent() {
            sync_directory(parent)?;
        }
        Ok(Self { file })
    }

    fn append(&mut self, record: &MoveIdentityLogRecord) -> Result<(), String> {
        use std::io::Write as _;

        let mut json = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        json.push(b'\n');
        self.file
            .write_all(&json)
            .map_err(|error| error.to_string())?;
        sync_file_best_effort(&self.file)
    }
}

fn hydrate_move_plan_identities(
    staged: &std::path::Path,
    plan: &mut [MoveRecord],
) -> Result<(), String> {
    use std::io::BufRead as _;

    let path = move_identity_log_path(staged);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata)
            if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
        {
            return Err("Extraction identity log is not a regular file.".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let file = crate::path_safety::open_regular_file_nofollow(&path)?;
    let mut reader = std::io::BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let bytes = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            // A crash can leave one torn append. Ignore only the incomplete
            // final record; complete malformed records remain a hard error.
            break;
        }
        line.pop();
        if line.ends_with(b"\r") {
            line.pop();
        }
        if line.is_empty() {
            return Err("Extraction identity log contains an empty record.".to_string());
        }
        let record: MoveIdentityLogRecord =
            serde_json::from_slice(&line).map_err(|error| error.to_string())?;
        let Some(planned) = plan.get_mut(record.index) else {
            return Err("Extraction identity log references an invalid move index.".to_string());
        };
        if planned.publish_temp != record.publish_temp {
            return Err("Extraction identity log does not match its move plan.".to_string());
        }
        // Append-only log: a later record for the same index replaces an
        // earlier one (copy-fallback publish corrections journal the post-copy
        // identity after the pre-publish source identity).
        planned.publish_identity = Some(record.identity);
    }
    Ok(())
}

/// Journal a publish identity in the append-only log and mirror it into the
/// in-memory plan. Does not rewrite `write_move_plan`'s JSON: that would put
/// the O(n^2) cost back for a merge into an existing destination.
fn record_publish_identity(
    identity_log: &mut MoveIdentityLogWriter,
    plan: &mut [MoveRecord],
    index: usize,
    identity: &FileIdentity,
) -> Result<(), String> {
    let publish_temp = plan
        .get(index)
        .and_then(|record| record.publish_temp.clone());
    identity_log.append(&MoveIdentityLogRecord {
        index,
        publish_temp,
        identity: identity.clone(),
    })?;
    plan[index].publish_identity = Some(identity.clone());
    Ok(())
}

#[cfg(windows)]
fn publish_target_local_copy(
    identity_log: &mut MoveIdentityLogWriter,
    plan: &mut [MoveRecord],
    index: usize,
) -> Result<(), String> {
    let source = plan[index].source.clone();
    let target = plan[index].target.clone();
    let expected_source = path_identity_with_fingerprint(&source)?;
    let publish_temp = plan[index]
        .publish_temp
        .clone()
        .ok_or_else(|| "Extraction publish path was not planned.".to_string())?;
    let metadata = std::fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) {
        return Err(format!(
            "Archive contains a symbolic link or reparse point: {}",
            source.display()
        ));
    }

    let copy_result = if metadata.is_file() {
        copy_file_no_replace_with_created(&source, &publish_temp, |_, identity| {
            record_publish_identity(identity_log, plan, index, identity)
        })
    } else if metadata.is_dir() {
        crate::fs_secure::create_inheriting_stage_dir(&publish_temp)
            .map_err(|error| error.to_string())?;
        let identity = path_identity(&publish_temp)?;
        let journal_result = record_publish_identity(identity_log, plan, index, &identity);
        if let Err(error) = journal_result {
            let cleanup = remove_path_if_matches(&publish_temp, &identity);
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => {
                    format!("{error}; publish-temp cleanup also failed: {cleanup_error}")
                }
            });
        }
        let result = copy_tree_with_inherited_acl(&source, &publish_temp)
            .and_then(|()| copy_windows_directory_metadata(&source, &publish_temp))
            .and_then(|()| sync_directory(&publish_temp));
        if let Err(error) = result {
            let cleanup = remove_path_if_matches(&publish_temp, &identity);
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => {
                    format!("{error}; publish-temp cleanup also failed: {cleanup_error}")
                }
            });
        }
        Ok(())
    } else {
        Err(format!(
            "Archive contains an unsupported entry: {}",
            source.display()
        ))
    };
    copy_result?;
    let published_snapshot = path_identity_with_fingerprint(&publish_temp)?;
    if published_snapshot.fingerprint() != expected_source.fingerprint() {
        return Err(format!(
            "Extraction publish copy changed during commit: {}",
            publish_temp.display()
        ));
    }
    record_publish_identity(identity_log, plan, index, &published_snapshot)?;

    // The temporary object was created directly under the final parent, so it
    // already has the correct NTFS/server ACL. MoveFileW preserves that ACL and
    // refuses an existing destination.
    rename_file_no_replace(&publish_temp, &target)?;
    if let Some(parent) = target.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn resolve_staged_symlink_target(
    staged: &std::path::Path,
    link: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    crate::path_safety::resolve_relative_symlink_within_root(staged, link)
}

fn final_path_for_staged_source(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
    source: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let mapped = plan
        .iter()
        .filter(|record| source == record.source || source.starts_with(&record.source))
        .max_by_key(|record| record.source.components().count());
    if let Some(record) = mapped {
        let suffix = source
            .strip_prefix(&record.source)
            .map_err(|error| error.to_string())?;
        return Ok(record.target.join(suffix));
    }
    Ok(destination.join(
        source
            .strip_prefix(staged)
            .map_err(|error| error.to_string())?,
    ))
}

fn relative_path_between(
    from_directory: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let from: Vec<_> = from_directory.components().collect();
    let to: Vec<_> = target.components().collect();
    let shared = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    if shared == 0 {
        return Err("Could not preserve an archive symbolic link across filesystems.".to_string());
    }
    let mut relative = std::path::PathBuf::new();
    for _ in shared..from.len() {
        relative.push("..");
    }
    for component in &to[shared..] {
        relative.push(component.as_os_str());
    }
    if relative.as_os_str().is_empty() {
        return Err("Archive contains a self-referential symbolic link.".to_string());
    }
    Ok(relative)
}

fn prepare_planned_links(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<(), String> {
    for record in plan {
        let mut pending = vec![record.source.clone()];
        let mut links = Vec::new();
        while let Some(path) = pending.pop() {
            let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if crate::path_safety::is_link_or_reparse(&metadata) {
                links.push(path);
                continue;
            }
            if metadata.is_dir() {
                for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                    pending.push(entry.map_err(|e| e.to_string())?.path());
                }
            }
        }
        for link in links {
            let source_target = resolve_staged_symlink_target(staged, &link)?;
            let final_target =
                final_path_for_staged_source(staged, destination, plan, &source_target)?;
            crate::path_safety::assert_path_resolves_within_root_or_missing(
                destination,
                &final_target,
            )?;
            let final_link = final_path_for_staged_source(staged, destination, plan, &link)?;
            let final_parent = final_link
                .parent()
                .ok_or_else(|| "Archive symbolic link target has no parent.".to_string())?;
            let rewritten_target = relative_path_between(final_parent, &final_target)?;
            if std::fs::read_link(&link).map_err(|e| e.to_string())? != rewritten_target {
                #[cfg(windows)]
                let was_directory_link = {
                    use std::os::windows::fs::FileTypeExt as _;
                    std::fs::symlink_metadata(&link)
                        .map_err(|error| error.to_string())?
                        .file_type()
                        .is_symlink_dir()
                };
                #[cfg(unix)]
                std::fs::remove_file(&link).map_err(|e| e.to_string())?;
                #[cfg(windows)]
                if was_directory_link {
                    std::fs::remove_dir(&link).map_err(|e| e.to_string())?;
                } else {
                    std::fs::remove_file(&link).map_err(|e| e.to_string())?;
                }
                #[cfg(unix)]
                std::os::unix::fs::symlink(&rewritten_target, &link).map_err(|e| e.to_string())?;
                #[cfg(windows)]
                if was_directory_link {
                    std::os::windows::fs::symlink_dir(&rewritten_target, &link)
                        .map_err(|e| e.to_string())?;
                } else {
                    std::os::windows::fs::symlink_file(&rewritten_target, &link)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn write_move_plan(staged: &std::path::Path, plan: &[MoveRecord]) -> Result<(), String> {
    let json = serde_json::to_string(plan).map_err(|e| e.to_string())?;
    let path = move_plan_path(staged);
    #[cfg(windows)]
    {
        atomic_replace_move_plan_windows(&path, &json)
    }
    #[cfg(not(windows))]
    {
        crate::settings_store::atomic_write_text(&path, &json)
    }
}

#[cfg(windows)]
fn atomic_replace_move_plan_windows(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let parent = path
        .parent()
        .ok_or_else(|| "Extraction move plan has no parent directory.".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Extraction move plan has an invalid file name.".to_string())?;
    let mut reserved = None;
    for _ in 0..32 {
        let candidate = parent.join(format!(
            ".{file_name}.{}.tmp",
            super::staging::random_token()?
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        match options.open(&candidate) {
            Ok(file) => {
                reserved = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let (temp, mut file) = reserved
        .ok_or_else(|| "Could not reserve a unique extraction move-plan temp file.".to_string())?;
    let write_result = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string());
    drop(file);
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }

    let temp_wide: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let path_wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    if unsafe { MoveFileExW(temp_wide.as_ptr(), path_wide.as_ptr(), flags) } == 0 {
        let error = std::io::Error::last_os_error();
        let cleanup = std::fs::remove_file(&temp);
        return Err(match cleanup {
            Ok(()) => error.to_string(),
            Err(cleanup_error) => {
                format!("{error}; move-plan temp cleanup also failed: {cleanup_error}")
            }
        });
    }
    sync_directory(parent)
}

pub(crate) fn validate_move_record(
    staged: &std::path::Path,
    destination: &std::path::Path,
    record: &MoveRecord,
) -> Result<(), String> {
    if !crate::path_safety::path_is_under_or_equal(staged, &record.source)
        || !crate::path_safety::path_is_under_or_equal(destination, &record.target)
    {
        return Err("Refusing unsafe extraction recovery move plan.".to_string());
    }
    if let Some(publish_temp) = &record.publish_temp {
        #[cfg(not(windows))]
        {
            let _ = publish_temp;
            return Err("Refusing a Windows publish path on this platform.".to_string());
        }
        #[cfg(windows)]
        {
            if publish_temp.parent() != record.target.parent()
                || !crate::path_safety::path_is_under_or_equal(destination, publish_temp)
                || !is_publish_temp_name(publish_temp)
            {
                return Err("Refusing unsafe extraction publish path.".to_string());
            }
        }
    } else if record.publish_identity.is_some() {
        #[cfg(windows)]
        {
            // Rename-published symbolic links and symlink-bearing directory
            // trees journal an identity without a target-local publish_temp.
            // Plain files still require the ACL-copy publish path.
            let allows_rename_publish = |path: &std::path::Path| -> bool {
                std::fs::symlink_metadata(path)
                    .map(|metadata| {
                        crate::path_safety::is_link_or_reparse(&metadata) || metadata.is_dir()
                    })
                    .unwrap_or(false)
            };
            if !allows_rename_publish(&record.source) && !allows_rename_publish(&record.target) {
                return Err(
                    "Refusing extraction publish identity without a publish path.".to_string(),
                );
            }
        }
    }
    Ok(())
}

fn rollback_target_local_record(record: &MoveRecord, crash_recovery: bool) -> Result<(), String> {
    let publish_temp = record
        .publish_temp
        .as_ref()
        .ok_or_else(|| "Extraction publish path is missing.".to_string())?;
    let source_exists = path_entry_exists(&record.source)?;
    let temp_exists = path_entry_exists(publish_temp)?;
    let target_exists = path_entry_exists(&record.target)?;
    let Some(identity) = &record.publish_identity else {
        if temp_exists {
            return Err(format!(
                "Refusing to remove unverified extraction publish path: {}",
                publish_temp.display()
            ));
        }
        return if source_exists {
            Ok(())
        } else {
            Err(format!(
                "Extraction source disappeared before its publish identity was recorded: {}",
                record.source.display()
            ))
        };
    };

    if source_exists {
        // A target-local publish is a copy, so the source remains until the
        // whole stage is committed. Remove only the exact object whose identity
        // was recorded when the publish temp was created.
        if target_exists && ensure_path_identity(&record.target, identity).is_ok() {
            if crash_recovery {
                ensure_recovery_path_unchanged(&record.target, identity)?;
            }
            remove_path_if_matches(&record.target, identity)?;
        }
        if temp_exists {
            if crash_recovery {
                ensure_recovery_path_unchanged(publish_temp, identity)?;
            }
            remove_path_if_matches(publish_temp, identity)?;
        }
        return Ok(());
    }

    // This state is not expected during normal copy publishing, but supporting
    // it makes recovery safe if a future implementation retires the source
    // before commit or a manual repair moved it.
    if target_exists && ensure_path_identity(&record.target, identity).is_ok() {
        if crash_recovery {
            ensure_recovery_path_unchanged(&record.target, identity)?;
        }
        if let Some(parent) = record.source.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        return rename_file_no_replace(&record.target, &record.source);
    }
    if temp_exists && ensure_path_identity(publish_temp, identity).is_ok() {
        if crash_recovery {
            ensure_recovery_path_unchanged(publish_temp, identity)?;
        }
        if let Some(parent) = record.source.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        return rename_file_no_replace(publish_temp, &record.source);
    }
    Err(format!(
        "Extraction source and its verified publish object are missing: {}",
        record.source.display()
    ))
}

#[cfg(test)]
pub(crate) fn rollback_move_records(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<(), String> {
    rollback_move_records_impl(staged, destination, plan, false)
}

fn rollback_move_records_impl(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
    crash_recovery: bool,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for record in plan.iter().rev() {
        if let Err(error) = validate_move_record(staged, destination, record) {
            failures.push(error);
            continue;
        }
        if let Err(error) = assert_safe_extract_target_ancestors(destination, &record.target) {
            failures.push(error);
            continue;
        }
        if record.publish_temp.is_some() {
            if let Err(error) = rollback_target_local_record(record, crash_recovery) {
                failures.push(error);
            }
            continue;
        }
        let source_exists = path_entry_exists(&record.source)?;
        let target_metadata = match std::fs::symlink_metadata(&record.target) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                failures.push(error.to_string());
                continue;
            }
        };
        let Some(_target_metadata) = target_metadata else {
            if !source_exists {
                failures.push(format!(
                    "Both extraction source and promoted target are missing: {}",
                    record.target.display()
                ));
            }
            continue;
        };
        if source_exists {
            // Hard-link / exclusive-copy publish can leave the stage source while
            // the target is already visible. Retract the published target so a
            // failed commit does not leave partial extract output behind.
            // (Rename-only publishes remove the source, so both existing means
            // a non-move publish path ran.)
            if path_entry_exists(&record.target).unwrap_or(false) {
                let Some(identity) = &record.publish_identity else {
                    failures.push(format!(
                        "Refusing to retract published extraction target without a recorded identity: {}",
                        record.target.display()
                    ));
                    continue;
                };
                if crash_recovery {
                    if let Err(error) = ensure_recovery_path_unchanged(&record.target, identity) {
                        failures.push(error);
                        continue;
                    }
                }
                if let Err(error) = remove_path_if_matches(&record.target, identity) {
                    failures.push(format!(
                        "Could not retract published extraction target {}: {error}",
                        record.target.display()
                    ));
                }
            }
            continue;
        }
        // Rename operates on the link/reparse entry itself and does not follow
        // it. Ancestors were verified above, so links are safe to roll back.
        let Some(identity) = &record.publish_identity else {
            failures.push(format!(
                "Refusing to roll back an extraction target without a recorded identity: {}",
                record.target.display()
            ));
            continue;
        };
        let unchanged = if crash_recovery {
            ensure_recovery_path_unchanged(&record.target, identity)
        } else {
            ensure_path_entry_identity(&record.target, identity)
        };
        if let Err(error) = unchanged {
            failures.push(format!(
                "Extraction target changed after publication and was preserved: {} ({error})",
                record.target.display()
            ));
            continue;
        }
        if let Some(parent) = record.source.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                failures.push(error.to_string());
                continue;
            }
        }
        if let Err(error) = rename_file_no_replace(&record.target, &record.source) {
            failures.push(format!(
                "Could not roll back {}: {error}",
                record.target.display()
            ));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub(crate) fn rollback_persisted_move_plan(
    staged: &std::path::Path,
    destination: &std::path::Path,
    allow_legacy_location: bool,
) -> Result<(), String> {
    let path = move_plan_path(staged);
    let json = match read_recovery_text_file(&path)? {
        Some(json) => json,
        None if allow_legacy_location => {
            // Compatibility recovery for transactions started by older betas.
            match read_recovery_text_file(&staged.join(LEGACY_MOVE_PLAN_FILE_NAME))? {
                Some(json) => json,
                None => return Ok(()),
            }
        }
        None => return Ok(()),
    };
    #[allow(unused_mut)]
    let mut plan: Vec<MoveRecord> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    hydrate_move_plan_identities(staged, &mut plan)?;
    rollback_move_records_impl(staged, destination, &plan, true)
}

fn read_recovery_text_file(path: &std::path::Path) -> Result<Option<String>, String> {
    use std::io::Read as _;

    match std::fs::symlink_metadata(path) {
        Ok(metadata)
            if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
        {
            return Err(format!(
                "Refusing unexpected extraction recovery sidecar {}.",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let mut file = crate::path_safety::open_regular_file_nofollow(path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|error| error.to_string())?;
    Ok(Some(contents))
}

pub(crate) fn merge_staged_extract_with_commit<F>(
    staged: &std::path::Path,
    destination: &std::path::Path,
    max_bytes: u64,
    mark_committed: F,
) -> Result<Vec<std::path::PathBuf>, String>
where
    F: FnOnce() -> Result<(), String>,
{
    // Always enforce the operation-specific limit immediately before publish.
    // Fast extractions can finish before the live monitor's first poll.
    validate_staged_tree(staged, max_bytes)?;
    if !path_entry_exists(destination)? {
        if let Some(parent) = destination.parent() {
            assert_real_directory(parent)?;
        }
        // Re-check immediately before rename: a symlink/reparse point must never
        // be published as the destination root.
        match std::fs::symlink_metadata(destination) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) => {
                return Err(
                    "Extraction destination became a symbolic link or reparse point during commit."
                        .to_string(),
                );
            }
            Ok(_) => {
                return Err("Extraction destination appeared during commit.".to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
        rename_file_no_replace(staged, destination)?;
        if let Err(error) = crate::fs_secure::apply_parent_directory_mode(destination) {
            let rollback = rename_file_no_replace(destination, staged).and_then(|()| {
                if let Some(parent) = destination.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            });
            return Err(match rollback {
                Ok(()) => error.to_string(),
                Err(rollback_error) => {
                    format!("{error}; extraction mode rollback also failed: {rollback_error}")
                }
            });
        }
        let durability = if let Some(parent) = destination.parent() {
            sync_directory(parent)
        } else {
            Ok(())
        };
        if let Err(error) = durability {
            let rollback = rename_file_no_replace(destination, staged).and_then(|()| {
                if let Some(parent) = destination.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            });
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}; extraction durability rollback also failed: {rollback_error}")
                }
            });
        }
        if let Err(error) = mark_committed() {
            let rollback = rename_file_no_replace(destination, staged).and_then(|()| {
                if let Some(parent) = destination.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            });
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}; extraction commit rollback also failed: {rollback_error}")
                }
            });
        }
        return Ok(vec![destination.to_path_buf()]);
    }
    assert_real_directory(destination)?;
    let mut reserved = std::collections::HashSet::new();
    let mut plan = Vec::new();
    plan_staged_contents(staged, destination, &mut reserved, &mut plan)?;
    prepare_planned_links(staged, destination, &plan)?;
    #[cfg(windows)]
    prepare_target_local_publish_paths(&mut plan, &mut reserved)?;
    match std::fs::remove_file(move_identity_log_path(staged)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // Written once up front with every `publish_identity` still `None`. Per-file
    // identities are journaled afterward through the append-only identity log
    // (`identity_log`) instead of rewriting this JSON per entry, which used to
    // make a merge into an existing destination with n entries cost O(n^2) I/O.
    write_move_plan(staged, &plan)?;
    let mut identity_log = MoveIdentityLogWriter::create(staged)?;
    for index in 0..plan.len() {
        let mut publish_one = || -> Result<(), String> {
            validate_move_record(staged, destination, &plan[index])?;
            let source = plan[index].source.clone();
            let target = plan[index].target.clone();
            assert_safe_extract_target_ancestors(destination, &target)?;
            if path_entry_exists(&target)? {
                return Err(format!(
                    "Extraction destination changed during commit: {}",
                    target.display()
                ));
            }
            #[cfg(windows)]
            if plan[index].publish_temp.is_some() {
                return publish_target_local_copy(&mut identity_log, &mut plan, index);
            }
            let metadata = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
            if crate::path_safety::is_link_or_reparse(&metadata) {
                let expected = path_identity_with_fingerprint(&source)?;
                record_publish_identity(&mut identity_log, &mut plan, index, &expected)?;
            }
            if metadata.is_file() {
                // Journal identity before visibility so hard-link retract cannot
                // fail closed with both source and target present and no id.
                if !crate::path_safety::is_link_or_reparse(&metadata) {
                    let expected = path_identity_with_fingerprint(&source)?;
                    record_publish_identity(&mut identity_log, &mut plan, index, &expected)?;
                }
                publish_file_no_replace(&plan[index].source, &plan[index].target)?;
                if let Some(expected) = plan[index].publish_identity.clone() {
                    let actual = path_identity(&plan[index].target)?;
                    if !file_identities_match(&actual, &expected) {
                        let actual = path_identity_with_fingerprint(&plan[index].target)?;
                        if actual.fingerprint() != expected.fingerprint() {
                            return Err(format!(
                                "Extraction target changed during commit: {}",
                                plan[index].target.display()
                            ));
                        }
                        // Rename and hard-link publication preserve the source's
                        // identity on every platform Zinnia ships for, so this
                        // only fires for the rare copy fallback used when a
                        // filesystem has neither atomic primitive. Append the
                        // correction; hydration takes the latest record per index.
                        record_publish_identity(&mut identity_log, &mut plan, index, &actual)?;
                    }
                }
                return Ok(());
            }
            if !crate::path_safety::is_link_or_reparse(&metadata) {
                let expected = path_identity_with_fingerprint(&source)?;
                record_publish_identity(&mut identity_log, &mut plan, index, &expected)?;
            }
            rename_file_no_replace(&source, &target)?;
            // Stage roots are 0o700 while private. Renamed directories must
            // inherit the destination parent's mode so merge publishes are
            // not left owner-only under shared/group-readable trees.
            if metadata.is_dir() {
                crate::fs_secure::apply_parent_directory_mode(&plan[index].target)
                    .map_err(|error| error.to_string())?;
            }
            if !crate::path_safety::is_link_or_reparse(&metadata) {
                let actual = path_identity(&plan[index].target)?;
                let expected = plan[index]
                    .publish_identity
                    .as_ref()
                    .ok_or_else(|| "Extraction publish snapshot was not recorded.".to_string())?;
                if !file_identities_match(&actual, expected) {
                    let actual = path_identity_with_fingerprint(&plan[index].target)?;
                    if actual.fingerprint() != expected.fingerprint() {
                        return Err(format!(
                            "Extraction target changed during commit: {}",
                            plan[index].target.display()
                        ));
                    }
                    record_publish_identity(&mut identity_log, &mut plan, index, &actual)?;
                }
            } else if let Some(expected) = plan[index].publish_identity.clone() {
                let actual = path_identity_with_fingerprint(&plan[index].target)?;
                if actual.fingerprint() != expected.fingerprint() {
                    return Err(format!(
                        "Extraction link changed during commit: {}",
                        plan[index].target.display()
                    ));
                }
                if !file_identities_match(&actual, &expected) {
                    record_publish_identity(&mut identity_log, &mut plan, index, &actual)?;
                }
            }
            Ok(())
        };
        if let Err(error) = publish_one() {
            let rollback = rollback_move_records_impl(staged, destination, &plan, true);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
    }
    drop(identity_log);
    let promoted: Vec<_> = plan.iter().map(|record| record.target.clone()).collect();
    let durability = sync_directory(destination).and_then(|()| {
        if let Some(parent) = destination.parent() {
            sync_directory(parent)?;
        }
        Ok(())
    });
    if let Err(error) = durability {
        let rollback =
            rollback_move_records_impl(staged, destination, &plan, true).and_then(|()| {
                sync_directory(destination)?;
                if let Some(parent) = destination.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            });
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; extraction durability rollback also failed: {rollback_error}")
            }
        });
    }
    if let Err(error) = mark_committed() {
        let rollback =
            rollback_move_records_impl(staged, destination, &plan, true).and_then(|()| {
                sync_directory(destination)?;
                if let Some(parent) = destination.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            });
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; extraction commit rollback also failed: {rollback_error}")
            }
        });
    }

    // The journal now records a durable extraction commit. Nothing after this
    // point may return Err: recovery must preserve published targets and only
    // retry cleanup of the source stage and sidecars.
    match remove_move_plan_sidecars(staged) {
        Ok(()) => {
            if let Err(error) = crate::fs_secure::remove_dir_all_for_cleanup(staged) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "Extraction published; staging directory cleanup failed for {}: {error}",
                        staged.display()
                    );
                }
            }
        }
        Err(error) => {
            // Keep the stage so pending-stages tracking remains active and the
            // next startup can retry both stage and sidecar cleanup.
            eprintln!(
                "Extraction published; move-plan sidecar cleanup failed for {}: {error}",
                staged.display()
            );
        }
    }
    Ok(promoted)
}

#[cfg(test)]
pub(crate) fn merge_staged_extract(
    staged: &std::path::Path,
    destination: &std::path::Path,
    max_bytes: u64,
) -> Result<Vec<std::path::PathBuf>, String> {
    merge_staged_extract_with_commit(staged, destination, max_bytes, || Ok(()))
}

pub(crate) fn commit_cleanup(app: &tauri::AppHandle, plan: &CleanupPlan) -> Result<(), String> {
    let input_only = plan.staged_input_archive.is_some()
        && plan.staged_extract.is_none()
        && plan.staged_archive.is_none();
    if let Some(staged) = &plan.staged_input_archive {
        crate::fs_secure::remove_dir_all_for_cleanup(staged.parent().unwrap_or(staged))
            .map_err(|e| format!("Could not remove archive input snapshot: {e}"))?;
        if input_only {
            super::journal::unregister_plan_stages(plan);
        }
    }
    if let Some((staged, destination)) = &plan.staged_extract {
        merge_staged_extract_with_commit(
            staged,
            destination,
            plan.max_extract_bytes.unwrap_or(MAX_EXTRACTED_BYTES),
            || mark_extract_journal_committed(app, plan),
        )
        .map_err(|e| format!("Could not promote staged extraction safely: {e}"))?;
        crate::launch::remember_openable_directory(app, destination);
    }
    if let Some((staged, destination)) = &plan.staged_archive {
        assert_archive_destination_unchanged(destination, &plan.expected_archive_family)?;
        update_archive_journal(app, plan)?;
        promote_archive_family_with_commit(
            staged,
            destination,
            &plan.expected_archive_family,
            |original, identity| record_archive_journal_backup(app, plan, original, identity),
            |published, identity| record_archive_journal_published(app, plan, published, identity),
            || mark_archive_journal_committed(app, plan),
        )?;
        if let Some(parent) = destination.parent() {
            crate::launch::remember_openable_directory(app, parent);
        }
    }
    unregister_plan_stages(plan);
    Ok(())
}

#[cfg(test)]
mod sync_file_best_effort_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn unsupported_file_flush_matches_shared_folder_errnos() {
        let mut errnos = vec![libc::ENOTTY, libc::ENOTSUP, libc::EINVAL];
        // Darwin keeps these distinct; Linux aliases them to one value.
        if libc::EOPNOTSUPP != libc::ENOTSUP {
            errnos.push(libc::EOPNOTSUPP);
        }
        for errno in errnos {
            let error = std::io::Error::from_raw_os_error(errno);
            assert!(
                is_unsupported_file_flush(&error),
                "expected errno {errno} to be treated as unsupported flush"
            );
        }
        let io_error = std::io::Error::from_raw_os_error(libc::EIO);
        assert!(!is_unsupported_file_flush(&io_error));
    }

    #[test]
    fn sync_file_best_effort_accepts_local_temp_file() {
        let dir =
            std::env::temp_dir().join(format!("zinnia-sync-best-effort-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("file.bin");
        std::fs::write(&path, b"hello").expect("write");
        let file = std::fs::File::open(&path).expect("open");
        sync_file_best_effort(&file).expect("local flush");
        let _ = std::fs::remove_dir_all(dir);
    }
}
