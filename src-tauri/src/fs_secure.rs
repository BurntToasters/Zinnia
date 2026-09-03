//! Cross-platform helpers for private/internal directories, inheriting publish stages,
//! and durable directory sync.

use std::io;
use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Create a new directory that is private to the current user when the OS allows it.
/// Unix: mode 0o700. Windows: disable inheritance and grant only the current user + SYSTEM.
pub(crate) fn open_directory_nofollow(path: &Path) -> io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        if !directory.metadata()?.is_dir() {
            return Err(io::Error::other("Staging path is not a directory."));
        }
        Ok(directory)
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let directory = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            // Omit delete sharing while creation identity is recorded.
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let attributes = directory.metadata()?.file_attributes();
        if attributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(io::Error::other("Staging path is not a real directory."));
        }
        Ok(directory)
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
        create_private_dir_windows(path)
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
    create_private_file_windows(path)
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
    create_inheriting_stage_dir_windows(path)
}

#[cfg(windows)]
pub fn create_inheriting_stage_dir(path: &Path) -> io::Result<()> {
    create_inheriting_stage_dir_open(path).map(drop)
}

#[cfg(windows)]
#[repr(C)]
union NtIoStatusValue {
    status: i32,
    pointer: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[repr(C)]
struct NtIoStatusBlock {
    value: NtIoStatusValue,
    information: usize,
}

#[cfg(windows)]
#[repr(C)]
struct NtUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[cfg(windows)]
#[repr(C)]
struct NtObjectAttributes {
    length: u32,
    root_directory: windows_sys::Win32::Foundation::HANDLE,
    object_name: *mut NtUnicodeString,
    attributes: u32,
    security_descriptor: *mut std::ffi::c_void,
    security_quality_of_service: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file_handle: *mut windows_sys::Win32::Foundation::HANDLE,
        desired_access: u32,
        object_attributes: *mut NtObjectAttributes,
        io_status_block: *mut NtIoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut std::ffi::c_void,
        ea_length: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

/// Atomically create one directory component relative to a held parent and
/// return the handle produced by that same operation. `CreateDirectoryW`
/// cannot provide creation-bound identity because it requires a later pathname
/// reopen; `NtCreateFile(FILE_CREATE | FILE_DIRECTORY_FILE)` does both at once.
#[cfg(windows)]
fn create_stage_directory_windows(
    parent: &Path,
    name: &std::ffi::OsStr,
    desired_access: u32,
    security_descriptor: *mut std::ffi::c_void,
) -> io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
    const FILE_CREATE: u32 = 2;
    const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;

    let parent_directory = open_directory_nofollow(parent)?;
    let mut name_wide = name.encode_wide().collect::<Vec<_>>();
    if name_wide.is_empty() || name_wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Staging directory name is empty or contains NUL.",
        ));
    }
    let byte_len = name_wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Staging name is too long."))?;
    let maximum_length = byte_len
        .checked_add(std::mem::size_of::<u16>() as u16)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Staging name is too long."))?;
    name_wide.push(0);
    let mut object_name = NtUnicodeString {
        length: byte_len,
        maximum_length,
        buffer: name_wide.as_mut_ptr(),
    };
    let mut attributes = NtObjectAttributes {
        length: std::mem::size_of::<NtObjectAttributes>() as u32,
        root_directory: parent_directory.as_raw_handle() as HANDLE,
        object_name: &mut object_name,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor,
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut io_status = NtIoStatusBlock {
        value: NtIoStatusValue {
            pointer: std::ptr::null_mut(),
        },
        information: 0,
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut io_status,
            std::ptr::null_mut(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_CREATE,
            FILE_DIRECTORY_FILE,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::other(
            "Windows created a staging directory without returning its handle.",
        ));
    }
    let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
    Ok(std::fs::File::from(owned))
}

#[cfg(unix)]
fn create_stage_directory_in_held_parent(
    parent: &Path,
    name: &std::ffi::OsStr,
    mode: libc::mode_t,
) -> io::Result<std::fs::File> {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let parent_directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent)?;
    let name = unix_component(name)?;
    if unsafe { libc::mkdirat(parent_directory.as_raw_fd(), name.as_ptr(), mode) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // Directory creation has no portable create-and-return-handle operation.
    // Open immediately by one component relative to the still-held parent, then
    // prove that the public entry and returned handle identify the same object.
    // Ownership is recorded only from this handle, never from a later path stat.
    let directory = open_directory_relative(parent_directory.as_raw_fd(), &name)?;
    let opened = stat_open_file(&directory)?;
    let named = stat_named_entry(parent_directory.as_raw_fd(), &name)?;
    if !same_unix_object(&opened, &named) || opened.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::other(
            "New staging directory changed while its creation handle was acquired.",
        ));
    }
    Ok(directory)
}

