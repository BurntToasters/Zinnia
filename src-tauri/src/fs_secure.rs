//! Cross-platform helpers for private directories and durable directory sync.

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
        std::fs::create_dir(path).map_err(|error| {
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
        })?;
        if let Err(error) = restrict_directory_acl(path) {
            let _ = std::fs::remove_dir(path);
            return Err(io::Error::new(io::ErrorKind::Other, error));
        }
        Ok(())
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
    /// Account from whoami, e.g. `DESKTOP\dev` (kept for ACL listing match).
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
    // Zinnia is a windows_subsystem app; without CREATE_NO_WINDOW every helper
    // (whoami/icacls) flashes a console during staging ACL setup.
    std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

#[cfg(windows)]
fn current_user_sid_from_token() -> Result<String, String> {
    use std::mem::{align_of, size_of};
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = 0;
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
            return Err("GetTokenInformation reported an undersized TOKEN_USER buffer.".to_string());
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
        let mut sid_str: *mut u16 = ptr::null_mut();
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
            account: String::new(),
        },
        Err(token_error) => {
            let output = run_hidden_output("whoami", &["/user", "/fo", "csv", "/nh"])
                .map_err(|e| format!("token SID unavailable ({token_error}); whoami failed to start: {e}"))?;
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

#[cfg(windows)]
fn restrict_directory_acl(path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy();
    let identity = current_user_identity()?;
    // icacls accepts SID grants as *S-1-5-...
    let grant_user = format!("*{}:(OI)(CI)F", identity.sid);

    run_icacls(&[
        path_str.as_ref(),
        "/inheritance:r",
        "/grant:r",
        &grant_user,
        "/grant:r",
        "SYSTEM:(OI)(CI)F",
    ])?;

    // One call for all broad-principal removals (best-effort).
    let _ = run_icacls(&[
        path_str.as_ref(),
        "/remove",
        "*S-1-1-0", // Everyone
        "/remove",
        "*S-1-5-11", // Authenticated Users
        "/remove",
        "*S-1-5-32-545", // BUILTIN\Users
    ]);

    verify_restricted_acl(path, &identity)?;
    Ok(())
}

#[cfg(windows)]
fn read_directory_sddl(path: &Path) -> Result<String, String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| format!("Could not name ACL save file: {e}"))?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let save_path = std::env::temp_dir().join(format!("zinnia-acl-{token}.txt"));
    let path_str = path.to_string_lossy();
    let save_str = save_path.to_string_lossy();
    let save_result = run_icacls(&[path_str.as_ref(), "/save", save_str.as_ref()]);
    let content = std::fs::read(&save_path);
    let _ = std::fs::remove_file(&save_path);
    save_result?;
    let content = content.map_err(|e| format!("Could not read saved ACL: {e}"))?;
    let content = decode_windows_command_file(&content)?;
    // icacls /save writes: <path>\n<SDDL>\n
    let sddl = content.lines().nth(1).unwrap_or("").trim().to_string();
    if sddl.is_empty() {
        return Err(format!(
            "Saved ACL for {} did not include an SDDL line.",
            path.display()
        ));
    }
    Ok(sddl)
}

/// True when SDDL contains an Allow ACE whose trustee is `sid`
/// (bare SID, `*SID`, or a matching SDDL short alias).
#[cfg(any(windows, test))]
fn sddl_has_allow_trustee(sddl: &str, trustees: &[&str]) -> bool {
    let sddl_upper = sddl.to_ascii_uppercase();
    let trustees_upper: Vec<String> = trustees
        .iter()
        .map(|t| t.trim_start_matches('*').to_ascii_uppercase())
        .collect();
    for chunk in sddl_upper.split('(').skip(1) {
        let ace = chunk.trim_end_matches(')');
        let mut parts = ace.split(';');
        let Some(ace_type) = parts.next() else {
            continue;
        };
        if ace_type != "A" {
            continue;
        }
        // A;flags;rights;objectguid;inheritedobjectguid;trustee
        let trustee = parts.nth(4).unwrap_or("");
        let trustee = trustee.trim_start_matches('*');
        if trustees_upper.iter().any(|t| t == trustee) {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn verify_restricted_acl(path: &Path, identity: &WindowsUserIdentity) -> Result<(), String> {
    let sddl = read_directory_sddl(path)?;
    if sddl_has_allow_trustee(
        &sddl,
        &["WD", "AU", "BU", "S-1-1-0", "S-1-5-11", "S-1-5-32-545"],
    ) {
        return Err(format!(
            "Staging directory ACL still grants a broad principal: {}",
            path.display()
        ));
    }
    if !sddl_has_allow_trustee(&sddl, &[&identity.sid]) {
        return Err(format!(
            "Staging directory ACL missing current user SID after restrict: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn run_icacls(args: &[&str]) -> Result<(), String> {
    let output =
        run_hidden_output("icacls", args).map_err(|e| format!("icacls failed to start: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    Err(format!("icacls {} failed: {detail}", args.join(" ")))
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
    fn sddl_detects_user_sid_allow_ace() {
        let sddl = "D:P(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;OICI;FA;;;SY)";
        assert!(sddl_has_allow_trustee(sddl, &["S-1-5-21-1-2-3-1001"]));
        assert!(sddl_has_allow_trustee(sddl, &["SY"]));
        assert!(!sddl_has_allow_trustee(sddl, &["WD", "AU", "BU"]));
    }

    #[test]
    fn sddl_detects_broad_principal_aliases() {
        let sddl = "D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)";
        assert!(sddl_has_allow_trustee(sddl, &["WD", "S-1-1-0"]));
        let sddl_au = "D:P(A;OICI;FR;;;AU)";
        assert!(sddl_has_allow_trustee(sddl_au, &["AU", "S-1-5-11"]));
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
