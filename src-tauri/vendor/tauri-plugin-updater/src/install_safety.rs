// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Shared install-path and helper-binary checks used by the platform updaters.
//! Keep this module free of extra crate dependencies so unit tests can run
//! without elevation.

#![allow(dead_code)]

use std::path::{Component, Path, PathBuf};

/// Privileged replacement keeps the outer `.app` directory in place so Dock
/// bookmarks do not follow the running app into the rollback directory.
/// Both new and legacy backups store the original `Contents` under `$BAK`.
/// The staged tree is moved to `$SRC/Contents.new` and exchanged with the live
/// `Contents` by JXA `renamex_np(RENAME_SWAP)`, mirroring the unprivileged
/// path. The old tree then moves into `$BAK/Contents`. Only when the exchange
/// fails does the script fall back to the two-rename transaction.
pub const MACOS_PRIVILEGED_INSTALL_SCRIPT: &str = r#"
on installUpdate(srcPath, newPath, backupPath)
  -- Fallback below is two renames with no live Contents between them. A crash there leaves the app bundle without Contents, the same failure mode as before. It runs only when renamex_np is unavailable.
  do shell script "NEW=" & quoted form of newPath & "; SRC=" & quoted form of srcPath & "; BAK=" & quoted form of backupPath & "; /bin/test -d \"$NEW/Contents\" || exit 1; if /bin/test ! -d \"$SRC/Contents\"; then if /bin/test -d \"$BAK/Contents\"; then /bin/mkdir -p \"$SRC\" || exit 1; if /bin/test -e \"$SRC/Contents\"; then /bin/rm -rf \"$SRC/Contents\" || exit 1; fi; /bin/mv -f \"$BAK/Contents\" \"$SRC/Contents\" || exit 1; fi; fi; /bin/test -d \"$SRC/Contents\" || exit 1; /bin/rm -rf \"$SRC/Contents.new\" || exit 1; if /bin/test -e \"$BAK\"; then /bin/rm -rf \"$BAK\"; fi; /bin/mkdir \"$BAK\" || exit 1; /bin/mv -f \"$NEW/Contents\" \"$SRC/Contents.new\" || { /bin/rm -rf \"$SRC/Contents.new\"; exit 1; }; if /usr/bin/osascript -l JavaScript -e 'ObjC.bindFunction(\"renamex_np\", [\"int\", [\"char *\", \"char *\", \"unsigned int\"]]); function run(argv) { if ($.renamex_np(argv[0], argv[1], 2) !== 0) { throw new Error(\"renamex_np failed\"); } }' \"$SRC/Contents\" \"$SRC/Contents.new\"; then /bin/mv -f \"$SRC/Contents.new\" \"$BAK/Contents\"; /bin/rm -rf \"$BAK\"; /usr/bin/touch \"$SRC\"; exit 0; fi; /bin/mv -f \"$SRC/Contents\" \"$BAK/Contents\" || { /bin/rm -rf \"$SRC/Contents.new\"; exit 1; }; if /bin/mv -f \"$SRC/Contents.new\" \"$SRC/Contents\" && /bin/test -d \"$SRC/Contents\"; then /bin/rm -rf \"$BAK\"; /usr/bin/touch \"$SRC\"; exit 0; fi; /bin/rm -rf \"$SRC/Contents.new\"; if /bin/test -e \"$SRC/Contents\"; then /bin/rm -rf \"$SRC/Contents\"; fi; /bin/mv -f \"$BAK/Contents\" \"$SRC/Contents\"; exit 1" with administrator privileges
end installUpdate
"#;

/// True when `path` looks like a complete macOS `.app` bundle.
pub fn macos_app_bundle_complete(path: &Path) -> bool {
    path.join("Contents").is_dir()
}

/// Session variables pkexec, zenity, and polkit agents need after `env_clear`.
/// Never includes `PATH`.
pub const LINUX_PRIVILEGED_ENV_ALLOWLIST: &[&str] = &[
    "HOME",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
];

/// Sibling backup directory next to the live `.app` (same volume, not `/tmp`).
pub fn macos_update_backup_path(extract_path: &Path) -> Option<PathBuf> {
    let parent = extract_path.parent()?;
    let name = extract_path.file_name()?;
    Some(parent.join(format!(".zinnia-update-backup-{}", name.to_string_lossy())))
}

pub fn macos_legacy_update_backup_path(extract_path: &Path) -> Option<PathBuf> {
    extract_path
        .parent()
        .map(|parent| parent.join(".zinnia-update-backup"))
}

pub struct MacosBackupRecovery {
    pub install_backup: PathBuf,
    pub restore_denied: Option<std::io::Error>,
}

pub fn recover_macos_app_backups(
    live: &Path,
    scoped: &Path,
    legacy: &Path,
) -> std::io::Result<MacosBackupRecovery> {
    if macos_app_bundle_complete(live) {
        if scoped.exists() {
            let _ = std::fs::remove_dir_all(scoped);
        }
    } else {
        let source = if macos_app_bundle_complete(scoped) {
            Some(scoped)
        } else if macos_app_bundle_complete(legacy) {
            Some(legacy)
        } else {
            None
        };
        if let Some(source) = source {
            return match restore_macos_contents(source, live) {
                Ok(()) => Ok(MacosBackupRecovery {
                    install_backup: scoped.to_path_buf(),
                    restore_denied: None,
                }),
                Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                    Ok(MacosBackupRecovery {
                        install_backup: source.to_path_buf(),
                        restore_denied: Some(err),
                    })
                }
                Err(err) => Err(err),
            };
        }
    }
    Ok(MacosBackupRecovery {
        install_backup: scoped.to_path_buf(),
        restore_denied: None,
    })
}

fn restore_macos_contents(source: &Path, live: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(live)?;
    let contents = live.join("Contents");
    if contents.exists() {
        std::fs::remove_file(&contents)?;
    }
    std::fs::rename(source.join("Contents"), &contents)?;
    std::fs::remove_dir_all(source)
}

/// Replace only `Contents`; the installed `.app` inode is the Dock identity.
/// The caller recovers/removes any previous sibling backup before entering.
///
/// The staged tree is first moved beside the live bundle as `Contents.new`.
/// Then `renamex_np` with `RENAME_SWAP` exchanges the two directories in one
/// step, so a crash can never leave the live bundle without `Contents`. The
/// previous `Contents` ends up at `Contents.new` and is moved into the sibling
/// backup afterwards, keeping the existing recovery path usable. When the
/// exchange is unavailable, the two-rename backup transaction runs instead.
pub fn install_macos_app_contents(stage: &Path, app: &Path, backup: &Path) -> std::io::Result<()> {
    if let Some(result) = swap_app_contents_when_possible(stage, app, backup, exchange_contents) {
        return result;
    }
    install_macos_app_contents_with(stage, app, backup, move_dir_replacing)
}

