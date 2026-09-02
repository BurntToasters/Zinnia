//! Compress-input tree probes (symlinks, app bundles, Windows cloud/junction reparse).

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_EXAMPLES: usize = 4;
const MAX_PROBE_ENTRIES: u64 = 1_000_000;
const MAX_PROBE_PATH_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROBE_DEPTH: usize = 256;
const MAX_PROBE_DURATION: std::time::Duration = std::time::Duration::from_secs(60);

struct ProbeBudget {
    entries: u64,
    path_bytes: u64,
    deadline: std::time::Instant,
}

impl ProbeBudget {
    fn new() -> Self {
        Self {
            entries: 0,
            path_bytes: 0,
            deadline: std::time::Instant::now() + MAX_PROBE_DURATION,
        }
    }
}

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
    probe_compress_input_paths_with_cancel(paths, || false)
}

pub fn probe_compress_input_paths_with_cancel<C>(
    paths: &[String],
    should_cancel: C,
) -> Result<CompressInputProbe, String>
where
    C: Fn() -> bool,
{
    if paths.len() > 4096 {
        return Err("Too many compress inputs to probe.".to_string());
    }
    let mut probe = CompressInputProbe::default();
    let mut budget = ProbeBudget::new();
    let mut seen_roots = std::collections::HashSet::new();
    for raw in paths {
        let path = PathBuf::from(raw);
        if !seen_roots.insert(path.clone()) {
            continue;
        }
        walk_path(&path, &mut probe, &mut budget, &should_cancel)?;
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

fn walk_path<C>(
    root: &Path,
    probe: &mut CompressInputProbe,
    budget: &mut ProbeBudget,
    should_cancel: &C,
) -> Result<(), String>
where
    C: Fn() -> bool,
{
    let mut pending = vec![(root.to_path_buf(), true, 0usize)];
    while let Some((path, is_root, depth)) = pending.pop() {
        if should_cancel() {
            return Err("Compress input scan was cancelled.".to_string());
        }
        if std::time::Instant::now() >= budget.deadline {
            return Err("Compress input scan exceeded its 60-second safety deadline.".to_string());
        }
        budget.entries = budget.entries.saturating_add(1);
        if budget.entries > MAX_PROBE_ENTRIES {
            return Err(format!(
                "Compress input scan exceeded the safety limit of {MAX_PROBE_ENTRIES} entries across all selected roots. Select smaller folders."
            ));
        }
        budget.path_bytes = budget
            .path_bytes
            .saturating_add(path.as_os_str().as_encoded_bytes().len() as u64);
        if budget.path_bytes > MAX_PROBE_PATH_BYTES {
            return Err(format!(
                "Compress input scan exceeded its {} MiB aggregate path-name safety limit.",
                MAX_PROBE_PATH_BYTES / (1024 * 1024)
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
                if should_cancel() {
                    return Err("Compress input scan was cancelled.".to_string());
                }
                if std::time::Instant::now() >= budget.deadline {
                    return Err(
                        "Compress input scan exceeded its 60-second safety deadline.".to_string(),
                    );
                }
                pending.push((entry.map_err(|e| e.to_string())?.path(), false, depth + 1));
            }
        }
    }
    Ok(())
}

/// Enforce one bounded, cancellable traversal across every selected root. On
/// Windows, nested non-symlink reparse points additionally fail closed.
pub fn assert_compress_inputs_safe_with_cancel<C>(
    paths: &[String],
    should_cancel: C,
) -> Result<(), String>
where
    C: Fn() -> bool,
{
    let probe = probe_compress_input_paths_with_cancel(paths, should_cancel)?;
    #[cfg(windows)]
    if probe.nested_reparse_points != 0 {
        let sample = probe
            .examples
            .first()
            .cloned()
            .unwrap_or_else(|| "(path omitted)".to_string());
        return Err(format!(
            "Compress inputs contain a Windows reparse point (junction or cloud placeholder) that is not a symbolic link: {sample}. Copy the real files locally, or remove the reparse entry, then try again."
        ));
    }
    #[cfg(not(windows))]
    let _ = probe;
    Ok(())
}

/// Compatibility wrapper used by focused platform tests.
#[cfg(test)]
pub fn assert_no_nested_reparse_for_compress(paths: &[String]) -> Result<(), String> {
    assert_compress_inputs_safe_with_cancel(paths, || false)
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
    fn backend_compress_guard_walks_non_windows_inputs() {
        assert!(
            assert_no_nested_reparse_for_compress(&["/definitely/missing".to_string()])
                .expect_err("global traversal must validate every platform")
                .contains("Unable to read compress input")
        );
    }
}