/// Create a private stage and return the handle from the held-parent creation
/// context. The caller must derive ownership only from this returned handle.
pub(crate) fn create_private_stage_dir_open(
    parent: &Path,
    name: &std::ffi::OsStr,
) -> io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        create_stage_directory_in_held_parent(parent, name, 0o700)
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
        create_private_dir_windows(&parent.join(name))
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
        create_stage_directory_in_held_parent(parent, name, 0o700)
    }
    #[cfg(windows)]
    {
        create_inheriting_stage_dir_windows(&parent.join(name))
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
#[cfg(unix)]
pub fn apply_parent_directory_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    // Re-open the publish target with O_NOFOLLOW and read its mode from that
    // fd, so a symlink swap after the rename cannot redirect the chmod to an
    // outside victim. Compare device/inode to reject a swapped path.
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path has interior NUL"))?;
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| -> io::Result<()> {
        let mut st = unsafe { std::mem::zeroed::<libc::stat>() };
        if unsafe { libc::fstat(fd, &mut st) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if st.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(io::Error::other("publish target is not a directory"));
        }
        let parent_metadata = std::fs::metadata(parent)?;
        // Refuse if `path` and `parent` are the same inode (path == parent).
        use std::os::unix::fs::MetadataExt;
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
        if unsafe { libc::fchmod(fd, mode as libc::mode_t) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    unsafe { libc::close(fd) };
    result
}

#[cfg(not(unix))]
pub fn apply_parent_directory_mode(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Remove an app-owned directory tree, clearing Windows read-only attributes
/// first so extracted archive metadata cannot make cleanup fail after publish.
/// Reparse points are rejected rather than traversed.
pub fn remove_dir_all_for_cleanup(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    clear_windows_readonly_tree(path)?;
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
    clear_windows_readonly(path, &metadata)?;
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

#[cfg(unix)]
fn unix_component(value: &std::ffi::OsStr) -> io::Result<std::ffi::CString> {
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

#[cfg(unix)]
fn rename_relative_no_replace(
    directory_fd: std::os::fd::RawFd,
    source: &std::ffi::CStr,
    target: &std::ffi::CStr,
) -> io::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        unsafe extern "C" {
            fn renameatx_np(
                fromfd: libc::c_int,
                from: *const libc::c_char,
                tofd: libc::c_int,
                to: *const libc::c_char,
                flags: libc::c_uint,
            ) -> libc::c_int;
        }
        const RENAME_EXCL: libc::c_uint = 0x0000_0004;
        if unsafe {
            renameatx_np(
                directory_fd,
                source.as_ptr(),
                directory_fd,
                target.as_ptr(),
                RENAME_EXCL,
            )
        } == 0
        {
            return Ok(());
        }
        Err(io::Error::last_os_error())
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        unsafe extern "C" {
            fn renameat2(
                olddirfd: libc::c_int,
                oldpath: *const libc::c_char,
                newdirfd: libc::c_int,
                newpath: *const libc::c_char,
                flags: libc::c_uint,
            ) -> libc::c_int;
        }
        const RENAME_NOREPLACE: libc::c_uint = 1;
        if unsafe {
            renameat2(
                directory_fd,
                source.as_ptr(),
                directory_fd,
                target.as_ptr(),
                RENAME_NOREPLACE,
            )
        } == 0
        {
            return Ok(());
        }
        Err(io::Error::last_os_error())
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = (directory_fd, source, target);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "exclusive descriptor-relative rename is unavailable",
        ))
    }
}

#[cfg(unix)]
fn stat_open_file(file: &std::fs::File) -> io::Result<libc::stat> {
    use std::os::fd::AsRawFd as _;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() })
}

#[cfg(unix)]
fn stat_named_entry(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::CStr,
) -> io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            directory_fd,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() })
}

#[cfg(unix)]
fn same_unix_object(left: &libc::stat, right: &libc::stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode & libc::S_IFMT == right.st_mode & libc::S_IFMT
}

