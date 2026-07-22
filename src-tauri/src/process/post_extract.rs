//! Post-extract trust/fidelity helpers (quarantine, execute bits).

use std::path::Path;

/// Outcome of platform-specific post-extract fixes after a successful promote.
#[derive(Default)]
pub(crate) struct PostExtractFixups {
    /// macOS: `.app` bundles found under the destination (quarantine cleared on those bundles).
    pub cleared_quarantine_apps: u32,
    /// Unix: regular files that received an execute bit from content heuristics.
    pub restored_execute_bits: u32,
}

pub(crate) fn apply_post_extract_fixups(root: &Path) -> PostExtractFixups {
    #[allow(unused_mut)]
    let mut out = PostExtractFixups::default();
    #[cfg(target_os = "macos")]
    {
        out.cleared_quarantine_apps = clear_quarantine_tree(root);
    }
    #[cfg(unix)]
    {
        out.restored_execute_bits = restore_unix_execute_bits(root);
    }
    let _ = root;
    out
}

/// Clear `com.apple.quarantine` on `.app` bundles only (not the whole tree).
///
/// Clearing quarantine on every extracted file is a known Gatekeeper-bypass
/// pattern used by some third-party unarchivers. Scoped clearing keeps app
/// bundles usable after a user-initiated extract without broadly skipping
/// first-run checks on scripts and documents.
#[cfg(target_os = "macos")]
fn clear_quarantine_tree(root: &Path) -> u32 {
    let mut cleared = 0u32;
    visit_app_bundles(root, &mut |app| match clear_quarantine_attr(app) {
        Ok(()) => cleared = cleared.saturating_add(1),
        Err(error) => {
            eprintln!("Could not clear quarantine on {}: {error}", app.display());
        }
    });
    cleared
}

#[cfg(target_os = "macos")]
fn clear_quarantine_attr(path: &Path) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xattr exited with {status}"))
    }
}

#[cfg(target_os = "macos")]
fn is_app_bundle_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|s| s.len() > 4 && s.to_ascii_lowercase().ends_with(".app"))
}

#[cfg(target_os = "macos")]
fn visit_app_bundles(path: &Path, on_app: &mut dyn FnMut(&Path)) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
        return;
    }
    if path.file_name().is_some_and(is_app_bundle_name) {
        on_app(path);
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        visit_app_bundles(&entry.path(), on_app);
    }
}

#[cfg(unix)]
const MAX_EXECUTE_SCAN_ENTRIES: u32 = 50_000;

/// Grant `u+x` to extracted binaries/scripts that 7-Zip left non-executable
/// (common with ZIP that lacked Unix mode bits).
#[cfg(unix)]
fn restore_unix_execute_bits(root: &Path) -> u32 {
    let mut restored = 0u32;
    let mut visited = 0u32;
    fn walk(path: &Path, restored: &mut u32, visited: &mut u32) {
        if *visited >= MAX_EXECUTE_SCAN_ENTRIES {
            return;
        }
        *visited = visited.saturating_add(1);
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return;
        };
        if crate::path_safety::is_link_or_reparse(&meta) {
            return;
        }
        if meta.is_dir() {
            let Ok(entries) = std::fs::read_dir(path) else {
                return;
            };
            for entry in entries.flatten() {
                walk(&entry.path(), restored, visited);
            }
            return;
        }
        if !meta.is_file() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if mode & 0o111 != 0 {
            return;
        }
        if !file_looks_executable(path) {
            return;
        }
        let mut perms = meta.permissions();
        perms.set_mode(mode | 0o111);
        if std::fs::set_permissions(path, perms).is_ok() {
            *restored = restored.saturating_add(1);
        }
    }
    walk(root, &mut restored, &mut visited);
    restored
}

#[cfg(unix)]
fn file_looks_executable(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.ends_with(".appimage")
        || name.ends_with(".command")
        || name.ends_with(".sh")
        || name.ends_with(".run")
        || name.ends_with(".bin")
    {
        return true;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut header = [0u8; 4];
    let Ok(n) = file.read(&mut header) else {
        return false;
    };
    if n >= 2 && header[0] == b'#' && header[1] == b'!' {
        return true;
    }
    if n >= 4 && header == *b"\x7fELF" {
        return true;
    }
    // Mach-O 32/64 and fat binaries.
    if n >= 4 {
        let magic = u32::from_be_bytes(header);
        if matches!(
            magic,
            0xfeedface | 0xcefaedfe | 0xfeedfacf | 0xcffaedfe | 0xcafebabe | 0xbebafeca
        ) {
            return true;
        }
    }
    false
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;

    #[test]
    fn detects_app_bundle_names() {
        assert!(is_app_bundle_name(std::ffi::OsStr::new("Demo.app")));
        assert!(is_app_bundle_name(std::ffi::OsStr::new("Demo.APP")));
        assert!(!is_app_bundle_name(std::ffi::OsStr::new("Demo.txt")));
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn restores_execute_bit_for_shebang_and_elf_magic() {
        let root = std::env::temp_dir().join(format!("zinnia-exec-fix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");

        let script = root.join("tool.sh");
        {
            let mut f = std::fs::File::create(&script).expect("create");
            f.write_all(b"#!/bin/sh\necho hi\n").expect("write");
        }
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&script, perms).unwrap();

        let elf = root.join("payload");
        {
            let mut f = std::fs::File::create(&elf).expect("create");
            f.write_all(b"\x7fELF\x02\x01").expect("write");
        }
        let mut perms = std::fs::metadata(&elf).unwrap().permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&elf, perms).unwrap();

        let text = root.join("readme.txt");
        std::fs::write(&text, b"hello").unwrap();

        let restored = restore_unix_execute_bits(&root);
        assert!(restored >= 2);
        assert!(std::fs::metadata(&script).unwrap().permissions().mode() & 0o111 != 0);
        assert!(std::fs::metadata(&elf).unwrap().permissions().mode() & 0o111 != 0);
        assert_eq!(
            std::fs::metadata(&text).unwrap().permissions().mode() & 0o111,
            0
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
