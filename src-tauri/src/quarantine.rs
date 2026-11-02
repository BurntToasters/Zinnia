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
        let file = crate::path_safety::open_regular_file_nofollow(path)?;
        read_quarantine_from_open_file(&file)
    }

    pub(crate) fn read_quarantine_from_open_file(
        file: &std::fs::File,
    ) -> Result<Option<Vec<u8>>, String> {
        use std::os::unix::io::AsRawFd as _;
        let mut buffer = vec![0u8; MAX_QUARANTINE_BYTES];
        // SAFETY: `file` is an open regular-file descriptor and `buffer` is writable for `read`
        // bytes. The attribute name is a live NUL-terminated C string.
        let read = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
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

    fn set_mode_nofollow(path: &std::path::Path, mode: u32) -> std::io::Result<()> {
        let path_c = c_path(path).map_err(std::io::Error::other)?;
        // SAFETY: `path_c` is a live NUL-terminated CString for `path`, and `AT_SYMLINK_NOFOLLOW`
        // keeps the mode change on the link itself when `path` is a symlink.
        let result = unsafe {
            libc::fchmodat(
                libc::AT_FDCWD,
                path_c.as_ptr(),
                mode as libc::mode_t,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
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
    ) -> Result<bool, String> {
        match set_quarantine_nofollow(path, value) {
            Ok(()) => Ok(true),
            Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                let original = metadata.permissions();
                let mode = original.mode();
                set_mode_nofollow(path, mode | 0o200).map_err(|chmod_error| {
                    format!(
                        "Could not quarantine {}: {error}; owner write access could not be granted: {chmod_error}",
                        path.display()
                    )
                })?;
                let result = set_quarantine_nofollow(path, value);
                let restore = set_mode_nofollow(path, mode);
                result.map_err(|retry_error| {
                    format!("Could not quarantine {}: {retry_error}", path.display())
                })?;
                restore.map(|()| true).map_err(|restore_error| {
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
            if !apply_to_entry(&path, &metadata, value)? {
                eprintln!(
                    "Skipping quarantine marker for {}: the destination volume does not support extended attributes.",
                    root.display()
                );
                return Ok(());
            }
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

/// Download-marker source validated when the operation starts. Copy uses a fresh
/// no-follow open and the stored identity so a swapped path cannot supply a
/// different marker.
#[derive(Clone)]
pub(crate) struct ValidatedMotwSource {
    path: std::path::PathBuf,
    identity: crate::process::FileIdentity,
}

pub(crate) fn validated_mark_of_the_web_source(raw: &str) -> Result<ValidatedMotwSource, String> {
    let path = validated_regular_file(raw, "download-marker source")?;
    let file = crate::path_safety::open_regular_file_nofollow(&path)?;
    let identity = crate::process::file_identity(&file)?;
    Ok(ValidatedMotwSource { path, identity })
}

fn copy_mark_of_the_web_with_expected_identity(
    source: &std::path::Path,
    expected_identity: Option<&crate::process::FileIdentity>,
    output: &std::path::Path,
) -> Result<(), String> {
    let source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    let opened_identity = crate::process::file_identity(&source_file)?;
    if let Some(expected) = expected_identity {
        if !crate::process::file_identities_match(&opened_identity, expected) {
            return Err(
                "The download-marker source changed before the archive could be marked."
                    .to_string(),
            );
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(value) = macos::read_quarantine_from_open_file(&source_file)? {
        apply_quarantine_tree(output, &value)?;
    }
    #[cfg(windows)]
    crate::process::copy_windows_zone_identifier_with_identity(source, output, expected_identity)?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (source_file, output);
    Ok(())
}

/// Carries the source archive's download marker onto a conversion output. A
/// conversion writes a new file, which would otherwise shed the macOS
/// quarantine attribute or the Windows Zone.Identifier stream that Gatekeeper
/// and SmartScreen use to warn about downloaded files.
#[cfg(all(test, any(target_os = "macos", windows)))]
pub(crate) fn copy_mark_of_the_web(
    source: &std::path::Path,
    output: &std::path::Path,
) -> Result<(), String> {
    copy_mark_of_the_web_with_expected_identity(source, None, output)
}

/// Marks every member of the archive output family using a validated
/// selection-time download-marker source.
pub(crate) fn copy_mark_of_the_web_to_family_from_validated(
    source: &ValidatedMotwSource,
    output_base: &std::path::Path,
) -> Result<(), String> {
    let family = crate::process::archive_family(output_base)
        .map_err(|error| format!("The archive output cannot be marked: {error}"))?;
    if family.is_empty() {
        return Err("The archive output does not exist.".to_string());
    }
    for path in &family {
        copy_mark_of_the_web_with_expected_identity(&source.path, Some(&source.identity), path)?;
    }
    Ok(())
}

/// Marks every member of the archive output family with `source`'s download marker.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn copy_mark_of_the_web_to_family(
    source: &std::path::Path,
    output_base: &std::path::Path,
) -> Result<(), String> {
    copy_mark_of_the_web_to_family_with_identity(source, None, output_base)
}

pub(crate) fn copy_mark_of_the_web_to_family_with_identity(
    source: &std::path::Path,
    expected_identity: Option<&crate::process::FileIdentity>,
    output_base: &std::path::Path,
) -> Result<(), String> {
    let family = crate::process::archive_family(output_base)
        .map_err(|error| format!("The archive output cannot be marked: {error}"))?;
    if family.is_empty() {
        return Err("The archive output does not exist.".to_string());
    }
    for path in &family {
        copy_mark_of_the_web_with_expected_identity(source, expected_identity, path)?;
    }
    Ok(())
}

pub(crate) fn validated_regular_file(raw: &str, label: &str) -> Result<std::path::PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(format!("The {label} path is invalid."));
    }
    let path = std::path::PathBuf::from(raw);
    let meta =
        std::fs::symlink_metadata(&path).map_err(|_| format!("The {label} does not exist."))?;
    crate::path_safety::reject_link_or_reparse(&path, &meta)
        .map_err(|_| format!("The {label} cannot be a symbolic link or reparse point."))?;
    if !meta.is_file() {
        return Err(format!("The {label} must be a file."));
    }
    Ok(path)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::apply_quarantine_tree;
    use super::{
        copy_mark_of_the_web, copy_mark_of_the_web_to_family, read_quarantine,
        validated_regular_file,
    };

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zinnia-motw-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn conversion_output_inherits_the_source_quarantine_marker() {
        let dir = scratch_dir("carry");
        let source = dir.join("download.rar");
        let output = dir.join("converted.zip");
        std::fs::write(&source, b"source").expect("source");
        std::fs::write(&output, b"converted").expect("output");
        let marker = b"0081;65f0a1b2;Safari;ABCD-1234".to_vec();
        apply_quarantine_tree(&source, &marker).expect("mark source");

        copy_mark_of_the_web(&source, &output).expect("carry marker");

        assert_eq!(read_quarantine(&output).expect("read output"), Some(marker));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unmarked_source_leaves_conversion_output_unmarked() {
        let dir = scratch_dir("clean");
        let source = dir.join("local.rar");
        let output = dir.join("converted.zip");
        std::fs::write(&source, b"source").expect("source");
        std::fs::write(&output, b"converted").expect("output");

        copy_mark_of_the_web(&source, &output).expect("no-op");

        assert_eq!(read_quarantine(&output).expect("read output"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_conversion_output_marks_every_volume() {
        // `-v<size>` writes `converted.7z.001`, `.002`, ... and never the base path.
        let dir = scratch_dir("split");
        let source = dir.join("download.rar");
        let base = dir.join("converted.7z");
        std::fs::write(&source, b"source").expect("source");
        let volumes = [dir.join("converted.7z.001"), dir.join("converted.7z.002")];
        for volume in &volumes {
            std::fs::write(volume, b"volume").expect("volume");
        }
        let marker = b"0081;65f0a1b2;Safari;ABCD-5678".to_vec();
        apply_quarantine_tree(&source, &marker).expect("mark source");

        copy_mark_of_the_web_to_family(&source, &base)
            .expect("split output is a valid conversion result");

        for volume in &volumes {
            assert_eq!(
                read_quarantine(volume).expect("read volume"),
                Some(marker.clone())
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn command_rejects_missing_directory_and_symlink_paths() {
        let dir = scratch_dir("reject");
        let file = dir.join("file.zip");
        std::fs::write(&file, b"x").expect("file");
        let link = dir.join("link.zip");
        std::os::unix::fs::symlink(&file, &link).expect("symlink");

        assert!(
            validated_regular_file(&dir.join("missing.rar").to_string_lossy(), "source").is_err()
        );
        assert!(copy_mark_of_the_web_to_family(&file, &link).is_err());
        assert!(validated_regular_file(&dir.to_string_lossy(), "source").is_err());
        assert!(validated_regular_file(&link.to_string_lossy(), "source").is_err());
        assert!(validated_regular_file("", "source").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
