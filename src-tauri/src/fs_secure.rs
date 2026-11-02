//! Cross-platform helpers for private/internal directories, inheriting publish stages,
//! and durable directory sync.

use std::io;
use std::path::Path;

#[cfg(unix)]
mod unix;
#[cfg(any(windows, test))]
mod windows;

#[cfg(unix)]
pub use unix::apply_parent_directory_mode;
#[cfg(windows)]
pub(crate) use windows::{assert_handle_owned_by_current_user, system32_binary_path};

#[cfg(test)]
pub(crate) use windows::{
    decode_windows_command_file, is_valid_windows_sid_string, parse_whoami_user_csv,
    private_directory_sddl,
};

#[cfg(all(test, windows))]
pub(crate) use windows::{
    access_allowed_ace_view, create_private_file_windows, current_user_identity,
    current_user_sid_from_token, dacl_matches_expected, open_directory_for_acl_verification,
    read_directory_security_descriptor, security_descriptor_dacl, security_descriptor_owner,
    system32_whoami_path,
};

/// Create a new directory that is private to the current user when the OS allows it.
/// Unix: mode 0o700. Windows: disable inheritance and grant only the current user + SYSTEM.
pub(crate) fn open_directory_nofollow(path: &Path) -> io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        unix::open_directory_nofollow(path)
    }

    #[cfg(windows)]
    {
        windows::open_directory_nofollow(path)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let directory = std::fs::File::open(path)?;
        if !directory.metadata()?.is_dir() {
            return Err(io::Error::other("Staging path is not a directory."));
        }
        Ok(directory)
    }
}

pub(crate) fn create_private_dir_open(path: &Path) -> io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        std::fs::DirBuilder::new().mode(0o700).create(path)?;
        open_directory_nofollow(path)
    }

    #[cfg(windows)]
    {
        windows::create_private_dir_windows(path)
    }

    #[cfg(not(any(unix, windows)))]
    {
        std::fs::create_dir(path)?;
        open_directory_nofollow(path)
    }
}

pub fn create_private_dir(path: &Path) -> io::Result<()> {
    create_private_dir_open(path).map(drop)
}

/// Create a new private file owned by the current user (CREATE_NEW).
///
/// On Windows this applies the same protected SDDL as shell handoffs / private
/// directories. Elevated processes otherwise default new-object owners to the
/// Administrators group, which must not pass the shell-handoff owner check.
#[cfg(all(windows, test))]
pub(crate) fn create_private_file(path: &Path) -> io::Result<std::fs::File> {
    windows::create_private_file_windows(path)
}

/// Create a publish staging directory with the parent directory's normal policy.
///
/// On Windows this deliberately uses the parent directory's default security
/// descriptor instead of a local-account-specific private DACL. Network servers
/// may authenticate the SMB session as a different account, translate SIDs, or
/// normalize ACLs. Creating the stage under the ACL source that should govern the
/// published output matches ordinary Windows and SMB file creation.
///
/// App-owned temporary directories and list files must continue to use
/// `create_private_dir`; this compatibility helper is only for randomly named
/// publish stages whose contents are later committed to the same location.
#[cfg(windows)]
pub(crate) fn create_inheriting_stage_dir_open(path: &Path) -> io::Result<std::fs::File> {
    windows::create_inheriting_stage_dir_windows(path)
}

#[cfg(windows)]
pub fn create_inheriting_stage_dir(path: &Path) -> io::Result<()> {
    create_inheriting_stage_dir_open(path).map(drop)
}

/// Create a private stage and return the handle from the held-parent creation
/// context. The caller must derive ownership only from this returned handle.
pub(crate) fn create_private_stage_dir_open(
    parent: &Path,
    name: &std::ffi::OsStr,
) -> io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        unix::create_stage_directory_in_held_parent(parent, name, 0o700)
    }
    #[cfg(windows)]
    {
        if name.is_empty()
            || name == std::ffi::OsStr::new(".")
            || name == std::ffi::OsStr::new("..")
            || std::path::Path::new(name).components().count() != 1
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a single safe path component",
            ));
        }
        // The Windows helper creates one child relative to a held parent and
        // returns the handle from that same operation; ACL verification and
        // ownership identity never reopen the public child pathname.
        windows::create_private_dir_windows(&parent.join(name))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (parent, name);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "creation-bound staging directory handles are unavailable on this platform",
        ))
    }
}

/// Create a publish stage in one held-parent context and return the handle used
/// to establish its ownership identity.
pub(crate) fn create_inheriting_stage_dir_open_in(
    parent: &Path,
    name: &std::ffi::OsStr,
) -> io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        unix::create_stage_directory_in_held_parent(parent, name, 0o700)
    }
    #[cfg(windows)]
    {
        windows::create_inheriting_stage_dir_windows(&parent.join(name))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (parent, name);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "creation-bound staging directory handles are unavailable on this platform",
        ))
    }
}

/// After an atomic extract-root rename, match the destination parent's mode so
/// a private 0o700 stage does not leave a permanently restrictive directory.

