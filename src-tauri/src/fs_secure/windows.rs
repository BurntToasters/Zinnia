//! Windows ACL/SID/SDDL verification and private directory create.

#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub(crate) fn open_directory_nofollow(path: &Path) -> io::Result<std::fs::File> {
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
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(io::Error::other("Staging path is not a real directory."));
    }
    Ok(directory)
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
// SAFETY: these ntdll declarations mirror the documented NtCreateFile and RtlNtStatusToDosError
// prototypes. Every call passes pointers to locals that live for the call; see the call sites.
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
#[cfg(windows)]
pub(crate) fn create_stage_directory_windows(
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
    // SAFETY: `object_attributes` points at `object_name`, which points at `name_wide`, a
    // NUL-terminated buffer whose byte length is `byte_len`; all are locals that outlive the call.
    // RootDirectory is `parent_directory`, an open handle owned by this function.
    // `security_descriptor` is null or a live self-relative descriptor from the caller. `io_status`
    // and `handle` are writable out-parameters of the declared types, and NtCreateFile keeps no
    // pointer after returning.
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
        // SAFETY: RtlNtStatusToDosError takes the NTSTATUS by value and has no pointer arguments.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::other(
            "Windows created a staging directory without returning its handle.",
        ));
    }
    // SAFETY: `handle` came from a successful NtCreateFile and was checked for null and
    // INVALID_HANDLE_VALUE above. Nothing else owns it, so OwnedHandle closes it exactly once.
    let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
    Ok(std::fs::File::from(owned))
}
#[cfg(windows)]
pub(crate) fn open_directory_for_quarantine(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, SYNCHRONIZE,
    };
    // Children are deleted through their own DELETE handles. Asking for
    // FILE_DELETE_CHILD here rejects ordinary Windows Modify-only ACLs.
    let directory = std::fs::OpenOptions::new()
        .access_mode(
            DELETE
                | FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | FILE_WRITE_ATTRIBUTES
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
pub(crate) fn open_relative_for_cleanup(
    parent: &std::fs::File,
    name: &std::ffi::OsStr,
) -> io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_NORMAL, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, SYNCHRONIZE,
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
    // Keep the same minimal access as the root cleanup handle; recursion opens
    // every descendant separately with DELETE authority.
    // SAFETY: `object_name` is NUL-terminated (`name_wide.push(0)`) and outlives the call;
    // `object_attributes` and `io_status` are live locals. RootDirectory is `parent`'s handle,
    // which stays alive for the call. `handle` is a writable out-parameter.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            DELETE
                | FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | FILE_WRITE_ATTRIBUTES
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
        // SAFETY: RtlNtStatusToDosError takes the NTSTATUS by value and has no pointer arguments.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::other(
            "Windows opened a cleanup entry without returning its handle.",
        ));
    }
    // SAFETY: `handle` came from a successful NtCreateFile and was checked for null and
    // INVALID_HANDLE_VALUE above. OwnedHandle takes sole ownership and closes it exactly once.
    let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
    Ok(std::fs::File::from(owned))
}

