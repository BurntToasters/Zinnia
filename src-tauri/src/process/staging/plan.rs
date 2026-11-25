//! Cleanup plan preparation for mutating archive operations.

use crate::process::archive_snapshot::stage_extract_input_with_progress;
use crate::process::commit::archive_destination_family_snapshot;
use crate::process::quota::free_space_for_path;
use crate::process::CleanupPlan;

const MAX_EXTRACT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MIN_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;

/// Extracted-byte ceiling for an archive of `archive_bytes`: 1000 times its
/// compressed size, capped at 1 TiB.
pub(crate) fn extract_ratio_limit(archive_bytes: u64) -> u64 {
    archive_bytes.saturating_mul(1000).min(MAX_EXTRACT_BYTES)
}

/// Splits the destination's free space into the extract budget and the reserve.
/// `None` free space (probe unavailable) drops the disk bound and the reserve.
fn disk_budget(ratio_limit: u64, free_space: Option<u64>) -> (u64, u64) {
    match free_space {
        Some(free_space) => {
            let reserve = (free_space / 10).max(MIN_DISK_RESERVE_BYTES);
            let disk_limit = free_space.saturating_sub(reserve);
            (ratio_limit.min(disk_limit), reserve)
        }
        None => (ratio_limit, 0),
    }
}

#[cfg(test)]
pub(crate) fn prepare_cleanup_plan(
    args: &[String],
    cache_dir: Option<std::path::PathBuf>,
    expected_archive_identity: Option<&str>,
) -> Result<CleanupPlan, String> {
    prepare_cleanup_plan_with_cancel(
        args,
        cache_dir,
        expected_archive_identity,
        || false,
        |_: u8| {},
    )
    .map_err(|error| error.into_parts().0)
}

pub(crate) fn prepare_cleanup_plan_with_cancel<C, P>(
    args: &[String],
    cache_dir: Option<std::path::PathBuf>,
    expected_archive_identity: Option<&str>,
    should_cancel: C,
    on_snapshot_progress: P,
) -> Result<CleanupPlan, super::PreparationPlanError>
where
    C: Fn() -> bool,
    P: Fn(u8),
{
    prepare_cleanup_plan_inner(
        args,
        cache_dir,
        expected_archive_identity,
        should_cancel,
        on_snapshot_progress,
    )
    .map_err(super::classify_preparation_error)
}

const COMPOUND_WILDCARD_MESSAGE: &str =
    "Zinnia cannot read a compressed TAR archive from a folder whose path contains '*'. Move the archive to another folder.";

fn reject_compound_snapshot_wildcard(archive: &str) -> Result<(), String> {
    let location =
        std::fs::canonicalize(archive).unwrap_or_else(|_| std::path::PathBuf::from(archive));
    if location.to_string_lossy().contains('*') {
        return Err(COMPOUND_WILDCARD_MESSAGE.to_string());
    }
    Ok(())
}