#[cfg(not(unix))]
pub fn apply_parent_directory_mode(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Remove an app-owned directory tree, clearing Windows read-only attributes
/// first so extracted archive metadata cannot make cleanup fail after publish.
/// Reparse points are rejected rather than traversed.
pub fn remove_dir_all_for_cleanup(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    windows::clear_windows_readonly_tree(path)?;
    std::fs::remove_dir_all(path)
}

/// Remove an app-owned regular file, clearing the Windows read-only attribute
/// first. The final path component must not be a link or reparse point.
pub fn remove_file_for_cleanup(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(io::Error::other(format!(
            "Refusing to remove an unexpected cleanup file: {}",
            path.display()
        )));
    }
    #[cfg(windows)]
    windows::clear_windows_readonly(path, &metadata)?;
    std::fs::remove_file(path)
}

fn quarantine_component() -> io::Result<String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    Ok(format!(
        ".zinnia-quarantine-{}",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

/// Atomically move a regular file to a random same-directory quarantine name,
/// bind the moved entry to the already-open source object, run an optional
/// identity/content verifier on the quarantined handle, and only then unlink it.
/// On Unix every namespace operation is relative to one held, no-follow parent.
/// Windows uses the strongest available no-follow/path quarantine sequence but
/// cannot claim descriptor-relative ancestor protection.
pub(crate) fn quarantine_regular_file_if<F>(path: &Path, mut verify: F) -> io::Result<bool>
where
    F: FnMut(&mut std::fs::File) -> io::Result<bool>,
{
    #[cfg(unix)]
    {
        use rustix::fs::{AtFlags, OFlags};

        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let original_os = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
        let original = unix::unix_component(original_os)?;
        let directory = unix::open_unix_path(
            parent,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        )?;
        let source = match unix::open_regular_relative(&directory, &original) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let source_stat = unix::stat_open_file(&source)?;

        let quarantine_name = quarantine_component()?;
        let quarantine = unix::unix_component(std::ffi::OsStr::new(&quarantine_name))?;
        unix::rename_relative_no_replace(&directory, &original, &quarantine)?;
        let mut quarantined = match unix::open_regular_relative(&directory, &quarantine) {
            Ok(file) => file,
            Err(error) => {
                return unix::restore_quarantine(
                    &directory,
                    &quarantine,
                    &original,
                    path,
                    &format!("Could not verify quarantined cleanup entry: {error}"),
                );
            }
        };
        let quarantine_stat = unix::stat_open_file(&quarantined)?;
        if !unix::same_unix_object(&source_stat, &quarantine_stat) {
            return unix::restore_quarantine(
                &directory,
                &quarantine,
                &original,
                path,
                "Cleanup entry changed before quarantine and was preserved.",
            );
        }
        drop(source);
        if !verify(&mut quarantined)? {
            return unix::restore_quarantine(
                &directory,
                &quarantine,
                &original,
                path,
                "Quarantined cleanup entry did not match its recorded identity and was preserved.",
            );
        }
        let named_stat = unix::stat_named_entry(&directory, &quarantine)?;
        if !unix::same_unix_object(&quarantine_stat, &named_stat) {
            return unix::restore_quarantine(
                &directory,
                &quarantine,
                &original,
                path,
                "Quarantined cleanup entry changed during verification and was preserved.",
            );
        }
        rustix::fs::unlinkat(&directory, &quarantine, AtFlags::empty())?;
        sync_file_best_effort(&directory).map_err(io::Error::other)?;
        Ok(true)
    }

    #[cfg(windows)]
    {
        // Windows has no descriptor-relative rename/unlink equivalent in the
        // current portability layer. Hold the no-follow source, move it to an
        // unpredictable same-parent name with a path-based no-replace rename,
        // bind that name back to the source file ID, verify there, and recheck
        // immediately before removal. Ancestor substitution and the final
        // path-based unlink remain documented Windows limitations; every
        // detected mismatch is preserved and no restore may overwrite a name.
        let source = match crate::path_safety::open_regular_file_nofollow(path) {
            Ok(file) => file,
            Err(_)
                if std::fs::symlink_metadata(path).is_err_and(|metadata_error| {
                    metadata_error.kind() == io::ErrorKind::NotFound
                }) =>
            {
                return Ok(false)
            }
            Err(error) => return Err(io::Error::other(error)),
        };
        let source_identity = crate::process::file_identity(&source).map_err(io::Error::other)?;
        let quarantine = path.with_file_name(quarantine_component()?);
        crate::process::rename_file_no_replace(path, &quarantine).map_err(io::Error::other)?;

        let restore = |reason: String| -> io::Result<bool> {
            match crate::process::rename_file_no_replace(&quarantine, path) {
                Ok(()) => Err(io::Error::other(reason)),
                Err(restore_error) => Err(io::Error::other(format!(
                    "{reason} The entry was preserved beside {} under {} because its original name could not be restored: {restore_error}",
                    path.display(),
                    quarantine.display()
                ))),
            }
        };
        let mut quarantined = match crate::path_safety::open_regular_file_nofollow(&quarantine) {
            Ok(file) => file,
            Err(error) => {
                return restore(format!(
                    "Could not verify quarantined cleanup entry: {error}"
                ));
            }
        };
        let quarantine_identity =
            crate::process::file_identity(&quarantined).map_err(io::Error::other)?;
        if !crate::process::file_identities_match(&quarantine_identity, &source_identity) {
            return restore(
                "Cleanup entry changed before quarantine and was preserved.".to_string(),
            );
        }
        drop(source);
        if !verify(&mut quarantined)? {
            return restore(
                "Quarantined cleanup entry did not match its recorded identity and was preserved."
                    .to_string(),
            );
        }
        let named = match crate::path_safety::open_regular_file_nofollow(&quarantine) {
            Ok(file) => file,
            Err(error) => {
                return restore(format!(
                    "Could not recheck quarantined cleanup entry: {error}"
                ));
            }
        };
        let named_identity = crate::process::file_identity(&named).map_err(io::Error::other)?;
        if !crate::process::file_identities_match(&named_identity, &quarantine_identity) {
            return restore(
                "Quarantined cleanup entry changed during verification and was preserved."
                    .to_string(),
            );
        }
        drop((named, quarantined));
        remove_file_for_cleanup(&quarantine)?;
        Ok(true)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, verify);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "verified quarantine deletion is unavailable on this platform",
        ))
    }
}

