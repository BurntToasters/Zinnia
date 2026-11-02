//! Stable archive-input snapshots shared by extraction preflight and 7-Zip.

mod copy;
mod identity;
mod motw;
mod volumes;

pub(crate) use copy::SnapshotStrategy;
pub(crate) use identity::ArchiveFileIdentity;
pub(crate) use identity::{
    archive_file_identity, archive_identity_token, archive_identity_token_from_open_file,
};
#[cfg(windows)]
pub(crate) use motw::{copy_windows_zone_identifier, copy_windows_zone_identifier_with_identity};
#[cfg(test)]
pub(crate) use volumes::archive_input_family;
pub(crate) use volumes::assert_archive_identity_unchanged;
#[cfg(windows)]
type WindowsSnapshotHandle = (std::path::PathBuf, std::sync::Arc<std::fs::File>);

#[cfg(windows)]
type WindowsSnapshotRegistry =
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Vec<WindowsSnapshotHandle>>>;

#[cfg(windows)]
static WINDOWS_SNAPSHOT_HANDLES: std::sync::OnceLock<WindowsSnapshotRegistry> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn windows_snapshot_handles() -> &'static WindowsSnapshotRegistry {
    WINDOWS_SNAPSHOT_HANDLES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(windows)]
pub(crate) fn release_snapshot_handles(stage: &std::path::Path) {
    if let Ok(mut handles) = windows_snapshot_handles().lock() {
        handles.remove(stage);
    }
}

#[cfg(windows)]
pub(super) fn archive_identity_from_snapshot_handle(
    path: &std::path::Path,
) -> Option<identity::ArchiveFileIdentity> {
    let stage = path.parent()?;
    let handles = windows_snapshot_handles().lock().ok()?;
    handles
        .get(stage)?
        .iter()
        .find(|(snapshot, _)| snapshot == path)
        .and_then(|(_, file)| identity::archive_file_identity_from_open_file(path, file).ok())
}

#[cfg(not(windows))]
pub(super) fn archive_identity_from_snapshot_handle(
    _path: &std::path::Path,
) -> Option<identity::ArchiveFileIdentity> {
    None
}

#[cfg(not(windows))]
pub(crate) fn release_snapshot_handles(_stage: &std::path::Path) {}
#[derive(Debug)]
pub(super) struct StagedArchiveInput {
    pub(super) path: std::path::PathBuf,
    pub(super) stage_identity: super::journal::FileIdentity,
    pub(super) total_len: u64,
    pub(super) snapshot_strategy: copy::SnapshotStrategy,
}

#[cfg(test)]
pub(super) fn stage_extract_input(
    archive: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
    expected_identity: Option<&str>,
) -> Result<StagedArchiveInput, String> {
    stage_extract_input_with_cancel(archive, cache_dir, expected_identity, || false)
}

