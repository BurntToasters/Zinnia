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
        return meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
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
        return Err(format!(
            "Path is not a real directory: {}",
            path.display()
        ));
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

        let _ = std::fs::remove_dir_all(root);
    }
}
