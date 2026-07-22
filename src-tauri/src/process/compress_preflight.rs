//! Compress-input tree probes (symlinks, app bundles, Windows cloud/junction reparse).

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_WALK_ENTRIES: u32 = 40_000;
const MAX_EXAMPLES: usize = 4;

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
    let mut visited = 0u32;
    let mut hit_limit = false;
    for raw in paths {
        if raw.contains('*') || raw.contains('?') {
            continue;
        }
        let path = PathBuf::from(raw);
        walk_path(&path, &mut probe, &mut visited, true, &mut hit_limit)?;
        if hit_limit {
            break;
        }
    }
    if hit_limit {
        return Err(format!(
            "Compress input tree is too large to scan completely (>{MAX_WALK_ENTRIES} entries). Narrow the selection or archive a smaller folder."
        ));
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

fn walk_path(
    path: &Path,
    probe: &mut CompressInputProbe,
    visited: &mut u32,
    is_root: bool,
    hit_limit: &mut bool,
) -> Result<(), String> {
    if *visited >= MAX_WALK_ENTRIES {
        *hit_limit = true;
        return Ok(());
    }
    *visited = visited.saturating_add(1);

    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Unable to read compress input '{}': {error}",
                path.display()
            ));
        }
    };

    if meta.file_type().is_symlink() {
        if !is_root {
            probe.nested_symlinks = probe.nested_symlinks.saturating_add(1);
            push_example(probe, path);
        }
        return Ok(());
    }

    #[cfg(windows)]
    if crate::path_safety::is_link_or_reparse(&meta) {
        // Non-symlink reparse (junctions, OneDrive placeholders, etc.).
        if !is_root {
            probe.nested_reparse_points = probe.nested_reparse_points.saturating_add(1);
            push_example(probe, path);
        }
        return Ok(());
    }

    if meta.is_dir() {
        if path.file_name().is_some_and(is_app_bundle_name) {
            probe.app_bundles = probe.app_bundles.saturating_add(1);
            push_example(probe, path);
        }
        let entries = std::fs::read_dir(path).map_err(|e| {
            format!(
                "Unable to read directory '{}': {e}",
                path.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            walk_path(&entry.path(), probe, visited, false, hit_limit)?;
            if *hit_limit {
                break;
            }
        }
    }
    Ok(())
}

/// Fail closed when compress trees contain Windows cloud/junction reparse points.
pub fn assert_no_nested_reparse_for_compress(paths: &[String]) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn counts_nested_symlinks_and_apps() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "zinnia-probe-{}",
            std::process::id()
        ));
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
}
