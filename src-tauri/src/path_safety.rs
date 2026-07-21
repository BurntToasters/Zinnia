//! Shared path safety helpers (symlink / Windows reparse-point rejection).

use std::fs::Metadata;
use std::path::Path;

/// True when the metadata describes a symbolic link or (on Windows) any reparse point.
pub fn is_link_or_reparse(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Reject symlinks and Windows reparse points (junctions, cloud placeholders, etc.).
pub fn reject_link_or_reparse(path: &Path, meta: &Metadata) -> Result<(), String> {
    if is_link_or_reparse(meta) {
        return Err(format!(
            "Refusing symbolic link or reparse point: {}",
            path.display()
        ));
    }
    Ok(())
}

pub fn assert_real_directory(path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    reject_link_or_reparse(path, &meta)?;
    if !meta.is_dir() {
        return Err(format!("Path is not a real directory: {}", path.display()));
    }
    Ok(())
}

pub fn assert_real_file(path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    reject_link_or_reparse(path, &meta)?;
    if !meta.is_file() {
        return Err(format!("Path is not a regular file: {}", path.display()));
    }
    Ok(())
}

/// Open a regular file without following the final path component (Unix `O_NOFOLLOW`).
/// On Windows, opens with `FILE_FLAG_OPEN_REPARSE_POINT` and rejects reparse tags
/// on the opened handle so junctions/cloud placeholders cannot be followed.
pub fn open_regular_file_nofollow(path: &Path) -> Result<std::fs::File, String> {
    #[cfg(unix)]
    {
        use std::os::fd::FromRawFd;
        use std::os::unix::ffi::OsStrExt;

        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "Path contains interior null bytes.".to_string())?;
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        let fd = unsafe { libc::open(c_path.as_ptr(), flags) };
        if fd < 0 {
            return Err(format!(
                "Could not open {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err(format!("Path is not a regular file: {}", path.display()));
        }
        Ok(file)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::FromRawHandle;
        use std::ptr;
        use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "Could not open {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("Could not inspect {}: {err}", path.display()));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!(
                "Refusing symbolic link or reparse point: {}",
                path.display()
            ));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("Path is not a regular file: {}", path.display()));
        }
        Ok(unsafe { std::fs::File::from_raw_handle(handle as _) })
    }
    #[cfg(not(any(unix, windows)))]
    {
        assert_real_file(path)?;
        std::fs::File::open(path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "zinnia-path-safety-{tag}-{}",
            TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn assert_real_directory_accepts_plain_dirs() {
        let root = temp_root("dir");
        std::fs::create_dir_all(&root).expect("dir");
        assert_real_directory(&root).expect("plain directory");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn assert_real_file_accepts_plain_files() {
        let root = temp_root("file");
        std::fs::create_dir_all(&root).expect("dir");
        let file = root.join("plain.txt");
        std::fs::write(&file, b"ok").expect("write");
        assert_real_file(&file).expect("plain file");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn assert_real_directory_rejects_files() {
        let root = temp_root("not-dir");
        std::fs::create_dir_all(&root).expect("dir");
        let file = root.join("plain.txt");
        std::fs::write(&file, b"ok").expect("write");
        let err = assert_real_directory(&file).expect_err("file is not a directory");
        assert!(err.contains("not a real directory"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn assert_helpers_reject_symlinks() {
        use std::os::unix::fs::symlink;
        let root = temp_root("symlink");
        std::fs::create_dir_all(&root).expect("dir");
        let target_dir = root.join("real-dir");
        let target_file = root.join("real-file.txt");
        std::fs::create_dir_all(&target_dir).expect("target dir");
        std::fs::write(&target_file, b"ok").expect("target file");
        let link_dir = root.join("link-dir");
        let link_file = root.join("link-file");
        symlink(&target_dir, &link_dir).expect("dir symlink");
        symlink(&target_file, &link_file).expect("file symlink");

        let dir_err = assert_real_directory(&link_dir).expect_err("symlink dir");
        assert!(dir_err.contains("symbolic link") || dir_err.contains("reparse"));
        let file_err = assert_real_file(&link_file).expect_err("symlink file");
        assert!(file_err.contains("symbolic link") || file_err.contains("reparse"));

        let meta = std::fs::symlink_metadata(&link_file).expect("meta");
        assert!(is_link_or_reparse(&meta));
        assert!(reject_link_or_reparse(&link_file, &meta).is_err());
        let open_err = open_regular_file_nofollow(&link_file).expect_err("nofollow symlink");
        assert!(!open_err.is_empty());

        let plain = open_regular_file_nofollow(&target_file).expect("plain open");
        drop(plain);

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn open_regular_file_nofollow_opens_plain_windows_file() {
        let root = temp_root("win-plain");
        std::fs::create_dir_all(&root).expect("dir");
        let file = root.join("plain.txt");
        std::fs::write(&file, b"ok").expect("write");
        let opened = open_regular_file_nofollow(&file).expect("plain open");
        drop(opened);
        let dir_err = open_regular_file_nofollow(&root).expect_err("directory");
        assert!(dir_err.contains("not a regular file") || dir_err.contains("Could not open"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn open_regular_file_nofollow_rejects_windows_symlink() {
        use std::os::windows::fs::symlink_file;
        let root = temp_root("win-symlink");
        std::fs::create_dir_all(&root).expect("dir");
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        std::fs::write(&target, b"ok").expect("write");
        match symlink_file(&target, &link) {
            Ok(()) => {
                let err = open_regular_file_nofollow(&link).expect_err("symlink");
                assert!(
                    err.contains("reparse")
                        || err.contains("symbolic")
                        || err.contains("Could not")
                );
            }
            Err(_) => {
                // Symlink creation may require Developer Mode; skip quietly.
            }
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
