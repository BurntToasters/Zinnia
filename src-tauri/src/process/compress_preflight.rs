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
    C: Fn() -> bool + Sync,
{
    if paths.len() > 4096 {
        return Err("Too many compress inputs to probe.".to_string());
    }
    // Keep one bounded metadata worker set for the whole operation.  The
    // directory walk still consumes batches so budget accounting and result
    // ordering stay deterministic, but workers are not recreated for every
    // batch (or every directory).
    std::thread::scope(|scope| {
        let mut budget = ProbeBudget::new();
        let pool = MetadataProbePool::new(scope, &should_cancel, budget.deadline);
        let mut probe = CompressInputProbe::default();
        let mut seen_roots = std::collections::HashSet::new();
        for raw in paths {
            let path = PathBuf::from(raw);
            if !seen_roots.insert(path.clone()) {
                continue;
            }
            walk_path(&path, &mut probe, &mut budget, &should_cancel, &pool)?;
        }
        Ok(probe)
    })
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

struct PendingProbeEntry {
    path: PathBuf,
    is_root: bool,
    depth: usize,
    accounted: bool,
}

const METADATA_BATCH_SIZE: usize = 64;

#[cfg(test)]
static METADATA_WORKERS_CREATED: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

struct MetadataJob {
    index: usize,
    path: PathBuf,
    reply: std::sync::mpsc::Sender<(usize, Result<std::fs::Metadata, String>)>,
}

/// Operation-scoped metadata workers.  A queue/condition variable is used
/// instead of a new scoped thread group per directory batch.  The pool is
/// deliberately private to one probe operation so its cancellation callback
/// can remain borrowed and workers are joined by `thread::scope`.
struct MetadataProbePool {
    queue: std::sync::Arc<(
        std::sync::Mutex<std::collections::VecDeque<Option<MetadataJob>>>,
        std::sync::Condvar,
    )>,
    worker_count: usize,
    deadline: std::time::Instant,
}

impl MetadataProbePool {
    fn new<'scope, 'env, C>(
        scope: &'scope std::thread::Scope<'scope, 'env>,
        should_cancel: &'env C,
        deadline: std::time::Instant,
    ) -> Self
    where
        C: Fn() -> bool + Sync + 'env,
    {
        let worker_count = std::thread::available_parallelism()
            .map(|count| count.get().min(8))
            .unwrap_or(1)
            .max(1);
        let queue = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::VecDeque::<Option<MetadataJob>>::new()),
            std::sync::Condvar::new(),
        ));
        for _ in 0..worker_count {
            #[cfg(test)]
            METADATA_WORKERS_CREATED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let queue = std::sync::Arc::clone(&queue);
            scope.spawn(move || loop {
                let job = {
                    let (lock, wake) = &*queue;
                    let mut jobs = lock
                        .lock()
                        .expect("metadata probe worker queue lock poisoned");
                    loop {
                        if let Some(job) = jobs.pop_front() {
                            break job;
                        }
                        jobs = wake
                            .wait(jobs)
                            .expect("metadata probe worker queue lock poisoned");
                    }
                };
                let Some(job) = job else {
                    break;
                };
                let result = if should_cancel() {
                    Err("Compress input scan was cancelled.".to_string())
                } else if std::time::Instant::now() >= deadline {
                    Err("Compress input scan exceeded its 60-second safety deadline.".to_string())
                } else {
                    std::fs::symlink_metadata(&job.path).map_err(|error| {
                        format!(
                            "Unable to read compress input '{}': {error}",
                            job.path.display()
                        )
                    })
                };
                let _ = job.reply.send((job.index, result));
            });
        }
        Self {
            queue,
            worker_count,
            deadline,
        }
    }

    fn metadata_batch(&self, paths: &[PathBuf]) -> Result<Vec<std::fs::Metadata>, String> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        {
            let (lock, wake) = &*self.queue;
            let mut jobs = lock
                .lock()
                .map_err(|_| "Compress input metadata worker stopped unexpectedly.".to_string())?;
            for (index, path) in paths.iter().enumerate() {
                jobs.push_back(Some(MetadataJob {
                    index,
                    path: path.clone(),
                    reply: sender.clone(),
                }));
            }
            wake.notify_all();
        }
        drop(sender);

        let mut results = (0..paths.len())
            .map(|_| None)
            .collect::<Vec<Option<Result<std::fs::Metadata, String>>>>();
        for _ in 0..paths.len() {
            let (index, result) = receiver
                .recv()
                .map_err(|_| "Compress input metadata worker stopped unexpectedly.".to_string())?;
            results[index] = Some(result);
        }
        // The deadline is checked by workers before each syscall.  Check it
        // once more here so a batch that completed just as it expired cannot
        // extend the operation into the next directory.
        if std::time::Instant::now() >= self.deadline {
            return Err("Compress input scan exceeded its 60-second safety deadline.".to_string());
        }
        results
            .into_iter()
            .map(|result| result.expect("one metadata result per path"))
            .collect::<Result<Vec<_>, _>>()
    }
}

impl Drop for MetadataProbePool {
    fn drop(&mut self) {
        let (lock, wake) = &*self.queue;
        if let Ok(mut jobs) = lock.lock() {
            for _ in 0..self.worker_count {
                jobs.push_back(None);
            }
            wake.notify_all();
        }
    }
}

fn account_probe_entry<C>(
    path: &Path,
    depth: usize,
    budget: &mut ProbeBudget,
    should_cancel: &C,
) -> Result<(), String>
where
    C: Fn() -> bool + Sync,
{
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
    Ok(())
}

