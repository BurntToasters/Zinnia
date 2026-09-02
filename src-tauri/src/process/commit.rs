//! Promote/merge staged outputs, commit and rollback cleanup.

use super::journal::move_identity_log_path;
use super::journal::{
    ensure_path_entry_identity, ensure_path_identity, ensure_recovery_path_unchanged,
    ensure_retract_path_matches, file_identities_match, file_identity, identity_with_file_content,
    identity_with_fingerprint_from, mark_archive_journal_committed, mark_extract_journal_committed,
    move_plan_path, path_identity, path_identity_with_fingerprint, read_bounded_nofollow_bytes,
    record_archive_journal_backup, record_archive_journal_published, regular_file_identity,
    regular_file_identity_with_fingerprint, remove_directory_if_matches,
    remove_regular_file_if_matches, sync_directory, unregister_plan_stages,
    unregister_plan_stages_strict, update_archive_journal, FileIdentity, MoveRecord,
    LEGACY_MOVE_PLAN_FILE_NAME, MAX_MOVE_IDENTITY_LOG_BYTES, MAX_MOVE_IDENTITY_RECORD_BYTES,
    MAX_MOVE_PLAN_BYTES,
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

#[cfg(test)]
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
            // Plain create inherits default ACL / setgid from `target`. Apply
            // parent mode before recursing so nested creates see the corrected
            // policy, not a brief umask-only mode.
            std::fs::create_dir(&target_child).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            crate::fs_secure::apply_parent_directory_mode(&target_child)
                .map_err(|error| error.to_string())?;
            copy_tree_with_inherited_acl(&source_child, &target_child)?;
            #[cfg(windows)]
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

pub(crate) use crate::fs_secure::sync_file_best_effort;

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
    expected_stage_identity: &FileIdentity,
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
    ensure_path_identity(stage_dir, expected_stage_identity).map_err(|error| {
        format!("Archive stage changed after creation and was preserved: {error}")
    })?;
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
            // Always persist the final fingerprinted identity from the still-
            // open post-rename handle. Even filesystems whose stable ID did not
            // change need both active-journal and pending-registry ownership of
            // the sibling backup before commit can proceed.
            record_backup(&path, &backup_identity)?;
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

    // The archive family is durably committed. Cleanup is still part of the
    // owned operation: validate the complete backup set before deleting backup
    // zero, remove all sibling artifacts before the stage, and report failure
    // while preserving the committed publication and recovery ownership.
    let backup_identities = backups
        .iter()
        .map(|(_, _, identity)| Some(identity.clone()))
        .collect::<Vec<_>>();
    super::journal::cleanup_transaction_artifacts(
        stage_dir,
        Some(expected_stage_identity),
        None,
        None,
        &backup_identities,
    )
    .map_err(|error| {
        format!(
            "Archive was committed, but recovery artifact cleanup failed; published archives were preserved: {error}"
        )
    })?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn promote_archive_family(
    staged: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let expected = archive_destination_family_snapshot(destination)?;
    let stage = staged
        .parent()
        .ok_or_else(|| "Staged archive has no parent directory.".to_string())?;
    let stage_identity = path_identity(stage)?;
    promote_archive_family_with_commit(
        staged,
        destination,
        &expected,
        &stage_identity,
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
    // Once publication crossed its durable marker, any cleanup failure remains
    // recovery-owned even when all visible artifacts appear absent. The caller
    // must retain the journal, pending record, and operation slot for startup to
    // replay the identity-checked cleanup boundary.
    if error.contains("was committed, but recovery artifact cleanup failed")
        || error.contains("recovery ownership update failed")
    {
        return false;
    }
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

fn remove_plan_stage_if_owned(plan: &CleanupPlan, stage: &std::path::Path) -> Result<(), String> {
    let identity = plan.stage_identity(stage).ok_or_else(|| {
        format!(
            "Refusing staging cleanup without a creation-bound identity: {}",
            stage.display()
        )
    })?;
    let (move_plan_identity, move_identity_log_identity, archive_backup_identities) =
        if let Some(cache_dir) = &plan.cache_dir {
            super::journal::pending_artifact_identities(cache_dir, stage, identity)?
        } else {
            (None, None, Vec::new())
        };
    super::journal::cleanup_transaction_artifacts(
        stage,
        Some(identity),
        move_plan_identity.as_ref(),
        move_identity_log_identity.as_ref(),
        &archive_backup_identities,
    )
}

pub(crate) fn rollback_cleanup(plan: &CleanupPlan) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Some((staged, _)) = &plan.staged_extract {
        if let Err(e) = remove_plan_stage_if_owned(plan, staged) {
            failures.push(format!(
                "Could not remove partial extract transaction artifacts for {}: {e}",
                staged.display()
            ));
        }
    }
    if let Some((staged, _)) = &plan.staged_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = remove_plan_stage_if_owned(plan, stage_dir) {
            failures.push(format!(
                "Could not remove partial archive staging directory {}: {e}",
                stage_dir.display()
            ));
        }
    }
    if let Some(staged) = &plan.staged_input_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = remove_plan_stage_if_owned(plan, stage_dir) {
            failures.push(format!(
                "Could not remove archive input snapshot {}: {e}",
                stage_dir.display()
            ));
        }
    }
    if failures.is_empty() {
        unregister_plan_stages_strict(plan)
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
    validate_staged_tree_impl(root, max_bytes, false)
}

fn validate_and_sync_staged_tree(root: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    validate_staged_tree_impl(root, max_bytes, true)
}

fn validate_staged_tree_impl(
    root: &std::path::Path,
    max_bytes: u64,
    sync_contents: bool,
) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut directories = Vec::new();
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
        directories.push(directory.clone());
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
                if sync_contents {
                    let file = crate::path_safety::open_regular_file_nofollow(&path)?;
                    let opened_identity = file_identity(&file)?;
                    let current_identity = path_identity(&path)?;
                    if !file_identities_match(&opened_identity, &current_identity) {
                        return Err(format!(
                            "Staged file changed while being prepared for durable publication: {}",
                            path.display()
                        ));
                    }
                    sync_file_best_effort(&file)?;
                    let after_identity = path_identity(&path)?;
                    if !file_identities_match(&opened_identity, &after_identity) {
                        return Err(format!(
                            "Staged file changed while being prepared for durable publication: {}",
                            path.display()
                        ));
                    }
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
    if sync_contents {
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            crate::fs_secure::sync_directory_nofollow(&directory)?;
        }
    }
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
/// are rejected: staged trees should already have failed closed on those.
#[cfg(test)]
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

/// Create each published object under its final parent so destination default
/// ACL / setgid / NTFS inheritance apply. Top-level symlink/reparse entries
/// still rename in place; trees that contain relative symlinks are recreated
/// under the parent after `prepare_planned_links` rewrites their targets.
fn prepare_target_local_publish_paths(
    plan: &mut [MoveRecord],
    reserved: &mut std::collections::HashSet<std::path::PathBuf>,
) -> Result<(), String> {
    for record in plan {
        let metadata =
            std::fs::symlink_metadata(&record.source).map_err(|error| error.to_string())?;
        // Symlink/reparse roots cannot be ACL-copied as ordinary trees; rename
        // preserves the already-validated relative link after rewrite.
        if crate::path_safety::is_link_or_reparse(&metadata) {
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
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if crate::path_safety::is_link_or_reparse(&metadata) {
        return Err(format!(
            "Refusing to remove a publish path that became a link or reparse point: {}",
            path.display()
        ));
    }
    // Type dispatch only. Identity is bound by the quarantine helpers, which
    // preserve a same-name replacement instead of path-walking it.
    if metadata.is_dir() {
        remove_directory_if_matches(path, identity)
    } else if metadata.is_file() {
        remove_regular_file_if_matches(path, identity)
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
    /// Target-local publish creates a temp object directly under the real
    /// target parent so the copy inherits that parent's ACL/mode policy;
    /// rename-only symlink roots leave this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    publish_temp: Option<std::path::PathBuf>,
    identity: FileIdentity,
}

struct MoveIdentityLogWriter {
    path: std::path::PathBuf,
    file: std::fs::File,
    creation_identity: FileIdentity,
    hasher: sha2::Sha256,
    bytes_written: u64,
    records_written: u64,
}

impl MoveIdentityLogWriter {
    fn create(staged: &std::path::Path) -> Result<Self, String> {
        use sha2::Digest as _;

        let path = move_identity_log_path(staged);
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
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
        let mut file = options.open(&path).map_err(|error| error.to_string())?;
        sync_file_best_effort(&file)?;
        let creation_identity = file_identity(&file)?;
        ensure_path_identity(&path, &creation_identity)?;
        let empty_identity = identity_with_file_content(
            creation_identity.clone(),
            0,
            sha2::Sha256::digest([]).into(),
        );
        if super::journal::held_regular_file_identity_with_fingerprint(&mut file)? != empty_identity
        {
            return Err("Extraction identity log changed during creation.".to_string());
        }
        if let Some(parent) = path.parent() {
            sync_directory(parent)?;
        }
        Ok(Self {
            path,
            file,
            creation_identity,
            hasher: sha2::Sha256::new(),
            bytes_written: 0,
            records_written: 0,
        })
    }

    fn current_identity(&self) -> FileIdentity {
        use sha2::Digest as _;

        identity_with_file_content(
            self.creation_identity.clone(),
            self.bytes_written,
            self.hasher.clone().finalize().into(),
        )
    }

    fn append(&mut self, record: &MoveIdentityLogRecord) -> Result<FileIdentity, String> {
        use sha2::Digest as _;
        use std::io::Write as _;

        let mut json = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        if json.len() > MAX_MOVE_IDENTITY_RECORD_BYTES {
            return Err(
                "Extraction identity log record exceeds its byte safety limit.".to_string(),
            );
        }
        json.push(b'\n');
        let next_bytes = self.bytes_written.saturating_add(json.len() as u64);
        let next_records = self.records_written.saturating_add(1);
        if next_bytes > MAX_MOVE_IDENTITY_LOG_BYTES
            || next_records > MAX_EXTRACT_ENTRIES.saturating_mul(2)
        {
            return Err("Extraction identity log exceeds its safety limit.".to_string());
        }
        self.file
            .write_all(&json)
            .map_err(|error| error.to_string())?;
        sync_file_best_effort(&self.file)?;
        self.hasher.update(&json);
        self.bytes_written = next_bytes;
        self.records_written = next_records;
        let identity = self.current_identity();
        let actual = file_identity(&self.file)?;
        let metadata = self.file.metadata().map_err(|error| error.to_string())?;
        if !file_identities_match(&actual, &identity) || metadata.len() != self.bytes_written {
            return Err("Extraction identity log changed during append.".to_string());
        }
        ensure_path_identity(&self.path, &identity)?;
        Ok(identity)
    }

    fn seal(mut self) -> Result<FileIdentity, String> {
        sync_file_best_effort(&self.file)?;
        let expected = self.current_identity();
        let held = super::journal::held_regular_file_identity_with_fingerprint(&mut self.file)?;
        if held != expected {
            return Err("Extraction identity log changed before it was sealed.".to_string());
        }
        ensure_path_identity(&self.path, &expected)?;
        Ok(expected)
    }
}

fn hydrate_move_plan_identities(
    contents: Option<&[u8]>,
    plan: &mut [MoveRecord],
) -> Result<(), String> {
    let Some(contents) = contents else {
        return Ok(());
    };
    let mut records = 0u64;
    for raw_line in contents.split_inclusive(|byte| *byte == b'\n') {
        if !raw_line.ends_with(b"\n") {
            // A crash can leave one torn append. Ignore only the incomplete
            // final record; complete malformed records remain a hard error.
            break;
        }
        if raw_line.len() > MAX_MOVE_IDENTITY_RECORD_BYTES.saturating_add(1) {
            return Err(
                "Extraction identity log record exceeds its byte safety limit.".to_string(),
            );
        }
        records = records.saturating_add(1);
        if records > MAX_EXTRACT_ENTRIES.saturating_mul(2) {
            return Err("Extraction identity log exceeds its record safety limit.".to_string());
        }
        let mut line = &raw_line[..raw_line.len() - 1];
        if line.ends_with(b"\r") {
            line = &line[..line.len() - 1];
        }
        if line.is_empty() {
            return Err("Extraction identity log contains an empty record.".to_string());
        }
        let record: MoveIdentityLogRecord =
            serde_json::from_slice(line).map_err(|error| error.to_string())?;
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

trait ExtractArtifactRecorder {
    fn record_move_plan(&mut self, identity: &FileIdentity) -> Result<(), String>;
    fn record_move_identity_log(&mut self, identity: &FileIdentity) -> Result<(), String>;
}

/// Journal a publish identity in the append-only log and mirror it into the
/// in-memory plan. The updated log fingerprint is persisted before the
/// corresponding object can be published.
fn record_publish_identity<R: ExtractArtifactRecorder>(
    recorder: &mut R,
    identity_log: &mut MoveIdentityLogWriter,
    plan: &mut [MoveRecord],
    index: usize,
    identity: &FileIdentity,
) -> Result<(), String> {
    let publish_temp = plan
        .get(index)
        .and_then(|record| record.publish_temp.clone());
    let log_identity = identity_log.append(&MoveIdentityLogRecord {
        index,
        publish_temp,
        identity: identity.clone(),
    })?;
    recorder.record_move_identity_log(&log_identity)?;
    plan[index].publish_identity = Some(identity.clone());
    Ok(())
}

fn publish_target_local_copy<R: ExtractArtifactRecorder>(
    recorder: &mut R,
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
            record_publish_identity(recorder, identity_log, plan, index, identity)
        })
    } else if metadata.is_dir() {
        // Create under the final parent so default ACL / setgid / NTFS policy
        // inherit. Windows uses the inheriting helper for SMB-safe DACLs;
        // Unix uses plain mkdir (explicit 0o700 would defeat inheritance).
        #[cfg(windows)]
        crate::fs_secure::create_inheriting_stage_dir(&publish_temp)
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        std::fs::create_dir(&publish_temp).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        crate::fs_secure::apply_parent_directory_mode(&publish_temp)
            .map_err(|error| error.to_string())?;
        let identity = path_identity(&publish_temp)?;
        let journal_result =
            record_publish_identity(recorder, identity_log, plan, index, &identity);
        if let Err(error) = journal_result {
            let cleanup = remove_path_if_matches(&publish_temp, &identity);
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => {
                    format!("{error}; publish-temp cleanup also failed: {cleanup_error}")
                }
            });
        }
        let copied = copy_tree_with_inherited_acl(&source, &publish_temp);
        #[cfg(windows)]
        let copied = copied.and_then(|()| copy_windows_directory_metadata(&source, &publish_temp));
        let result = copied.and_then(|()| sync_directory(&publish_temp));
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
    record_publish_identity(recorder, identity_log, plan, index, &published_snapshot)?;

    // Created under the final parent, so rename preserves inherited ACL/mode
    // and still refuses an existing destination.
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

pub(crate) fn write_move_plan(
    staged: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<FileIdentity, String> {
    use sha2::Digest as _;
    use std::io::Write as _;

    if plan.len() as u64 > MAX_EXTRACT_ENTRIES {
        return Err("Extraction move plan exceeds its record safety limit.".to_string());
    }
    let bytes = serde_json::to_vec(plan).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MOVE_PLAN_BYTES {
        return Err("Extraction move plan exceeds its byte safety limit.".to_string());
    }
    let path = move_plan_path(staged);
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    let mut file = options.open(&path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    sync_file_best_effort(&file)?;
    let expected = identity_with_file_content(
        file_identity(&file)?,
        bytes.len() as u64,
        sha2::Sha256::digest(&bytes).into(),
    );
    let held = super::journal::held_regular_file_identity_with_fingerprint(&mut file)?;
    if held != expected {
        return Err("Extraction move plan changed while it was installed.".to_string());
    }
    ensure_path_identity(&path, &expected).map_err(|error| {
        format!("Extraction move plan final name changed during creation: {error}")
    })?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(expected)
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
        if publish_temp.parent() != record.target.parent()
            || !crate::path_safety::path_is_under_or_equal(destination, publish_temp)
            || !is_publish_temp_name(publish_temp)
        {
            return Err("Refusing unsafe extraction publish path.".to_string());
        }
    } else if record.publish_identity.is_some() {
        #[cfg(windows)]
        {
            // New Windows publishes always set publish_temp for non-link roots.
            // Only rename-published symlink/reparse roots may omit it.
            let allows_rename_publish = |path: &std::path::Path| -> bool {
                std::fs::symlink_metadata(path)
                    .map(|metadata| crate::path_safety::is_link_or_reparse(&metadata))
                    .unwrap_or(false)
            };
            if !allows_rename_publish(&record.source) && !allows_rename_publish(&record.target) {
                return Err(
                    "Refusing extraction publish identity without a publish path.".to_string(),
                );
            }
        }
        // Unix still accepts legacy rename/hardlink journals without
        // publish_temp so interrupted pre-0.6.1 merges can recover.
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
        // whole stage is committed. Quarantine-delete only the recorded object;
        // a same-name replacement is preserved.
        if target_exists && ensure_path_identity(&record.target, identity).is_ok() {
            if crash_recovery {
                ensure_retract_path_matches(&record.target, identity)?;
            }
            remove_path_if_matches(&record.target, identity)?;
        }
        if temp_exists {
            if crash_recovery {
                ensure_retract_path_matches(publish_temp, identity)?;
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
            ensure_retract_path_matches(&record.target, identity)?;
        }
        if let Some(parent) = record.source.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        return rename_file_no_replace(&record.target, &record.source);
    }
    if temp_exists && ensure_path_identity(publish_temp, identity).is_ok() {
        if crash_recovery {
            ensure_retract_path_matches(publish_temp, identity)?;
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
                    if let Err(error) = ensure_retract_path_matches(&record.target, identity) {
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
            ensure_retract_path_matches(&record.target, identity)
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
    move_plan_identity: Option<&FileIdentity>,
    move_identity_log_identity: Option<&FileIdentity>,
) -> Result<(), String> {
    let plan_path = move_plan_path(staged);
    let sibling_plan = match std::fs::symlink_metadata(&plan_path) {
        Ok(_) => {
            let expected = move_plan_identity.ok_or_else(|| {
                format!(
                    "Refusing to read present move-plan sibling {} without its recorded identity.",
                    plan_path.display()
                )
            })?;
            super::journal::read_bounded_nofollow_bytes_if_matches(
                &plan_path,
                MAX_MOVE_PLAN_BYTES,
                expected,
            )?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let plan_bytes = match sibling_plan {
        Some(bytes) => Some(bytes),
        None if allow_legacy_location => {
            // Conservative compatibility: only the stage-owned in-payload plan
            // may be read without a sibling identity.
            read_bounded_nofollow_bytes(
                &staged.join(LEGACY_MOVE_PLAN_FILE_NAME),
                MAX_MOVE_PLAN_BYTES,
            )?
        }
        None => None,
    };

    let log_path = move_identity_log_path(staged);
    let log_bytes = match std::fs::symlink_metadata(&log_path) {
        Ok(_) => {
            let expected = move_identity_log_identity.ok_or_else(|| {
                format!(
                    "Refusing to read present move-identity-log sibling {} without its recorded identity.",
                    log_path.display()
                )
            })?;
            super::journal::read_bounded_nofollow_bytes_if_matches(
                &log_path,
                MAX_MOVE_IDENTITY_LOG_BYTES,
                expected,
            )?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let Some(plan_bytes) = plan_bytes else {
        if log_bytes.is_some() {
            return Err(
                "Extraction identity log is present without an authenticated move plan."
                    .to_string(),
            );
        }
        return Ok(());
    };
    let mut plan: Vec<MoveRecord> =
        serde_json::from_slice(&plan_bytes).map_err(|error| error.to_string())?;
    if plan.len() as u64 > MAX_EXTRACT_ENTRIES {
        return Err("Extraction move plan exceeds its record safety limit.".to_string());
    }
    hydrate_move_plan_identities(log_bytes.as_deref(), &mut plan)?;
    rollback_move_records_impl(staged, destination, &plan, true)
}

fn merge_staged_extract_recorded<R, F>(
    staged: &std::path::Path,
    destination: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    max_bytes: u64,
    recorder: &mut R,
    mark_committed: F,
) -> Result<Vec<std::path::PathBuf>, String>
where
    R: ExtractArtifactRecorder,
    F: FnOnce() -> Result<(), String>,
{
    ensure_path_identity(staged, expected_stage_identity).map_err(|error| {
        format!("Extraction stage changed after creation and was preserved: {error}")
    })?;
    // Always enforce the operation-specific limit immediately before publish,
    // and make every regular file plus directory entry durable before any
    // staged object becomes visible at the destination.
    validate_and_sync_staged_tree(staged, max_bytes)?;
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
        let publish_identity = path_identity_with_fingerprint(staged)?;
        if !file_identities_match(&publish_identity, expected_stage_identity) {
            return Err(
                "Extraction stage changed before whole-stage publication and was preserved."
                    .to_string(),
            );
        }
        let final_identity = path_identity_with_fingerprint(staged)?;
        if !file_identities_match(&publish_identity, &final_identity)
            || publish_identity.fingerprint() != final_identity.fingerprint()
        {
            return Err("Extraction stage changed before whole-stage publication.".to_string());
        }
        rename_file_no_replace(staged, destination)?;
        let verification_error = match path_identity_with_fingerprint(destination) {
            Ok(actual)
                if file_identities_match(&actual, expected_stage_identity)
                    && actual.fingerprint() == publish_identity.fingerprint() =>
            {
                None
            }
            Ok(_) => Some("published stage identity changed".to_string()),
            Err(error) => Some(error),
        };
        if let Some(verification_error) = verification_error {
            return Err(format!(
                "Extraction destination did not retain the creation-bound stage identity and was preserved for recovery: {verification_error}"
            ));
        }
        if let Err(error) = crate::fs_secure::apply_parent_directory_mode(destination) {
            return Err(format!(
                "{error}; the published extraction destination was preserved for journal recovery"
            ));
        }
        let durability = if let Some(parent) = destination.parent() {
            sync_directory(parent)
        } else {
            Ok(())
        };
        if let Err(error) = durability {
            return Err(format!(
                "{error}; the published extraction destination was preserved for journal recovery"
            ));
        }
        if let Err(error) = mark_committed() {
            return Err(format!(
                "{error}; the published extraction destination was preserved for journal recovery"
            ));
        }
        return Ok(vec![destination.to_path_buf()]);
    }
    assert_real_directory(destination)?;
    let mut reserved = std::collections::HashSet::new();
    let mut plan = Vec::new();
    plan_staged_contents(staged, destination, &mut reserved, &mut plan)?;
    prepare_planned_links(staged, destination, &plan)?;
    prepare_target_local_publish_paths(&mut plan, &mut reserved)?;
    // Install both recovery siblings with create-new semantics. Each identity is
    // persisted to the active journal and exact pending record before any
    // destination publication begins.
    let move_plan_identity = write_move_plan(staged, &plan)?;
    recorder.record_move_plan(&move_plan_identity)?;
    let mut identity_log = MoveIdentityLogWriter::create(staged)?;
    let mut move_identity_log_identity = identity_log.current_identity();
    recorder.record_move_identity_log(&move_identity_log_identity)?;
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
            if plan[index].publish_temp.is_some() {
                return publish_target_local_copy(recorder, &mut identity_log, &mut plan, index);
            }
            let metadata = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
            if !crate::path_safety::is_link_or_reparse(&metadata) {
                return Err(format!(
                    "Extraction publish path missing for non-link entry: {}",
                    source.display()
                ));
            }
            let expected = path_identity_with_fingerprint(&source)?;
            record_publish_identity(recorder, &mut identity_log, &mut plan, index, &expected)?;
            rename_file_no_replace(&source, &target)?;
            let actual = path_identity_with_fingerprint(&plan[index].target)?;
            if actual.fingerprint() != expected.fingerprint() {
                return Err(format!(
                    "Extraction link changed during commit: {}",
                    plan[index].target.display()
                ));
            }
            if !file_identities_match(&actual, &expected) {
                record_publish_identity(recorder, &mut identity_log, &mut plan, index, &actual)?;
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
    move_identity_log_identity = match identity_log.seal().and_then(|identity| {
        recorder.record_move_identity_log(&identity)?;
        Ok(identity)
    }) {
        Ok(identity) => identity,
        Err(error) => {
            let rollback = rollback_move_records_impl(staged, destination, &plan, true);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}; extraction seal rollback also failed: {rollback_error}")
                }
            });
        }
    };
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

    // The journal now records a durable extraction commit. Cleanup remains an
    // owned recovery operation: return failure while preserving publication so
    // the journal, pending record, and process slot stay available for retry.
    super::journal::cleanup_transaction_artifacts(
        staged,
        Some(expected_stage_identity),
        Some(&move_plan_identity),
        Some(&move_identity_log_identity),
        &[],
    )
    .map_err(|error| {
        format!(
            "Extraction was committed, but recovery artifact cleanup failed; published files were preserved: {error}"
        )
    })?;
    Ok(promoted)
}

struct JournalExtractArtifactRecorder<'a> {
    app: &'a tauri::AppHandle,
    plan: &'a CleanupPlan,
}

impl ExtractArtifactRecorder for JournalExtractArtifactRecorder<'_> {
    fn record_move_plan(&mut self, identity: &FileIdentity) -> Result<(), String> {
        super::journal::record_extract_move_plan_identity(self.app, self.plan, identity)
    }

    fn record_move_identity_log(&mut self, identity: &FileIdentity) -> Result<(), String> {
        super::journal::record_extract_move_identity_log_identity(self.app, self.plan, identity)
    }
}

#[cfg(test)]
struct TestExtractArtifactRecorder;

#[cfg(test)]
impl ExtractArtifactRecorder for TestExtractArtifactRecorder {
    fn record_move_plan(&mut self, _identity: &FileIdentity) -> Result<(), String> {
        Ok(())
    }

    fn record_move_identity_log(&mut self, _identity: &FileIdentity) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn merge_staged_extract_with_commit<F>(
    staged: &std::path::Path,
    destination: &std::path::Path,
    expected_stage_identity: &FileIdentity,
    max_bytes: u64,
    mark_committed: F,
) -> Result<Vec<std::path::PathBuf>, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let mut recorder = TestExtractArtifactRecorder;
    merge_staged_extract_recorded(
        staged,
        destination,
        expected_stage_identity,
        max_bytes,
        &mut recorder,
        mark_committed,
    )
}

#[cfg(test)]
pub(crate) fn merge_staged_extract(
    staged: &std::path::Path,
    destination: &std::path::Path,
    max_bytes: u64,
) -> Result<Vec<std::path::PathBuf>, String> {
    let stage_identity = path_identity(staged)?;
    merge_staged_extract_with_commit(staged, destination, &stage_identity, max_bytes, || Ok(()))
}

pub(crate) fn commit_cleanup(app: &tauri::AppHandle, plan: &CleanupPlan) -> Result<(), String> {
    let input_only = plan.staged_input_archive.is_some()
        && plan.staged_extract.is_none()
        && plan.staged_archive.is_none();
    if let Some(staged) = &plan.staged_input_archive {
        remove_plan_stage_if_owned(plan, staged.parent().unwrap_or(staged))
            .map_err(|e| format!("Could not remove archive input snapshot: {e}"))?;
        if input_only {
            super::journal::unregister_plan_stages(plan);
        }
    }
    if let Some((staged, destination)) = &plan.staged_extract {
        let stage_identity = plan.stage_identity(staged).ok_or_else(|| {
            "Extraction stage has no creation-bound ownership identity.".to_string()
        })?;
        let mut recorder = JournalExtractArtifactRecorder { app, plan };
        merge_staged_extract_recorded(
            staged,
            destination,
            stage_identity,
            plan.max_extract_bytes.unwrap_or(MAX_EXTRACTED_BYTES),
            &mut recorder,
            || mark_extract_journal_committed(app, plan),
        )
        .map_err(|e| format!("Could not promote staged extraction safely: {e}"))?;
        crate::launch::remember_openable_directory(app, destination);
    }
    if let Some((staged, destination)) = &plan.staged_archive {
        assert_archive_destination_unchanged(destination, &plan.expected_archive_family)?;
        update_archive_journal(app, plan)
            .map_err(|error| format!("Archive recovery ownership update failed: {error}"))?;
        let stage = staged
            .parent()
            .ok_or_else(|| "Archive staging directory is missing.".to_string())?;
        let stage_identity = plan
            .stage_identity(stage)
            .ok_or_else(|| "Archive stage has no creation-bound ownership identity.".to_string())?;
        promote_archive_family_with_commit(
            staged,
            destination,
            &plan.expected_archive_family,
            stage_identity,
            |original, identity| {
                record_archive_journal_backup(app, plan, original, identity)
                    .map_err(|error| format!("Archive recovery ownership update failed: {error}"))
            },
            |published, identity| {
                record_archive_journal_published(app, plan, published, identity)
                    .map_err(|error| format!("Archive recovery ownership update failed: {error}"))
            },
            || {
                mark_archive_journal_committed(app, plan)
                    .map_err(|error| format!("Archive recovery ownership update failed: {error}"))
            },
        )?;
        if let Some(parent) = destination.parent() {
            crate::launch::remember_openable_directory(app, parent);
        }
    }
    if plan.staged_extract.is_some() || plan.staged_archive.is_some() {
        unregister_plan_stages_strict(plan).map_err(|error| {
            format!(
                "Transaction was committed, but recovery artifact cleanup failed; published output was preserved: {error}"
            )
        })?;
    } else {
        unregister_plan_stages(plan);
    }
    Ok(())
}