pub(crate) fn quarantine_directory_if<F>(path: &Path, mut verify: F) -> io::Result<bool>
where
    F: FnMut(&std::fs::File) -> io::Result<bool>,
{
    #[cfg(unix)]
    {
        use rustix::fs::{AtFlags, OFlags};

        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let original_os = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
        let original = unix::unix_component(original_os)?;
        let directory = unix::open_unix_path(
            parent,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        )?;
        let source = match unix::open_directory_relative(&directory, &original) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let source_stat = unix::stat_open_file(&source)?;
        let quarantine_name = quarantine_component()?;
        let quarantine = unix::unix_component(std::ffi::OsStr::new(&quarantine_name))?;
        unix::rename_relative_no_replace(&directory, &original, &quarantine)?;
        let quarantined = match unix::open_directory_relative(&directory, &quarantine) {
            Ok(file) => file,
            Err(error) => {
                return unix::restore_quarantine(
                    &directory,
                    &quarantine,
                    &original,
                    path,
                    &format!("Could not verify quarantined directory: {error}"),
                );
            }
        };
        let quarantine_stat = unix::stat_open_file(&quarantined)?;
        if !unix::same_unix_object(&source_stat, &quarantine_stat) || !verify(&quarantined)? {
            return unix::restore_quarantine(
                &directory,
                &quarantine,
                &original,
                path,
                "Quarantined directory did not match its recorded identity and was preserved.",
            );
        }
        drop(source);
        unix::remove_directory_contents_relative(&quarantined)?;
        let named_stat = unix::stat_named_entry(&directory, &quarantine)?;
        let opened_stat = unix::stat_open_file(&quarantined)?;
        if !unix::same_unix_object(&named_stat, &opened_stat) {
            return Err(io::Error::other(
                "Quarantined directory name changed during cleanup; replacement was preserved.",
            ));
        }
        drop(quarantined);
        rustix::fs::unlinkat(&directory, &quarantine, AtFlags::REMOVEDIR)?;
        sync_file_best_effort(&directory).map_err(io::Error::other)?;
        Ok(true)
    }

    #[cfg(windows)]
    {
        // Rename is still a path-based no-replace MoveFileW, so ancestor
        // substitution remains a documented Windows residual. Deletion is bound
        // to the creation/quarantine handle: contents and the directory itself
        // are removed through that object, never through a later pathname walk.
        let source = match windows::open_directory_for_quarantine(path) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let source_identity = crate::process::file_identity(&source).map_err(io::Error::other)?;
        let quarantine = path.with_file_name(quarantine_component()?);
        crate::process::rename_file_no_replace(path, &quarantine).map_err(io::Error::other)?;
        let restore = |reason: String| -> io::Result<bool> {
            match crate::process::rename_file_no_replace(&quarantine, path) {
                Ok(()) => Err(io::Error::other(reason)),
                Err(restore_error) => Err(io::Error::other(format!(
                    "{reason} The entry was preserved beside {} under {} because its original name could not be restored: {restore_error}",
                    path.display(),
                    quarantine.display()
                ))),
            }
        };
        let named = match windows::open_directory_for_quarantine(&quarantine) {
            Ok(file) => file,
            Err(error) => {
                return restore(format!("Could not verify quarantined directory: {error}"));
            }
        };
        let named_identity = crate::process::file_identity(&named).map_err(io::Error::other)?;
        if !crate::process::file_identities_match(&named_identity, &source_identity)
            || !verify(&named)?
        {
            drop(named);
            return restore(
                "Quarantined directory did not match its recorded identity and was preserved."
                    .to_string(),
            );
        }
        drop(named);
        windows::remove_directory_contents_relative(&source)?;
        windows::mark_handle_deleted(&source)?;
        Ok(true)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, verify);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "verified quarantine deletion is unavailable on this platform",
        ))
    }
}

/// Remove the exact regular object opened immediately before quarantine. A
/// replacement inserted after that open is moved aside, detected, and restored
/// (or left under its quarantine name if restoration collides). Unix then
/// unlinks the verified quarantine name; Windows path-unlinks that name after
/// dropping handles.
pub fn remove_regular_file_nofollow_if_exists(path: &Path) -> io::Result<bool> {
    quarantine_regular_file_if(path, |_| Ok(true))
}