/// Sibling staging name used by the exchange transaction.
fn contents_new_path(app: &Path) -> PathBuf {
    app.join("Contents.new")
}

/// Removes a leftover `Contents.new` from an interrupted exchange. The live
/// bundle must already be complete, so this copy is never the only recoverable
/// one. Never follows a symlink at the staging name.
fn remove_leftover_contents_new(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// Moves the staged tree back when the exchange cannot proceed, so the caller's
/// fallback transaction or the privileged script still finds `stage/Contents`.
fn restore_staged_contents(stage: &Path, contents_new: &Path) -> std::io::Result<()> {
    move_dir_replacing(contents_new, &stage.join("Contents"))
}

/// Exchanges the staged and live `Contents` in one step, so the live bundle is
/// never missing. `None` means the caller should use the backup transaction.
fn swap_app_contents_when_possible(
    stage: &Path,
    app: &Path,
    backup: &Path,
    exchange: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Option<std::io::Result<()>> {
    if !macos_app_bundle_complete(stage)
        || !macos_app_bundle_complete(app)
        || !backup_slot_is_free(backup)
    {
        return None;
    }
    let live = app.join("Contents");
    let contents_new = contents_new_path(app);

    if let Err(err) = remove_leftover_contents_new(&contents_new) {
        return Some(Err(err));
    }
    if let Err(err) = move_dir_replacing(&stage.join("Contents"), &contents_new) {
        let _ = remove_leftover_contents_new(&contents_new);
        // Admin-owned bundles must reach the privileged path, not the fallback.
        return if err.kind() == std::io::ErrorKind::PermissionDenied {
            Some(Err(err))
        } else {
            None
        };
    }

    // Refuse an existing backup before touching the live tree. `create_dir`
    // never overwrites the only recoverable copy.
    if let Err(err) = std::fs::create_dir(backup) {
        return match restore_staged_contents(stage, &contents_new) {
            Ok(()) => Some(Err(err)),
            Err(restore_error) => Some(Err(std::io::Error::other(format!(
                "{err}; could not restore staged Contents: {restore_error}"
            )))),
        };
    }

    match exchange(&live, &contents_new) {
        Ok(()) => {
            archive_swapped_contents(&contents_new, backup);
            Some(Ok(()))
        }
        // Admin-owned bundles must reach the privileged path, not the fallback.
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            let _ = std::fs::remove_dir(backup);
            match restore_staged_contents(stage, &contents_new) {
                Ok(()) => Some(Err(err)),
                Err(restore_error) => Some(Err(std::io::Error::other(format!(
                    "{err}; could not restore staged Contents: {restore_error}"
                )))),
            }
        }
        // RENAME_SWAP reports ENOTSUP/EINVAL on filesystems without atomic
        // directory exchange. Fall back to the two-rename backup transaction.
        Err(_) => {
            let _ = std::fs::remove_dir(backup);
            match restore_staged_contents(stage, &contents_new) {
                Ok(()) => None,
                Err(restore_error) => Some(Err(std::io::Error::other(format!(
                    "atomic Contents exchange is unavailable and the staged tree could not be restored: {restore_error}"
                )))),
            }
        }
    }
}

/// After a successful exchange, the old live `Contents` sits at
/// `app/Contents.new`. Move it into the adjacent backup, then drop the backup
/// because the new bundle is already live.
fn archive_swapped_contents(contents_new: &Path, backup: &Path) {
    // The exchange committed the update. A failure here must not report the
    // install as failed; keep the previous tree beside the live bundle.
    let archived = std::fs::rename(contents_new, backup.join("Contents"));
    if archived.is_ok() {
        let _ = std::fs::remove_dir_all(backup);
    } else {
        let _ = std::fs::remove_dir(backup);
    }
    if let Err(err) = archived {
        eprintln!(
            "The new app is installed, but the previous Contents could not be moved into {}: {err}; it remains at {}",
            backup.display(),
            contents_new.display()
        );
    }
}

/// True when nothing, not even a dangling link, occupies the backup path.
fn backup_slot_is_free(backup: &Path) -> bool {
    matches!(
        std::fs::symlink_metadata(backup),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound
    )
}

#[cfg(target_os = "macos")]
fn exchange_contents(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::{c_char, c_int, c_uint, CString};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
    }
    // RENAME_SWAP from <sys/stat.h>: exchange both paths in one step.
    const RENAME_SWAP: c_uint = 0x0000_0002;

    let invalid =
        |err: std::ffi::NulError| std::io::Error::new(std::io::ErrorKind::InvalidInput, err);
    let from = CString::new(from.as_os_str().as_bytes()).map_err(invalid)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(invalid)?;
    // SAFETY: both pointers come from live, NUL-terminated CStrings.
    let status = unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_SWAP) };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn exchange_contents(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

/// Reads `CFBundleShortVersionString` from an XML `Info.plist`. Binary or
/// malformed input yields `None`, and the caller then skips the version check.
pub fn macos_plist_short_version(xml: &str) -> Option<String> {
    const KEY: &str = "<key>CFBundleShortVersionString</key>";
    let rest = xml.split_once(KEY)?.1.trim_start();
    let value = rest
        .strip_prefix("<string>")?
        .split_once("</string>")?
        .0
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub fn macos_plist_build_version(xml: &str) -> Option<String> {
    const KEY: &str = "<key>CFBundleVersion</key>";
    let rest = xml.split_once(KEY)?.1.trim_start();
    let value = rest
        .strip_prefix("<string>")?
        .split_once("</string>")?
        .0
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn build_components(value: &str) -> Option<Vec<u64>> {
    value
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        })
        .collect()
}

pub fn dotted_build_cmp(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (a, b) = (build_components(a)?, build_components(b)?);
    let len = a.len().max(b.len());
    let pad = |mut parts: Vec<u64>| {
        parts.resize(len, 0);
        parts
    };
    Some(pad(a).cmp(&pad(b)))
}

pub fn payload_build_is_newer(
    payload_build: Option<&str>,
    installed_build: Option<&str>,
) -> Option<bool> {
    let ordering = dotted_build_cmp(payload_build?, installed_build?)?;
    Some(ordering == std::cmp::Ordering::Greater)
}

/// True when pkexec exited because the user dismissed its prompt (exit 126).
pub fn pkexec_authorization_cancelled(exit_code: Option<i32>) -> bool {
    exit_code == Some(126)
}

/// True when restoring the backup was refused for permissions. The privileged
/// script can finish that recovery, so the unprivileged install is skipped.
pub fn restore_error_needs_admin(error: Option<&std::io::Error>) -> bool {
    error.is_some_and(|err| err.kind() == std::io::ErrorKind::PermissionDenied)
}

/// Fallback two-rename transaction for filesystems where `RENAME_SWAP` is
/// unavailable. It keeps the previous `Contents` in the backup until the new
/// tree is verified, then restores it after an injected or real move failure.
fn install_macos_app_contents_with(
    stage: &Path,
    app: &Path,
    backup: &Path,
    move_contents: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    if !macos_app_bundle_complete(stage) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "staged app is missing Contents",
        ));
    }
    // create_dir deliberately refuses an existing backup: never overwrite the
    // only recoverable copy when the caller has not completed recovery.
    std::fs::create_dir(backup)?;
    let live = app.join("Contents");
    let saved = backup.join("Contents");
    if let Err(error) = std::fs::rename(&live, &saved) {
        let _ = std::fs::remove_dir(backup);
        return Err(error);
    }
    let installed = move_contents(&stage.join("Contents"), &live).and_then(|()| {
        if live.is_dir() {
            Ok(())
        } else {
            Err(std::io::Error::other(
                "new app is missing Contents after install",
            ))
        }
    });
    if let Err(error) = installed {
        let restore = (|| -> std::io::Result<()> {
            if live.exists() {
                std::fs::remove_dir_all(&live)?;
            }
            std::fs::rename(&saved, &live)
        })();
        if let Err(restore_error) = restore {
            return Err(std::io::Error::other(format!(
                "{error}; could not restore app Contents: {restore_error}; backup retained at {}",
                backup.display()
            )));
        }
        let _ = std::fs::remove_dir(backup);
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(backup);
    Ok(())
}