#[cfg(unix)]
fn open_regular_relative(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::CStr,
) -> io::Result<std::fs::File> {
    use std::os::fd::FromRawFd as _;
    let fd = unsafe {
        libc::openat(
            directory_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let stat = stat_open_file(&file)?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(io::Error::other("cleanup entry is not a regular file"));
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

#[cfg(unix)]
fn open_directory_relative(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::CStr,
) -> io::Result<std::fs::File> {
    use std::os::fd::FromRawFd as _;
    let fd = unsafe {
        libc::openat(
            directory_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn restore_quarantine<T>(
    directory_fd: std::os::fd::RawFd,
    quarantine: &std::ffi::CStr,
    original: &std::ffi::CStr,
    display_path: &Path,
    reason: &str,
) -> io::Result<T> {
    match rename_relative_no_replace(directory_fd, quarantine, original) {
        Ok(()) => Err(io::Error::other(reason.to_string())),
        Err(restore_error) => Err(io::Error::other(format!(
            "{reason} The entry was preserved beside {} under {} because its original name could not be restored: {restore_error}",
            display_path.display(),
            quarantine.to_string_lossy()
        ))),
    }
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
        use std::os::fd::AsRawFd as _;
        use std::os::unix::fs::OpenOptionsExt as _;

        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let original_os = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
        let original = unix_component(original_os)?;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)?;
        let source = match open_regular_relative(directory.as_raw_fd(), &original) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let source_stat = stat_open_file(&source)?;

        let quarantine_name = quarantine_component()?;
        let quarantine = unix_component(std::ffi::OsStr::new(&quarantine_name))?;
        rename_relative_no_replace(directory.as_raw_fd(), &original, &quarantine)?;
        let mut quarantined = match open_regular_relative(directory.as_raw_fd(), &quarantine) {
            Ok(file) => file,
            Err(error) => {
                return restore_quarantine(
                    directory.as_raw_fd(),
                    &quarantine,
                    &original,
                    path,
                    &format!("Could not verify quarantined cleanup entry: {error}"),
                );
            }
        };
        let quarantine_stat = stat_open_file(&quarantined)?;
        if !same_unix_object(&source_stat, &quarantine_stat) {
            return restore_quarantine(
                directory.as_raw_fd(),
                &quarantine,
                &original,
                path,
                "Cleanup entry changed before quarantine and was preserved.",
            );
        }
        drop(source);
        if !verify(&mut quarantined)? {
            return restore_quarantine(
                directory.as_raw_fd(),
                &quarantine,
                &original,
                path,
                "Quarantined cleanup entry did not match its recorded identity and was preserved.",
            );
        }
        let named_stat = stat_named_entry(directory.as_raw_fd(), &quarantine)?;
        if !same_unix_object(&quarantine_stat, &named_stat) {
            return restore_quarantine(
                directory.as_raw_fd(),
                &quarantine,
                &original,
                path,
                "Quarantined cleanup entry changed during verification and was preserved.",
            );
        }
        if unsafe { libc::unlinkat(directory.as_raw_fd(), quarantine.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
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

#[cfg(unix)]
fn remove_directory_contents_relative(directory: &std::fs::File) -> io::Result<()> {
    use std::os::fd::AsRawFd as _;

    let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe { libc::close(duplicate) };
        return Err(error);
    }
    let result = (|| loop {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let errno = {
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                unsafe {
                    *libc::__error()
                }
                #[cfg(not(any(target_os = "macos", target_os = "ios")))]
                unsafe {
                    *libc::__errno_location()
                }
            };
            return if errno == 0 {
                Ok(())
            } else {
                Err(io::Error::from_raw_os_error(errno))
            };
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        let stat = stat_named_entry(directory.as_raw_fd(), name)?;
        if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
            let child = open_directory_relative(directory.as_raw_fd(), name)?;
            remove_directory_contents_relative(&child)?;
            let named_after = stat_named_entry(directory.as_raw_fd(), name)?;
            let opened = stat_open_file(&child)?;
            if !same_unix_object(&named_after, &opened) {
                return Err(io::Error::other(
                    "Directory entry changed during quarantined cleanup.",
                ));
            }
            drop(child);
            if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
                != 0
            {
                return Err(io::Error::last_os_error());
            }
        } else if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
    })();
    unsafe { libc::closedir(stream) };
    result
}

#[cfg(windows)]
fn open_directory_for_quarantine(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FILE_WRITE_ATTRIBUTES, SYNCHRONIZE,
    };
    let directory = std::fs::OpenOptions::new()
        .access_mode(
            DELETE
                | FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | FILE_WRITE_ATTRIBUTES
                | FILE_DELETE_CHILD
                | SYNCHRONIZE,
        )
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let attributes = directory.metadata()?.file_attributes();
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(io::Error::other("Cleanup path is not a real directory."));
    }
    Ok(directory)
}

#[cfg(windows)]
fn open_relative_for_cleanup(
    parent: &std::fs::File,
    name: &std::ffi::OsStr,
) -> io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_NORMAL, FILE_DELETE_CHILD, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FILE_WRITE_ATTRIBUTES, SYNCHRONIZE,
    };

    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
    const FILE_OPEN: u32 = 1;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
    const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x0000_4000;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let mut name_wide = name.encode_wide().collect::<Vec<_>>();
    if name_wide.is_empty() || name_wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Cleanup entry name is empty or contains NUL.",
        ));
    }
    let byte_len = name_wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Cleanup name is too long."))?;
    let maximum_length = byte_len
        .checked_add(std::mem::size_of::<u16>() as u16)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Cleanup name is too long."))?;
    name_wide.push(0);
    let mut object_name = NtUnicodeString {
        length: byte_len,
        maximum_length,
        buffer: name_wide.as_mut_ptr(),
    };
    let mut attributes = NtObjectAttributes {
        length: std::mem::size_of::<NtObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle() as HANDLE,
        object_name: &mut object_name,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut io_status = NtIoStatusBlock {
        value: NtIoStatusValue {
            pointer: std::ptr::null_mut(),
        },
        information: 0,
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            DELETE
                | FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | FILE_WRITE_ATTRIBUTES
                | FILE_DELETE_CHILD
                | SYNCHRONIZE,
            &mut attributes,
            &mut io_status,
            std::ptr::null_mut(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::other(
            "Windows opened a cleanup entry without returning its handle.",
        ));
    }
    let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
    Ok(std::fs::File::from(owned))
}

