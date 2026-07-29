//! Shared path safety helpers (symlink / Windows reparse-point rejection).

use std::fs::Metadata;
use std::path::{Component, Path};

/// True when `candidate` is `root` or a descendant whose relative path uses only
/// normal components (no `..`, `.`, roots, or prefixes). Uses component-wise
/// matching, not string prefixing.
pub fn path_is_under_or_equal(root: &Path, candidate: &Path) -> bool {
    if candidate == root {
        return true;
    }
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

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
            "Choose the real path, not a symbolic link or reparse point: {}",
            path.display()
        ));
    }
    Ok(())
}

fn read_lexically_contained_relative_symlink(
    root: &Path,
    link_path: &Path,
) -> Result<std::path::PathBuf, String> {
    let target = std::fs::read_link(link_path).map_err(|e| e.to_string())?;
    if target.is_absolute() {
        return Err(format!(
            "Archive contains an absolute symbolic link: {}",
            link_path.display()
        ));
    }
    // Preserve the specific escape diagnostic for obvious lexical `..`
    // traversal. This is only an early classification check; canonicalization
    // below remains authoritative because ancestor symlinks can change how the
    // operating system resolves later `..` components.
    let link_parent = link_path.parent().unwrap_or(link_path);
    let relative_parent = link_parent.strip_prefix(root).map_err(|_| {
        format!(
            "Archive symbolic link escapes the extract root: {}",
            link_path.display()
        )
    })?;
    let mut lexical_depth = 0usize;
    for component in relative_parent.components().chain(target.components()) {
        match component {
            std::path::Component::Normal(_) => lexical_depth += 1,
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                lexical_depth = lexical_depth.checked_sub(1).ok_or_else(|| {
                    format!(
                        "Archive symbolic link escapes the extract root: {}",
                        link_path.display()
                    )
                })?;
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(format!(
                    "Archive contains an absolute symbolic link: {}",
                    link_path.display()
                ));
            }
        }
    }
    Ok(target)
}

fn canonical_root(root: &Path) -> Result<std::path::PathBuf, String> {
    root.canonicalize().map_err(|error| {
        format!(
            "Could not resolve the extraction root {}: {error}",
            root.display()
        )
    })
}

fn assert_resolved_target_within_root(
    canonical_root: &Path,
    link_path: &Path,
    resolved: &Path,
) -> Result<std::path::PathBuf, String> {
    let relative = resolved.strip_prefix(canonical_root).map_err(|_| {
        format!(
            "Archive symbolic link escapes the extract root: {}",
            link_path.display()
        )
    })?;
    Ok(relative.to_path_buf())
}

fn deepest_resolvable_ancestor(path: &Path) -> Result<std::path::PathBuf, String> {
    let mut candidate = path.to_path_buf();
    loop {
        match candidate.canonicalize() {
            Ok(resolved) => return Ok(resolved),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !candidate.pop() {
                    return Err(format!(
                        "Could not resolve any existing ancestor of {}",
                        path.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "Could not resolve an existing ancestor of {}: {error}",
                    path.display()
                ));
            }
        }
    }
}

/// Resolve a symlink only when its target is relative, exists, and stays under
/// `root` after the operating system resolves every intermediate symlink and
/// `..` component.
///
/// macOS `.app` / `.framework` bundles commonly use relative symlinks
/// (`Versions/Current` → `A`). Absolute, dangling, and escaping links stay
/// rejected.
pub(crate) fn resolve_relative_symlink_within_root(
    root: &Path,
    link_path: &Path,
) -> Result<std::path::PathBuf, String> {
    let target = read_lexically_contained_relative_symlink(root, link_path)?;
    let canonical_root = root.canonicalize().map_err(|error| {
        format!(
            "Could not resolve the extraction root {}: {error}",
            root.display()
        )
    })?;
    let resolved = link_path
        .parent()
        .unwrap_or(link_path)
        .join(target)
        .canonicalize()
        .map_err(|error| {
            format!(
                "Archive symbolic link target is missing or cannot be resolved safely: {} ({error})",
                link_path.display()
            )
        })?;
    let relative = assert_resolved_target_within_root(&canonical_root, link_path, &resolved)?;
    // Preserve caller's spelling of `root` (notably `/var` versus
    // `/private/var` on macOS) while returning the OS-resolved in-root target.
    Ok(root.join(relative))
}

/// During extraction, a valid symlink may appear before its target. The quota
/// walker never follows links, so allow only that temporary missing-target
/// state. Resolvable targets still receive the same OS-resolved containment
/// check, and final staged-tree validation remains strict.
pub(crate) fn assert_relative_symlink_during_write(
    root: &Path,
    link_path: &Path,
) -> Result<(), String> {
    let target = read_lexically_contained_relative_symlink(root, link_path)?;
    let canonical_root = canonical_root(root)?;
    let unresolved = link_path.parent().unwrap_or(link_path).join(target);
    match unresolved.canonicalize() {
        Ok(resolved) => {
            assert_resolved_target_within_root(&canonical_root, link_path, &resolved).map(|_| ())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let ancestor = deepest_resolvable_ancestor(&unresolved)?;
            assert_resolved_target_within_root(&canonical_root, link_path, &ancestor).map(|_| ())
        }
        Err(error) => Err(format!(
            "Archive symbolic link target cannot be resolved safely: {} ({error})",
            link_path.display()
        )),
    }
}