pub(super) fn stage_extract_input_with_cancel<C>(
    archive: &std::path::Path,
    cache_dir: Option<&std::path::Path>,
    expected_identity: Option<&str>,
    should_cancel: C,
) -> Result<StagedArchiveInput, String>
where
    C: Fn() -> bool,
{
    let archive = crate::path_safety::resolve_regular_file_input(archive)?;
    let initial_token = identity::archive_identity_token(&archive)?;
    if expected_identity.is_some_and(|expected| expected != initial_token) {
        return Err(
            "Archive changed after it was browsed; review the new contents before extracting."
                .to_string(),
        );
    }
    if let Some(cache) = cache_dir {
        std::fs::create_dir_all(cache)
            .map_err(|error| format!("Could not create archive snapshot cache: {error}"))?;
    }
    let sources = volumes::archive_input_family(&archive)?;
    let mut inputs = Vec::with_capacity(sources.len());
    let mut total_len = 0u64;
    for source in sources {
        let identity = identity::archive_file_identity(&source)?;
        total_len = total_len
            .checked_add(identity.len)
            .ok_or_else(|| "Archive volume family size overflowed.".to_string())?;
        inputs.push((source, identity));
    }
    // Prefer a private sibling of the archive. That keeps snapshots on the
    // source filesystem, enabling APFS/Btrfs/XFS CoW and avoiding a mandatory
    // full copy onto the system/app-cache disk. Read-only source locations fall
    // back to app cache.
    let created_stage = match super::create_private_stage_dir(&archive, "input", cache_dir) {
        Ok(stage) => stage,
        Err(source_error) => {
            if super::staging::preparation_error_requires_recovery(&source_error) {
                return Err(source_error);
            }
            let Some(cache) = cache_dir else {
                return Err(source_error);
            };
            let cache_anchor = cache.join(archive.file_name().unwrap_or_default());
            super::create_private_stage_dir(&cache_anchor, "input", cache_dir).map_err(
                |cache_error| {
                    format!(
                        "Could not create archive snapshot beside the input ({source_error}) or in app cache ({cache_error})."
                    )
                },
            )?
        }
    };
    let stage = created_stage.path;
    let stage_identity = created_stage.identity;
    let cleanup_identity = stage_identity.clone();
    #[cfg(windows)]
    let mut hardlink_handles = Vec::new();
    #[cfg(windows)]
    let mut used_hardlink = false;
    #[cfg(not(windows))]
    let used_hardlink = false;
    let mut snapshot_strategy: Option<copy::SnapshotStrategy> = None;
    let result = (|| {
        for (source, expected) in inputs {
            if should_cancel() {
                return Err("Archive operation was cancelled during input snapshot.".to_string());
            }
            let destination = stage.join(
                source
                    .file_name()
                    .ok_or_else(|| "Archive volume has no file name.".to_string())?,
            );
            let mut source_file =
                crate::path_safety::open_regular_file_nofollow_for_snapshot(&source).map_err(
                    |error| format!("Could not open archive input {}: {error}", source.display()),
                )?;
            let opened_identity =
                identity::archive_file_identity_from_open_file(&source, &source_file)?;
            if opened_identity != expected {
                return Err(
                    "Archive changed before its private snapshot could be created; extraction was cancelled."
                        .to_string(),
                );
            }
            #[cfg(windows)]
            let hardlinked = copy::try_hardlink_snapshot_file(&source, &destination)?;
            #[cfg(not(windows))]
            let hardlinked = false;
            let strategy = if hardlinked {
                copy::SnapshotStrategy::WindowsHardlink
            } else {
                copy::copy_archive_snapshot_file(
                    &mut source_file,
                    &source,
                    &destination,
                    &should_cancel,
                )
                .map_err(|error| {
                    format!(
                        "Could not snapshot archive input {}: {error}",
                        source.display()
                    )
                })?
            };
            snapshot_strategy = Some(match snapshot_strategy {
                Some(previous) => previous.merge(strategy),
                None => strategy,
            });
            let copied_identity =
                identity::archive_file_identity_from_open_file(&source, &source_file)?;
            if copied_identity != expected {
                return Err(
                    "Archive changed while its private snapshot was being created; extraction was cancelled."
                        .to_string(),
                );
            }
            if !hardlinked {
                volumes::assert_archive_identity_unchanged(&source, &expected)?;
            }
            #[cfg(windows)]
            if hardlinked {
                used_hardlink = true;
                hardlink_handles.push((destination.clone(), std::sync::Arc::new(source_file)));
            }
        }
        if !used_hardlink && identity::archive_identity_token(&archive)? != initial_token {
            return Err(
                "Archive changed while its private snapshot was being created; extraction was cancelled."
                    .to_string(),
            );
        }
        #[cfg(windows)]
        if !hardlink_handles.is_empty() {
            if let Ok(mut handles) = windows_snapshot_handles().lock() {
                handles.insert(stage.clone(), hardlink_handles);
            } else {
                return Err("Windows snapshot handle registry is unavailable.".to_string());
            }
        }
        Ok(StagedArchiveInput {
            path: stage.join(
                archive
                    .file_name()
                    .ok_or_else(|| "Archive input has no file name.".to_string())?,
            ),
            stage_identity,
            total_len,
            snapshot_strategy: snapshot_strategy.unwrap_or(copy::SnapshotStrategy::ByteCopy),
        })
    })();
    match result {
        Ok(staged) => Ok(staged),
        Err(operation_error) => {
            // The handle registry is populated just before the staged-input
            // value is returned. If constructing that value ever fails, this
            // path runs before a CleanupPlan/SnapshotHandleGuard exists; do
            // not leave the source archive write/delete-locked while the
            // private stage is rolled back.
            #[cfg(windows)]
            release_snapshot_handles(&stage);
            let cleanup_result =
                super::journal::remove_directory_if_matches(&stage, &cleanup_identity).and_then(
                    |()| {
                        if let Some(cache) = cache_dir {
                            super::unregister_pending_stage(cache, &stage)
                        } else {
                            Ok(())
                        }
                    },
                );
            match cleanup_result {
                Ok(()) => Err(operation_error),
                Err(cleanup_error) => Err(super::staging::preparation_cleanup_failed(
                    operation_error,
                    cleanup_error,
                )),
            }
        }
    }
}

