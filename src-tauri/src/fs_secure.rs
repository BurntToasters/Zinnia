//! Cross-platform helpers for private/internal directories, inheriting publish stages,
//! and durable directory sync.

use std::io;
use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Create a new directory that is private to the current user when the OS allows it.
/// Unix: mode 0o700. Windows: disable inheritance and grant only the current user + SYSTEM.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700).create(path)?;
        Ok(())
    }

    #[cfg(windows)]
    {
        create_private_dir_windows(path)
    }

    #[cfg(not(any(unix, windows)))]
    {
        std::fs::create_dir(path)
    }
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
pub fn create_inheriting_stage_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        create_private_dir(path)
    }

    #[cfg(windows)]
    {
        create_inheriting_stage_dir_windows(path)
    }

    #[cfg(not(any(unix, windows)))]
    {
        std::fs::create_dir(path)
    }
}

/// Flush directory metadata so rename/create durability survives a crash where possible.
pub fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // std opens directories with FILE_FLAG_BACKUP_SEMANTICS so
        // FlushFileBuffers (via sync_all) is the fsync(dirfd) equivalent.
        // Some environments deny directory FlushFileBuffers (os error 5); treat
        // that as best-effort success; the file write itself already succeeded.
        match std::fs::File::open(path).and_then(|directory| directory.sync_all()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    #[cfg(unix)]
    {
        match std::fs::File::open(path).and_then(|directory| directory.sync_all()) {
            Ok(()) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(())
    }
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
    if !sid.starts_with("S-1-") || sid.len() < 7 {
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
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
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
        let sample = bytes.chunks_exact(2).take(256);
        let total = sample.len();
        let zero_high_bytes = sample.filter(|pair| pair[1] == 0).count();
        if zero_high_bytes * 4 >= total * 3 {
            return decode_utf16(bytes, true);
        }
    }
    let payload = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(payload.to_vec())
        .map_err(|error| format!("Could not decode command output as UTF-8: {error}"))
}

#[cfg(windows)]
fn run_hidden_output(program: &str, args: &[&str]) -> io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    // Zinnia is a windows_subsystem app; without CREATE_NO_WINDOW the
    // `whoami` fallback flashes a console during staging ACL setup.
    std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
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
        if !sid.starts_with("S-1-") || sid.len() < 7 {
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
    // whoami remains a documented fallback when token APIs are unavailable.
    let identity = match current_user_sid_from_token() {
        Ok(sid) => WindowsUserIdentity {
            sid,
            #[cfg(test)]
            account: String::new(),
        },
        Err(token_error) => {
            let output =
                run_hidden_output("whoami", &["/user", "/fo", "csv", "/nh"]).map_err(|e| {
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
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) } == 0
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

    let sid: PSID = sid_bytes.cast_mut().cast();
    if unsafe { IsValidSid(sid) } == 0 {
        return Err(format!("Allow ACE {index} has an invalid trustee SID."));
    }
    if unsafe { GetLengthSid(sid) } as usize != encoded_sid_length {
        return Err(format!("Allow ACE {index} has an inconsistent trustee SID."));
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

#[cfg(windows)]
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
    let first = unsafe {
        GetKernelObjectSecurity(handle, requested, ptr::null_mut(), 0, &mut needed)
    };
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
        let capacity_u32 = u32::try_from(capacity).map_err(|_| {
            io::Error::other("Staging directory security descriptor is too large.")
        })?;
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
        return Err(
            "The expected staging directory security descriptor is invalid.".to_string(),
        );
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
fn create_inheriting_stage_dir_windows(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    std::fs::create_dir(path).map_err(|error| map_windows_directory_create_error(path, error))?;

    // Creation used the parent/server default descriptor. Confirm that the
    // randomly named entry is still a real directory before handing it to 7-Zip.
    // The extraction commit path performs deeper tree checks after 7-Zip exits.
    let validation = (|| -> io::Result<()> {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_dir() {
            return Err(io::Error::other("New staging path is not a directory."));
        }
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other(
                "New staging directory unexpectedly became a reparse point.",
            ));
        }
        Ok(())
    })();

    if let Err(error) = validation {
        return match std::fs::remove_dir(path) {
            Ok(()) => Err(error),
            Err(cleanup) if cleanup.kind() == io::ErrorKind::NotFound => Err(error),
            Err(cleanup) => Err(io::Error::other(format!(
                "{error}; additionally could not remove the rejected staging directory: {cleanup}"
            ))),
        };
    }
    Ok(())
}

#[cfg(windows)]
fn create_private_dir_windows(path: &Path) -> io::Result<()> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

    let identity = current_user_identity().map_err(io::Error::other)?;
    let sddl = private_directory_sddl(&identity.sid);
    let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut path_wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if path_wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Staging directory path contains an embedded NUL.",
        ));
    }
    path_wide.push(0);
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

    // Keep the creator descriptor alive through creation and verification, then
    // always release the LocalAlloc buffer returned by the SDDL conversion API.
    let result = (|| -> io::Result<()> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: expected_descriptor,
            bInheritHandle: 0,
        };

        // Apply the protected DACL and explicit owner as part of creation. This
        // avoids the old create-then-restrict window and supports \\?\ paths
        // without routing them through command-line argument parsing.
        if unsafe { CreateDirectoryW(path_wide.as_ptr(), &attributes) } == 0 {
            return Err(map_windows_directory_create_error(
                path,
                io::Error::last_os_error(),
            ));
        }

        // Read the descriptor back from an open directory handle. This is a
        // verification step, not a second ACL mutation. It also fails closed on
        // filesystems that ignore or cannot persist the requested ACL.
        let verification = (|| -> io::Result<()> {
            let directory = open_directory_for_acl_verification(path)?;
            let actual_storage = read_directory_security_descriptor(&directory)?;
            let actual_descriptor = actual_storage.as_ptr().cast_mut().cast();
            verify_private_directory_security(actual_descriptor, expected_descriptor).map_err(
                |error| {
                    io::Error::other(format!("Could not verify staging directory ACL: {error}"))
                },
            )
        })();

        if let Err(error) = verification {
            return match std::fs::remove_dir(path) {
                Ok(()) => Err(error),
                Err(cleanup) if cleanup.kind() == io::ErrorKind::NotFound => Err(error),
                Err(cleanup) => Err(io::Error::other(format!(
                    "{error}; additionally could not remove the rejected private directory: {cleanup}"
                ))),
            };
        }
        Ok(())
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
    fn current_user_sid_from_token_returns_sid_string() {
        let sid = current_user_sid_from_token().expect("process token SID");
        assert!(
            sid.starts_with("S-1-") && sid.len() >= 7,
            "unexpected SID: {sid}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn current_user_identity_prefers_token_sid() {
        let identity = current_user_identity().expect("identity");
        assert!(identity.sid.starts_with("S-1-"));
        assert!(identity.sid.len() >= 7);
    }
}