pub fn assert_relative_symlink_within_root(root: &Path, link_path: &Path) -> Result<(), String> {
    resolve_relative_symlink_within_root(root, link_path).map(|_| ())
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
        // O_NONBLOCK prevents `open` itself from blocking forever on a FIFO
        // with no writer (a same-user TOCTOU swap of the target between an
        // earlier `is_file()`-style check and this open could otherwise hang
        // every caller of this function indefinitely). It is cleared again
        // right after the metadata check confirms a regular file, so normal
        // reads from the returned handle behave exactly as before.
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
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
        let current_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if current_flags < 0
            || unsafe { libc::fcntl(fd, libc::F_SETFL, current_flags & !libc::O_NONBLOCK) } < 0
        {
            return Err(format!(
                "Could not clear O_NONBLOCK on {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(file)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };

        open_regular_file_nofollow_windows(
            path,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        assert_real_file(path)?;
        std::fs::File::open(path).map_err(|e| e.to_string())
    }
}

/// Open an archive input for snapshotting without following the final component.
///
/// Windows additionally denies write and delete sharing while this handle is
/// alive, so another process cannot modify, rename, or replace the archive while
/// its bytes are copied. Unix keeps the existing `O_NOFOLLOW` behavior; callers
/// still verify stable file identity before and after the copy.
pub fn open_regular_file_nofollow_for_snapshot(path: &Path) -> Result<std::fs::File, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        open_regular_file_nofollow_windows(path, FILE_SHARE_READ)
    }
    #[cfg(not(windows))]
    {
        open_regular_file_nofollow(path)
    }
}

#[cfg(windows)]
fn open_regular_file_nofollow_windows(
    path: &Path,
    share_mode: u32,
) -> Result<std::fs::File, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        OPEN_EXISTING,
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
            share_mode,
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
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
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
    fn path_is_under_or_equal_rejects_parent_dir_escape() {
        let root = std::path::Path::new("/tmp/zinnia-root");
        assert!(path_is_under_or_equal(root, root));
        assert!(path_is_under_or_equal(root, &root.join("nested/file.txt")));
        assert!(!path_is_under_or_equal(
            root,
            &root.join("nested").join("..").join("escape.txt")
        ));
        assert!(!path_is_under_or_equal(
            root,
            std::path::Path::new("/tmp/zinnia-root-extra/file.txt")
        ));
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
    fn snapshot_open_blocks_concurrent_write_and_rename() {
        let root = temp_root("win-snapshot-share");
        std::fs::create_dir_all(&root).expect("dir");
        let file = root.join("archive.7z");
        let renamed = root.join("renamed.7z");
        std::fs::write(&file, b"archive").expect("write");

        let snapshot_source =
            open_regular_file_nofollow_for_snapshot(&file).expect("snapshot open");
        let reader = std::fs::File::open(&file).expect("concurrent reader");
        assert!(std::fs::OpenOptions::new().write(true).open(&file).is_err());
        assert!(std::fs::rename(&file, &renamed).is_err());

        drop(reader);
        drop(snapshot_source);
        std::fs::rename(&file, &renamed).expect("rename after snapshot handle closes");
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

    #[cfg(unix)]
    #[test]
    fn relative_symlink_within_root_is_allowed() {
        use std::os::unix::fs::symlink;
        let root = temp_root("rel-link-ok");
        std::fs::create_dir_all(root.join("Versions/A")).expect("dir");
        let link = root.join("Versions/Current");
        symlink("A", &link).expect("symlink");
        assert_relative_symlink_within_root(&root, &link).expect("in-tree relative link");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_traversing_through_another_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = temp_root("rel-link-chain-escape");
        let outside = root.with_file_name(format!(
            "{}-outside",
            root.file_name().unwrap_or_default().to_string_lossy()
        ));
        std::fs::create_dir_all(&root).expect("dir");
        std::fs::create_dir_all(outside.join("child")).expect("outside child");
        std::fs::write(outside.join("secret"), b"outside").expect("outside file");
        symlink(&outside, root.join("escape_via")).expect("chain symlink");
        let link = root.join("chained");
        symlink("escape_via/child/../secret", &link).expect("chained target symlink");
        let error = assert_relative_symlink_within_root(&root, &link).expect_err("chained escape");
        assert!(error.contains("escapes the extract root"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_relative_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = temp_root("rel-link-dangling");
        std::fs::create_dir_all(&root).expect("dir");
        let link = root.join("dangling");
        symlink("missing", &link).expect("dangling symlink");
        let error = assert_relative_symlink_within_root(&root, &link).expect_err("dangling");
        assert!(error.contains("missing or cannot be resolved"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn in_progress_dangling_link_behind_escaping_ancestor_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = temp_root("rel-link-in-progress-escape");
        let outside = root.with_file_name(format!(
            "{}-outside",
            root.file_name().unwrap_or_default().to_string_lossy()
        ));
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&outside).expect("outside");
        symlink(&outside, root.join("escape_via")).expect("ancestor symlink");
        let link = root.join("pending");
        symlink("escape_via/missing-tail", &link).expect("pending symlink");

        let error =
            assert_relative_symlink_during_write(&root, &link).expect_err("escaping ancestor");
        assert!(error.contains("escapes the extract root"), "{error}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn absolute_and_escaping_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = temp_root("rel-link-bad");
        std::fs::create_dir_all(root.join("nested")).expect("dir");
        let absolute = root.join("abs");
        symlink("/tmp", &absolute).expect("absolute");
        let escape = root.join("nested/escape");
        symlink("../../outside", &escape).expect("escape");
        assert!(assert_relative_symlink_within_root(&root, &absolute)
            .expect_err("absolute")
            .contains("absolute"));
        assert!(assert_relative_symlink_within_root(&root, &escape)
            .expect_err("escape")
            .contains("escapes"));
        let _ = std::fs::remove_dir_all(root);
    }
}