#[cfg(test)]
mod strategy_tests {
    use super::SnapshotStrategy;

    #[test]
    fn snapshot_strategy_labels_and_mixed_classification_are_stable() {
        assert_eq!(
            SnapshotStrategy::WindowsHardlink.label(),
            "windows-hardlink-lock"
        );
        assert_eq!(SnapshotStrategy::CopyFile2.label(), "windows-copyfile2");
        assert_eq!(SnapshotStrategy::CowClone.label(), "cow-clone");
        assert_eq!(SnapshotStrategy::ByteCopy.label(), "cancellable-byte-copy");
        assert_eq!(
            SnapshotStrategy::CowClone.merge(SnapshotStrategy::ByteCopy),
            SnapshotStrategy::Mixed
        );
        assert_eq!(
            SnapshotStrategy::Mixed.merge(SnapshotStrategy::ByteCopy),
            SnapshotStrategy::Mixed
        );
    }
}

#[cfg(all(test, windows))]
mod windows_snapshot_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);

    struct SnapshotTestGuard {
        root: std::path::PathBuf,
        stage: Option<std::path::PathBuf>,
    }

    impl SnapshotTestGuard {
        fn new(root: std::path::PathBuf) -> Self {
            Self { root, stage: None }
        }

        fn retain_stage(&mut self, stage: &std::path::Path) {
            self.stage = Some(stage.to_path_buf());
        }
    }

    impl Drop for SnapshotTestGuard {
        fn drop(&mut self) {
            // Each test owns a distinct stage key. Release its entry before
            // removing the root so a parallel test cannot inherit a source
            // lock from this test's registry entry.
            if let Some(stage) = self.stage.take() {
                release_snapshot_handles(&stage);
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn test_root(prefix: &str) -> std::path::PathBuf {
        loop {
            let suffix = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("{prefix}-{}-{suffix}", std::process::id()));
            match std::fs::create_dir(&root) {
                Ok(()) => return root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create Windows snapshot test directory: {error}"),
            }
        }
    }

    fn zone_identifier_path(path: &std::path::Path) -> std::path::PathBuf {
        let mut stream = path.as_os_str().to_os_string();
        stream.push(":Zone.Identifier");
        stream.into()
    }

    fn hardlink_snapshot_or_skip(
    ) -> Option<(SnapshotTestGuard, StagedArchiveInput, std::path::PathBuf)> {
        let root = test_root("zinnia-windows-hardlink-snapshot");
        let mut cleanup = SnapshotTestGuard::new(root.clone());
        let source = root.join("archive.7z");
        std::fs::write(&source, b"archive payload").expect("archive");

        // Probe once before staging. A network share or a filesystem without
        // hard-link support is a valid deployment, so skip the hard-link-only
        // assertions there instead of making the test environment-dependent.
        let probe = root.join("hardlink-probe.7z");
        if !copy::try_hardlink_snapshot_file(&source, &probe).expect("hard-link probe") {
            eprintln!("skipping Windows hard-link snapshot test: hard links unavailable");
            return None;
        }
        std::fs::remove_file(&probe).expect("remove hard-link probe");

        let staged = super::stage_extract_input(&source, None, None).expect("snapshot archive");
        assert_eq!(
            staged.snapshot_strategy,
            copy::SnapshotStrategy::WindowsHardlink,
            "hard-link support probe succeeded but staging selected another strategy"
        );
        let stage = staged.path.parent().expect("snapshot stage");
        cleanup.retain_stage(stage);
        Some((cleanup, staged, source))
    }

    #[test]
    fn windows_hardlink_strategy_registers_snapshot_identity() {
        let Some((_cleanup, staged, _source)) = hardlink_snapshot_or_skip() else {
            return;
        };

        let registered = super::archive_identity_from_snapshot_handle(&staged.path)
            .expect("hard-link snapshot identity must be registered");
        let opened = crate::path_safety::open_regular_file_nofollow_for_snapshot(&staged.path)
            .expect("open staged hard-link");
        let direct = archive_file_identity_from_open_file(&staged.path, &opened)
            .expect("read staged hard-link identity");
        assert_eq!(registered, direct);
    }

    #[test]
    fn windows_hardlink_handle_blocks_source_mutation_until_release() {
        let Some((mut cleanup, staged, source)) = hardlink_snapshot_or_skip() else {
            return;
        };
        let stage = staged.path.parent().expect("snapshot stage");
        let renamed = source.with_file_name("renamed.7z");

        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&source)
                .is_err(),
            "held snapshot handle must deny source writes"
        );
        assert!(
            std::fs::rename(&source, &renamed).is_err(),
            "held snapshot handle must deny source renames"
        );
        assert!(
            std::fs::remove_file(&source).is_err(),
            "held snapshot handle must deny source deletion"
        );

        release_snapshot_handles(stage);
        assert!(
            super::archive_identity_from_snapshot_handle(&staged.path).is_none(),
            "released stage must be removed from the handle registry"
        );
        std::fs::write(&source, b"mutated after release").expect("write after release");
        std::fs::rename(&source, &renamed).expect("rename after release");
        std::fs::remove_file(&renamed).expect("delete after release");
        cleanup.stage = None;
        std::fs::remove_dir_all(stage).expect("remove released snapshot stage");
    }

    #[test]
    fn windows_hardlink_unavailable_uses_copy_fallback() {
        let root = test_root("zinnia-windows-hardlink-fallback");
        let cleanup = SnapshotTestGuard::new(root.clone());
        let source = root.join("archive.7z");
        let destination = root.join("snapshot.7z");
        std::fs::write(&source, b"archive payload").expect("archive");
        let zone_contents = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        let mut zone_file = match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(zone_identifier_path(&source))
        {
            Ok(file) => file,
            Err(error) => {
                eprintln!("skipping windows_hardlink_unavailable_uses_copy_fallback: {error}");
                return;
            }
        };
        use std::io::Write as _;
        zone_file
            .write_all(zone_contents)
            .expect("write source Zone.Identifier");
        zone_file.sync_all().expect("sync source Zone.Identifier");
        drop(zone_file);

        // An existing destination directory makes hard-link creation fail
        // deterministically without relying on a second volume or network
        // share. Remove it, then exercise the copy path used after that false
        // hard-link result.
        std::fs::create_dir(&destination).expect("hard-link fallback blocker");
        assert!(!copy::try_hardlink_snapshot_file(&source, &destination)
            .expect("hard-link fallback probe"));
        std::fs::remove_dir(&destination).expect("remove hard-link fallback blocker");

        let mut source_file = crate::path_safety::open_regular_file_nofollow_for_snapshot(&source)
            .expect("open source for copy fallback");
        let strategy =
            copy::copy_archive_snapshot_file(&mut source_file, &source, &destination, &|| false)
                .expect("copy fallback");
        assert!(
            matches!(
                strategy,
                copy::SnapshotStrategy::CopyFile2 | copy::SnapshotStrategy::ByteCopy
            ),
            "copy fallback selected unexpected strategy: {strategy:?}"
        );
        assert_eq!(
            std::fs::read(&destination).expect("fallback snapshot"),
            b"archive payload"
        );
        assert_eq!(
            std::fs::read(zone_identifier_path(&destination))
                .expect("fallback snapshot Zone.Identifier"),
            zone_contents
        );
        drop(source_file);
        drop(cleanup);
        assert!(
            !root.exists(),
            "copy fallback test cleanup must remove the test root"
        );
    }

    #[test]
    fn windows_byte_copy_zone_identifier_helper_preserves_valid_stream() {
        let root = test_root("zinnia-windows-byte-copy-motw");
        let cleanup = SnapshotTestGuard::new(root.clone());
        let source = root.join("archive.7z");
        let destination = root.join("snapshot.7z");
        std::fs::write(&source, b"archive payload").expect("archive");
        std::fs::write(&destination, b"snapshot payload").expect("snapshot");

        let zone_contents = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        let mut zone_file = match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(zone_identifier_path(&source))
        {
            Ok(file) => file,
            Err(error) => {
                eprintln!(
                    "skipping windows_byte_copy_zone_identifier_helper_preserves_valid_stream: {error}"
                );
                return;
            }
        };
        use std::io::Write as _;
        zone_file
            .write_all(zone_contents)
            .expect("write source Zone.Identifier");
        zone_file.sync_all().expect("sync source Zone.Identifier");
        drop(zone_file);

        motw::copy_windows_zone_identifier(&source, &destination).expect("copy Zone.Identifier");
        assert_eq!(
            std::fs::read(zone_identifier_path(&destination))
                .expect("manual byte-copy Zone.Identifier"),
            zone_contents
        );

        drop(cleanup);
        assert!(
            !root.exists(),
            "manual Zone.Identifier test cleanup must remove the test root"
        );
    }
}