#[cfg(windows)]
fn list_directory_children(directory: &std::fs::File) -> io::Result<Vec<std::ffi::OsString>> {
    use std::os::windows::ffi::OsStringExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_FILES, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
        FILE_ID_BOTH_DIR_INFO,
    };

    let handle = directory.as_raw_handle() as HANDLE;
    let mut buffer_size = 64 * 1024usize;
    loop {
        let mut buffer = vec![0u8; buffer_size];
        let mut names = Vec::new();
        let mut restart = true;
        let listed = loop {
            let class = if restart {
                FileIdBothDirectoryRestartInfo
            } else {
                FileIdBothDirectoryInfo
            };
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    handle,
                    class,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                )
            };
            if ok == 0 {
                let error = io::Error::last_os_error();
                break match error.raw_os_error() {
                    Some(code) if code == ERROR_NO_MORE_FILES as i32 => Ok(names),
                    Some(code) if code == ERROR_MORE_DATA as i32 => Err(error),
                    _ => Err(error),
                };
            }
            restart = false;
            let mut offset = 0usize;
            loop {
                if offset >= buffer.len() {
                    break Err(io::Error::other("Directory listing was truncated."));
                }
                let remaining = &buffer[offset..];
                if remaining.len() < std::mem::size_of::<FILE_ID_BOTH_DIR_INFO>() {
                    break Err(io::Error::other("Directory listing entry was truncated."));
                }
                let info = remaining.as_ptr().cast::<FILE_ID_BOTH_DIR_INFO>();
                let name_len = unsafe { (*info).FileNameLength as usize };
                let name_offset = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
                if remaining.len() < name_offset.saturating_add(name_len) || name_len % 2 != 0 {
                    break Err(io::Error::other("Directory listing name was truncated."));
                }
                let name_units = unsafe {
                    std::slice::from_raw_parts(
                        remaining.as_ptr().add(name_offset).cast::<u16>(),
                        name_len / 2,
                    )
                };
                names.push(std::ffi::OsString::from_wide(name_units));
                let next = unsafe { (*info).NextEntryOffset as usize };
                if next == 0 {
                    break Ok(());
                }
                offset = offset
                    .checked_add(next)
                    .ok_or_else(|| io::Error::other("Directory listing offset overflowed."))?;
            }?;
        };
        match listed {
            Ok(names) => return Ok(names),
            Err(error)
                if error.raw_os_error() == Some(ERROR_MORE_DATA as i32)
                    && buffer_size < 1024 * 1024 =>
            {
                buffer_size = buffer_size.saturating_mul(2);
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(windows)]
fn mark_handle_deleted(file: &std::fs::File) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, FileDispositionInfo, FileDispositionInfoEx, SetFileInformationByHandle,
        FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_BASIC_INFO,
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
    };

    let handle = file.as_raw_handle() as HANDLE;
    let posix = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    if unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfoEx,
            (&posix as *const FILE_DISPOSITION_INFO_EX).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } != 0
    {
        return Ok(());
    }
    let attributes = file.metadata()?.file_attributes();
    if attributes & FILE_ATTRIBUTE_READONLY != 0 {
        let mut basic = FILE_BASIC_INFO::default();
        let cleared = attributes & !FILE_ATTRIBUTE_READONLY;
        basic.FileAttributes = if cleared == 0 {
            FILE_ATTRIBUTE_NORMAL
        } else {
            cleared
        };
        if unsafe {
            SetFileInformationByHandle(
                handle,
                FileBasicInfo,
                (&basic as *const FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn remove_directory_contents_relative(directory: &std::fs::File) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    for name in list_directory_children(directory)? {
        if name == "." || name == ".." || name.is_empty() {
            continue;
        }
        let child = open_relative_for_cleanup(directory, &name)?;
        let attributes = child.metadata()?.file_attributes();
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
            && attributes & FILE_ATTRIBUTE_DIRECTORY != 0
        {
            remove_directory_contents_relative(&child)?;
        }
        mark_handle_deleted(&child)?;
    }
    Ok(())
}

/// Quarantine and recursively remove a directory only when both the pre-rename
/// handle and the caller's recorded identity approve the quarantined object.
pub(crate) fn quarantine_directory_if<F>(path: &Path, mut verify: F) -> io::Result<bool>
where
    F: FnMut(&std::fs::File) -> io::Result<bool>,
{
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd as _;
        use std::os::unix::fs::OpenOptionsExt as _;

        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let original_os = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
        let original = unix_component(original_os)?;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)?;
        let source = match open_directory_relative(directory.as_raw_fd(), &original) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let source_stat = stat_open_file(&source)?;
        let quarantine_name = quarantine_component()?;
        let quarantine = unix_component(std::ffi::OsStr::new(&quarantine_name))?;
        rename_relative_no_replace(directory.as_raw_fd(), &original, &quarantine)?;
        let quarantined = match open_directory_relative(directory.as_raw_fd(), &quarantine) {
            Ok(file) => file,
            Err(error) => {
                return restore_quarantine(
                    directory.as_raw_fd(),
                    &quarantine,
                    &original,
                    path,
                    &format!("Could not verify quarantined directory: {error}"),
                );
            }
        };
        let quarantine_stat = stat_open_file(&quarantined)?;
        if !same_unix_object(&source_stat, &quarantine_stat) || !verify(&quarantined)? {
            return restore_quarantine(
                directory.as_raw_fd(),
                &quarantine,
                &original,
                path,
                "Quarantined directory did not match its recorded identity and was preserved.",
            );
        }
        drop(source);
        remove_directory_contents_relative(&quarantined)?;
        let named_stat = stat_named_entry(directory.as_raw_fd(), &quarantine)?;
        let opened_stat = stat_open_file(&quarantined)?;
        if !same_unix_object(&named_stat, &opened_stat) {
            return Err(io::Error::other(
                "Quarantined directory name changed during cleanup; replacement was preserved.",
            ));
        }
        drop(quarantined);
        if unsafe {
            libc::unlinkat(
                directory.as_raw_fd(),
                quarantine.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        sync_file_best_effort(&directory).map_err(io::Error::other)?;
        Ok(true)
    }

    #[cfg(windows)]
    {
        // Rename is still a path-based no-replace MoveFileW, so ancestor
        // substitution remains a documented Windows residual. Deletion is bound
        // to the creation/quarantine handle: contents and the directory itself
        // are removed through that object, never through a later pathname walk.
        let source = match open_directory_for_quarantine(path) {
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
        let named = match open_directory_for_quarantine(&quarantine) {
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
        remove_directory_contents_relative(&source)?;
        mark_handle_deleted(&source)?;
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

#[cfg(windows)]
fn clear_windows_readonly_tree(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if crate::path_safety::is_link_or_reparse(&metadata) {
        return Err(io::Error::other(format!(
            "Refusing to traverse a link or reparse point during cleanup: {}",
            path.display()
        )));
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            clear_windows_readonly_tree(&entry?.path())?;
        }
    }
    clear_windows_readonly(path, &metadata)?;
    Ok(())
}

#[cfg(windows)]
// This helper is Windows-only, where `set_readonly(false)` clears only
// FILE_ATTRIBUTE_READONLY; the Unix mode-bit hazard cannot apply.
#[allow(clippy::permissions_set_readonly_false)]
fn clear_windows_readonly(path: &Path, metadata: &std::fs::Metadata) -> io::Result<()> {
    if metadata.permissions().readonly() {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
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
        use std::os::unix::fs::OpenOptionsExt as _;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)
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

/// Errnos that mean "this mount cannot honor a durable flush ioctl", not that
/// the prior write failed. Used after a successful byte copy / clone when the
/// next reader is this process (private archive snapshots, publish temps).
#[cfg(unix)]
pub(crate) fn is_unsupported_file_flush(error: &std::io::Error) -> bool {
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

#[cfg(any(windows, test))]
const MAX_WINDOWS_SID_CHARS: usize = 256;

/// Strict SID check before interpolating into SDDL. Rejects `)`, spaces,
/// letters in subauthorities, and other injection shapes. Matches
/// `^S-1-[0-9]+(-[0-9]+)+$` with a 256-character ceiling.
#[cfg(any(windows, test))]
fn is_valid_windows_sid_string(sid: &str) -> bool {
    if sid.len() < 7 || sid.len() > MAX_WINDOWS_SID_CHARS {
        return false;
    }
    let Some(rest) = sid.strip_prefix("S-1-") else {
        return false;
    };
    let mut parts = rest.split('-');
    let Some(authority) = parts.next() else {
        return false;
    };
    if authority.is_empty() || !authority.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let mut subauths = 0usize;
    for part in parts {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        subauths += 1;
    }
    subauths >= 1
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsUserIdentity {
    /// SID string, e.g. `S-1-5-21-...`
    sid: String,
    /// Account from the `whoami` fallback, retained only for parser tests.
    #[cfg(test)]
    account: String,
}

#[cfg(any(windows, test))]
fn parse_whoami_user_csv(line: &str) -> Result<WindowsUserIdentity, String> {
    // CSV: "DOMAIN\user","S-1-5-21-...". Account names can contain
    // commas and quotes, so this must be a real CSV parser rather than split(',').
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut chars = line.trim().chars().peekable();
    let mut quoted = false;
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                field.push('"');
            }
            '"' => quoted = !quoted,
            ',' if !quoted => {
                fields.push(field.trim().to_string());
                field.clear();
            }
            _ => field.push(ch),
        }
    }
    if quoted {
        return Err(format!("Could not parse unterminated whoami CSV: {line}"));
    }
    fields.push(field.trim().to_string());

    let account = fields.first().map(String::as_str).unwrap_or("");
    let sid = fields.get(1).map(String::as_str).unwrap_or("");
    if account.is_empty() {
        return Err(format!("Could not parse account from whoami: {line}"));
    }
    if !is_valid_windows_sid_string(sid) {
        return Err(format!(
            "Could not parse current user SID from whoami: {line}"
        ));
    }
    Ok(WindowsUserIdentity {
        sid: sid.to_string(),
        #[cfg(test)]
        account: account.to_string(),
    })
}

#[cfg(any(windows, test))]
fn decode_windows_command_file(bytes: &[u8]) -> Result<String, String> {
    fn decode_utf16(payload: &[u8], little_endian: bool) -> Result<String, String> {
        if !payload.len().is_multiple_of(2) {
            return Err("UTF-16 command output has an odd byte count".to_string());
        }
        let words: Vec<u16> = payload
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
                }
            })
            .collect();
        String::from_utf16(&words)
            .map_err(|error| format!("Could not decode UTF-16 command output: {error}"))
    }

    if let Some(payload) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return decode_utf16(payload, true);
    }
    if let Some(payload) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return decode_utf16(payload, false);
    }
    // Some Windows command-line tools emit UTF-16LE without a BOM when stdout
    // is redirected. SDDL and path output is predominantly ASCII, producing a
    // reliable zero high-byte pattern.
    if bytes.len() >= 4 && bytes.len().is_multiple_of(2) {
        let chunks = bytes.as_chunks::<2>().0;
        let sample = &chunks[..chunks.len().min(256)];
        let total = sample.len();
        let zero_high_bytes = sample.iter().filter(|pair| pair[1] == 0).count();
        if zero_high_bytes * 4 >= total * 3 {
            return decode_utf16(bytes, true);
        }
    }
    let payload = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(payload.to_vec())
        .map_err(|error| format!("Could not decode command output as UTF-8: {error}"))
}

#[cfg(windows)]
fn run_hidden_output(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[&str],
) -> io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    // Zinnia is a windows_subsystem app; without CREATE_NO_WINDOW the
    // `whoami` fallback flashes a console during staging ACL setup.
    std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Resolve `%SystemRoot%\System32\<name>` and fail closed if missing.
///
/// Rust's Windows program-name resolution for a bare executable name searches,
/// in order: the child's `PATH` argument, the *current process's own
/// directory*, System32, the Windows directory, then `PATH`. NSIS installs
/// under `installMode: currentUser`, so Zinnia's own install directory is
/// user-writable; a bare `Command::new("reg")`/`"taskkill"`/`"powershell.exe"`
/// would resolve a same-named binary placed there before ever reaching the
/// real System32 copy. Every OS-helper invocation must resolve through this
/// function instead so a hijacked binary in the app directory cannot run with
/// Zinnia's privileges (the same reasoning already applied to `whoami.exe`).
#[cfg(windows)]
pub(crate) fn system32_binary_path(name: &str) -> Result<std::path::PathBuf, String> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| format!("SystemRoot is unset; cannot resolve System32\\{name}"))?;
    let path = std::path::PathBuf::from(system_root)
        .join("System32")
        .join(name);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("System32\\{name} not found at {}: {error}", path.display()))?;
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(format!(
            "System32\\{name} at {} is not a regular file",
            path.display()
        ));
    }
    Ok(path)
}