fn classify_link(
    path: &Path,
    is_root: bool,
    meta: &std::fs::Metadata,
    probe: &mut CompressInputProbe,
) -> bool {
    #[cfg(windows)]
    if crate::path_safety::is_link_or_reparse(meta) {
        if !is_root {
            if crate::path_safety::is_non_symlink_reparse(path, meta) {
                probe.nested_reparse_points = probe.nested_reparse_points.saturating_add(1);
            } else {
                probe.nested_symlinks = probe.nested_symlinks.saturating_add(1);
            }
            push_example(probe, path);
        }
        return true;
    }

    #[cfg(not(windows))]
    if meta.file_type().is_symlink() {
        if !is_root {
            probe.nested_symlinks = probe.nested_symlinks.saturating_add(1);
            push_example(probe, path);
        }
        return true;
    }

    false
}

fn walk_path<C>(
    root: &Path,
    probe: &mut CompressInputProbe,
    budget: &mut ProbeBudget,
    should_cancel: &C,
    metadata_pool: &MetadataProbePool,
) -> Result<(), String>
where
    C: Fn() -> bool + Sync,
{
    let mut pending = vec![PendingProbeEntry {
        path: root.to_path_buf(),
        is_root: true,
        depth: 0,
        accounted: false,
    }];
    while let Some(entry) = pending.pop() {
        let PendingProbeEntry {
            path,
            is_root,
            depth,
            accounted,
        } = entry;
        if !accounted {
            account_probe_entry(&path, depth, budget, should_cancel)?;
        }
        // A parallel batch only decides which child directories are worth
        // traversing. Re-read every queued directory before opening it so a
        // directory replaced by a symlink/reparse point cannot be traversed
        // using stale metadata from the batch.
        let meta = std::fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Unable to read compress input '{}': {error}",
                path.display()
            )
        })?;
        if classify_link(&path, is_root, &meta, probe) {
            continue;
        }
        if !meta.is_dir() {
            continue;
        }
        if path.file_name().is_some_and(is_app_bundle_name) {
            probe.app_bundles = probe.app_bundles.saturating_add(1);
            push_example(probe, &path);
        }
        let mut entries = std::fs::read_dir(&path)
            .map_err(|error| format!("Unable to read directory '{}': {error}", path.display()))?;
        loop {
            let mut children = Vec::with_capacity(METADATA_BATCH_SIZE);
            for _ in 0..METADATA_BATCH_SIZE {
                let Some(entry) = entries.next() else { break };
                children.push(
                    entry
                        .map_err(|error| {
                            format!("Unable to read directory '{}': {error}", path.display())
                        })?
                        .path(),
                );
            }
            if children.is_empty() {
                break;
            }
            for child in &children {
                account_probe_entry(child, depth.saturating_add(1), budget, should_cancel)?;
            }
            let metadata = metadata_pool.metadata_batch(&children)?;
            for (child, metadata) in children.into_iter().zip(metadata) {
                if classify_link(&child, false, &metadata, probe) {
                    continue;
                }
                if metadata.is_dir() {
                    pending.push(PendingProbeEntry {
                        path: child,
                        is_root: false,
                        depth: depth.saturating_add(1),
                        accounted: true,
                    });
                }
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
    C: Fn() -> bool + Sync,
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
    use super::*;

    static PROBE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(unix)]
    #[test]
    fn counts_nested_symlinks_and_apps() {
        let _test_lock = PROBE_TEST_LOCK.lock().unwrap();
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

    #[test]
    fn backend_compress_guard_walks_missing_inputs() {
        let _test_lock = PROBE_TEST_LOCK.lock().unwrap();
        let missing = std::env::temp_dir().join("zinnia-definitely-missing-compress-input");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(
            assert_no_nested_reparse_for_compress(&[missing.to_string_lossy().to_string()])
                .expect_err("global traversal must validate every platform")
                .contains("Unable to read compress input")
        );
    }

    #[test]
    fn metadata_workers_are_bounded_per_probe_operation() {
        let _test_lock = PROBE_TEST_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "zinnia-probe-many-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..(METADATA_BATCH_SIZE * 5 + 1) {
            std::fs::write(root.join(format!("entry-{index}")), b"x").unwrap();
        }
        let before = METADATA_WORKERS_CREATED.load(std::sync::atomic::Ordering::Relaxed);
        probe_compress_input_paths(&[root.to_string_lossy().to_string()]).unwrap();
        let created = METADATA_WORKERS_CREATED
            .load(std::sync::atomic::Ordering::Relaxed)
            .saturating_sub(before);
        let max_workers = std::thread::available_parallelism()
            .map(|count| count.get().min(8))
            .unwrap_or(1)
            .max(1);
        assert_eq!(
            created, max_workers,
            "one bounded metadata worker pool must serve all batches"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn backend_compress_guard_rejects_nested_junction() {
        let _test_lock = PROBE_TEST_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "zinnia-probe-junc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("real");
        let nested = root.join("nested");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let junction = nested.join("cloud");
        if let Err(error) = crate::path_safety::try_create_directory_junction(&junction, &real) {
            let _ = std::fs::remove_dir_all(&root);
            eprintln!("skipping backend_compress_guard_rejects_nested_junction: {error}");
            return;
        }
        let meta = std::fs::symlink_metadata(&junction).expect("junction metadata");
        assert!(
            crate::path_safety::is_link_or_reparse(&meta),
            "mklink /J must create a reparse point"
        );
        assert!(
            crate::path_safety::is_non_symlink_reparse(&junction, &meta),
            "directory junctions must not be classified as NTFS symbolic links"
        );

        let error = assert_no_nested_reparse_for_compress(&[root.to_string_lossy().to_string()])
            .expect_err("nested junction must fail closed");
        assert!(
            error.contains("reparse point"),
            "unexpected rejection: {error}"
        );

        let _ = std::fs::remove_dir(&junction);
        let _ = std::fs::remove_dir_all(&root);
    }
}
