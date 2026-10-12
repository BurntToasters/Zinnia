#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    const QUARANTINE_ATTRIBUTE: &std::ffi::CStr = c"com.apple.quarantine";
    const MAX_QUARANTINE_BYTES: usize = 4096;

    fn c_path(path: &std::path::Path) -> Result<CString, String> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| format!("Path contains an interior NUL: {}", path.display()))
    }

    pub(crate) fn read_quarantine(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
        let path_c = c_path(path)?;
        let mut buffer = vec![0u8; MAX_QUARANTINE_BYTES];
        // SAFETY: `path_c` and the attribute name are live NUL-terminated strings, and `buffer` is
        // a writable allocation of exactly `buffer.len()` bytes, the size passed to getxattr.
        let read = unsafe {
            libc::getxattr(
                path_c.as_ptr(),
                QUARANTINE_ATTRIBUTE.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
                0,
            )
        };
        if read < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ENOATTR | libc::ENOTSUP)) {
                return Ok(None);
            }
            return Err(format!(
                "Could not read the archive quarantine attribute: {error}"
            ));
        }
        buffer.truncate(read as usize);
        Ok(Some(buffer))
    }

    fn set_quarantine_nofollow(path: &std::path::Path, value: &[u8]) -> std::io::Result<()> {
        let path_c = c_path(path).map_err(std::io::Error::other)?;
        // SAFETY: `path_c` and the attribute name are live NUL-terminated strings, and `value` is
        // read for exactly `value.len()` bytes. XATTR_NOFOLLOW keeps a symbolic link from
        // redirecting the write to its target.
        let written = unsafe {
            libc::setxattr(
                path_c.as_ptr(),
                QUARANTINE_ATTRIBUTE.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if written == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn apply_to_entry(
        path: &std::path::Path,
        metadata: &std::fs::Metadata,
        value: &[u8],
    ) -> Result<(), String> {
        match set_quarantine_nofollow(path, value) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                let original = metadata.permissions();
                let mode = original.mode();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o200))
                    .map_err(|chmod_error| {
                        format!(
                            "Could not quarantine {}: {error}; owner write access could not be granted: {chmod_error}",
                            path.display()
                        )
                    })?;
                let result = set_quarantine_nofollow(path, value);
                let restore = std::fs::set_permissions(path, original);
                result.map_err(|retry_error| {
                    format!("Could not quarantine {}: {retry_error}", path.display())
                })?;
                restore.map_err(|restore_error| {
                    format!(
                        "Quarantined {} but could not restore its permissions: {restore_error}",
                        path.display()
                    )
                })
            }
            Err(error) => Err(format!("Could not quarantine {}: {error}", path.display())),
        }
    }

    pub(crate) fn apply_quarantine_tree(
        root: &std::path::Path,
        value: &[u8],
    ) -> Result<(), String> {
        let mut pending = vec![root.to_path_buf()];
        while let Some(path) = pending.pop() {
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if !metadata.is_dir() && !metadata.is_file() {
                return Err(format!(
                    "Refusing to quarantine an unsupported file type: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                for entry in std::fs::read_dir(&path)
                    .map_err(|error| format!("Could not read {}: {error}", path.display()))?
                {
                    let entry = entry.map_err(|error| error.to_string())?;
                    pending.push(entry.path());
                }
            }
            apply_to_entry(&path, &metadata, value)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{apply_quarantine_tree, read_quarantine};

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_quarantine(_path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_quarantine_tree(_root: &std::path::Path, _value: &[u8]) -> Result<(), String> {
    Ok(())
}