#[cfg(windows)]
pub(crate) fn list_directory_children(
    directory: &std::fs::File,
) -> io::Result<Vec<std::ffi::OsString>> {
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
            // SAFETY: `handle` is the live handle of `directory`, borrowed for this call. `buffer`
            // is a live allocation of exactly `buffer.len()` bytes, passed as the length, so the
            // API writes only within it. The FileIdBothDirectory classes fill it with
            // FILE_ID_BOTH_DIR_INFO records.
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
                // SAFETY: the `remaining.len() >= size_of::<FILE_ID_BOTH_DIR_INFO>()` check above
                // keeps the fixed header inside `buffer`. `read_unaligned` copies it out, so the
                // byte buffer's alignment does not matter, and the struct is plain integers.
                let info = unsafe {
                    std::ptr::read_unaligned(remaining.as_ptr().cast::<FILE_ID_BOTH_DIR_INFO>())
                };
                let name_len = info.FileNameLength as usize;
                let name_offset = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
                let Some(name_bytes) = name_offset
                    .checked_add(name_len)
                    .and_then(|name_end| remaining.get(name_offset..name_end))
                    .filter(|bytes| bytes.len() % 2 == 0)
                else {
                    break Err(io::Error::other("Directory listing name was truncated."));
                };
                let (units, _) = name_bytes.as_chunks::<2>();
                let name_units: Vec<u16> = units.iter().copied().map(u16::from_le_bytes).collect();
                names.push(std::ffi::OsString::from_wide(&name_units));
                let next = info.NextEntryOffset as usize;
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
pub(crate) fn mark_handle_deleted(file: &std::fs::File) -> io::Result<()> {
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
    // SAFETY: `handle` is borrowed from `file` for this call. `posix` is a live
    // FILE_DISPOSITION_INFO_EX whose size is passed; the API only reads it.
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
        // SAFETY: same live handle. `basic` is a live FILE_BASIC_INFO whose size is passed; the API
        // only reads it.
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
    // SAFETY: same live handle. `info` is a live FILE_DISPOSITION_INFO whose size is passed; the
    // API only reads it.
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
pub(crate) fn remove_directory_contents_relative(directory: &std::fs::File) -> io::Result<()> {
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
#[cfg(windows)]
pub(crate) fn clear_windows_readonly_tree(path: &Path) -> io::Result<()> {
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
pub(crate) fn clear_windows_readonly(path: &Path, metadata: &std::fs::Metadata) -> io::Result<()> {
    if metadata.permissions().readonly() {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
const MAX_WINDOWS_SID_CHARS: usize = 256;

/// Strict SID check before interpolating into SDDL. Rejects `)`, spaces,
/// letters in subauthorities, and other injection shapes. Matches
/// `^S-1-[0-9]+(-[0-9]+)+$` with a 256-character ceiling.
#[cfg(any(windows, test))]
pub(crate) fn is_valid_windows_sid_string(sid: &str) -> bool {
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
pub(crate) struct WindowsUserIdentity {
    /// SID string, e.g. `S-1-5-21-...`
    pub(crate) sid: String,
    /// Account from the `whoami` fallback, retained only for parser tests.
    #[cfg(test)]
    pub(crate) account: String,
}

#[cfg(any(windows, test))]
pub(crate) fn parse_whoami_user_csv(line: &str) -> Result<WindowsUserIdentity, String> {
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
pub(crate) fn decode_windows_command_file(bytes: &[u8]) -> Result<String, String> {
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
pub(crate) fn run_hidden_output(
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
pub(crate) fn system32_whoami_path() -> Result<std::path::PathBuf, String> {
    system32_binary_path("whoami.exe")
}

#[cfg(windows)]
pub(crate) fn current_user_sid_from_token() -> Result<String, String> {
    use std::mem::{align_of, size_of};
    use std::ptr;
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: OpenProcessToken writes a new token handle into the live `token` local, and
    // GetCurrentProcess returns a pseudo-handle that needs no closing. The token is closed on every
    // return path. TOKEN_USER is read from `buffer`, which is sized by GetTokenInformation's answer
    // and aligned to TOKEN_USER by `align_offset`.
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
pub(crate) fn current_user_identity() -> Result<WindowsUserIdentity, String> {
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
    // SAFETY: `owner` is a SID inside `storage`, which is alive and was validated by
    // security_descriptor_owner. ConvertSidToStringSidW returns a LocalAlloc'd NUL-terminated
    // string in `sid_str`. It is read only up to that terminator and freed exactly once with
    // LocalFree before any other return.
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
pub(crate) fn private_directory_sddl(user_sid: &str) -> String {
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
pub(crate) fn security_descriptor_owner(
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<windows_sys::Win32::Security::PSID, String> {
    use std::ptr;
    use windows_sys::Win32::Security::{GetSecurityDescriptorOwner, IsValidSid, PSID};

    let mut owner: PSID = ptr::null_mut();
    let mut defaulted = 0;
    // SAFETY: `descriptor` is a self-relative descriptor in live storage held by the caller;
    // `owner` and `defaulted` are writable out-parameters.
    if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) } == 0 {
        return Err(format!(
            "GetSecurityDescriptorOwner failed: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: `owner` was returned by GetSecurityDescriptorOwner for the same live descriptor; the
    // null check short-circuits first.
    if owner.is_null() || unsafe { IsValidSid(owner) } == 0 {
        return Err("Security descriptor has no valid owner SID.".to_string());
    }
    Ok(owner)
}

#[cfg(windows)]
pub(crate) fn security_descriptor_dacl(
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<*mut windows_sys::Win32::Security::ACL, String> {
    use std::ptr;
    use windows_sys::Win32::Security::{GetSecurityDescriptorDacl, IsValidAcl, ACL};

    let mut present = 0;
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut defaulted = 0;
    // SAFETY: `descriptor` is live (as above); `present`, `dacl`, and `defaulted` are writable
    // out-parameters.
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
    // SAFETY: `dacl` is non-null (checked above) and points into the live descriptor returned by
    // GetSecurityDescriptorDacl.
    if unsafe { IsValidAcl(dacl) } == 0 {
        return Err("Security descriptor contains an invalid DACL.".to_string());
    }
    Ok(dacl)
}

#[cfg(windows)]
pub(crate) fn access_allowed_ace_view(
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
    // SAFETY: `dacl` was validated by IsValidAcl in a live descriptor. `raw_ace` is a writable
    // out-pointer; GetAce returns a pointer into the ACL buffer, which is checked for null below.
    if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
        return Err(format!(
            "GetAce({index}) failed: {}",
            io::Error::last_os_error()
        ));
    }

    // SAFETY: `raw_ace` is non-null and points at an ACE inside the validated ACL. ACE_HEADER is
    // the 4-byte prefix every ACE begins with, so the reference is in bounds. ACEs are
    // DWORD-aligned inside an ACL.
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
    // SAFETY: the check `ace_size >= sid_offset + SID_FIXED_BYTES` above keeps `sid_offset` inside
    // the ACE.
    let sid_bytes = unsafe { raw_ace.cast::<u8>().add(sid_offset) };
    // SAFETY: the 8 fixed SID bytes at `sid_offset` lie inside the ACE per the check above; byte 1
    // is SubAuthorityCount.
    let sub_authority_count = unsafe { *sid_bytes.add(1) } as usize;
    let encoded_sid_length = SID_FIXED_BYTES + sub_authority_count * size_of::<u32>();
    if encoded_sid_length > ace_size - sid_offset {
        return Err(format!("Allow ACE {index} has a truncated trustee SID."));
    }

    let sid: PSID = sid_bytes.cast();
    // SAFETY: `encoded_sid_length` was checked to fit in the bytes left in the ACE, so IsValidSid
    // reads only ACE memory.
    if unsafe { IsValidSid(sid) } == 0 {
        return Err(format!("Allow ACE {index} has an invalid trustee SID."));
    }
    // SAFETY: `sid` passed IsValidSid immediately above.
    if unsafe { GetLengthSid(sid) } as usize != encoded_sid_length {
        return Err(format!(
            "Allow ACE {index} has an inconsistent trustee SID."
        ));
    }

    // SAFETY: ACCESS_ALLOWED_ACE is 12 bytes (header, mask, first SID dword). The ACE is at least
    // 16 bytes by the check above, so the reference is in bounds. Only `Mask` is read.
    let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
    Ok(Some(AccessAllowedAceView {
        flags: header.AceFlags,
        mask: ace.Mask,
        sid,
    }))
}

#[cfg(windows)]
pub(crate) fn dacl_matches_expected(
    actual: *const windows_sys::Win32::Security::ACL,
    expected: *const windows_sys::Win32::Security::ACL,
) -> Result<bool, String> {
    use windows_sys::Win32::Security::EqualSid;

    // SAFETY: `actual` is an ACL pointer returned by security_descriptor_dacl and validated with
    // IsValidAcl; the ACL header lies at its start.
    let actual_count = unsafe { (*actual).AceCount } as u32;
    // SAFETY: `expected` is an ACL pointer returned by security_descriptor_dacl and validated with
    // IsValidAcl.
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
                // SAFETY: both SIDs come from access_allowed_ace_view, which validated each one
                // with IsValidSid inside a live DACL.
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
pub(crate) fn open_directory_for_acl_verification(path: &Path) -> io::Result<std::fs::File> {
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
pub(crate) fn read_directory_security_descriptor(
    directory: &std::fs::File,
) -> io::Result<Vec<usize>> {
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
        // SAFETY: `handle` is the live handle of `directory`, borrowed for this call. The null
        // buffer with length 0 is the documented size query and writes nothing; `needed` is a
        // writable u32.
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
        // SAFETY: `buffer` is a usize-aligned allocation whose byte length is `capacity_u32`,
        // passed as nLength, so the API writes only inside it. `returned` is a writable u32.
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
pub(crate) fn verify_private_directory_security(
    actual: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
    expected: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<(), String> {
    use windows_sys::Win32::Security::{
        EqualSid, GetSecurityDescriptorControl, IsValidSecurityDescriptor, SE_DACL_PROTECTED,
    };

    // SAFETY: `actual` points into the storage buffer that the caller holds alive for the whole
    // comparison.
    if unsafe { IsValidSecurityDescriptor(actual) } == 0 {
        return Err(
            "Windows returned an invalid staging directory security descriptor.".to_string(),
        );
    }
    // SAFETY: `expected` is the LocalAlloc'd descriptor from the SDDL conversion, which the caller
    // frees only after this call.
    if unsafe { IsValidSecurityDescriptor(expected) } == 0 {
        return Err("The expected staging directory security descriptor is invalid.".to_string());
    }

    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: `actual` was validated above; `control` and `revision` are writable out-parameters.
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
    // SAFETY: the owners come from security_descriptor_owner, which validated each with IsValidSid
    // inside a live descriptor.
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
pub(crate) fn map_windows_directory_create_error(path: &Path, error: io::Error) -> io::Error {
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
pub(crate) fn create_inheriting_stage_dir_windows(path: &Path) -> io::Result<std::fs::File> {
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
pub(crate) fn create_private_file_windows(path: &Path) -> io::Result<std::fs::File> {
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
    // SAFETY: `sddl_wide` is NUL-terminated and `descriptor` is a writable out-parameter. On
    // success Windows allocates the descriptor with LocalAlloc; the caller frees it with LocalFree
    // on every path.
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
        // SAFETY: `path_wide` is NUL-terminated and alive for the call; `attributes` is a live
        // SECURITY_ATTRIBUTES whose descriptor stays allocated until LocalFree after this closure
        // returns.
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
        // SAFETY: `handle` was checked non-null and not INVALID_HANDLE_VALUE. CREATE_NEW returned
        // it to this call alone, so OwnedHandle takes sole ownership.
        let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
        Ok(std::fs::File::from(owned))
    })();

    // SAFETY: `descriptor` was allocated by the SDDL conversion above and is freed exactly once,
    // after the closure that borrows it has returned.
    unsafe {
        LocalFree(descriptor);
    }
    result
}

#[cfg(windows)]
pub(crate) fn create_private_dir_windows(path: &Path) -> io::Result<std::fs::File> {
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

    // SAFETY: `sddl_wide` is NUL-terminated and alive; `expected_descriptor` is a writable
    // out-parameter that Windows allocates with LocalAlloc. It is freed with LocalFree on every
    // path below.
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

    // SAFETY: `expected_descriptor` is the LocalAlloc'd buffer from the SDDL conversion above. The
    // closure that borrowed it has already returned, so this is the single free.
    unsafe {
        LocalFree(expected_descriptor);
    }
    result
}
