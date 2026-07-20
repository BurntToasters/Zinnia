//! Cross-platform helpers for private directories and durable directory sync.

use std::io;
use std::path::Path;

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
        std::fs::create_dir(path)?;
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
    #[cfg(any(unix, windows))]
    {
        // On Windows, std opens directories with FILE_FLAG_BACKUP_SEMANTICS so
        // FlushFileBuffers (via sync_all) is the fsync(dirfd) equivalent.
        std::fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(windows)]
fn current_user_sid() -> Result<String, String> {
    // Prefer the process token identity over the mutable USERNAME environment
    // variable. whoami /user reads the logon token; fail closed if unavailable.
    // (A future Win32 GetTokenInformation path would avoid the helper binary.)
    let output = std::process::Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|e| format!("whoami failed to start: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "whoami failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next().unwrap_or("").trim();
    // CSV: "DOMAIN\user","S-1-5-21-..."
    let sid = line
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .trim();
    if !sid.starts_with("S-1-") || sid.len() < 7 {
        return Err(format!("Could not parse current user SID from whoami: {line}"));
    }
    Ok(sid.to_string())
}

#[cfg(windows)]
fn restrict_directory_acl(path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy();
    let sid = current_user_sid()?;
    // icacls accepts SID grants as *S-1-5-...
    let grant_user = format!("*{sid}:(OI)(CI)F");

    run_icacls(&[
        path_str.as_ref(),
        "/inheritance:r",
        "/grant:r",
        &grant_user,
        "/grant:r",
        "SYSTEM:(OI)(CI)F",
    ])?;

    for principal in [
        "Everyone",
        "Users",
        "Authenticated Users",
        r"BUILTIN\Users",
    ] {
        // Removals are best-effort when the principal was never present.
        let _ = run_icacls(&[path_str.as_ref(), "/remove", principal]);
    }

    verify_restricted_acl(path)?;
    Ok(())
}

#[cfg(windows)]
fn verify_restricted_acl(path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy();
    let output = std::process::Command::new("icacls")
        .arg(path_str.as_ref())
        .output()
        .map_err(|e| format!("icacls verify failed to start: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "icacls verify failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let listing = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    for forbidden in ["everyone", "authenticated users", r"builtin\users"] {
        if listing.contains(forbidden) {
            return Err(format!(
                "Staging directory ACL still grants {forbidden}: {}",
                path.display()
            ));
        }
    }
    // Require that some ACE for the current SID survived.
    let sid = current_user_sid()?.to_ascii_lowercase();
    if !listing.contains(&sid) {
        return Err(format!(
            "Staging directory ACL missing current user SID after restrict: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn run_icacls(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("icacls")
        .args(args)
        .output()
        .map_err(|e| format!("icacls failed to start: {e}"))?;
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