/// Resolve `%SystemRoot%\System32\whoami.exe` and fail closed if missing.
/// Never search PATH: a hijacked whoami on PATH could inject SDDL via SID text.
#[cfg(windows)]
fn system32_whoami_path() -> Result<std::path::PathBuf, String> {
    system32_binary_path("whoami.exe")
}

#[cfg(windows)]
fn current_user_sid_from_token() -> Result<String, String> {
    use std::mem::{align_of, size_of};
    use std::ptr;
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(format!(
                "OpenProcessToken failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut needed = 0u32;
        let first = GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
        if first != 0
            || std::io::Error::last_os_error().raw_os_error()
                != Some(ERROR_INSUFFICIENT_BUFFER as i32)
        {
            let err = std::io::Error::last_os_error();
            CloseHandle(token);
            return Err(format!("GetTokenInformation size probe failed: {err}"));
        }
        // Align the TOKEN_USER view; Vec<u8> alone is not guaranteed pointer-aligned.
        let align = align_of::<TOKEN_USER>().max(align_of::<usize>());
        let size = needed as usize;
        if size < size_of::<TOKEN_USER>() {
            CloseHandle(token);
            return Err(
                "GetTokenInformation reported an undersized TOKEN_USER buffer.".to_string(),
            );
        }
        let mut raw = vec![0u8; size + align];
        let offset = raw.as_ptr().align_offset(align);
        let buffer = &mut raw[offset..offset + size];
        if GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
        {
            let err = std::io::Error::last_os_error();
            CloseHandle(token);
            return Err(format!("GetTokenInformation failed: {err}"));
        }
        CloseHandle(token);

        let token_user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut sid_str: windows_sys::core::PWSTR = ptr::null_mut();
        if ConvertSidToStringSidW(token_user.User.Sid, &mut sid_str) == 0 || sid_str.is_null() {
            return Err(format!(
                "ConvertSidToStringSidW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut len = 0usize;
        while *sid_str.add(len) != 0 {
            len += 1;
        }
        let wide = std::slice::from_raw_parts(sid_str, len);
        let sid = String::from_utf16_lossy(wide);
        LocalFree(sid_str.cast());
        if !is_valid_windows_sid_string(&sid) {
            return Err(format!("Process token returned an invalid SID: {sid}"));
        }
        Ok(sid)
    }
}

#[cfg(windows)]
fn current_user_identity() -> Result<WindowsUserIdentity, String> {
    use std::sync::OnceLock;
    // Cache only successful lookups: a transient identity failure must not
    // permanently break staging ACL for the process lifetime.
    static CACHED: OnceLock<WindowsUserIdentity> = OnceLock::new();
    if let Some(identity) = CACHED.get() {
        return Ok(identity.clone());
    }
    // Prefer the process token SID (Win32) over whoami / USERNAME env.
    // whoami remains a documented fallback when token APIs are unavailable;
    // it must be the absolute System32 binary, never a PATH search.
    let identity = match current_user_sid_from_token() {
        Ok(sid) => WindowsUserIdentity {
            sid,
            #[cfg(test)]
            account: String::new(),
        },
        Err(token_error) => {
            let whoami = system32_whoami_path().map_err(|path_error| {
                format!("token SID unavailable ({token_error}); whoami path failed: {path_error}")
            })?;
            let output =
                run_hidden_output(&whoami, &["/user", "/fo", "csv", "/nh"]).map_err(|e| {
                    format!("token SID unavailable ({token_error}); whoami failed to start: {e}")
                })?;
            if !output.status.success() {
                return Err(format!(
                    "token SID unavailable ({token_error}); whoami failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            let stdout = decode_windows_command_file(&output.stdout)?;
            let line = stdout.lines().next().unwrap_or("").trim();
            parse_whoami_user_csv(line).map_err(|e| {
                format!("token SID unavailable ({token_error}); whoami parse failed: {e}")
            })?
        }
    };
    let _ = CACHED.set(identity.clone());
    Ok(identity)
}

/// Verify that an open file/directory handle is owned by the current user.
/// Used for Windows shell handoff consumption after a nofollow open.
#[cfg(windows)]
pub(crate) fn assert_handle_owned_by_current_user(file: &std::fs::File) -> Result<(), String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;

    let expected_sid = current_user_identity()?.sid;
    let storage = read_directory_security_descriptor(file).map_err(|error| {
        format!("Could not read object security descriptor for owner check: {error}")
    })?;
    let descriptor = storage.as_ptr().cast_mut().cast();
    let owner = security_descriptor_owner(descriptor)?;
    unsafe {
        let mut sid_str: windows_sys::core::PWSTR = std::ptr::null_mut();
        if ConvertSidToStringSidW(owner, &mut sid_str) == 0 || sid_str.is_null() {
            return Err(format!(
                "ConvertSidToStringSidW failed during owner check: {}",
                io::Error::last_os_error()
            ));
        }
        let mut len = 0usize;
        while *sid_str.add(len) != 0 {
            len += 1;
        }
        let wide = std::slice::from_raw_parts(sid_str, len);
        let owner_sid = String::from_utf16_lossy(wide);
        LocalFree(sid_str.cast());
        if !is_valid_windows_sid_string(&owner_sid) {
            return Err(format!("Object owner SID is invalid: {owner_sid}"));
        }
        if owner_sid != expected_sid {
            return Err(format!(
                "Object owner is not the current user (owner={owner_sid}, expected={expected_sid})."
            ));
        }
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn private_directory_sddl(user_sid: &str) -> String {
    // Set the current token user as owner. D:P protects the DACL from parent
    // inheritance. OI/CI propagates the two full-control ACEs to children.
    format!("O:{user_sid}D:P(A;OICI;FA;;;{user_sid})(A;OICI;FA;;;SY)")
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct AccessAllowedAceView {
    flags: u8,
    mask: u32,
    sid: windows_sys::Win32::Security::PSID,
}

#[cfg(windows)]
fn security_descriptor_owner(
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<windows_sys::Win32::Security::PSID, String> {
    use std::ptr;
    use windows_sys::Win32::Security::{GetSecurityDescriptorOwner, IsValidSid, PSID};

    let mut owner: PSID = ptr::null_mut();
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) } == 0 {
        return Err(format!(
            "GetSecurityDescriptorOwner failed: {}",
            io::Error::last_os_error()
        ));
    }
    if owner.is_null() || unsafe { IsValidSid(owner) } == 0 {
        return Err("Security descriptor has no valid owner SID.".to_string());
    }
    Ok(owner)
}

#[cfg(windows)]
fn security_descriptor_dacl(
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<*mut windows_sys::Win32::Security::ACL, String> {
    use std::ptr;
    use windows_sys::Win32::Security::{GetSecurityDescriptorDacl, IsValidAcl, ACL};

    let mut present = 0;
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        == 0
    {
        return Err(format!(
            "GetSecurityDescriptorDacl failed: {}",
            io::Error::last_os_error()
        ));
    }
    // A present-but-NULL DACL grants full access to everyone, so fail closed.
    if present == 0 || dacl.is_null() {
        return Err("Security descriptor has no non-NULL DACL.".to_string());
    }
    if unsafe { IsValidAcl(dacl) } == 0 {
        return Err("Security descriptor contains an invalid DACL.".to_string());
    }
    Ok(dacl)
}

#[cfg(windows)]
fn access_allowed_ace_view(
    dacl: *const windows_sys::Win32::Security::ACL,
    index: u32,
) -> Result<Option<AccessAllowedAceView>, String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;
    use windows_sys::Win32::Security::{
        GetAce, GetLengthSid, IsValidSid, ACCESS_ALLOWED_ACE, ACE_HEADER, PSID,
    };
    use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;

    let mut raw_ace: *mut c_void = ptr::null_mut();
    if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
        return Err(format!(
            "GetAce({index}) failed: {}",
            io::Error::last_os_error()
        ));
    }

    let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
    if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
        return Ok(None);
    }

    // ACCESS_ALLOWED_ACE ends with a variable-sized SID. Validate its size from
    // the bytes inside this ACE before asking Win32 to inspect the SID pointer.
    const SID_FIXED_BYTES: usize = 8; // Revision + count + identifier authority.
    let sid_offset = size_of::<ACE_HEADER>() + size_of::<u32>();
    let ace_size = usize::from(header.AceSize);
    if ace_size < sid_offset + SID_FIXED_BYTES {
        return Err(format!("Allow ACE {index} is truncated."));
    }
    let sid_bytes = unsafe { raw_ace.cast::<u8>().add(sid_offset) };
    let sub_authority_count = unsafe { *sid_bytes.add(1) } as usize;
    let encoded_sid_length = SID_FIXED_BYTES + sub_authority_count * size_of::<u32>();
    if encoded_sid_length > ace_size - sid_offset {
        return Err(format!("Allow ACE {index} has a truncated trustee SID."));
    }

    let sid: PSID = sid_bytes.cast();
    if unsafe { IsValidSid(sid) } == 0 {
        return Err(format!("Allow ACE {index} has an invalid trustee SID."));
    }
    if unsafe { GetLengthSid(sid) } as usize != encoded_sid_length {
        return Err(format!(
            "Allow ACE {index} has an inconsistent trustee SID."
        ));
    }

    let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
    Ok(Some(AccessAllowedAceView {
        flags: header.AceFlags,
        mask: ace.Mask,
        sid,
    }))
}

#[cfg(windows)]
fn dacl_matches_expected(
    actual: *const windows_sys::Win32::Security::ACL,
    expected: *const windows_sys::Win32::Security::ACL,
) -> Result<bool, String> {
    use windows_sys::Win32::Security::EqualSid;

    let actual_count = unsafe { (*actual).AceCount } as u32;
    let expected_count = unsafe { (*expected).AceCount } as u32;
    if actual_count != expected_count {
        return Ok(false);
    }

    // Compare ACEs semantically and without relying on their order. Windows may
    // canonicalize a DACL while preserving the same effective entries.
    let mut matched = vec![false; actual_count as usize];
    for expected_index in 0..expected_count {
        let Some(expected_ace) = access_allowed_ace_view(expected, expected_index)? else {
            return Err(format!(
                "Expected DACL ACE {expected_index} is not an allow ACE."
            ));
        };
        let mut found = false;
        for actual_index in 0..actual_count {
            if matched[actual_index as usize] {
                continue;
            }
            let Some(actual_ace) = access_allowed_ace_view(actual, actual_index)? else {
                continue;
            };
            if actual_ace.flags == expected_ace.flags
                && actual_ace.mask == expected_ace.mask
                && unsafe { EqualSid(actual_ace.sid, expected_ace.sid) } != 0
            {
                matched[actual_index as usize] = true;
                found = true;
                break;
            }
        }
        if !found {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(all(windows, test))]
fn open_directory_for_acl_verification(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        READ_CONTROL,
    };

    // Open the directory itself, not a reparse target. Omit FILE_SHARE_DELETE so
    // it cannot be renamed or removed while its descriptor is being verified.
    let directory = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| {
            io::Error::other(format!(
                "Could not open the staging directory for ACL verification: {error}"
            ))
        })?;

    let attributes = directory.metadata()?.file_attributes();
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(io::Error::other(
            "Staging path is no longer a directory during ACL verification.",
        ));
    }
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other(
            "Staging directory unexpectedly became a reparse point during ACL verification.",
        ));
    }
    Ok(directory)
}

#[cfg(windows)]
fn read_directory_security_descriptor(directory: &std::fs::File) -> io::Result<Vec<usize>> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::ptr;
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, HANDLE};
    use windows_sys::Win32::Security::{
        GetKernelObjectSecurity, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    };

    let handle = directory.as_raw_handle() as HANDLE;
    let requested = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let mut needed = 0u32;
    let first =
        unsafe { GetKernelObjectSecurity(handle, requested, ptr::null_mut(), 0, &mut needed) };
    let first_error = io::Error::last_os_error();
    if first != 0
        || first_error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
        || needed == 0
    {
        return Err(io::Error::other(format!(
            "Could not size the staging directory security descriptor: {first_error}"
        )));
    }

    loop {
        // A usize-backed buffer provides sufficient alignment for the returned
        // self-relative security descriptor while still owning raw bytes.
        let word_size = size_of::<usize>();
        let words = (needed as usize).div_ceil(word_size);
        let mut buffer = vec![0usize; words];
        let capacity = buffer.len() * word_size;
        let capacity_u32 = u32::try_from(capacity)
            .map_err(|_| io::Error::other("Staging directory security descriptor is too large."))?;
        let mut returned = needed;
        if unsafe {
            GetKernelObjectSecurity(
                handle,
                requested,
                buffer.as_mut_ptr().cast(),
                capacity_u32,
                &mut returned,
            )
        } != 0
        {
            return Ok(buffer);
        }

        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
            || returned <= capacity_u32
        {
            return Err(io::Error::other(format!(
                "Could not read the staging directory security descriptor: {error}"
            )));
        }
        needed = returned;
    }
}

#[cfg(windows)]
fn verify_private_directory_security(
    actual: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
    expected: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<(), String> {
    use windows_sys::Win32::Security::{
        EqualSid, GetSecurityDescriptorControl, IsValidSecurityDescriptor, SE_DACL_PROTECTED,
    };

    if unsafe { IsValidSecurityDescriptor(actual) } == 0 {
        return Err(
            "Windows returned an invalid staging directory security descriptor.".to_string(),
        );
    }
    if unsafe { IsValidSecurityDescriptor(expected) } == 0 {
        return Err("The expected staging directory security descriptor is invalid.".to_string());
    }

    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(actual, &mut control, &mut revision) } == 0 {
        return Err(format!(
            "GetSecurityDescriptorControl failed: {}",
            io::Error::last_os_error()
        ));
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Err("Staging directory DACL is not protected from inheritance.".to_string());
    }

    let actual_owner = security_descriptor_owner(actual)?;
    let expected_owner = security_descriptor_owner(expected)?;
    if unsafe { EqualSid(actual_owner, expected_owner) } == 0 {
        return Err("Staging directory owner is not the current user SID.".to_string());
    }

    let actual_dacl = security_descriptor_dacl(actual)?;
    let expected_dacl = security_descriptor_dacl(expected)?;
    if !dacl_matches_expected(actual_dacl, expected_dacl)? {
        return Err(
            "Staging directory DACL does not exactly grant full control to only the current user and SYSTEM."
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn map_windows_directory_create_error(path: &Path, error: io::Error) -> io::Error {
    if error.kind() == io::ErrorKind::PermissionDenied {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "Access is denied creating staging directory under {}. Choose a writable folder such as Desktop or Documents.",
                path.parent().unwrap_or(path).display()
            ),
        )
    } else {
        error
    }
}

#[cfg(windows)]
fn create_inheriting_stage_dir_windows(path: &Path) -> io::Result<std::fs::File> {
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Staging directory path has no file name.",
        )
    })?;
    create_stage_directory_windows(parent, name, FILE_READ_ATTRIBUTES, std::ptr::null_mut())
        .map_err(|error| map_windows_directory_create_error(path, error))
}

