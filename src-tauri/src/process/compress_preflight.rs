//! Compress-input tree probes (symlinks, app bundles, Windows cloud/junction reparse).

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_EXAMPLES: usize = 4;
const MAX_PROBE_ENTRIES: u64 = 1_000_000;
const MAX_PROBE_DEPTH: usize = 256;

#[derive(Default, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompressInputProbe {
    pub nested_symlinks: u32,
    pub app_bundles: u32,
    pub nested_reparse_points: u32,
    pub examples: Vec<String>,
}

/// Walk selected compress inputs (files/folders). Top-level symlink inputs are
/// rejected elsewhere; this finds nested links and Windows non-symlink reparse.
pub fn probe_compress_input_paths(paths: &[String]) -> Result<CompressInputProbe, String> {
    if paths.len() > 4096 {
        return Err("Too many compress inputs to probe.".to_string());
    }
    let mut probe = CompressInputProbe::default();
    for raw in paths {
        let path = PathBuf::from(raw);
        walk_path(&path, &mut probe)?;
    }
    Ok(probe)
}

fn push_example(probe: &mut CompressInputProbe, path: &Path) {
    if probe.examples.len() >= MAX_EXAMPLES {
        return;
    }
    let displayed = path.to_string_lossy().to_string();
    if !probe.examples.iter().any(|e| e == &displayed) {
        probe.examples.push(displayed);
    }
}

fn is_app_bundle_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|s| s.len() > 4 && s.to_ascii_lowercase().ends_with(".app"))
}

fn walk_path(root: &Path, probe: &mut CompressInputProbe) -> Result<(), String> {
    let mut pending = vec![(root.to_path_buf(), true, 0usize)];
    let mut entries = 0u64;
    while let Some((path, is_root, depth)) = pending.pop() {
        entries = entries.saturating_add(1);
        if entries > MAX_PROBE_ENTRIES {
            return Err(format!(
                "Compress input scan exceeded the safety limit of {MAX_PROBE_ENTRIES} entries. Select smaller folders."
            ));
        }
        if depth > MAX_PROBE_DEPTH {
            return Err(format!(
                "Compress input scan exceeded the maximum folder depth of {MAX_PROBE_DEPTH}."
            ));
        }
        let meta = std::fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Unable to read compress input '{}': {error}",
                path.display()
            )
        })?;

        if meta.file_type().is_symlink() {
            if !is_root {
                probe.nested_symlinks = probe.nested_symlinks.saturating_add(1);
                push_example(probe, &path);
            }
            continue;
        }

        #[cfg(windows)]
        if crate::path_safety::is_link_or_reparse(&meta) {
            // Non-symlink reparse (junctions, OneDrive placeholders, etc.).
            if !is_root {
                probe.nested_reparse_points = probe.nested_reparse_points.saturating_add(1);
                push_example(probe, &path);
            }
            continue;
        }

        if meta.is_dir() {
            if path.file_name().is_some_and(is_app_bundle_name) {
                probe.app_bundles = probe.app_bundles.saturating_add(1);
                push_example(probe, &path);
            }
            let entries = std::fs::read_dir(&path)
                .map_err(|e| format!("Unable to read directory '{}': {e}", path.display()))?;
            for entry in entries {
                pending.push((entry.map_err(|e| e.to_string())?.path(), false, depth + 1));
            }
        }
    }
    Ok(())
}

/// Fail closed when compress trees contain Windows cloud/junction reparse points.
pub fn assert_no_nested_reparse_for_compress(paths: &[String]) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = paths;
        Ok(())
    }
    #[cfg(windows)]
    {
        let probe = probe_compress_input_paths(paths)?;
        if probe.nested_reparse_points == 0 {
            return Ok(());
        }
        let sample = probe
            .examples
            .first()
            .cloned()
            .unwrap_or_else(|| "(path omitted)".to_string());
        Err(format!(
            "Compress inputs contain a Windows reparse point (junction or cloud placeholder) that is not a symbolic link: {sample}. Copy the real files locally, or remove the reparse entry, then try again."
        ))
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    #[test]
    fn counts_nested_symlinks_and_apps() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("zinnia-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let app = root.join("Demo.app/Contents");
        std::fs::create_dir_all(&app).unwrap();
        symlink("A", root.join("Demo.app/Contents/Current")).unwrap();
        std::fs::create_dir_all(root.join("plain")).unwrap();

        let probe = probe_compress_input_paths(&[root.to_string_lossy().to_string()]).unwrap();
        assert!(probe.app_bundles >= 1);
        assert!(probe.nested_symlinks >= 1);
        assert_eq!(probe.nested_reparse_points, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(windows))]
    #[test]
    fn backend_reparse_guard_does_not_walk_non_windows_inputs() {
        assert_no_nested_reparse_for_compress(&["/definitely/missing".to_string()])
            .expect("Windows-only guard must be a no-op");
    }
}