/// Flush directory metadata so rename/create durability survives a crash where possible.
pub fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows has no portable fsync(dirfd) equivalent. `sync_all` may work
        // on an opened directory, but Windows rejects volume roots with error 3
        // and many local/SMB filesystems return access denied, invalid function,
        // invalid handle, not supported, or invalid parameter. First prove the
        // path still names a real directory, then treat only those known
        // unsupported flush results as best effort. Other I/O failures remain
        // fatal so a disconnected share or vanished non-root path is reported.
        // Following an already-approved directory reparse point is safe here:
        // this helper only flushes and is also used for redirected app data.
        let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err(format!(
                "Could not sync a path that is not a directory: {}",
                path.display()
            ));
        }
        // Plain `File::open` never sets FILE_FLAG_BACKUP_SEMANTICS, so opening a
        // directory with it always fails with ERROR_ACCESS_DENIED (5) before a
        // handle is even obtained. That used to make every Windows call in this
        // function silently succeed without ever touching FlushFileBuffers, which
        // defeated the durability semantics this helper promises to callers. Open
        // with backup semantics explicitly so a real handle can be flushed.
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        let open_result = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path);
        // Separate open failures from flush failures: an unopenable path is a
        // real I/O error (only the volume-root NotFound is benign), whereas the
        // tolerated codes below are per-filesystem FlushFileBuffers results.
        let directory = match open_result {
            Ok(directory) => directory,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound && path.parent().is_none() =>
            {
                return Ok(());
            }
            Err(error) => {
                return Err(format!(
                    "Could not open directory to sync {}: {error}",
                    path.display()
                ));
            }
        };
        match directory.sync_all() {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(()),
            Err(error) if matches!(error.raw_os_error(), Some(1 | 6 | 50 | 87)) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    #[cfg(unix)]
    {
        let directory = std::fs::File::open(path).map_err(|error| error.to_string())?;
        sync_file_best_effort(&directory)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(())
    }
}

/// Flush a directory through a handle that refuses a link/reparse final component.
/// Security-sensitive staged-tree callers use this variant; the general helper
/// above still permits redirected application-data directories.
pub fn sync_directory_nofollow(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use rustix::fs::OFlags;
        let directory =
            unix::open_unix_path(path, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW)
                .map_err(|error| error.to_string())?;
        let metadata = directory.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err(format!("Expected a real directory: {}", path.display()));
        }
        sync_file_best_effort(&directory)
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| error.to_string())?;
        let metadata = directory.metadata().map_err(|error| error.to_string())?;
        if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() {
            return Err(format!("Expected a real directory: {}", path.display()));
        }
        match directory.sync_all() {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(()),
            Err(error) if matches!(error.raw_os_error(), Some(1 | 6 | 50 | 87)) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        sync_directory(path)
    }
}