#[cfg(all(windows, test))]
fn create_private_file_windows(path: &Path) -> io::Result<std::fs::File> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use std::ptr;
    use windows_sys::Win32::Foundation::{LocalFree, GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL};

    let identity = current_user_identity().map_err(io::Error::other)?;
    let sddl = private_directory_sddl(&identity.sid);
    let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut path_wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if path_wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Private file path contains an embedded NUL.",
        ));
    }
    path_wide.push(0);
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::other(format!(
            "Could not build the private file security descriptor: {}",
            io::Error::last_os_error()
        )));
    }
    if descriptor.is_null() {
        return Err(io::Error::other(
            "Windows returned an empty private file security descriptor.",
        ));
    }

    let result = (|| -> io::Result<std::fs::File> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };
        if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
        Ok(std::fs::File::from(owned))
    })();

    unsafe {
        LocalFree(descriptor);
    }
    result
}

#[cfg(windows)]
fn create_private_dir_windows(path: &Path) -> io::Result<std::fs::File> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;
    use windows_sys::Win32::Storage::FileSystem::{FILE_READ_ATTRIBUTES, READ_CONTROL};

    let identity = current_user_identity().map_err(io::Error::other)?;
    let sddl = private_directory_sddl(&identity.sid);
    let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut expected_descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();

    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut expected_descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::other(format!(
            "Could not build the staging directory security descriptor: {}",
            io::Error::last_os_error()
        )));
    }
    if expected_descriptor.is_null() {
        return Err(io::Error::other(
            "Windows returned an empty staging directory security descriptor.",
        ));
    }

    // Keep the creator descriptor alive through atomic creation and verification,
    // then always release the LocalAlloc buffer returned by the SDDL conversion.
    let result = (|| -> io::Result<std::fs::File> {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let name = path.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Staging directory path has no file name.",
            )
        })?;
        // Apply the protected DACL and explicit owner in the operation that
        // returns the directory handle. No public-path reopen can substitute a
        // different same-user directory before ownership identity is captured.
        let directory = create_stage_directory_windows(
            parent,
            name,
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            expected_descriptor.cast(),
        )
        .map_err(|error| map_windows_directory_create_error(path, error))?;
        let actual_storage = read_directory_security_descriptor(&directory)?;
        let actual_descriptor = actual_storage.as_ptr().cast_mut().cast();
        verify_private_directory_security(actual_descriptor, expected_descriptor).map_err(
            |error| io::Error::other(format!("Could not verify staging directory ACL: {error}")),
        )?;
        Ok(directory)
    })();

    unsafe {
        LocalFree(expected_descriptor);
    }
    result
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