fn prepare_cleanup_plan_inner<C, P>(
    args: &[String],
    cache_dir: Option<std::path::PathBuf>,
    expected_archive_identity: Option<&str>,
    should_cancel: C,
    on_snapshot_progress: P,
) -> Result<CleanupPlan, String>
where
    C: Fn() -> bool,
    P: Fn(u8),
{
    let cache_ref = cache_dir.as_deref();
    let command = args.first().map(String::as_str);
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let compound_stream = args.get(separator + 1).is_some_and(|archive| {
        let lower = archive.to_ascii_lowercase();
        [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
    });
    if matches!(command, Some("x" | "l" | "t")) && compound_stream {
        if let Some(archive) = args.get(separator + 1) {
            reject_compound_snapshot_wildcard(archive)?;
        }
    }
    let Some(target) = super::operation_output_path(args) else {
        if matches!(command, Some("l" | "t")) && compound_stream {
            let archive = args
                .get(separator + 1)
                .ok_or_else(|| "Archive command is missing an archive path.".to_string())?;
            let staged_input = stage_extract_input_with_progress(
                std::path::Path::new(archive),
                cache_ref,
                expected_archive_identity,
                &should_cancel,
                &on_snapshot_progress,
            )?;
            let preparation = (|| {
                let ratio_limit = extract_ratio_limit(staged_input.total_len);
                let free_space = free_space_for_path(&staged_input.path)?;
                let (max_bytes, reserve) = disk_budget(ratio_limit, free_space);
                if max_bytes == 0 {
                    return Err(
                        "Not enough free space to inspect the compound TAR stream.".to_string()
                    );
                }
                Ok((max_bytes, reserve))
            })();
            return match preparation {
                Ok((max_extract_bytes, min_free_bytes)) => Ok(CleanupPlan {
                    staged_extract: None,
                    staged_archive: None,
                    expected_archive_family: Vec::new(),
                    stage_identities: vec![(
                        staged_input
                            .path
                            .parent()
                            .expect("staged input has a parent")
                            .to_path_buf(),
                        staged_input.stage_identity.clone(),
                    )],
                    staged_input_archive: Some(staged_input.path),
                    snapshot_strategy: Some(staged_input.snapshot_strategy),
                    cache_dir,
                    max_extract_bytes: Some(max_extract_bytes),
                    min_free_bytes: Some(min_free_bytes),
                    extract_destination_preexisting: false,
                }),
                Err(error) => {
                    let error = if let Some(parent) = staged_input.path.parent() {
                        match super::cleanup_owned_stage(
                            parent,
                            &staged_input.stage_identity,
                            cache_ref,
                        ) {
                            Ok(()) => error,
                            Err(cleanup_error) => {
                                super::preparation_cleanup_failed(error, cleanup_error)
                            }
                        }
                    } else {
                        super::preparation_cleanup_failed(
                            error,
                            "staged archive input has no parent directory",
                        )
                    };
                    Err(error)
                }
            };
        }
        return Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            expected_archive_family: Vec::new(),
            staged_input_archive: None,
            snapshot_strategy: None,
            cache_dir,
            stage_identities: Vec::new(),
            max_extract_bytes: None,
            min_free_bytes: None,
            extract_destination_preexisting: false,
        });
    };

    match args.first().map(String::as_str) {
        Some("x") => {
            crate::validation::reject_extract_output_wildcard(&target.to_string_lossy())?;
            let expected_archive_identity = expected_archive_identity.ok_or_else(|| {
                "Mutating archive operations require an archive identity token.".to_string()
            })?;
            let destination_preexisting = super::path_entry_exists(&target)?;
            let destination = if destination_preexisting {
                super::resolve_existing_target(&target, true)
                    .map_err(|e| format!("Could not resolve the extraction destination: {e}"))?
            } else {
                super::resolve_new_target(&target)?
            };
            crate::validation::reject_extract_output_wildcard(&destination.to_string_lossy())?;
            let separator = args
                .iter()
                .position(|arg| arg == "--")
                .unwrap_or(args.len());
            let created_stage = super::next_extract_stage_path(&destination, cache_ref)?;
            let stage = created_stage.path;
            let stage_identity = created_stage.identity;
            let archive = args
                .get(separator + 1)
                .ok_or_else(|| "Extraction command is missing an archive path.".to_string())?;
            let staged_input = match stage_extract_input_with_progress(
                std::path::Path::new(archive),
                cache_ref,
                Some(expected_archive_identity),
                &should_cancel,
                &on_snapshot_progress,
            ) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let error = match super::cleanup_owned_stage(&stage, &stage_identity, cache_ref)
                    {
                        Ok(()) => error,
                        Err(cleanup_error) => {
                            super::preparation_cleanup_failed(error, cleanup_error)
                        }
                    };
                    return Err(error);
                }
            };
            let preparation = (|| {
                let ratio_limit = extract_ratio_limit(staged_input.total_len);
                let free_space = free_space_for_path(&destination)?;
                let (max_extract_bytes, reserve) = disk_budget(ratio_limit, free_space);
                if let Some(free_space) = free_space.filter(|free| *free <= reserve) {
                    return Err(format!(
                        "Not enough free space to extract safely ({} MiB available).",
                        free_space / (1024 * 1024)
                    ));
                }
                Ok((max_extract_bytes, reserve))
            })();
            let (max_extract_bytes, reserve) = match preparation {
                Ok(preparation) => preparation,
                Err(error) => {
                    let input_stage = staged_input.path.parent().map(std::path::Path::to_path_buf);
                    let mut error = error;
                    if let Err(cleanup_error) =
                        super::cleanup_owned_stage(&stage, &stage_identity, cache_ref)
                    {
                        error = super::preparation_cleanup_failed(error, cleanup_error);
                    }
                    if let Some(input_stage) = &input_stage {
                        if let Err(cleanup_error) = super::cleanup_owned_stage(
                            input_stage,
                            &staged_input.stage_identity,
                            cache_ref,
                        ) {
                            error = super::preparation_cleanup_failed(error, cleanup_error);
                        }
                    } else {
                        error = super::preparation_cleanup_failed(
                            error,
                            "staged archive input has no parent directory",
                        );
                    }
                    return Err(error);
                }
            };
            Ok(CleanupPlan {
                staged_extract: Some((stage.clone(), destination)),
                staged_archive: None,
                expected_archive_family: Vec::new(),
                stage_identities: vec![
                    (stage, stage_identity),
                    (
                        staged_input
                            .path
                            .parent()
                            .expect("staged input has a parent")
                            .to_path_buf(),
                        staged_input.stage_identity.clone(),
                    ),
                ],
                staged_input_archive: Some(staged_input.path),
                snapshot_strategy: Some(staged_input.snapshot_strategy),
                // Member preflight plus a fixed, wildcard-free stage
                // contains 7-Zip output. Unrelated siblings may legitimately
                // appear during a long extraction and must not abort commit.
                cache_dir,
                max_extract_bytes: Some(max_extract_bytes),
                min_free_bytes: Some(reserve),
                extract_destination_preexisting: destination_preexisting,
            })
        }
        Some("a") => {
            let expected = expected_archive_identity.ok_or_else(|| {
                "Mutating archive operations require an archive identity token.".to_string()
            })?;
            let pre_family = archive_destination_family_snapshot(&target)?;
            let current = super::archive_output_family_token_from_snapshots(&pre_family);
            if expected == super::ARCHIVE_OUTPUT_ABSENT_TOKEN {
                if current != super::ARCHIVE_OUTPUT_ABSENT_TOKEN {
                    return Err(
                        "Archive output appeared after it was selected; choose a different output path."
                            .to_string(),
                    );
                }
            } else if current == super::ARCHIVE_OUTPUT_ABSENT_TOKEN {
                return Err(
                    "Archive output disappeared after it was selected; choose a new output path."
                        .to_string(),
                );
            } else if current != expected {
                return Err(
                    "Archive output changed after it was selected; choose the current file again."
                        .to_string(),
                );
            }
            let requested_target = target.clone();
            let target = if super::path_entry_exists(&requested_target)? {
                super::resolve_existing_target(&requested_target, false)?
            } else {
                super::resolve_new_target(&requested_target)?
            };
            let expected_archive_family = if target == requested_target {
                // Selection snapshot already covered this exact path. Avoid a
                // second full read/hash before 7-Zip starts.
                pre_family.clone()
            } else {
                archive_destination_family_snapshot(&target)?
            };
            if !super::archive_family_content_matches(&pre_family, &expected_archive_family) {
                return Err(
                    "Archive output changed after it was selected; choose the current file again."
                        .to_string(),
                );
            }
            let created_stage = super::create_publish_stage_dir(&target, "archive", cache_ref)?;
            let stage_dir = created_stage.path;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                expected_archive_family,
                staged_input_archive: None,
                snapshot_strategy: None,
                cache_dir,
                stage_identities: vec![(stage_dir, created_stage.identity)],
                max_extract_bytes: None,
                min_free_bytes: None,
                extract_destination_preexisting: false,
            })
        }
        Some("u") => {
            let expected = expected_archive_identity.ok_or_else(|| {
                "Mutating archive operations require an archive identity token.".to_string()
            })?;
            if !super::path_entry_exists(&target)? {
                return Err("Update requires an existing output archive file.".to_string());
            }
            // Keep the full content snapshot that produced the selection token.
            // Resolving a case-insensitive or symlinked target can canonicalize
            // the path; without this comparison the file could be replaced in
            // that gap and the replacement would be staged for update.
            let pre_family = archive_destination_family_snapshot(&target)?;
            let current = super::archive_output_family_token_from_snapshots(&pre_family);
            if expected == super::ARCHIVE_OUTPUT_ABSENT_TOKEN
                || current == super::ARCHIVE_OUTPUT_ABSENT_TOKEN
            {
                return Err("Update requires an existing output archive file.".to_string());
            }
            if current != expected {
                return Err(
                    "Archive changed after it was selected; review the current archive before updating it."
                        .to_string(),
                );
            }
            let requested_target = target.clone();
            let target = super::resolve_existing_target(&requested_target, false)?;
            let expected_archive_family = if target == requested_target {
                pre_family.clone()
            } else {
                archive_destination_family_snapshot(&target)?
            };
            if !super::archive_family_content_matches(&pre_family, &expected_archive_family) {
                return Err(
                    "Archive changed after it was selected; review the current archive before updating it."
                        .to_string(),
                );
            }
            if expected_archive_family.len() != 1 {
                return Err(
                    "Updating split or multi-volume archives is not supported by bundled 7-Zip. Create a new archive instead."
                        .to_string(),
                );
            }
            let created_stage = super::create_publish_stage_dir(&target, "archive", cache_ref)?;
            let stage_dir = created_stage.path;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                expected_archive_family,
                staged_input_archive: None,
                snapshot_strategy: None,
                cache_dir,
                stage_identities: vec![(stage_dir, created_stage.identity)],
                max_extract_bytes: None,
                min_free_bytes: None,
                extract_destination_preexisting: false,
            })
        }
        _ => Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            expected_archive_family: Vec::new(),
            staged_input_archive: None,
            snapshot_strategy: None,
            cache_dir,
            stage_identities: Vec::new(),
            max_extract_bytes: None,
            min_free_bytes: None,
            extract_destination_preexisting: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::prepare_cleanup_plan;
    use crate::process::archive_identity_token;
    use crate::process::commit::rollback_cleanup;

    const WILDCARD_OUTPUT_MESSAGE: &str =
        "Zinnia cannot extract into a folder whose path contains '*'. Choose another folder.";
    const WILDCARD_COMPOUND_MESSAGE: &str =
        "Zinnia cannot read a compressed TAR archive from a folder whose path contains '*'. Move the archive to another folder.";

    fn temp_root(prefix: &str) -> std::path::PathBuf {
        let token = crate::process::staging::random_token().expect("random token");
        std::env::temp_dir().join(format!("{prefix}-{token}"))
    }

    fn directory_entries(root: &std::path::Path) -> Vec<std::ffi::OsString> {
        let mut names: Vec<std::ffi::OsString> = std::fs::read_dir(root)
            .expect("read test root")
            .map(|entry| entry.expect("directory entry").file_name())
            .collect();
        names.sort();
        names
    }

    fn extract_args(destination: &std::path::Path, archive: &std::path::Path) -> Vec<String> {
        vec![
            "x".to_string(),
            format!("-o{}", destination.display()),
            "-aou".to_string(),
            "--".to_string(),
            archive.to_string_lossy().into_owned(),
        ]
    }

    #[test]
    fn extract_plan_rejects_wildcard_ancestor_before_creating_stage() {
        let root = temp_root("zinnia-wildcard-ancestor");
        std::fs::create_dir_all(&root).expect("test root");
        let before = directory_entries(&root);
        let destination = root.join("an*cestor").join("out");
        let args = extract_args(&destination, &root.join("archive.7z"));
        let err = prepare_cleanup_plan(&args, None, Some("absent"))
            .expect_err("wildcard ancestor is rejected");
        assert_eq!(err, WILDCARD_OUTPUT_MESSAGE);
        assert_eq!(directory_entries(&root), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_plan_rejects_wildcard_basename_before_creating_stage() {
        let root = temp_root("zinnia-wildcard-basename");
        std::fs::create_dir_all(&root).expect("test root");
        let before = directory_entries(&root);
        let destination = root.join("out*");
        let args = extract_args(&destination, &root.join("archive.7z"));
        let err = prepare_cleanup_plan(&args, None, Some("absent"))
            .expect_err("wildcard basename is rejected");
        assert_eq!(err, WILDCARD_OUTPUT_MESSAGE);
        assert_eq!(directory_entries(&root), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_plan_keeps_plain_destination_staging_beside_destination() {
        let root = temp_root("zinnia-plain-destination");
        std::fs::create_dir_all(&root).expect("test root");
        let archive = root.join("archive.7z");
        std::fs::write(&archive, b"archive").expect("test archive");
        let destination = root.join("out");
        let args = extract_args(&destination, &archive);
        let identity = archive_identity_token(&archive).expect("archive identity");
        let plan = prepare_cleanup_plan(&args, None, Some(&identity)).expect("plain plan");
        let (staged, target) = plan.staged_extract.clone().expect("staging plan");
        assert_eq!(staged.parent(), target.parent());
        if let Some(input_stage) = plan
            .staged_input_archive
            .as_ref()
            .and_then(|path| path.parent())
        {
            crate::process::release_snapshot_handles(input_stage);
        }
        rollback_cleanup(&plan).expect("rollback");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn compound_archive_in_wildcard_folder_is_rejected_before_snapshot() {
        let root = temp_root("zinnia-wildcard-compound");
        std::fs::create_dir_all(&root).expect("test root");
        let before = directory_entries(&root);
        let archive = root.join("an*cestor").join("bundle.tar.gz");
        let args = vec![
            "l".to_string(),
            "--".to_string(),
            archive.to_string_lossy().into_owned(),
        ];
        let err = prepare_cleanup_plan(&args, None, None)
            .expect_err("wildcard compound archive is rejected");
        assert_eq!(err, WILDCARD_COMPOUND_MESSAGE);
        assert_eq!(directory_entries(&root), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn compress_input_named_like_compound_archive_is_not_rejected() {
        let root = temp_root("zinnia-compress-compound-input");
        std::fs::create_dir_all(&root).expect("test root");
        let output = root.join("out.7z");
        let input = root.join("an*cestor").join("bundle.tar.gz");
        let args = vec![
            "a".to_string(),
            "-t7z".to_string(),
            output.to_string_lossy().into_owned(),
            "--".to_string(),
            input.to_string_lossy().into_owned(),
        ];
        let plan = prepare_cleanup_plan(&args, None, Some("absent"))
            .expect("compress input is not a staged archive");
        rollback_cleanup(&plan).expect("rollback");
        let _ = std::fs::remove_dir_all(&root);
    }
}