/// Flush file data with mount-tolerant fallbacks.
///
/// - Windows: `PermissionDenied` from `FlushFileBuffers` is ignored (same
///   policy as [`sync_directory`]).
/// - Unix/macOS: `File::sync_all` is `F_FULLFSYNC` on Darwin. VM shared folders
///   and SMB often reject that ioctl even after a successful write. Follow the
///   SQLite/LevelDB/Go pattern: fall back to plain `fsync` on any `sync_all`
///   failure, then treat only "flush unsupported" fsync errors as success.
///   Real I/O failures from `fsync` (for example `EIO`) still fail the caller.
pub fn sync_file_best_effort(file: &std::fs::File) -> Result<(), String> {
    match file.sync_all() {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(()),
        #[cfg(unix)]
        Err(_full_sync_error) => match rustix::fs::fsync(file).map_err(io::Error::from) {
            Ok(()) => Ok(()),
            Err(fsync_error) if unix::is_unsupported_file_flush(&fsync_error) => Ok(()),
            Err(fsync_error) => Err(fsync_error.to_string()),
        },
        #[cfg(not(unix))]
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_whoami_user_csv_extracts_account_and_sid() {
        let identity =
            parse_whoami_user_csv(r#""DESKTOP-ABC\dev","S-1-5-21-1-2-3-1001""#).expect("parse");
        assert_eq!(identity.account, r"DESKTOP-ABC\dev");
        assert_eq!(identity.sid, "S-1-5-21-1-2-3-1001");
    }

    #[test]
    fn parse_whoami_user_csv_handles_escaped_fields() {
        let identity =
            parse_whoami_user_csv(r#""DOMAIN,user ""dev""","S-1-5-21-1-2-3-1001""#).expect("parse");
        assert_eq!(identity.account, r#"DOMAIN,user "dev""#);
        assert_eq!(identity.sid, "S-1-5-21-1-2-3-1001");
    }

    #[test]
    fn windows_sid_string_rejects_injection_and_malformed_shapes() {
        assert!(is_valid_windows_sid_string("S-1-5-18"));
        assert!(is_valid_windows_sid_string("S-1-5-21-1-2-3-1001"));
        assert!(!is_valid_windows_sid_string(""));
        assert!(!is_valid_windows_sid_string("S-1-5"));
        assert!(!is_valid_windows_sid_string("S-1-"));
        assert!(!is_valid_windows_sid_string("S-1-5-21-1)(A;;FA;;;WD"));
        assert!(!is_valid_windows_sid_string("S-1-5-21 1001"));
        assert!(!is_valid_windows_sid_string("S-1-5-21-abc-1001"));
        assert!(!is_valid_windows_sid_string("S-1-5-21-1-2-3-1001 "));
        assert!(!is_valid_windows_sid_string(&format!(
            "S-1-5-{}",
            "1".repeat(300)
        )));
        assert!(parse_whoami_user_csv(r#""u","S-1-5-21-1)(A;;FA;;;WD)""#).is_err());
        assert!(parse_whoami_user_csv(r#""u","S-1-5-21 1001""#).is_err());
        assert!(parse_whoami_user_csv(r#""u","S-1-5-21-abc""#).is_err());
        assert!(parse_whoami_user_csv(r#""u","""#).is_err());
        assert!(parse_whoami_user_csv(r#""u","S-1-5""#).is_err());
    }

    #[test]
    fn decode_windows_command_file_accepts_utf8_and_utf16() {
        assert_eq!(
            decode_windows_command_file(b"path\r\nD:P(A;;FA;;;SY)\r\n").unwrap(),
            "path\r\nD:P(A;;FA;;;SY)\r\n"
        );
        let expected = "path\r\nD:P(A;;FA;;;SY)\r\n";
        let mut utf16le = vec![0xff, 0xfe];
        for word in expected.encode_utf16() {
            utf16le.extend_from_slice(&word.to_le_bytes());
        }
        assert_eq!(decode_windows_command_file(&utf16le).unwrap(), expected);
        assert_eq!(
            decode_windows_command_file(&utf16le[2..]).unwrap(),
            expected
        );
    }

    #[test]
    fn private_directory_sddl_is_protected_and_specific() {
        let sddl = private_directory_sddl("S-1-5-21-1-2-3-1001");
        assert_eq!(
            sddl,
            "O:S-1-5-21-1-2-3-1001D:P(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;OICI;FA;;;SY)"
        );
        assert!(sddl.starts_with("O:S-1-5-21-1-2-3-1001D:P"));
        assert!(!sddl.contains(";;;WD)"));
        assert!(!sddl.contains(";;;AU)"));
        assert!(!sddl.contains(";;;BU)"));
    }

    #[cfg(unix)]
    #[test]
    fn quarantine_restore_collision_preserves_both_entries() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random quarantine test suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("zinnia-quarantine-restore-{suffix}"));
        std::fs::create_dir(&root).expect("quarantine test root");
        let path = root.join("recovery.json");
        std::fs::write(&path, b"recorded").expect("recorded cleanup file");

        let error = quarantine_regular_file_if(&path, |_| {
            std::fs::write(&path, b"collision")?;
            Ok(false)
        })
        .expect_err("a restore collision must fail closed");

        assert!(error.to_string().contains("preserved"));
        assert_eq!(std::fs::read(&path).expect("collision file"), b"collision");
        let quarantined = std::fs::read_dir(&root)
            .expect("quarantine test entries")
            .map(|entry| entry.expect("quarantine test entry").path())
            .find(|entry| {
                entry
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".zinnia-quarantine-"))
            })
            .expect("recorded object remains quarantined");
        assert_eq!(
            std::fs::read(quarantined).expect("quarantined recorded object"),
            b"recorded"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn apply_parent_directory_mode_preserves_inherited_setgid() {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random setgid test suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("zinnia-setgid-mode-{suffix}"));
        std::fs::create_dir(&root).expect("setgid test root");
        let parent = root.join("parent");
        std::fs::DirBuilder::new()
            .mode(0o2755)
            .create(&parent)
            .expect("setgid parent");
        if std::fs::metadata(&parent)
            .expect("parent meta")
            .permissions()
            .mode()
            & 0o2000
            == 0
        {
            let _ = std::fs::remove_dir_all(&root);
            eprintln!("skipping: filesystem did not honor setgid on mkdir");
            return;
        }
        let child = parent.join("child");
        std::fs::create_dir(&child).expect("child under setgid parent");
        let before = std::fs::metadata(&child)
            .expect("child meta")
            .permissions()
            .mode();
        if before & 0o2000 == 0 {
            let _ = std::fs::remove_dir_all(&root);
            eprintln!("skipping: mkdir did not inherit setgid");
            return;
        }
        apply_parent_directory_mode(&child).expect("apply parent mode");
        let after = std::fs::metadata(&child)
            .expect("child after")
            .permissions()
            .mode();
        assert_ne!(
            after & 0o2000,
            0,
            "inherited setgid must survive parent-mode apply"
        );
        assert_eq!(after & 0o777, 0o755, "standard bits should match parent");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn private_directory_creation_round_trips_security_descriptor() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random test directory suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("zinnia-private-dir-{suffix}"));

        create_private_dir(&path).expect("create and verify private directory");
        assert!(path.is_dir());
        std::fs::remove_dir(&path).expect("remove private test directory");
    }

    #[cfg(windows)]
    #[test]
    fn inheriting_stage_directory_uses_compatible_creation_path() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random test directory suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("zinnia-publish-stage-{suffix}"));

        create_inheriting_stage_dir(&path).expect("create inherited-ACL publish stage");
        assert!(path.is_dir());
        std::fs::remove_dir(&path).expect("remove publish stage test directory");
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_removes_readonly_regular_files() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random cleanup test suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("zinnia-readonly-cleanup-{suffix}.tmp"));
        std::fs::write(&path, b"cleanup").expect("write cleanup file");
        let mut permissions = std::fs::metadata(&path)
            .expect("cleanup metadata")
            .permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).expect("mark cleanup file read-only");

        remove_file_for_cleanup(&path).expect("remove read-only cleanup file");
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn directory_sync_accepts_windows_volume_roots() {
        let configured = std::env::var_os("ZINNIA_TEST_VOLUME_ROOT").map(std::path::PathBuf::from);
        let root = configured.unwrap_or_else(|| {
            std::env::temp_dir()
                .ancestors()
                .find(|path| path.parent().is_none() && path.has_root())
                .expect("temporary volume root")
                .to_path_buf()
        });
        assert!(root.is_dir(), "volume root must exist: {}", root.display());
        sync_directory(&root).expect("sync Windows volume root");
        assert!(
            sync_directory(&root.join("zinnia-missing-directory")).is_err(),
            "missing non-root directory sync must remain an error"
        );
    }

    #[cfg(windows)]
    #[test]
    fn inside_destination_stage_files_follow_destination_not_parent_acl() {
        use windows_sys::Win32::Security::EqualSid;

        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random ACL test suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("zinnia-acl-policy-{suffix}"));
        std::fs::create_dir(&root).expect("ACL test parent");
        let parent_file = root.join("parent-policy.txt");
        std::fs::write(&parent_file, b"parent policy").expect("parent policy file");

        let destination = root.join("destination");
        create_private_dir(&destination).expect("destination ACL B");
        let direct_file = destination.join("direct.txt");
        std::fs::write(&direct_file, b"direct destination file").expect("direct destination file");
        let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
        create_inheriting_stage_dir(&stage).expect("inside-destination publish stage");
        let staged_file = stage.join("staged.txt");
        std::fs::write(&staged_file, b"staged destination file").expect("staged destination file");

        let parent_handle = std::fs::File::open(&parent_file).expect("open parent policy file");
        let direct_handle = std::fs::File::open(&direct_file).expect("open direct file");
        let staged_handle = std::fs::File::open(&staged_file).expect("open staged file");
        let parent_storage =
            read_directory_security_descriptor(&parent_handle).expect("parent descriptor");
        let direct_storage =
            read_directory_security_descriptor(&direct_handle).expect("direct descriptor");
        let staged_storage =
            read_directory_security_descriptor(&staged_handle).expect("staged descriptor");
        let parent_descriptor = parent_storage.as_ptr().cast_mut().cast();
        let direct_descriptor = direct_storage.as_ptr().cast_mut().cast();
        let staged_descriptor = staged_storage.as_ptr().cast_mut().cast();

        let direct_owner = security_descriptor_owner(direct_descriptor).expect("direct owner");
        let staged_owner = security_descriptor_owner(staged_descriptor).expect("staged owner");
        // SAFETY: test-only. Both owner SIDs come from descriptors kept alive by `direct_storage`
        // and `staged_storage`.
        assert_ne!(unsafe { EqualSid(direct_owner, staged_owner) }, 0);
        let parent_dacl = security_descriptor_dacl(parent_descriptor).expect("parent DACL");
        let direct_dacl = security_descriptor_dacl(direct_descriptor).expect("direct DACL");
        let staged_dacl = security_descriptor_dacl(staged_descriptor).expect("staged DACL");
        assert!(
            dacl_matches_expected(staged_dacl, direct_dacl)
                .expect("compare staged and destination DACLs"),
            "stage file did not receive destination ACL B"
        );
        assert!(
            !dacl_matches_expected(staged_dacl, parent_dacl)
                .expect("compare staged and parent DACLs"),
            "stage file incorrectly received parent ACL A"
        );

        drop((parent_handle, direct_handle, staged_handle));
        std::fs::remove_dir_all(&root).expect("remove ACL policy test tree");
    }

    #[cfg(windows)]
    #[test]
    fn extraction_publish_recreates_nested_target_acl_for_files_and_trees() {
        fn open_acl_object(path: &Path) -> std::fs::File {
            if path.is_dir() {
                open_directory_for_acl_verification(path).expect("open ACL directory")
            } else {
                std::fs::File::open(path).expect("open ACL file")
            }
        }

        fn dacl_matches(left: &Path, right: &Path) -> bool {
            let left_handle = open_acl_object(left);
            let right_handle = open_acl_object(right);
            let left_storage =
                read_directory_security_descriptor(&left_handle).expect("left descriptor");
            let right_storage =
                read_directory_security_descriptor(&right_handle).expect("right descriptor");
            let left_descriptor = left_storage.as_ptr().cast_mut().cast();
            let right_descriptor = right_storage.as_ptr().cast_mut().cast();
            let left_dacl = security_descriptor_dacl(left_descriptor).expect("left DACL");
            let right_dacl = security_descriptor_dacl(right_descriptor).expect("right DACL");
            dacl_matches_expected(left_dacl, right_dacl).expect("compare DACLs")
        }

        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random nested ACL test suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("zinnia-nested-acl-{suffix}"));
        std::fs::create_dir(&root).expect("nested ACL test parent");

        // Destination ACL B differs from parent ACL A. Build the nested policy
        // under A, then move it under B; Windows preserves its custom ACL.
        let destination = root.join("destination");
        create_private_dir(&destination).expect("destination ACL B");
        let nested_source = root.join("nested-policy");
        std::fs::create_dir(&nested_source).expect("nested ACL A");
        let nested = destination.join("nested");
        std::fs::rename(&nested_source, &nested).expect("install nested ACL A under B");

        let direct_file = nested.join("direct-file.txt");
        std::fs::write(&direct_file, b"direct").expect("direct nested file");
        let direct_directory = nested.join("direct-directory");
        std::fs::create_dir(&direct_directory).expect("direct nested directory");
        let direct_deep_file = direct_directory.join("deep.txt");
        std::fs::write(&direct_deep_file, b"direct deep").expect("direct deep file");

        let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
        create_inheriting_stage_dir(&stage).expect("inside-destination stage");
        let staged_nested = stage.join("nested");
        std::fs::create_dir(&staged_nested).expect("staged existing nested path");
        std::fs::write(staged_nested.join("published-file.txt"), b"published")
            .expect("staged nested file");
        let staged_directory = staged_nested.join("published-directory");
        std::fs::create_dir(&staged_directory).expect("staged directory tree");
        std::fs::write(staged_directory.join("deep.txt"), b"published deep")
            .expect("staged deep file");

        crate::process::merge_staged_extract(
            &stage,
            &destination,
            crate::process::MAX_EXTRACTED_BYTES,
        )
        .expect("publish nested extraction");

        let published_file = nested.join("published-file.txt");
        let published_directory = nested.join("published-directory");
        let published_deep_file = published_directory.join("deep.txt");
        assert!(
            dacl_matches(&published_file, &direct_file),
            "published file did not inherit the real nested target ACL"
        );
        assert!(
            dacl_matches(&published_directory, &direct_directory),
            "published directory did not inherit the real nested target ACL"
        );
        assert!(
            dacl_matches(&published_deep_file, &direct_deep_file),
            "published directory contents did not inherit the nested tree ACL"
        );
        assert!(
            std::fs::read_dir(&nested)
                .expect("list nested destination")
                .all(|entry| !entry
                    .expect("nested entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".zinnia-publish-")),
            "publish temp remained after commit"
        );

        std::fs::remove_dir_all(&root).expect("remove nested ACL test tree");
    }

    #[cfg(windows)]
    #[test]
    fn extraction_publish_recreates_nested_target_acl_for_symlink_trees() {
        fn open_acl_object(path: &Path) -> std::fs::File {
            if path.is_dir() {
                open_directory_for_acl_verification(path).expect("open ACL directory")
            } else {
                std::fs::File::open(path).expect("open ACL file")
            }
        }

        fn dacl_matches(left: &Path, right: &Path) -> bool {
            let left_handle = open_acl_object(left);
            let right_handle = open_acl_object(right);
            let left_storage =
                read_directory_security_descriptor(&left_handle).expect("left descriptor");
            let right_storage =
                read_directory_security_descriptor(&right_handle).expect("right descriptor");
            let left_descriptor = left_storage.as_ptr().cast_mut().cast();
            let right_descriptor = right_storage.as_ptr().cast_mut().cast();
            let left_dacl = security_descriptor_dacl(left_descriptor).expect("left DACL");
            let right_dacl = security_descriptor_dacl(right_descriptor).expect("right DACL");
            dacl_matches_expected(left_dacl, right_dacl).expect("compare DACLs")
        }

        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random symlink ACL test suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("zinnia-symlink-acl-{suffix}"));
        std::fs::create_dir(&root).expect("symlink ACL test parent");

        let destination = root.join("destination");
        create_private_dir(&destination).expect("destination ACL B");
        let nested_source = root.join("nested-policy");
        std::fs::create_dir(&nested_source).expect("nested ACL A");
        let nested = destination.join("nested");
        std::fs::rename(&nested_source, &nested).expect("install nested ACL A under B");

        let direct_directory = nested.join("direct-directory");
        std::fs::create_dir(&direct_directory).expect("direct nested directory");

        let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
        create_inheriting_stage_dir(&stage).expect("inside-destination stage");
        let staged_nested = stage.join("nested");
        std::fs::create_dir(&staged_nested).expect("staged existing nested path");
        let staged_directory = staged_nested.join("published-directory");
        std::fs::create_dir(&staged_directory).expect("staged directory tree");
        std::fs::write(staged_directory.join("payload.txt"), b"payload").expect("staged payload");
        match std::os::windows::fs::symlink_file("payload.txt", staged_directory.join("current")) {
            Ok(()) => {}
            Err(error) => {
                eprintln!(
                    "skipping extraction_publish_recreates_nested_target_acl_for_symlink_trees: {error}"
                );
                let _ = std::fs::remove_dir_all(&root);
                return;
            }
        }

        crate::process::merge_staged_extract(
            &stage,
            &destination,
            crate::process::MAX_EXTRACTED_BYTES,
        )
        .expect("publish symlink-bearing nested extraction");

        let published_directory = nested.join("published-directory");
        assert!(
            dacl_matches(&published_directory, &direct_directory),
            "symlink-bearing directory did not inherit the real nested target ACL"
        );
        assert_eq!(
            std::fs::read_link(published_directory.join("current")).expect("published link"),
            std::path::PathBuf::from("payload.txt")
        );

        std::fs::remove_dir_all(&root).expect("remove symlink ACL test tree");
    }

    #[cfg(windows)]
    #[test]
    fn current_user_sid_from_token_returns_sid_string() {
        let sid = current_user_sid_from_token().expect("process token SID");
        assert!(is_valid_windows_sid_string(&sid), "unexpected SID: {sid}");
    }

    #[cfg(windows)]
    #[test]
    fn current_user_identity_prefers_token_sid() {
        let identity = current_user_identity().expect("identity");
        assert!(is_valid_windows_sid_string(&identity.sid));
    }

    #[cfg(windows)]
    #[test]
    fn system32_whoami_path_resolves_under_system_root() {
        let path = system32_whoami_path().expect("System32 whoami");
        assert!(path.ends_with(std::path::Path::new("System32").join("whoami.exe")));
        assert!(path.is_file());
    }

    #[cfg(windows)]
    #[test]
    fn private_file_handle_is_owned_by_current_user() {
        use std::io::Write as _;

        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random owner-check suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("zinnia-owner-check-{suffix}"));
        create_private_dir(&dir).expect("private dir");
        let path = dir.join("owned.tmp");
        // Match shell-handoff creation: elevated tokens otherwise own new files as
        // Administrators, which must fail the consume-side owner check.
        let mut file = create_private_file(&path).expect("private owned file");
        file.write_all(b"owned").expect("write owned file");
        assert_handle_owned_by_current_user(&file).expect("current-user owner");
        drop(file);
        std::fs::remove_dir_all(&dir).expect("cleanup owner-check tree");
    }

    #[cfg(unix)]
    #[test]
    fn unsupported_file_flush_matches_shared_folder_errnos() {
        let mut errnos = vec![libc::ENOTTY, libc::ENOTSUP, libc::EINVAL];
        if libc::EOPNOTSUPP != libc::ENOTSUP {
            errnos.push(libc::EOPNOTSUPP);
        }
        for errno in errnos {
            let error = std::io::Error::from_raw_os_error(errno);
            assert!(
                unix::is_unsupported_file_flush(&error),
                "expected errno {errno} to be treated as unsupported flush"
            );
        }
        let io_error = std::io::Error::from_raw_os_error(libc::EIO);
        assert!(!unix::is_unsupported_file_flush(&io_error));
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

    #[test]
    fn quarantine_directory_removes_owned_tree() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random directory quarantine suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("zinnia-dir-quarantine-{suffix}"));
        std::fs::create_dir_all(&root).expect("quarantine directory root");
        let path = root.join("stage");
        std::fs::create_dir(&path).expect("owned stage");
        std::fs::write(path.join("owned.txt"), b"owned").expect("owned file");
        assert!(
            quarantine_directory_if(&path, |_| Ok(true)).expect("owned directory cleanup"),
            "owned directory must be removed"
        );
        assert!(!path.exists(), "original stage name must be gone");
        let leftover: Vec<_> = std::fs::read_dir(&root)
            .expect("quarantine root")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".zinnia-quarantine-")
            })
            .collect();
        assert!(
            leftover.is_empty(),
            "successful cleanup must not leave a quarantine name"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn quarantine_directory_preserves_post_verify_name_replacement() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).expect("random directory replacement suffix");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("zinnia-dir-quarantine-replace-{suffix}"));
        std::fs::create_dir_all(&root).expect("replacement test root");
        let path = root.join("stage");
        std::fs::create_dir(&path).expect("owned stage");
        std::fs::write(path.join("owned.txt"), b"owned").expect("owned file");

        let _ = quarantine_directory_if(&path, |_| {
            let quarantined = std::fs::read_dir(&root)
                .expect("quarantine entries")
                .map(|entry| entry.expect("quarantine entry").path())
                .find(|entry| {
                    entry.file_name().is_some_and(|name| {
                        name.to_string_lossy().starts_with(".zinnia-quarantine-")
                    })
                })
                .expect("quarantine name after exclusive rename");
            let aside = root.join("aside");
            std::fs::rename(&quarantined, &aside).expect("move owned object aside");
            std::fs::create_dir(&quarantined).expect("replacement directory");
            std::fs::write(quarantined.join("attacker.txt"), b"attacker")
                .expect("replacement marker");
            Ok(true)
        });

        let attacker = std::fs::read_dir(&root)
            .expect("replacement root")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|entry| {
                entry.join("attacker.txt").is_file()
                    || entry
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy() == "attacker.txt")
            });
        assert!(
            attacker.is_some(),
            "replacement directory must not be deleted by handle-bound cleanup"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