/// ShellExecuteW returns a value `<= 32` on failure (Win32).
pub fn shell_execute_launch_ok(result: isize) -> bool {
    result > 32
}

/// True when `rename` failed because source and destination are on different devices.
pub fn is_cross_device(err: &std::io::Error) -> bool {
    match err.raw_os_error() {
        // Unix EXDEV
        Some(18) => true,
        // Windows ERROR_NOT_SAME_DEVICE
        Some(17) if cfg!(windows) => true,
        _ => false,
    }
}

/// Owns the staged temp path and removes it unless it was renamed into place.
struct StagedTempFile {
    path: PathBuf,
    persisted: bool,
}

impl Drop for StagedTempFile {
    fn drop(&mut self) {
        if !self.persisted {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Creates a new `0600` file in `parent` with a unique name. `create_new`
/// never follows or reuses an existing entry, so a collision only retries.
fn create_staged_file(parent: &Path) -> std::io::Result<(std::fs::File, StagedTempFile)> {
    static NEXT_STAGED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    const ATTEMPTS: usize = 16;
    for _ in 0..ATTEMPTS {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let counter = NEXT_STAGED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = parent.join(format!(
            ".zinnia-staged-{}-{}-{}",
            std::process::id(),
            nanos,
            counter
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                let staged = StagedTempFile {
                    path,
                    persisted: false,
                };
                return Ok((file, staged));
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not create a unique staged file",
    ))
}

pub(crate) fn replace_file_atomically<F>(dest: &Path, write: F) -> std::io::Result<()>
where
    F: FnOnce(&mut std::fs::File) -> std::io::Result<()>,
{
    let parent = match dest.parent() {
        Some(parent) if parent.as_os_str().is_empty() => Path::new("."),
        Some(parent) => parent,
        None => return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput)),
    };
    if !parent.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "destination directory does not exist",
        ));
    }
    let (mut staged_file, mut staged) = create_staged_file(parent)?;
    write(&mut staged_file)?;
    staged_file.sync_all()?;
    match std::fs::metadata(dest) {
        Ok(metadata) => staged_file.set_permissions(metadata.permissions())?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    std::fs::rename(&staged.path, dest)?;
    staged.persisted = true;
    Ok(())
}

/// Skip the archive's first path component (Tauri `.app.tar.gz` wrapper), then
/// reject `Prefix` / `RootDir` / `ParentDir`. Remaining components must be
/// relative and contained.
pub fn confined_tar_member_relative(entry_path: &Path) -> Result<PathBuf, ConfinedPathError> {
    let mut components = entry_path.components();
    match components.next() {
        Some(Component::Normal(_)) | Some(Component::CurDir) => {}
        Some(Component::Prefix(_))
        | Some(Component::RootDir)
        | Some(Component::ParentDir)
        | None => {
            return Err(ConfinedPathError::Unconfined);
        }
    }

    let mut relative = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(ConfinedPathError::Unconfined);
            }
        }
    }
    Ok(relative)
}

/// Create `dest`'s parent directories under `root` without following symlinks.
pub fn create_confined_parent_dirs(root: &Path, dest: &Path) -> std::io::Result<()> {
    let Some(parent) = dest.parent() else {
        return Ok(());
    };
    if !path_is_inside(root, parent) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "parent path is not confined",
        ));
    }
    if parent == root {
        return Ok(());
    }
    let relative = parent.strip_prefix(root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "parent path is not confined",
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "parent path is not confined",
            ));
        };
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "refusing to create updater files through a symlink parent",
                ));
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "updater extract parent is not a directory",
                ));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)?;
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Lexical containment: `candidate` must be `root` or a descendant without `..`.
pub fn path_is_inside(root: &Path, candidate: &Path) -> bool {
    if candidate == root {
        return true;
    }
    let Ok(rest) = candidate.strip_prefix(root) else {
        return false;
    };
    rest.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// Symlink targets must be relative and stay inside `root` when resolved from
/// the symlink's parent directory.
pub fn confined_symlink_target(root: &Path, link_parent: &Path, target: &Path) -> bool {
    if target.as_os_str().is_empty() {
        return false;
    }
    if !path_is_inside(root, link_parent) {
        return false;
    }

    let mut resolved = link_parent.to_path_buf();
    for component in target.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if resolved == root || !resolved.pop() {
                    return false;
                }
            }
            Component::Prefix(_) | Component::RootDir => return false,
        }
        if !path_is_inside(root, &resolved) {
            return false;
        }
    }
    path_is_inside(root, &resolved)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfinedPathError {
    Unconfined,
}

impl std::fmt::Display for ConfinedPathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfinedPathError::Unconfined => {
                write!(f, "updater archive member path is not confined")
            }
        }
    }
}

impl std::error::Error for ConfinedPathError {}

/// Candidate absolute paths for a Linux helper. Never search `PATH`.
pub fn trusted_system_helper_candidates(name: &str) -> [PathBuf; 2] {
    [
        PathBuf::from("/usr/bin").join(name),
        PathBuf::from("/bin").join(name),
    ]
}

pub fn helper_name_is_safe(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// Root-owned regular file, not group/world-writable.
pub fn unix_metadata_is_trusted_helper(uid: u32, mode: u32, is_regular_file: bool) -> bool {
    is_regular_file && uid == 0 && (mode & 0o022) == 0
}

/// Trust check for the directory entry at a helper path before following it.
///
/// Regular files must be root-owned and not group/world-writable. Symlink
/// inodes must be root-owned; their mode is ignored because Linux always
/// reports 0777 on symlinks and never uses those bits (`man 7 symlink`).
/// Rejecting 0777 would refuse `/usr/bin/sh` -> `dash` and any distro helper
/// that is an alias.
pub fn unix_directory_entry_is_trusted_helper(uid: u32, mode: u32, is_symlink: bool) -> bool {
    if uid != 0 {
        return false;
    }
    if is_symlink {
        return true;
    }
    (mode & 0o022) == 0
}

#[cfg(unix)]
pub fn unix_helper_is_trusted(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let Ok(link_meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    // The directory entry must be root-owned. A user-owned /usr/bin symlink
    // cannot be swapped in. Writable-bit checks apply to regular files only.
    if !unix_directory_entry_is_trusted_helper(
        link_meta.uid(),
        link_meta.mode(),
        link_meta.file_type().is_symlink(),
    ) {
        return false;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    unix_metadata_is_trusted_helper(meta.uid(), meta.mode(), meta.is_file())
}

#[cfg(unix)]
pub fn resolve_trusted_system_helper(name: &str) -> std::io::Result<PathBuf> {
    if !helper_name_is_safe(name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid helper name",
        ));
    }
    for candidate in trusted_system_helper_candidates(name) {
        if unix_helper_is_trusted(&candidate) {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("trusted helper {name} not found"),
    ))
}

/// Recursively copy a directory tree onto `dst` (for EXDEV fallback).
pub fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if file_type.is_symlink() {
            let target = std::fs::read_link(&from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, &to)?;
            #[cfg(not(unix))]
            {
                let _ = target;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "symlink copy is not supported on this platform",
                ));
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Move a directory onto `dst`. On EXDEV, copy beside the destination then rename.
pub fn move_dir_replacing(src: &Path, dst: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(err) if is_cross_device(&err) => {
            if let Some(parent) = dst.parent() {
                let staging = parent.join(".zinnia-update-staging");
                if staging.exists() {
                    std::fs::remove_dir_all(&staging)?;
                }
                copy_dir_all(src, &staging)?;
                std::fs::rename(&staging, dst)?;
                let _ = std::fs::remove_dir_all(src);
                Ok(())
            } else {
                Err(err)
            }
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::path::Path;

    #[test]
    fn macos_script_quotes_handler_args_and_restores_backup() {
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("quoted form of"));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("backupPath"));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -d \\\"$NEW/Contents\\\""));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -d \\\"$SRC/Contents\\\""));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT
            .contains("/bin/mv -f \\\"$BAK/Contents\\\" \\\"$SRC/Contents\\\""));
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT
                .contains("/bin/rm -rf \\\"$SRC/Contents\\\"; fi; /bin/mv -f \\\"$BAK/Contents\\\" \\\"$SRC/Contents\\\""),
            "failed swap must remove the incomplete new tree before restoring the backup"
        );
        let staged_at = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("/bin/mv -f \\\"$NEW/Contents\\\" \\\"$SRC/Contents.new\\\"")
            .expect("staged Contents must move beside the live bundle first");
        let stale_backup_rm = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("if /bin/test -e \\\"$BAK\\\"; then /bin/rm -rf \\\"$BAK\\\"; fi; /bin/mkdir \\\"$BAK\\\" || exit 1;")
            .expect("stale backup must be cleared before the exchange");
        let swap_at = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("-l JavaScript")
            .expect("live Contents must be exchanged with renamex_np first");
        let fallback_at = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("/bin/mv -f \\\"$SRC/Contents\\\" \\\"$BAK/Contents\\\" ||")
            .expect("two-rename fallback must remain for unsupported filesystems");
        assert!(
            stale_backup_rm < swap_at && staged_at < swap_at,
            "must not delete the sibling backup or exchange before the staged tree is in place"
        );
        assert!(
            swap_at < fallback_at,
            "the atomic exchange must be attempted before the two-rename fallback"
        );
        assert!(
            !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("rm -rf \" & quoted form of srcPath"),
            "must never rm -rf the live bundle path via AppleScript concatenation"
        );
        assert!(
            !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("Zinnia.app")
                && !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/Applications"),
            "script template must not embed filesystem paths"
        );
        let malicious = "/Applications/Don't '; touch /tmp/pwned; '.app";
        assert!(!MACOS_PRIVILEGED_INSTALL_SCRIPT.contains(malicious));
    }

    #[test]
    fn backup_path_is_sibling_not_tmp() {
        let app = Path::new("/Applications/Zinnia.app");
        assert_eq!(
            macos_update_backup_path(app).as_deref(),
            Some(Path::new("/Applications/.zinnia-update-backup-Zinnia.app"))
        );
        assert_eq!(
            macos_legacy_update_backup_path(app).as_deref(),
            Some(Path::new("/Applications/.zinnia-update-backup"))
        );
    }

    #[test]
    fn backup_path_is_distinct_per_bundle_under_one_parent() {
        let a = macos_update_backup_path(Path::new("/Applications/A.app"));
        let b = macos_update_backup_path(Path::new("/Applications/B.app"));
        assert_ne!(a, b);
        assert_eq!(macos_update_backup_path(Path::new("/")), None);
    }

    fn write_bundle(bundle: &Path, value: &str) {
        std::fs::create_dir_all(bundle.join("Contents")).unwrap();
        std::fs::write(bundle.join("Contents/version"), value).unwrap();
    }

    fn bundle_value(bundle: &Path) -> Option<String> {
        std::fs::read_to_string(bundle.join("Contents/version")).ok()
    }

    #[test]
    fn scoped_cleanup_removes_only_healthy_bundles_own_backup() {
        let dir = ScratchDir::new("backup-scoped-cleanup");
        let app_a = dir.0.join("A.app");
        let app_b = dir.0.join("B.app");
        write_bundle(&app_a, "a-live");
        write_bundle(&app_b, "b-live");
        let scoped_a = macos_update_backup_path(&app_a).unwrap();
        let scoped_b = macos_update_backup_path(&app_b).unwrap();
        let legacy = macos_legacy_update_backup_path(&app_a).unwrap();
        write_bundle(&scoped_a, "a-old");
        write_bundle(&scoped_b, "b-old");
        write_bundle(&legacy, "legacy");

        let recovery = recover_macos_app_backups(&app_a, &scoped_a, &legacy).unwrap();

        assert!(recovery.restore_denied.is_none());
        assert_eq!(recovery.install_backup, scoped_a);
        assert!(!scoped_a.exists());
        assert_eq!(bundle_value(&scoped_b).as_deref(), Some("b-old"));
        assert_eq!(bundle_value(&legacy).as_deref(), Some("legacy"));
        assert_eq!(bundle_value(&app_a).as_deref(), Some("a-live"));
    }

    #[test]
    fn incomplete_bundle_restores_from_its_own_scoped_backup() {
        let dir = ScratchDir::new("backup-restore-scoped");
        let app_a = dir.0.join("A.app");
        let app_b = dir.0.join("B.app");
        std::fs::create_dir_all(&app_a).unwrap();
        write_bundle(&app_b, "b-live");
        let scoped_a = macos_update_backup_path(&app_a).unwrap();
        let scoped_b = macos_update_backup_path(&app_b).unwrap();
        let legacy = macos_legacy_update_backup_path(&app_a).unwrap();
        write_bundle(&scoped_a, "a-recovery");
        write_bundle(&scoped_b, "b-recovery");
        write_bundle(&legacy, "legacy");

        let recovery = recover_macos_app_backups(&app_a, &scoped_a, &legacy).unwrap();

        assert!(recovery.restore_denied.is_none());
        assert_eq!(recovery.install_backup, scoped_a);
        assert_eq!(bundle_value(&app_a).as_deref(), Some("a-recovery"));
        assert!(!scoped_a.exists());
        assert_eq!(bundle_value(&scoped_b).as_deref(), Some("b-recovery"));
        assert_eq!(bundle_value(&legacy).as_deref(), Some("legacy"));
    }

    #[test]
    fn incomplete_bundle_restores_from_legacy_when_no_scoped_backup() {
        let dir = ScratchDir::new("backup-restore-legacy");
        let app_a = dir.0.join("A.app");
        let app_b = dir.0.join("B.app");
        std::fs::create_dir_all(&app_a).unwrap();
        write_bundle(&app_b, "b-live");
        let scoped_b = macos_update_backup_path(&app_b).unwrap();
        let scoped_a = macos_update_backup_path(&app_a).unwrap();
        let legacy = macos_legacy_update_backup_path(&app_a).unwrap();
        write_bundle(&scoped_b, "b-recovery");
        write_bundle(&legacy, "legacy-recovery");

        let recovery = recover_macos_app_backups(&app_a, &scoped_a, &legacy).unwrap();

        assert!(recovery.restore_denied.is_none());
        assert_eq!(recovery.install_backup, scoped_a);
        assert_eq!(bundle_value(&app_a).as_deref(), Some("legacy-recovery"));
        assert!(!legacy.exists());
        assert_eq!(bundle_value(&scoped_b).as_deref(), Some("b-recovery"));
    }

    #[test]
    fn healthy_bundle_keeps_legacy_backup() {
        let dir = ScratchDir::new("backup-healthy-legacy");
        let app_a = dir.0.join("A.app");
        write_bundle(&app_a, "a-live");
        let scoped_a = macos_update_backup_path(&app_a).unwrap();
        let legacy = macos_legacy_update_backup_path(&app_a).unwrap();
        write_bundle(&legacy, "legacy");

        let recovery = recover_macos_app_backups(&app_a, &scoped_a, &legacy).unwrap();

        assert!(recovery.restore_denied.is_none());
        assert_eq!(bundle_value(&legacy).as_deref(), Some("legacy"));
        assert_eq!(bundle_value(&app_a).as_deref(), Some("a-live"));
    }

    #[test]
    fn incomplete_bundle_without_any_complete_backup_is_left_alone() {
        let dir = ScratchDir::new("backup-nothing-to-restore");
        let app_a = dir.0.join("A.app");
        std::fs::create_dir_all(&app_a).unwrap();
        let scoped_a = macos_update_backup_path(&app_a).unwrap();
        let legacy = macos_legacy_update_backup_path(&app_a).unwrap();
        std::fs::create_dir_all(&scoped_a).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();

        let recovery = recover_macos_app_backups(&app_a, &scoped_a, &legacy).unwrap();

        assert!(recovery.restore_denied.is_none());
        assert_eq!(recovery.install_backup, scoped_a);
        assert!(scoped_a.is_dir());
        assert!(legacy.is_dir());
        assert!(!app_a.join("Contents").exists());
    }

    #[test]
    fn build_version_reader_parses_cfbundleversion_beside_short_version() {
        let xml = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.7.0</string>\n\t<key>CFBundleVersion</key>\n\t<string>0.7.3002</string>\n</dict></plist>";
        assert_eq!(macos_plist_build_version(xml).as_deref(), Some("0.7.3002"));
        assert_eq!(macos_plist_short_version(xml).as_deref(), Some("0.7.0"));
    }

    #[test]
    fn build_version_reader_missing_or_non_string_is_none() {
        let only_short = "<plist><dict><key>CFBundleShortVersionString</key><string>0.7.0</string></dict></plist>";
        assert_eq!(macos_plist_build_version(only_short), None);
        let integer = "<key>CFBundleVersion</key><integer>3002</integer>";
        assert_eq!(macos_plist_build_version(integer), None);
        let blank = "<key>CFBundleVersion</key><string>  </string>";
        assert_eq!(macos_plist_build_version(blank), None);
    }

    #[test]
    fn build_version_reader_ignores_binary_and_garbage() {
        assert_eq!(
            macos_plist_build_version("bplist00\u{0}\u{1}\u{ff}CFBundleVersion"),
            None
        );
        assert_eq!(macos_plist_build_version("\u{0}\u{ff}not xml"), None);
        assert_eq!(macos_plist_build_version(""), None);
    }

    #[test]
    fn build_is_newer_accepts_later_beta_in_same_series() {
        assert_eq!(
            payload_build_is_newer(Some("0.7.3003"), Some("0.7.3002")),
            Some(true)
        );
    }

    #[test]
    fn build_is_newer_refuses_older_beta_in_same_series() {
        assert_eq!(
            payload_build_is_newer(Some("0.7.3002"), Some("0.7.3003")),
            Some(false)
        );
    }

    #[test]
    fn build_is_newer_refuses_equal_build() {
        assert_eq!(
            payload_build_is_newer(Some("0.7.3003"), Some("0.7.3003")),
            Some(false)
        );
    }

    #[test]
    fn build_is_newer_orders_stable_after_betas_of_same_patch() {
        assert_eq!(
            payload_build_is_newer(Some("0.7.9999"), Some("0.7.3003")),
            Some(true)
        );
        assert_eq!(
            payload_build_is_newer(Some("0.7.3003"), Some("0.7.9999")),
            Some(false)
        );
    }

    #[test]
    fn build_is_newer_orders_next_patch_after_stable_numerically() {
        assert_eq!(
            payload_build_is_newer(Some("0.7.13001"), Some("0.7.9999")),
            Some(true)
        );
        assert_eq!(
            payload_build_is_newer(Some("0.7.9999"), Some("0.7.13001")),
            Some(false)
        );
    }

    #[test]
    fn build_is_newer_missing_or_unparsable_is_none() {
        assert_eq!(payload_build_is_newer(None, Some("0.7.3002")), None);
        assert_eq!(payload_build_is_newer(Some("0.7.3002"), None), None);
        assert_eq!(payload_build_is_newer(None, None), None);
        assert_eq!(
            payload_build_is_newer(Some("0.7.x"), Some("0.7.3002")),
            None
        );
        assert_eq!(payload_build_is_newer(Some("0.7.3002"), Some("")), None);
        assert_eq!(
            payload_build_is_newer(Some("0.7.3002."), Some("0.7.3002")),
            None
        );
        assert_eq!(payload_build_is_newer(Some("0..7"), Some("0.7.3002")), None);
        assert_eq!(payload_build_is_newer(Some("+0.7"), Some("0.7.3002")), None);
        assert_eq!(
            payload_build_is_newer(Some("0.7.99999999999999999999999"), Some("0.7.3002")),
            None
        );
    }

    #[test]
    fn dotted_build_cmp_treats_missing_components_as_zero() {
        use std::cmp::Ordering;
        assert_eq!(dotted_build_cmp("0.7", "0.7.0"), Some(Ordering::Equal));
        assert_eq!(dotted_build_cmp("0.7.1", "0.7"), Some(Ordering::Greater));
        assert_eq!(dotted_build_cmp("1", "0.9.9"), Some(Ordering::Greater));
        assert_eq!(dotted_build_cmp("0.7.10", "0.7.9"), Some(Ordering::Greater));
    }

    #[cfg(unix)]
    fn macos_fixture() -> (
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "zinnia-dock-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let app = root.join("Zinnia.app");
        let stage = root.join("stage");
        let backup = root.join("backup");
        for (bundle, value) in [(&app, "old"), (&stage, "new")] {
            std::fs::create_dir_all(bundle.join("Contents")).unwrap();
            std::fs::write(bundle.join("Contents/version"), value).unwrap();
        }
        (root, app, stage, backup)
    }

    #[cfg(unix)]
    #[test]
    fn macos_update_preserves_outer_app_identity() {
        use std::os::unix::fs::MetadataExt;
        let (root, app, stage, backup) = macos_fixture();
        let inode = std::fs::metadata(&app).unwrap().ino();
        std::fs::write(app.join("root-marker"), "preserved").unwrap();
        install_macos_app_contents(&stage, &app, &backup).unwrap();
        assert_eq!(std::fs::metadata(&app).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/version")).unwrap(),
            "new"
        );
        assert!(app.join("root-marker").is_file());
        assert!(!backup.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn macos_missing_stage_keeps_live_contents() {
        let (root, app, stage, backup) = macos_fixture();
        std::fs::remove_dir_all(stage.join("Contents")).unwrap();
        assert!(install_macos_app_contents(&stage, &app, &backup).is_err());
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/version")).unwrap(),
            "old"
        );
        assert!(!backup.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn macos_failed_contents_move_restores_without_nesting() {
        use std::os::unix::fs::MetadataExt;
        let (root, app, stage, backup) = macos_fixture();
        let inode = std::fs::metadata(&app).unwrap().ino();
        let error = install_macos_app_contents_with(&stage, &app, &backup, |_, dest| {
            std::fs::create_dir(dest)?;
            std::fs::write(dest.join("partial"), "incomplete")?;
            Err(std::io::Error::other("injected copy failure"))
        })
        .unwrap_err();
        assert!(
            error.to_string().contains("injected copy failure"),
            "{error}"
        );
        assert_eq!(std::fs::metadata(&app).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/version")).unwrap(),
            "old"
        );
        assert!(!app.join("Contents/partial").exists());
        assert!(!app.join("Contents/Contents").exists());
        assert!(!backup.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn macos_failed_rollback_preserves_backup() {
        let (root, app, stage, backup) = macos_fixture();
        let error = install_macos_app_contents_with(&stage, &app, &backup, |_, dest| {
            std::fs::write(dest, "blocks directory restoration")?;
            Err(std::io::Error::other("injected move failure"))
        })
        .unwrap_err();
        assert!(error.to_string().contains("restore"));
        assert_eq!(
            std::fs::read_to_string(backup.join("Contents/version")).unwrap(),
            "old"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn macos_existing_backup_is_not_overwritten() {
        let (root, app, stage, backup) = macos_fixture();
        std::fs::create_dir_all(backup.join("Contents")).unwrap();
        std::fs::write(backup.join("Contents/version"), "recovery").unwrap();
        assert!(install_macos_app_contents(&stage, &app, &backup).is_err());
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/version")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(backup.join("Contents/version")).unwrap(),
            "recovery"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plist_short_version_reads_plain_xml_value() {
        let xml = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.7.1</string>\n\t<key>CFBundleVersion</key>\n\t<string>999</string>\n</dict></plist>";
        assert_eq!(macos_plist_short_version(xml).as_deref(), Some("0.7.1"));
    }

    #[test]
    fn plist_short_version_missing_or_non_string_is_none() {
        let only_build = "<plist><dict><key>CFBundleVersion</key><string>1</string></dict></plist>";
        assert_eq!(macos_plist_short_version(only_build), None);
        let integer = "<key>CFBundleShortVersionString</key><integer>7</integer>";
        assert_eq!(macos_plist_short_version(integer), None);
        let blank = "<key>CFBundleShortVersionString</key><string>  </string>";
        assert_eq!(macos_plist_short_version(blank), None);
    }

    #[test]
    fn plist_short_version_ignores_binary_and_garbage() {
        assert_eq!(
            macos_plist_short_version("bplist00\u{0}\u{1}\u{ff}CFBundleShortVersionString"),
            None
        );
        assert_eq!(macos_plist_short_version("\u{0}\u{ff}not xml"), None);
        assert_eq!(macos_plist_short_version(""), None);
    }

    #[test]
    fn plist_short_version_keeps_prerelease_text_for_the_caller() {
        let xml = "<key>CFBundleShortVersionString</key><string>0.7.0-beta.2</string>";
        assert_eq!(
            macos_plist_short_version(xml).as_deref(),
            Some("0.7.0-beta.2")
        );
    }

    #[test]
    fn script_touches_bundle_before_success_exit() {
        let swapped = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("-l JavaScript")
            .expect("new Contents must be exchanged into the app");
        let touch = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("/usr/bin/touch \\\"$SRC\\\"; exit 0")
            .expect("bundle must be touched right before the success exit");
        assert!(swapped < touch, "touch must run after the successful swap");
        let fallback_moved = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("/bin/mv -f \\\"$SRC/Contents.new\\\" \\\"$SRC/Contents\\\"")
            .expect("fallback must move new Contents into the app");
        let fallback_touch = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .rfind("/usr/bin/touch \\\"$SRC\\\"; exit 0")
            .expect("fallback must touch the bundle before its success exit");
        assert!(
            fallback_moved < fallback_touch,
            "fallback touch must run after its successful move"
        );
    }

    #[test]
    fn pkexec_exit_126_means_the_prompt_was_dismissed() {
        assert!(pkexec_authorization_cancelled(Some(126)));
        assert!(!pkexec_authorization_cancelled(Some(0)));
        assert!(!pkexec_authorization_cancelled(Some(127)));
        assert!(!pkexec_authorization_cancelled(None));
    }

    #[test]
    fn restore_permission_denied_routes_to_admin_install() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(restore_error_needs_admin(Some(&denied)));
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(!restore_error_needs_admin(Some(&missing)));
        assert!(!restore_error_needs_admin(None));
    }

    #[cfg(unix)]
    #[test]
    fn swap_is_not_attempted_without_staged_contents() {
        let (root, app, stage, backup) = macos_fixture();
        std::fs::remove_dir_all(stage.join("Contents")).unwrap();
        let mut called = false;
        let outcome = swap_app_contents_when_possible(&stage, &app, &backup, |_, _| {
            called = true;
            Ok(())
        });
        assert!(outcome.is_none());
        assert!(!called);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn swap_is_not_attempted_over_an_existing_backup() {
        let (root, app, stage, backup) = macos_fixture();
        std::fs::create_dir_all(backup.join("Contents")).unwrap();
        let mut called = false;
        let outcome = swap_app_contents_when_possible(&stage, &app, &backup, |_, _| {
            called = true;
            Ok(())
        });
        assert!(outcome.is_none());
        assert!(!called, "a pending backup must be recovered, not bypassed");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn swap_permission_denied_goes_to_admin_path_unchanged() {
        let (root, app, stage, backup) = macos_fixture();
        for code in [1, 13] {
            let outcome = swap_app_contents_when_possible(&stage, &app, &backup, |_, _| {
                Err(std::io::Error::from_raw_os_error(code))
            });
            let error = outcome
                .expect("EACCES/EPERM must not fall back")
                .unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        }
        assert!(!backup.exists());
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/version")).unwrap(),
            "old"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn other_swap_errors_fall_back_to_backup_transaction() {
        let (root, app, stage, backup) = macos_fixture();
        for code in [18, 22, 45] {
            let outcome = swap_app_contents_when_possible(&stage, &app, &backup, |_, _| {
                Err(std::io::Error::from_raw_os_error(code))
            });
            assert!(outcome.is_none(), "errno {code} must fall back");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_swap_keeps_outer_app_and_archives_old_contents() {
        use std::os::unix::fs::MetadataExt;
        let (root, app, stage, backup) = macos_fixture();
        let inode = std::fs::metadata(&app).unwrap().ino();
        install_macos_app_contents(&stage, &app, &backup).unwrap();
        assert_eq!(std::fs::metadata(&app).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/version")).unwrap(),
            "new"
        );
        // The staged tree moves to Contents.new before the exchange, and the
        // old tree is archived only long enough to complete the transaction.
        assert!(!stage.join("Contents").exists());
        assert!(!app.join("Contents.new").exists());
        assert!(!backup.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shell_execute_rejects_win32_error_codes() {
        assert!(!shell_execute_launch_ok(0));
        assert!(!shell_execute_launch_ok(2));
        assert!(!shell_execute_launch_ok(32));
        assert!(shell_execute_launch_ok(33));
        assert!(shell_execute_launch_ok(42));
    }

    #[test]
    fn tar_paths_reject_parent_root_and_prefix() {
        assert_eq!(
            confined_tar_member_relative(Path::new("Zinnia.app/Contents/MacOS/zinnia")).unwrap(),
            PathBuf::from("Contents/MacOS/zinnia")
        );
        assert!(confined_tar_member_relative(Path::new("Zinnia.app"))
            .unwrap()
            .as_os_str()
            .is_empty());
        assert!(confined_tar_member_relative(Path::new("Zinnia.app/../etc/passwd")).is_err());
        assert!(confined_tar_member_relative(Path::new("/etc/passwd")).is_err());
        assert!(confined_tar_member_relative(Path::new("Zinnia.app/Contents/../../etc")).is_err());
        assert!(confined_tar_member_relative(Path::new("..")).is_err());
    }

    #[test]
    fn symlink_targets_must_stay_inside_extract_root() {
        let root = Path::new("/tmp/extract");
        let parent = Path::new("/tmp/extract/Contents/MacOS");
        assert!(confined_symlink_target(
            root,
            parent,
            Path::new("../Resources/icon.icns")
        ));
        assert!(!confined_symlink_target(
            root,
            parent,
            Path::new("/etc/passwd")
        ));
        assert!(!confined_symlink_target(
            root,
            parent,
            Path::new("../../../../etc/passwd")
        ));
        assert!(!confined_symlink_target(root, parent, Path::new("")));
    }

    #[test]
    fn trusted_helpers_never_search_path() {
        let old = std::env::var("PATH").ok();
        std::env::set_var("PATH", "/tmp/hostile-updater-path:/opt/evil/bin");
        let candidates = trusted_system_helper_candidates("pkexec");
        assert_eq!(candidates[0], PathBuf::from("/usr/bin/pkexec"));
        assert_eq!(candidates[1], PathBuf::from("/bin/pkexec"));
        assert!(helper_name_is_safe("dpkg"));
        assert!(helper_name_is_safe("rpm"));
        assert!(helper_name_is_safe("sudo"));
        assert!(!helper_name_is_safe("../usr/bin/pkexec"));
        assert!(!helper_name_is_safe("/usr/bin/pkexec"));
        assert!(!helper_name_is_safe("pkexec/../../bin/sh"));
        #[cfg(unix)]
        {
            let resolved = resolve_trusted_system_helper("sh").expect("sh should exist");
            assert!(
                resolved == Path::new("/bin/sh") || resolved == Path::new("/usr/bin/sh"),
                "hostile PATH must not change trusted helper resolution, got {resolved:?}"
            );
        }
        match old {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
    }

    #[test]
    fn linux_privileged_env_keep_session_display_and_dbus() {
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"DISPLAY"));
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"WAYLAND_DISPLAY"));
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"DBUS_SESSION_BUS_ADDRESS"));
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"XDG_RUNTIME_DIR"));
        assert!(!LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"PATH"));
    }

    #[cfg(unix)]
    #[test]
    fn confined_parent_dirs_refuse_symlink_parents() {
        let root =
            std::env::temp_dir().join(format!("zinnia-updater-confine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let outside =
            std::env::temp_dir().join(format!("zinnia-updater-outside-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let dest = link.join("evil");
        let err = create_confined_parent_dirs(&root, &dest).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn helper_mode_rejects_group_or_world_writable_and_non_root() {
        assert!(unix_metadata_is_trusted_helper(0, 0o755, true));
        assert!(unix_metadata_is_trusted_helper(0, 0o750, true));
        assert!(!unix_metadata_is_trusted_helper(0, 0o775, true));
        assert!(!unix_metadata_is_trusted_helper(0, 0o757, true));
        assert!(!unix_metadata_is_trusted_helper(501, 0o755, true));
        assert!(!unix_metadata_is_trusted_helper(0, 0o755, false));
        // Linux symlink inodes are always 0777; a root-owned link must still
        // be a valid helper directory entry.
        assert!(unix_directory_entry_is_trusted_helper(0, 0o777, true));
        assert!(unix_directory_entry_is_trusted_helper(0, 0o755, true));
        assert!(!unix_directory_entry_is_trusted_helper(501, 0o777, true));
        assert!(!unix_directory_entry_is_trusted_helper(0, 0o777, false));
        assert!(!unix_directory_entry_is_trusted_helper(0, 0o775, false));
    }

    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("zinnia-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sorted_entry_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    struct PartialThenFail {
        sent: bool,
    }

    impl Read for PartialThenFail {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.sent {
                return Err(std::io::Error::other("stream dropped mid-entry"));
            }
            self.sent = true;
            let chunk = b"new";
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            Ok(n)
        }
    }

    #[test]
    fn replace_write_error_keeps_original_and_removes_staged_file() {
        let dir = ScratchDir::new("replace-write-error");
        let dest = dir.0.join("app.AppImage");
        std::fs::write(&dest, b"original app").unwrap();

        let result = replace_file_atomically(&dest, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("write interrupted"))
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"original app");
        assert_eq!(sorted_entry_names(&dir.0), vec!["app.AppImage"]);
    }

    #[test]
    fn replace_stream_error_mid_copy_keeps_original() {
        let dir = ScratchDir::new("replace-stream-error");
        let dest = dir.0.join("app.AppImage");
        std::fs::write(&dest, b"original app").unwrap();

        let result = replace_file_atomically(&dest, |file| {
            let mut stream = PartialThenFail { sent: false };
            std::io::copy(&mut stream, file)?;
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"original app");
        assert_eq!(sorted_entry_names(&dir.0), vec!["app.AppImage"]);
    }

    #[test]
    fn replace_success_writes_exact_bytes_and_leaves_no_staged_file() {
        let dir = ScratchDir::new("replace-success");
        let dest = dir.0.join("app.AppImage");
        std::fs::write(&dest, b"original app with a longer tail").unwrap();

        replace_file_atomically(&dest, |file| file.write_all(b"new app")).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"new app");
        assert_eq!(sorted_entry_names(&dir.0), vec!["app.AppImage"]);
    }

    #[test]
    fn replace_leaves_live_file_untouched_until_rename() {
        let dir = ScratchDir::new("replace-untouched");
        let dest = dir.0.join("app.AppImage");
        std::fs::write(&dest, b"original app").unwrap();
        let mut observed_during_write = None;

        let result = replace_file_atomically(&dest, |file| {
            file.write_all(b"partial")?;
            observed_during_write = Some(std::fs::read(&dest)?);
            file.write_all(b" new app")?;
            Ok(())
        });

        result.unwrap();
        assert_eq!(observed_during_write, Some(b"original app".to_vec()));
        assert_eq!(std::fs::read(&dest).unwrap(), b"partial new app");
    }

    #[test]
    fn replace_missing_parent_errors_without_creating_anything() {
        let dir = ScratchDir::new("replace-missing-parent");
        let dest = dir.0.join("absent").join("app.AppImage");
        let mut writer_called = false;

        let result = replace_file_atomically(&dest, |file| {
            writer_called = true;
            file.write_all(b"new app")
        });

        assert!(result.is_err());
        assert!(!writer_called);
        assert!(!dir.0.join("absent").exists());
        assert!(sorted_entry_names(&dir.0).is_empty());
    }

    #[test]
    fn replace_creates_missing_destination() {
        let dir = ScratchDir::new("replace-create");
        let dest = dir.0.join("app.AppImage");

        replace_file_atomically(&dest, |file| file.write_all(b"new app")).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"new app");
        assert_eq!(sorted_entry_names(&dir.0), vec!["app.AppImage"]);
    }

    #[test]
    fn replace_directory_destination_errors_and_leaves_no_staged_file() {
        let dir = ScratchDir::new("replace-directory-dest");
        let dest = dir.0.join("app.AppImage");
        std::fs::create_dir(&dest).unwrap();

        let result = replace_file_atomically(&dest, |file| file.write_all(b"new app"));

        assert!(result.is_err());
        assert!(dest.is_dir());
        assert_eq!(sorted_entry_names(&dir.0), vec!["app.AppImage"]);
    }

    #[cfg(unix)]
    #[test]
    fn replace_keeps_original_unix_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = ScratchDir::new("replace-mode");
        let dest = dir.0.join("app.AppImage");
        std::fs::write(&dest, b"original app").unwrap();
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o754)).unwrap();

        replace_file_atomically(&dest, |file| file.write_all(b"new app")).unwrap();

        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o754);
        assert_eq!(std::fs::read(&dest).unwrap(), b"new app");
    }

    #[cfg(unix)]
    #[test]
    fn resolve_sh_from_system_roots_without_elevation() {
        let resolved =
            resolve_trusted_system_helper("sh").expect("sh should exist as a root helper");
        assert!(
            resolved == Path::new("/bin/sh") || resolved == Path::new("/usr/bin/sh"),
            "unexpected sh path {resolved:?}"
        );
        assert!(unix_helper_is_trusted(&resolved));
        let hostile = std::env::temp_dir().join("zinnia-hostile-pkexec");
        let _ = std::fs::write(&hostile, b"#!/bin/sh\n");
        assert!(!unix_helper_is_trusted(&hostile));
        let _ = std::fs::remove_file(&hostile);
        let hostile_link = std::env::temp_dir().join("zinnia-hostile-sh-link");
        let _ = std::fs::remove_file(&hostile_link);
        std::os::unix::fs::symlink(&resolved, &hostile_link).unwrap();
        assert!(
            !unix_helper_is_trusted(&hostile_link),
            "a user-owned symlink to a trusted helper must not be trusted"
        );
        let _ = std::fs::remove_file(&hostile_link);
        assert!(resolve_trusted_system_helper("definitely-not-a-zinnia-helper").is_err());
    }
}
