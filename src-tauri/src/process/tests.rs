//! Unit tests for the process module.

use super::archive_snapshot::{
    archive_file_identity, archive_input_family, assert_archive_identity_unchanged,
    stage_extract_input,
};
use super::commit::copy_file_no_replace;
use super::*;

fn temp_root(prefix: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "{prefix}-{}",
        random_token().expect("random test token")
    ))
}

fn bundled_7z_test_binary() -> Option<std::path::PathBuf> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let arch = std::env::consts::ARCH;
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["pc-windows-msvc.exe"]
    } else if cfg!(target_os = "macos") {
        &["apple-darwin", "universal-apple-darwin"]
    } else {
        &["unknown-linux-gnu"]
    };
    for suffix in candidates {
        let name = if suffix.starts_with("universal") {
            format!("7z-{suffix}")
        } else {
            format!("7z-{arch}-{suffix}")
        };
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(windows)]
fn volume_guid_alias(path: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        GetVolumeNameForVolumeMountPointW, GetVolumePathNameW,
    };

    let input: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut mount = vec![0u16; 32_768];
    if unsafe { GetVolumePathNameW(input.as_ptr(), mount.as_mut_ptr(), mount.len() as u32) } == 0 {
        return None;
    }
    let mount_len = mount.iter().position(|unit| *unit == 0)?;
    let mount_path = std::path::PathBuf::from(OsString::from_wide(&mount[..mount_len]));
    let relative = path.strip_prefix(&mount_path).ok()?;

    let mount_wide: Vec<u16> = mount_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut volume = [0u16; 50];
    if unsafe {
        GetVolumeNameForVolumeMountPointW(
            mount_wide.as_ptr(),
            volume.as_mut_ptr(),
            volume.len() as u32,
        )
    } == 0
    {
        return None;
    }
    let volume_len = volume.iter().position(|unit| *unit == 0)?;
    Some(std::path::PathBuf::from(OsString::from_wide(&volume[..volume_len])).join(relative))
}

#[test]
fn ensure_idle_detects_busy_state() {
    let idle = ProcessState::idle();
    let cancelling = ProcessState {
        cancelling: true,
        ..ProcessState::idle()
    };

    assert!(ensure_idle(&idle).is_ok());
    assert!(ensure_idle(&cancelling).is_err());
}

#[test]
fn cancellation_helper_kills_and_reaps_spawned_child() {
    #[cfg(unix)]
    let mut command = {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
        command
    };
    let child =
        std::sync::Arc::new(shared_child::SharedChild::spawn(&mut command).expect("spawn child"));
    terminate_child(&child);
    assert!(child.try_wait().expect("poll reaped child").is_some());
}

#[test]
fn safe_stage_dir_name_requires_exact_token_pattern() {
    assert!(is_safe_stage_dir_name(
        ".zinnia-extract-0123456789abcdef0123456789abcdef"
    ));
    assert!(is_safe_stage_dir_name(
        ".out.zinnia-extract-0123456789abcdef0123456789abcdef"
    ));
    assert!(is_safe_stage_dir_name(
        ".archive.7z.zinnia-archive-fedcba9876543210fedcba9876543210"
    ));
    assert!(is_safe_stage_dir_name(
        ".archive.7z.zinnia-input-fedcba9876543210fedcba9876543210"
    ));
    assert!(!is_safe_stage_dir_name("photos.zinnia-extract-evil"));
    assert!(!is_safe_stage_dir_name(
        ".out.zinnia-extract-0123456789abcdef0123456789abcd"
    ));
    assert!(!is_safe_stage_dir_name(
        "out.zinnia-extract-0123456789abcdef0123456789abcdef"
    ));
}

#[test]
fn operation_output_path_finds_archive_for_add() {
    let args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        "/tmp/out.7z".to_string(),
        "--".to_string(),
        "input.txt".to_string(),
    ];
    assert_eq!(
        operation_output_path(&args),
        Some(std::path::PathBuf::from("/tmp/out.7z"))
    );
}

#[test]
fn operation_output_path_finds_output_dir_for_extract() {
    let args = vec![
        "x".to_string(),
        "-o/tmp/out".to_string(),
        "--".to_string(),
        "archive.7z".to_string(),
    ];
    assert_eq!(
        operation_output_path(&args),
        Some(std::path::PathBuf::from("/tmp/out"))
    );
}

#[test]
fn operation_output_path_none_for_list() {
    let args = vec!["l".to_string(), "--".to_string(), "archive.7z".to_string()];
    assert_eq!(operation_output_path(&args), None);
}

#[test]
fn windows_listfile_rewrite_places_reference_before_any_separator() {
    let mut compress = vec![
        "a".to_string(),
        "-t7z".to_string(),
        "out.7z".to_string(),
        "--".to_string(),
        "one.txt".to_string(),
        "two.txt".to_string(),
    ];
    let selected =
        rewrite_args_for_managed_listfile(&mut compress, "@C:\\temp\\items.txt".to_string())
            .expect("compress rewrite");
    assert_eq!(selected, ["one.txt", "two.txt"]);
    assert_eq!(
        compress,
        ["a", "-scsUTF-8", "-t7z", "out.7z", "@C:\\temp\\items.txt"]
    );
    assert!(!compress.iter().any(|arg| arg == "--"));

    let mut extract = vec![
        "x".to_string(),
        "-oC:\\out".to_string(),
        "-aou".to_string(),
        "--".to_string(),
        "C:\\archive.7z".to_string(),
        "docs\\one.txt".to_string(),
    ];
    let selected =
        rewrite_args_for_managed_listfile(&mut extract, "@C:\\temp\\items.txt".to_string())
            .expect("extract rewrite");
    assert_eq!(selected, ["docs\\one.txt"]);
    assert_eq!(
        extract,
        [
            "x",
            "-scsUTF-8",
            "-oC:\\out",
            "-aou",
            "C:\\archive.7z",
            "@C:\\temp\\items.txt"
        ]
    );
}

#[test]
fn existing_extraction_destination_stages_inside_destination() {
    let root = temp_root("zinnia-extract-existing-plan-test");
    std::fs::create_dir_all(&root).expect("test directory");
    let archive = root.join("archive.7z");
    std::fs::write(&archive, b"archive").expect("test archive");
    let args = vec![
        "x".to_string(),
        format!("-o{}", root.display()),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let plan = prepare_cleanup_plan(&args, None).expect("cleanup plan");
    let (staged, target) = plan.staged_extract.clone().expect("staging plan");
    assert_eq!(staged.parent(), Some(target.as_path()));
    assert_eq!(
        ExtractStagePlacement::from_paths(&staged, &target),
        Ok(ExtractStagePlacement::InsideDestination)
    );
    rollback_cleanup(&plan).expect("rollback");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn new_extraction_destination_stages_beside_destination() {
    let root = temp_root("zinnia-extract-new-plan-test");
    std::fs::create_dir_all(&root).expect("test directory");
    let archive = root.join("archive.7z");
    let destination = root.join("new-destination");
    std::fs::write(&archive, b"archive").expect("test archive");
    let args = vec![
        "x".to_string(),
        format!("-o{}", destination.display()),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let plan = prepare_cleanup_plan(&args, None).expect("cleanup plan");
    let (staged, target) = plan.staged_extract.clone().expect("staging plan");
    assert_eq!(staged.parent(), target.parent());
    assert_eq!(
        ExtractStagePlacement::from_paths(&staged, &target),
        Ok(ExtractStagePlacement::Sibling)
    );
    rollback_cleanup(&plan).expect("rollback");
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn extraction_staging_supports_volume_guid_destinations() {
    let root = temp_root("zinnia-volume-guid-stage-test");
    std::fs::create_dir_all(&root).expect("test directory");
    let Some(volume_root) = volume_guid_alias(&root) else {
        eprintln!("skipping: temporary directory has no volume-GUID alias");
        let _ = std::fs::remove_dir_all(root);
        return;
    };
    let archive = root.join("archive.7z");
    std::fs::write(&archive, b"archive").expect("test archive");

    let existing = volume_root.join("existing");
    std::fs::create_dir(&existing).expect("existing volume-GUID destination");
    let existing_args = vec![
        "x".to_string(),
        format!("-o{}", existing.display()),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let existing_plan =
        prepare_cleanup_plan(&existing_args, None).expect("existing destination plan");
    let (existing_stage, existing_target) = existing_plan
        .staged_extract
        .as_ref()
        .expect("existing stage");
    assert_eq!(existing_stage.parent(), Some(existing_target.as_path()));
    assert!(existing_target.is_absolute());
    rollback_cleanup(&existing_plan).expect("existing rollback");

    let new_destination = volume_root.join("new");
    let new_args = vec![
        "x".to_string(),
        format!("-o{}", new_destination.display()),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let new_plan = prepare_cleanup_plan(&new_args, None).expect("new destination plan");
    let (new_stage, new_target) = new_plan.staged_extract.as_ref().expect("new stage");
    assert_eq!(new_stage.parent(), new_target.parent());
    assert!(new_target.is_absolute());
    rollback_cleanup(&new_plan).expect("new rollback");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn real_7z_extract_uses_snapshot_publish_stage_and_safe_commit() {
    let Some(binary) = bundled_7z_test_binary() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };
    let root = temp_root("zinnia-real-extract-transaction");
    let source = root.join("source");
    let cache = root.join("cache");
    std::fs::create_dir_all(&root).expect("transaction root");
    let external_archive = std::env::var_os("ZINNIA_TEST_ARCHIVE").map(std::path::PathBuf::from);
    let archive = if let Some(archive) = &external_archive {
        assert!(archive.is_file(), "ZINNIA_TEST_ARCHIVE must be a file");
        archive.clone()
    } else {
        std::fs::create_dir(&source).expect("source directory");
        std::fs::write(source.join("payload.txt"), b"transaction payload\n")
            .expect("source payload");
        let archive = root.join("payload.7z");
        let add = std::process::Command::new(&binary)
            .current_dir(&source)
            .args(["a", "-t7z"])
            .arg(&archive)
            .arg("--")
            .arg("payload.txt")
            .output()
            .expect("create test archive");
        assert!(
            add.status.success(),
            "7z create failed: {}",
            String::from_utf8_lossy(&add.stderr)
        );
        archive
    };

    let external_publish_parent =
        std::env::var_os("ZINNIA_TEST_PUBLISH_PARENT").map(std::path::PathBuf::from);
    let publish_root = if let Some(parent) = &external_publish_parent {
        assert!(parent.is_absolute(), "publish parent must be absolute");
        crate::path_safety::assert_real_directory(parent).expect("real publish parent");
        parent.clone()
    } else {
        #[cfg(windows)]
        {
            volume_guid_alias(&root).expect("volume-GUID alias")
        }
        #[cfg(not(windows))]
        {
            root.clone()
        }
    };
    let destination_token = random_token().expect("destination token");

    for existing in [true, false] {
        let name = if external_publish_parent.is_some() {
            format!(
                "zinnia-transaction-{}-{destination_token}",
                if existing { "existing" } else { "new" }
            )
        } else if existing {
            "existing-destination".to_string()
        } else {
            "new-destination".to_string()
        };
        let destination = publish_root.join(&name);
        if existing {
            std::fs::create_dir(&destination).expect("existing destination");
        }
        let mut args = vec![
            "x".to_string(),
            "-aou".to_string(),
            format!("-o{}", destination.display()),
            "--".to_string(),
            archive.to_string_lossy().to_string(),
        ];
        crate::validation::validate_run_7z_args(&args).expect("valid extract arguments");
        super::commands::harden_7z_args(&mut args);

        let plan =
            prepare_cleanup_plan(&args, Some(cache.clone())).expect("prepare production plan");
        let staged_snapshot = plan
            .staged_input_archive
            .as_ref()
            .expect("private archive snapshot");
        let (staged_output, resolved_destination) =
            plan.staged_extract.as_ref().expect("publish stage");
        if existing {
            assert_eq!(staged_output.parent(), Some(resolved_destination.as_path()));
        } else {
            assert_eq!(staged_output.parent(), resolved_destination.parent());
        }

        let mut execution_args = args.clone();
        super::staging::rewrite_extract_archive(&mut execution_args, staged_snapshot)
            .expect("rewrite snapshot input");
        super::staging::rewrite_extract_output(&mut execution_args, staged_output)
            .expect("rewrite publish stage");

        let list_args = extract_member_list_args(&execution_args).expect("member list arguments");
        let list = std::process::Command::new(&binary)
            .args(&list_args)
            .output()
            .expect("list snapshot members");
        assert!(
            list.status.success(),
            "7z list failed: {}",
            String::from_utf8_lossy(&list.stderr)
        );
        assert_slt_archive_members_safe(
            &String::from_utf8_lossy(&list.stdout),
            execution_args.last().expect("snapshot argument"),
        )
        .expect("safe archive members");

        let extract = std::process::Command::new(&binary)
            .args(&execution_args)
            .output()
            .expect("extract into publish stage");
        assert!(
            extract.status.success(),
            "7z extract failed: {}",
            String::from_utf8_lossy(&extract.stderr)
        );
        merge_staged_extract(
            staged_output,
            resolved_destination,
            plan.max_extract_bytes.expect("extract quota"),
        )
        .expect("safe staged commit");
        std::fs::remove_dir_all(
            staged_snapshot
                .parent()
                .expect("snapshot staging directory"),
        )
        .expect("remove snapshot stage");
        unregister_plan_stages(&plan);

        let normal_destination = external_publish_parent
            .as_ref()
            .unwrap_or(&root)
            .join(&name);
        if external_archive.is_some() {
            assert!(
                std::fs::read_dir(&normal_destination)
                    .expect("published destination")
                    .next()
                    .is_some(),
                "external archive extracted no entries"
            );
        } else {
            assert_eq!(
                std::fs::read_to_string(normal_destination.join("payload.txt"))
                    .expect("published payload"),
                "transaction payload\n"
            );
        }
        assert!(!staged_output.exists());
        assert!(!move_plan_path(staged_output).exists());
        if external_publish_parent.is_some() {
            std::fs::remove_dir_all(&normal_destination)
                .expect("remove external publish destination");
        }
    }

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn real_7z_archive_create_and_update_use_publish_stages() {
    let Some(binary) = bundled_7z_test_binary() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };
    let root = temp_root("zinnia-real-archive-transaction");
    let source = root.join("source");
    let cache = root.join("cache");
    std::fs::create_dir_all(&source).expect("source directory");
    let old_input = source.join("old.txt");
    let new_input = source.join("new.txt");
    std::fs::write(&old_input, b"old payload\n").expect("old input");
    std::fs::write(&new_input, b"new payload\n").expect("new input");

    let external_publish_parent =
        std::env::var_os("ZINNIA_TEST_PUBLISH_PARENT").map(std::path::PathBuf::from);
    let publish_root = if let Some(parent) = &external_publish_parent {
        assert!(parent.is_absolute(), "publish parent must be absolute");
        crate::path_safety::assert_real_directory(parent).expect("real publish parent");
        parent.clone()
    } else {
        #[cfg(windows)]
        {
            volume_guid_alias(&root).expect("volume-GUID alias")
        }
        #[cfg(not(windows))]
        {
            root.clone()
        }
    };
    let archive_name = if external_publish_parent.is_some() {
        format!(
            "zinnia-archive-transaction-{}.7z",
            random_token().expect("archive token")
        )
    } else {
        "output.7z".to_string()
    };
    let destination = publish_root.join(&archive_name);
    let normal_destination = external_publish_parent
        .as_ref()
        .unwrap_or(&root)
        .join(&archive_name);

    let mut create_args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        destination.to_string_lossy().to_string(),
        "--".to_string(),
        old_input.to_string_lossy().to_string(),
    ];
    crate::validation::validate_run_7z_args(&create_args).expect("valid create arguments");
    super::commands::harden_7z_args(&mut create_args);
    let create_plan =
        prepare_cleanup_plan(&create_args, Some(cache.clone())).expect("prepare create plan");
    let (staged_create, resolved_destination) =
        create_plan.staged_archive.as_ref().expect("create stage");
    assert_eq!(
        staged_create.parent().and_then(std::path::Path::parent),
        resolved_destination.parent()
    );
    let mut create_execution = create_args.clone();
    super::staging::rewrite_archive_output(&mut create_execution, staged_create)
        .expect("rewrite create output");
    let create = std::process::Command::new(&binary)
        .args(&create_execution)
        .output()
        .expect("run staged create");
    assert!(
        create.status.success(),
        "7z create failed: {}",
        String::from_utf8_lossy(&create.stderr)
    );
    promote_archive_family(staged_create, resolved_destination).expect("promote created archive");
    unregister_plan_stages(&create_plan);
    assert!(normal_destination.is_file());
    assert!(!staged_create.exists());

    let mut update_args = vec![
        "u".to_string(),
        destination.to_string_lossy().to_string(),
        "--".to_string(),
        new_input.to_string_lossy().to_string(),
    ];
    crate::validation::validate_run_7z_args(&update_args).expect("valid update arguments");
    super::commands::harden_7z_args(&mut update_args);
    let update_plan = prepare_cleanup_plan(&update_args, Some(cache)).expect("prepare update plan");
    let (staged_update, resolved_destination) =
        update_plan.staged_archive.as_ref().expect("update stage");
    assert!(staged_update.is_file(), "update must copy existing archive");
    let mut update_execution = update_args.clone();
    super::staging::rewrite_archive_output(&mut update_execution, staged_update)
        .expect("rewrite update output");
    let update = std::process::Command::new(&binary)
        .args(&update_execution)
        .output()
        .expect("run staged update");
    assert!(
        update.status.success(),
        "7z update failed: {}",
        String::from_utf8_lossy(&update.stderr)
    );
    promote_archive_family(staged_update, resolved_destination).expect("promote updated archive");
    unregister_plan_stages(&update_plan);
    assert!(!staged_update.exists());

    let list = std::process::Command::new(&binary)
        .arg("l")
        .arg("--")
        .arg(&normal_destination)
        .output()
        .expect("list updated archive");
    assert!(list.status.success(), "updated archive list failed");
    let listing = String::from_utf8_lossy(&list.stdout);
    assert!(listing.contains("old.txt"));
    assert!(listing.contains("new.txt"));
    if external_publish_parent.is_some() {
        std::fs::remove_file(&normal_destination).expect("remove external archive output");
    }

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extract_stage_placement_rejects_mismatched_layouts() {
    let root = std::path::Path::new("root");
    let destination = root.join("destination");
    let sibling = root.join(".zinnia-extract-token");
    let inside = destination.join(".zinnia-extract-token");

    assert!(ExtractStagePlacement::Sibling.matches_paths(&sibling, &destination));
    assert!(!ExtractStagePlacement::Sibling.matches_paths(&inside, &destination));
    assert!(ExtractStagePlacement::InsideDestination.matches_paths(&inside, &destination));
    assert!(!ExtractStagePlacement::InsideDestination.matches_paths(&sibling, &destination));
    assert!(
        ExtractStagePlacement::from_paths(&root.join("elsewhere/stage"), &destination).is_err()
    );
}

#[test]
fn extract_stage_placement_serializes_and_legacy_journals_remain_sibling_only() {
    let destination = std::path::PathBuf::from("root/destination");
    let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::InsideDestination),
        move_plan_sidecar: true,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(super::journal::FileIdentity::Unix {
            device: 1,
            inode: 2,
        }),
        extract_phase: Some(ExtractJournalPhase::InProgress),
        archive_phase: None,
    };
    let value = serde_json::to_value(&journal).expect("serialize journal");
    assert_eq!(
        value.get("extract_stage_placement"),
        Some(&serde_json::Value::String("inside_destination".to_string()))
    );
    let decoded: CleanupJournal = serde_json::from_value(value.clone()).expect("decode journal");
    assert_eq!(
        decoded.extract_stage_placement,
        Some(ExtractStagePlacement::InsideDestination)
    );
    assert_eq!(
        decoded.extract_phase,
        Some(ExtractJournalPhase::InProgress)
    );
    assert_eq!(decoded.extract_stage_identity, journal.extract_stage_identity);
    assert!(ExtractStagePlacement::InsideDestination
        .matches_paths(&decoded.stage, &decoded.destination));

    let sibling = destination
        .parent()
        .expect("destination parent")
        .join(".zinnia-extract-fedcba9876543210fedcba9876543210");
    let mut legacy = serde_json::to_value(CleanupJournal {
        stage: sibling.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: false,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: None,
    })
    .expect("serialize legacy base");
    legacy
        .as_object_mut()
        .expect("journal object")
        .remove("extract_stage_placement");
    legacy
        .as_object_mut()
        .expect("journal object")
        .remove("extract_phase");
    legacy
        .as_object_mut()
        .expect("journal object")
        .remove("extract_stage_identity");
    let decoded: CleanupJournal = serde_json::from_value(legacy).expect("decode legacy journal");
    assert_eq!(decoded.extract_stage_placement, None);
    assert_eq!(decoded.extract_phase, None);
    assert_eq!(decoded.extract_stage_identity, None);
    assert_eq!(decoded.stage.parent(), decoded.destination.parent());
    assert_ne!(decoded.stage.parent(), Some(decoded.destination.as_path()));
}

#[test]
fn existing_archive_is_untouched_after_staged_rollback() {
    let root = temp_root("zinnia-process-test");
    std::fs::create_dir_all(&root).expect("test directory");
    let target = root.join("output.7z");
    std::fs::write(&target, b"original").expect("test archive");

    let args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        target.to_string_lossy().to_string(),
        "--".to_string(),
        "input.txt".to_string(),
    ];
    let plan = prepare_cleanup_plan(&args, None).expect("cleanup plan");
    let staged = plan
        .staged_archive
        .as_ref()
        .map(|(staged, _)| staged.clone())
        .expect("staged archive");
    assert!(target.exists());
    let canonical_target = target.canonicalize().expect("canonical archive target");
    assert_eq!(
        staged.parent().and_then(|stage| stage.parent()),
        canonical_target.parent()
    );
    std::fs::write(&staged, b"partial").expect("partial staged archive");
    rollback_cleanup(&plan).expect("rollback should remove staging");
    assert_eq!(
        std::fs::read(&target).expect("restored archive"),
        b"original"
    );
    assert!(!staged.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn inside_destination_extract_stage_merges_without_self_conflict() {
    let root = temp_root("zinnia-inside-destination-merge-test");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("new.txt"), b"new").expect("staged file");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect("inside-destination merge should succeed");

    assert_eq!(
        std::fs::read(destination.join("new.txt")).expect("promoted file"),
        b"new"
    );
    assert!(!staged.exists());
    assert!(!move_plan_path(&staged).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_commit_point_precedes_stage_cleanup() {
    let root = temp_root("zinnia-extract-commit-point");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("new.txt"), b"new").expect("staged file");
    let committed = std::cell::Cell::new(false);

    merge_staged_extract_with_commit(
        &staged,
        &destination,
        MAX_EXTRACTED_BYTES,
        || {
            assert!(staged.is_dir(), "stage must remain until commit is durable");
            assert!(destination.join("new.txt").is_file());
            committed.set(true);
            Ok(())
        },
    )
    .expect("merge and commit");

    assert!(committed.get());
    assert!(!staged.exists());
    assert!(!move_plan_path(&staged).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_commit_marker_failure_rolls_back_existing_destination() {
    let root = temp_root("zinnia-extract-commit-rollback");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("staged tree");
    let source = staged.join("new.txt");
    std::fs::write(&source, b"new").expect("staged file");

    let error = merge_staged_extract_with_commit(
        &staged,
        &destination,
        MAX_EXTRACTED_BYTES,
        || Err("journal write failed".to_string()),
    )
    .expect_err("commit marker failure must abort");

    assert!(error.contains("journal write failed"));
    assert_eq!(std::fs::read(&source).expect("restored staged source"), b"new");
    assert!(!destination.join("new.txt").exists());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_file(move_identity_log_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_commit_marker_failure_restores_new_destination_stage() {
    let root = temp_root("zinnia-new-extract-commit-rollback");
    let destination = root.join("destination");
    let staged = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("new.txt"), b"new").expect("staged file");

    let error = merge_staged_extract_with_commit(
        &staged,
        &destination,
        MAX_EXTRACTED_BYTES,
        || Err("journal write failed".to_string()),
    )
    .expect_err("commit marker failure must abort");

    assert!(error.contains("journal write failed"));
    assert!(staged.join("new.txt").is_file());
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn readonly_staged_files_do_not_turn_a_committed_extract_into_failure() {
    let root = temp_root("zinnia-readonly-stage-cleanup");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("staged tree");
    let source = staged.join("readonly.txt");
    std::fs::write(&source, b"readonly").expect("staged file");
    let mut permissions = std::fs::metadata(&source).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&source, permissions).expect("set read-only attribute");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect("read-only extraction must commit and clean its stage");

    assert!(!staged.exists());
    let published = destination.join("readonly.txt");
    assert!(published.is_file());
    assert!(std::fs::metadata(&published).unwrap().permissions().readonly());
    crate::fs_secure::remove_dir_all_for_cleanup(&root).expect("cleanup test tree");
}

#[test]
fn nested_extract_merge_does_not_double_remove_directories() {
    let root = temp_root("zinnia-merge-test");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(staged.join("nested")).expect("staged tree");
    std::fs::create_dir_all(destination.join("nested")).expect("destination tree");
    std::fs::write(staged.join("nested/new.txt"), b"new").expect("staged file");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).expect("merge should succeed");
    assert_eq!(
        std::fs::read(destination.join("nested/new.txt")).expect("promoted file"),
        b"new"
    );
    assert!(!staged.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn final_extract_scan_enforces_operation_specific_quota() {
    let root = temp_root("zinnia-final-quota-test");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("expanded.bin"), b"12345678").expect("staged file");

    let error = merge_staged_extract(&staged, &destination, 7)
        .expect_err("final scan must reject an over-quota extraction");
    assert!(error.contains("expanded-size safety limit"));
    assert!(!destination.exists());
    assert!(staged.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn staged_symlink_is_rejected_even_for_new_destination() {
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-symlink-test");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    symlink("/tmp", staged.join("unsafe-link")).expect("test symlink");

    assert!(merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).is_err());
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn staged_relative_in_tree_symlink_is_allowed() {
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-rel-symlink-ok");
    let staged = root.join("staged");
    let destination = root.join("destination");
    let framework = staged.join("Demo.app/Contents/Frameworks/Demo.framework");
    std::fs::create_dir_all(framework.join("Versions/A/Resources")).expect("framework tree");
    std::fs::write(framework.join("Versions/A/Resources/Info.plist"), b"ok").expect("plist");
    symlink("A", framework.join("Versions/Current")).expect("Current symlink");
    symlink("Versions/Current/Resources", framework.join("Resources")).expect("Resources symlink");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).expect("relative links ok");
    assert!(destination
        .join("Demo.app/Contents/Frameworks/Demo.framework/Resources")
        .symlink_metadata()
        .expect("resources link")
        .file_type()
        .is_symlink());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn staged_relative_escape_symlink_is_rejected() {
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-rel-symlink-escape");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(staged.join("nested")).expect("staged tree");
    symlink("../../outside", staged.join("nested/escape")).expect("escape symlink");

    let error = merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect_err("escape link must fail");
    assert!(
        error.contains("escapes the extract root") || error.contains("symbolic link"),
        "unexpected error: {error}"
    );
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn existing_destination_symlink_is_never_followed_during_merge() {
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-destination-symlink-test");
    let staged = root.join("staged");
    let destination = root.join("destination");
    let outside = root.join("outside");
    std::fs::create_dir_all(staged.join("nested")).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination");
    std::fs::create_dir_all(&outside).expect("outside");
    std::fs::write(staged.join("nested/new.txt"), b"unsafe").expect("staged file");
    symlink(&outside, destination.join("nested")).expect("destination symlink");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect("symlink must be treated as a conflict");
    assert!(!outside.join("new.txt").exists());
    assert_eq!(
        std::fs::read(destination.join("nested_1/new.txt")).expect("renamed safe output"),
        b"unsafe"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn publish_rejects_symlink_swapped_ancestor_before_rename() {
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-toctou-ancestor-test");
    let destination = root.join("destination");
    let outside = root.join("outside");
    let nested = destination.join("nested");
    std::fs::create_dir_all(&nested).expect("destination nested");
    std::fs::create_dir_all(&outside).expect("outside");
    let target = nested.join("new.txt");
    assert_safe_extract_target_ancestors(&destination, &target).expect("real ancestors ok");

    std::fs::remove_dir(&nested).expect("remove nested");
    symlink(&outside, &nested).expect("swap nested for symlink");
    let error = assert_safe_extract_target_ancestors(&destination, &target)
        .expect_err("symlink ancestor must fail");
    assert!(
        error.contains("real directory")
            || error.contains("symbolic link")
            || error.contains("reparse"),
        "unexpected error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn persisted_move_plan_rolls_back_a_partial_merge() {
    let root = temp_root("zinnia-move-recovery-test");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: None,
    }];
    write_move_plan(&staged, &plan).expect("durable move plan");
    std::fs::write(&target, b"partially published").expect("partial target");

    rollback_persisted_move_plan(&staged, &destination, false).expect("rollback plan");

    assert_eq!(
        std::fs::read(&source).expect("restored source"),
        b"partially published"
    );
    assert!(!target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn inside_destination_move_plan_rolls_back_a_partial_merge() {
    let root = temp_root("zinnia-inside-move-recovery-test");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("inside-destination stage");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    std::fs::write(&source, b"partially published").expect("staged source");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: None,
    }];
    write_move_plan(&staged, &plan).expect("durable sidecar move plan");
    std::fs::rename(&source, &target).expect("partial promotion");

    rollback_persisted_move_plan(&staged, &destination, false)
        .expect("rollback inside-destination plan");

    assert_eq!(
        std::fs::read(&source).expect("restored staged source"),
        b"partially published"
    );
    assert!(!target.exists());
    assert!(move_plan_path(&staged).is_file());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn target_local_publish_recovery_removes_only_verified_copies() {
    let root = temp_root("zinnia-target-local-recovery");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("inside-destination stage");
    let source = staged.join("new.txt");
    std::fs::write(&source, b"staged source").expect("staged source");

    let publish_temp = destination.join(".zinnia-publish-0123456789abcdef0123456789abcdef");
    std::fs::write(&publish_temp, b"partial copy").expect("publish temp");
    let publish_identity = super::journal::path_identity(&publish_temp).expect("publish identity");
    let target = destination.join("new.txt");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: Some(publish_temp.clone()),
        publish_identity: Some(publish_identity),
    }];
    write_move_plan(&staged, &plan).expect("target-local move plan");

    rollback_persisted_move_plan(&staged, &destination, false)
        .expect("remove verified partial copy");

    assert_eq!(std::fs::read(&source).unwrap(), b"staged source");
    assert!(!publish_temp.exists());
    assert!(!target.exists());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn target_local_recovery_hydrates_append_only_identity_log() {
    use std::io::Write as _;

    let root = temp_root("zinnia-target-local-identity-log");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("inside-destination stage");
    let source = staged.join("new.txt");
    std::fs::write(&source, b"staged source").expect("staged source");

    let publish_temp = destination.join(".zinnia-publish-0123456789abcdef0123456789abcdef");
    std::fs::write(&publish_temp, b"partial copy").expect("publish temp");
    let publish_identity = super::journal::path_identity(&publish_temp).expect("publish identity");
    let target = destination.join("new.txt");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: Some(publish_temp.clone()),
        publish_identity: None,
    }];
    write_move_plan(&staged, &plan).expect("base move plan");

    let record = serde_json::json!({
        "index": 0,
        "publish_temp": publish_temp,
        "identity": publish_identity,
    });
    let mut log = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(move_identity_log_path(&staged))
        .expect("identity log");
    writeln!(log, "{}", serde_json::to_string(&record).unwrap()).expect("identity record");
    // Simulate a crash during the next append. Recovery must ignore only this
    // incomplete final record and still use the prior durable identity.
    write!(log, "{{\"index\":").expect("torn record");
    log.sync_all().expect("sync identity log");

    rollback_persisted_move_plan(&staged, &destination, false)
        .expect("hydrate identity log and remove verified copy");

    assert_eq!(std::fs::read(&source).unwrap(), b"staged source");
    assert!(!destination.join(".zinnia-publish-0123456789abcdef0123456789abcdef").exists());
    assert!(!target.exists());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_file(move_identity_log_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn target_local_publish_recovery_preserves_replacement_target() {
    let root = temp_root("zinnia-target-local-replacement");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("inside-destination stage");
    let source = staged.join("new.txt");
    std::fs::write(&source, b"staged source").expect("staged source");

    let publish_temp = destination.join(".zinnia-publish-0123456789abcdef0123456789abcdef");
    std::fs::write(&publish_temp, b"owned object").expect("owned publish object");
    let publish_identity = super::journal::path_identity(&publish_temp).expect("publish identity");
    std::fs::remove_file(&publish_temp).expect("remove owned publish object");
    let target = destination.join("new.txt");
    std::fs::write(&target, b"replacement").expect("replacement target");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: Some(publish_temp),
        publish_identity: Some(publish_identity),
    }];
    write_move_plan(&staged, &plan).expect("target-local move plan");

    rollback_persisted_move_plan(&staged, &destination, false)
        .expect("leave replacement target untouched");

    assert_eq!(std::fs::read(&source).unwrap(), b"staged source");
    assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extracted_move_plan_filename_is_preserved_as_user_content() {
    let root = temp_root("zinnia-move-plan-member");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    std::fs::write(staged.join("move-plan.json"), b"user archive content").expect("member content");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).expect("merge");

    assert_eq!(
        std::fs::read(destination.join("move-plan.json")).expect("published member"),
        b"user archive content"
    );
    assert!(!move_plan_path(&staged).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn merge_rewrites_relative_symlink_when_target_is_auto_renamed() {
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-link-conflict-map");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    std::fs::write(staged.join("payload"), b"new").expect("new payload");
    std::fs::write(destination.join("payload"), b"old").expect("old payload");
    symlink("payload", staged.join("link")).expect("staged link");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).expect("safe merge");

    let rewritten = std::fs::read_link(destination.join("link")).expect("published link");
    assert_ne!(rewritten, std::path::PathBuf::from("payload"));
    assert_eq!(
        std::fs::read(destination.join("link")).expect("linked new payload"),
        b"new"
    );
    assert_eq!(std::fs::read(destination.join("payload")).unwrap(), b"old");
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn persisted_move_plan_rolls_back_a_promoted_symlink() {
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-link-rollback");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("link");
    let target = destination.join("link");
    symlink("payload", &source).expect("source link");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: None,
    }];
    write_move_plan(&staged, &plan).expect("move plan");
    std::fs::rename(&source, &target).expect("partial promotion");

    rollback_persisted_move_plan(&staged, &destination, false).expect("rollback link");

    assert!(source.symlink_metadata().unwrap().file_type().is_symlink());
    assert!(!target.exists());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn split_archive_family_is_promoted_as_one_set() {
    let root = temp_root("zinnia-volume-test");
    std::fs::create_dir_all(&root).expect("test root");
    let stage_dir = root.join("stage");
    std::fs::create_dir(&stage_dir).expect("stage dir");
    let staged = stage_dir.join("output.7z");
    let destination = root.join("output.7z");
    std::fs::write(stage_dir.join("output.7z.001"), b"new-1").expect("stage volume 1");
    std::fs::write(stage_dir.join("output.7z.002"), b"new-2").expect("stage volume 2");
    std::fs::write(root.join("output.7z.001"), b"old-1").expect("old volume 1");
    std::fs::write(root.join("output.7z.002"), b"old-2").expect("old volume 2");
    std::fs::write(root.join("output.7z.003"), b"stale-3").expect("stale volume");
    std::fs::write(root.join("output.7z.2024"), b"unrelated").expect("unrelated numeric suffix");

    promote_archive_family(&staged, &destination).expect("promote volume set");
    assert_eq!(std::fs::read(root.join("output.7z.001")).unwrap(), b"new-1");
    assert_eq!(std::fs::read(root.join("output.7z.002")).unwrap(), b"new-2");
    assert!(!root.join("output.7z.003").exists());
    assert_eq!(
        std::fs::read(root.join("output.7z.2024")).unwrap(),
        b"unrelated"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_named_backup_zero_does_not_collide_with_transaction_backup() {
    let root = temp_root("zinnia-backup-name-collision");
    let stage_dir = root.join(".zinnia-archive-0123456789abcdef0123456789abcdef");
    let staged = stage_dir.join("backup-0");
    let destination = root.join("backup-0");
    std::fs::create_dir_all(&stage_dir).expect("stage");
    std::fs::write(&staged, b"new archive").expect("new archive");
    std::fs::write(&destination, b"old archive").expect("old archive");

    promote_archive_family(&staged, &destination).expect("promotion");

    assert_eq!(std::fs::read(&destination).unwrap(), b"new archive");
    assert!(!archive_backup_path(&stage_dir, 0).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn publish_no_replace_never_deletes_a_destination_it_did_not_create() {
    let root = temp_root("zinnia-publish-race");
    std::fs::create_dir_all(&root).expect("root");
    let source = root.join("source.bin");
    let target = root.join("target.bin");
    std::fs::write(&source, b"staged").expect("source");
    std::fs::write(&target, b"concurrent").expect("target");

    assert!(publish_file_no_replace(&source, &target).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"concurrent");
    assert_eq!(std::fs::read(&source).unwrap(), b"staged");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn exclusive_copy_fallback_preserves_existing_targets_and_source_permissions() {
    let root = temp_root("zinnia-exclusive-copy");
    std::fs::create_dir_all(&root).expect("root");
    let source = root.join("source.bin");
    let target = root.join("target.bin");
    std::fs::write(&source, b"staged archive").expect("source");

    copy_file_no_replace(&source, &target).expect("exclusive copy");
    assert_eq!(std::fs::read(&target).unwrap(), b"staged archive");
    assert_eq!(std::fs::read(&source).unwrap(), b"staged archive");

    std::fs::write(&source, b"replacement").expect("replace source");
    assert!(copy_file_no_replace(&source, &target).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"staged archive");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn kill_error_detection_handles_known_messages() {
    assert!(is_non_running_kill_error("process already finished"));
    assert!(is_non_running_kill_error("child process is not running"));
    assert!(!is_non_running_kill_error("permission denied"));
}

#[test]
fn staged_tree_usage_enforces_entry_and_byte_limits() {
    let root = temp_root("zinnia-quota-test");
    std::fs::create_dir_all(&root).expect("quota test root");
    std::fs::write(root.join("one.bin"), b"1234").expect("first quota file");
    std::fs::write(root.join("two.bin"), b"5678").expect("second quota file");

    assert!(staged_tree_usage(&root, 10, 100).is_ok());
    assert!(staged_tree_usage(&root, 1, 100).is_err());
    assert!(staged_tree_usage(&root, 10, 7).is_err());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn slt_member_preflight_rejects_parent_and_absolute_paths() {
    // Real `7z l -slt -ba` output starts with the first member; it has no
    // leading archive-container Path record.
    let first_member_unsafe = "\
Path = ../sibling/evil.txt
Size = 4
";
    let err = assert_slt_archive_members_safe(first_member_unsafe, "/tmp/archive.7z")
        .expect_err("parent escape");
    assert!(err.contains("../sibling/evil.txt"));

    let absolute = "\
Path = C:\\Users\\a\\a.7z
----------
Path = C:\\Windows\\system32\\evil.dll
Size = 1
";
    #[cfg(target_os = "windows")]
    {
        let err = assert_slt_archive_members_safe(absolute, r"C:\Users\a\a.7z")
            .expect_err("absolute escape");
        assert!(err.contains("evil.dll"));
    }
    #[cfg(not(target_os = "windows"))]
    assert_slt_archive_members_safe(absolute, r"C:\Users\a\a.7z")
        .expect("backslashes and colons are valid Unix member-name characters");

    let safe = "\
Path = /tmp/archive.7z
----------
Path = folder/file.txt
Size = 1
";
    assert_slt_archive_members_safe(safe, "/tmp/archive.7z").expect("safe members");

    assert_slt_archive_members_safe("", "/tmp/empty.7z").expect("empty archive");
    assert!(assert_slt_archive_members_safe("unexpected schema", "/tmp/archive.7z").is_err());
}

#[test]
fn extract_member_list_preserves_password_and_archive_type() {
    let args = vec![
        "x".to_string(),
        "-y".to_string(),
        "-psecret".to_string(),
        "-ttar".to_string(),
        "-o/tmp/out".to_string(),
        "--".to_string(),
        "/tmp/archive.custom".to_string(),
    ];
    #[allow(unused_mut)]
    let mut expected = vec![
        "l",
        "-spd",
        "-slt",
        "-ba",
        "-psecret",
        "-ttar",
        "--",
        "/tmp/archive.custom",
    ];
    #[cfg(target_os = "windows")]
    expected.insert(1, "-sccUTF-8");
    assert_eq!(
        extract_member_list_args(&args).expect("list args"),
        expected
    );
}

#[test]
fn archive_identity_detects_replacement() {
    let root = temp_root("zinnia-archive-identity");
    std::fs::create_dir_all(&root).expect("root");
    let archive = root.join("archive.7z");
    std::fs::write(&archive, b"first").expect("first archive");
    let identity = archive_file_identity(&archive).expect("identity");
    std::fs::write(&archive, b"replacement-content").expect("replacement archive");
    assert!(assert_archive_identity_unchanged(&archive, &identity).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_uses_a_private_archive_snapshot() {
    let root = temp_root("zinnia-archive-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let archive = root.join("archive.7z");
    std::fs::write(&archive, b"original").expect("archive");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&archive, std::fs::Permissions::from_mode(0o644))
            .expect("source archive permissions");
    }
    let snapshot = stage_extract_input(&archive, None).expect("snapshot");
    std::fs::write(&archive, b"changed!").expect("mutate source");
    assert_eq!(
        std::fs::read(&snapshot.path).expect("snapshot data"),
        b"original"
    );
    assert_eq!(snapshot.total_len, 8);
    let stage = snapshot.path.parent().expect("stage");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(stage)
            .expect("snapshot stage metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        let snapshot_mode = std::fs::metadata(&snapshot.path)
            .expect("snapshot file metadata")
            .permissions()
            .mode();
        assert_eq!(snapshot_mode & 0o777, 0o600);
    }
    let _ = std::fs::remove_dir_all(stage);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_snapshot_uses_app_cache_when_available() {
    let root = temp_root("zinnia-archive-snapshot-cache");
    let source = root.join("source");
    let cache = root.join("cache");
    std::fs::create_dir_all(&source).expect("source");
    let archive = source.join("archive.7z");
    std::fs::write(&archive, b"archive").expect("archive");

    let snapshot = stage_extract_input(&archive, Some(&cache)).expect("snapshot");
    let stage = snapshot.path.parent().expect("stage");
    assert_eq!(stage.parent(), Some(cache.as_path()));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_snapshot_collects_split_volume_family() {
    let root = temp_root("zinnia-volume-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.7z.001");
    let second = root.join("archive.7z.002");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&second, b"second").expect("second");
    assert_eq!(
        archive_input_family(&first).expect("family"),
        vec![first.clone(), second.clone()]
    );
    assert!(archive_input_family(&second).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_snapshot_collects_part_rar_family() {
    let root = temp_root("zinnia-part-rar-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.part01.rar");
    let second = root.join("archive.part02.rar");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&second, b"second").expect("second");
    assert_eq!(
        archive_input_family(&first).expect("family"),
        vec![first.clone(), second.clone()]
    );
    assert!(archive_input_family(&second).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_snapshot_collects_split_zip_family_and_total_size() {
    let root = temp_root("zinnia-split-zip-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.z01");
    let second = root.join("archive.z02");
    let final_volume = root.join("archive.zip");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&second, b"second").expect("second");
    std::fs::write(&final_volume, b"final").expect("final");
    assert_eq!(
        archive_input_family(&final_volume).expect("family"),
        vec![first.clone(), second.clone(), final_volume.clone()]
    );
    assert!(archive_input_family(&first).is_err());

    let snapshot = stage_extract_input(&final_volume, None).expect("snapshot");
    assert_eq!(snapshot.total_len, 16);
    let stage = snapshot.path.parent().expect("stage").to_path_buf();
    assert!(stage.join("archive.z01").is_file());
    assert!(stage.join("archive.z02").is_file());
    assert!(stage.join("archive.zip").is_file());
    let _ = std::fs::remove_dir_all(stage);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_snapshot_collects_uppercase_split_zip_family() {
    let root = temp_root("zinnia-uppercase-split-zip-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.Z01");
    let second = root.join("archive.Z02");
    let final_volume = root.join("archive.ZIP");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&second, b"second").expect("second");
    std::fs::write(&final_volume, b"final").expect("final");

    let family = archive_input_family(&final_volume).expect("family");
    assert_eq!(family.len(), 3);
    assert_eq!(
        family[0].canonicalize().unwrap(),
        first.canonicalize().unwrap()
    );
    assert_eq!(
        family[1].canonicalize().unwrap(),
        second.canonicalize().unwrap()
    );
    assert_eq!(
        family[2].canonicalize().unwrap(),
        final_volume.canonicalize().unwrap()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn archive_snapshot_rejects_ambiguous_case_folded_volumes() {
    let root = temp_root("zinnia-ambiguous-split-zip-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let lower = root.join("archive.z01");
    let upper = root.join("archive.Z01");
    let final_volume = root.join("archive.zip");
    std::fs::write(&lower, b"lower").expect("lower");
    std::fs::write(&upper, b"upper").expect("upper");
    std::fs::write(&final_volume, b"final").expect("final");

    let error = archive_input_family(&final_volume).expect_err("ambiguous family");
    assert!(error.contains("ambiguous"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_quota_uses_complete_split_archive_size() {
    let root = temp_root("zinnia-split-family-quota");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.z01");
    let final_volume = root.join("archive.zip");
    std::fs::write(&first, b"12345").expect("first");
    std::fs::write(&final_volume, b"67890").expect("final");
    let destination = root.join("output");
    let args = vec![
        "x".to_string(),
        format!("-o{}", destination.display()),
        "--".to_string(),
        final_volume.to_string_lossy().to_string(),
    ];

    let plan = prepare_cleanup_plan(&args, None).expect("cleanup plan");
    assert_eq!(plan.max_extract_bytes, Some(10_000));
    rollback_cleanup(&plan).expect("rollback");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_snapshot_collects_legacy_rar_family() {
    let root = temp_root("zinnia-legacy-rar-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.rar");
    let second = root.join("archive.r00");
    let third = root.join("archive.r01");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&second, b"second").expect("second");
    std::fs::write(&third, b"third").expect("third");
    assert_eq!(
        archive_input_family(&first).expect("family"),
        vec![first.clone(), second.clone(), third.clone()]
    );
    assert!(archive_input_family(&second).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_snapshot_collects_uppercase_legacy_rar_family() {
    let root = temp_root("zinnia-uppercase-legacy-rar-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.RAR");
    let second = root.join("archive.R00");
    let third = root.join("archive.R01");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&second, b"second").expect("second");
    std::fs::write(&third, b"third").expect("third");

    let family = archive_input_family(&first).expect("family");
    assert_eq!(family.len(), 3);
    assert_eq!(
        family[0].canonicalize().unwrap(),
        first.canonicalize().unwrap()
    );
    assert_eq!(
        family[1].canonicalize().unwrap(),
        second.canonicalize().unwrap()
    );
    assert_eq!(
        family[2].canonicalize().unwrap(),
        third.canonicalize().unwrap()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn pending_stage_registry_round_trips() {
    let cache = temp_root("zinnia-pending-stages");
    std::fs::create_dir_all(&cache).expect("cache");
    let stage = cache.join(".out.zinnia-extract-0123456789abcdef0123456789abcdef");
    register_pending_stage(&cache, &stage).expect("register");
    let listed = read_pending_stages(&cache).expect("read");
    assert_eq!(listed, vec![stage.to_string_lossy().to_string()]);
    unregister_pending_stage(&cache, &stage).expect("unregister");
    assert!(read_pending_stages(&cache).expect("read empty").is_empty());
    let _ = std::fs::remove_dir_all(cache);
}

#[test]
fn unregister_plan_stages_keeps_present_archive_stage() {
    let cache = temp_root("zinnia-keep-pending-cache");
    let root = temp_root("zinnia-keep-pending-stage");
    std::fs::create_dir_all(&cache).expect("cache");
    let stage = root.join(".out.7z.zinnia-archive-0123456789abcdef0123456789abcdef");
    let staged = stage.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(archive_backup_path(&stage, 0), b"old").expect("backup");
    register_pending_stage(&cache, &stage).expect("register");

    let plan = CleanupPlan {
        staged_extract: None,
        staged_archive: Some((staged, root.join("out.7z"))),
        staged_input_archive: None,
        cache_dir: Some(cache.clone()),
        max_extract_bytes: None,
        min_free_bytes: None,
    };
    unregister_plan_stages(&plan);
    assert_eq!(
        read_pending_stages(&cache).expect("still registered"),
        vec![stage.to_string_lossy().to_string()]
    );

    std::fs::remove_dir_all(&stage).expect("remove stage");
    unregister_plan_stages(&plan);
    assert!(read_pending_stages(&cache).expect("cleared").is_empty());

    let _ = std::fs::remove_dir_all(cache);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_windows_file_identity_json_remains_compatible() {
    let identity: super::journal::FileIdentity = serde_json::from_str(
        r#"{"platform":"windows","volume_serial_number":7,"file_index":9}"#,
    )
    .expect("deserialize legacy Windows identity");
    assert_eq!(
        identity,
        super::journal::FileIdentity::Windows {
            volume_serial_number: 7,
            file_index: 9,
            volume_serial_number_64: None,
            file_id_128: None,
        }
    );
}

#[test]
fn windows_file_identity_matching_prefers_recorded_128_bit_id() {
    use super::journal::{file_identities_match, FileIdentity};

    let expected = FileIdentity::Windows {
        volume_serial_number: 7,
        file_index: 9,
        volume_serial_number_64: Some(700),
        file_id_128: Some([1; 16]),
    };
    let same = expected.clone();
    let legacy_fields_only_match = FileIdentity::Windows {
        volume_serial_number: 7,
        file_index: 9,
        volume_serial_number_64: Some(700),
        file_id_128: Some([2; 16]),
    };
    assert!(file_identities_match(&same, &expected));
    assert!(!file_identities_match(&legacy_fields_only_match, &expected));

    let legacy_expected = FileIdentity::Windows {
        volume_serial_number: 7,
        file_index: 9,
        volume_serial_number_64: None,
        file_id_128: None,
    };
    assert!(file_identities_match(&same, &legacy_expected));

    let malformed_partial_expected = FileIdentity::Windows {
        volume_serial_number: 7,
        file_index: 9,
        volume_serial_number_64: Some(700),
        file_id_128: None,
    };
    assert!(!file_identities_match(&same, &malformed_partial_expected));
}

#[test]
fn archive_journal_committed_when_promote_finished_and_stage_empty() {
    let root = temp_root("zinnia-journal-committed");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(&destination, b"published").expect("dest");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&destination).unwrap(),
        )],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: None,
    };
    assert!(archive_journal_is_committed(&journal));
    assert_eq!(std::fs::read(&destination).unwrap(), b"published");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn explicit_extract_phase_controls_cleanup_only_recovery() {
    let destination = std::path::PathBuf::from("root/destination");
    let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    let mut journal = CleanupJournal {
        stage,
        destination,
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::InsideDestination),
        move_plan_sidecar: true,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: None,
        extract_phase: Some(ExtractJournalPhase::InProgress),
        archive_phase: None,
    };
    assert!(!extract_journal_is_committed(&journal));
    journal.extract_phase = Some(ExtractJournalPhase::Committed);
    assert!(extract_journal_is_committed(&journal));
    journal.extract_phase = None;
    assert!(!extract_journal_is_committed(&journal));
}

#[test]
fn missing_new_destination_stage_rolls_back_the_matching_renamed_stage() {
    let root = temp_root("zinnia-missing-new-destination-stage");
    std::fs::create_dir_all(&root).expect("test root");
    let destination = root.join("destination");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&stage).expect("stage");
    std::fs::write(stage.join("new.txt"), b"new").expect("stage file");
    let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
    std::fs::rename(&stage, &destination).expect("simulate whole-stage publish");

    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: true,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(stage_identity),
        extract_phase: Some(ExtractJournalPhase::InProgress),
        archive_phase: None,
    };

    recover_missing_extract_stage(&journal).expect("roll back missing sibling stage");
    assert!(!stage.exists());
    assert!(!destination.exists());
    assert!(!move_plan_path(&stage).exists());
    assert!(!move_identity_log_path(&stage).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn missing_new_destination_stage_preserves_an_identity_mismatch() {
    let root = temp_root("zinnia-missing-new-destination-replacement");
    std::fs::create_dir_all(&root).expect("test root");
    let destination = root.join("destination");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&stage).expect("stage");
    let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
    std::fs::remove_dir(&stage).expect("remove original stage");
    std::fs::create_dir(&destination).expect("replacement destination");
    std::fs::write(destination.join("user.txt"), b"user").expect("replacement content");

    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: true,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(stage_identity),
        extract_phase: Some(ExtractJournalPhase::InProgress),
        archive_phase: None,
    };

    assert!(recover_missing_extract_stage(&journal).is_err());
    assert_eq!(
        std::fs::read(destination.join("user.txt")).expect("preserved replacement"),
        b"user"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn missing_committed_extract_stage_preserves_the_destination() {
    let root = temp_root("zinnia-missing-committed-stage");
    let destination = root.join("destination");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&destination).expect("committed destination");
    std::fs::write(destination.join("published.txt"), b"published")
        .expect("published file");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: true,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: None,
        extract_phase: Some(ExtractJournalPhase::Committed),
        archive_phase: None,
    };

    recover_missing_extract_stage(&journal).expect("committed cleanup-only recovery");
    assert_eq!(
        std::fs::read(destination.join("published.txt")).expect("preserved output"),
        b"published"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_cleanup_preserves_stage_when_sidecar_cleanup_fails() {
    let root = temp_root("zinnia-extract-cleanup-order");
    let destination = root.join("destination");
    let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(stage.join("payload.txt"), b"payload").expect("stage payload");
    // A directory at the sidecar pathname is invalid and cannot be removed as a
    // file. Cleanup must fail before deleting the only remaining stage state.
    std::fs::create_dir(move_plan_path(&stage)).expect("invalid sidecar directory");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination,
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::InsideDestination),
        move_plan_sidecar: true,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: None,
        extract_phase: Some(ExtractJournalPhase::Committed),
        archive_phase: None,
    };

    assert!(cleanup_extract_journal_artifacts(&journal).is_err());
    assert!(stage.is_dir(), "stage was deleted before sidecar cleanup");
    assert_eq!(
        std::fs::read(stage.join("payload.txt")).expect("preserved stage payload"),
        b"payload"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn extraction_recovery_rejects_a_symlinked_move_plan_sidecar() {
    use std::os::unix::fs::symlink;

    let root = temp_root("zinnia-move-plan-symlink");
    let destination = root.join("destination");
    let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&stage).expect("stage");
    let outside = root.join("outside.json");
    std::fs::write(&outside, b"not a move plan").expect("outside file");
    symlink(&outside, move_plan_path(&stage)).expect("symlink sidecar");

    let error = rollback_persisted_move_plan(&stage, &destination, false)
        .expect_err("symlinked sidecar must be rejected");
    assert!(error.contains("sidecar") || error.contains("link"));
    assert_eq!(std::fs::read(&outside).expect("outside file preserved"), b"not a move plan");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_not_committed_while_staged_outputs_remain() {
    let root = temp_root("zinnia-journal-incomplete");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(stage.join("out.7z"), b"staged").expect("staged output");
    std::fs::write(&destination, b"partial").expect("partial dest");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&destination).unwrap(),
        )],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: None,
    };
    assert!(!archive_journal_is_committed(&journal));
    rollback_archive_journal(&journal).expect("rollback partial new archive");
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_preserves_legacy_backup_without_identity() {
    let root = temp_root("zinnia-journal-update");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(archive_backup_path(&stage, 0), b"old").expect("backup");
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&destination).unwrap(),
        )],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    assert!(!archive_journal_is_committed(&journal));
    assert!(rollback_archive_journal(&journal).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"new-partial");
    assert_eq!(
        std::fs::read(archive_backup_path(&stage, 0)).unwrap(),
        b"old"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_restores_identity_verified_backup() {
    let root = temp_root("zinnia-journal-verified-backup");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity(&backup).unwrap();
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let published_identity = super::journal::regular_file_identity(&destination).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(published_identity)],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };

    rollback_archive_journal(&journal).expect("rollback verified update");
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    assert!(!backup.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_rejects_replaced_backup() {
    let root = temp_root("zinnia-journal-replaced-backup");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity(&backup).unwrap();
    let retained_backup = root.join("retained-backup-identity");
    std::fs::hard_link(&backup, &retained_backup).expect("retain backup identity");
    std::fs::remove_file(&backup).expect("remove original backup name");
    std::fs::write(&backup, b"attacker replacement").expect("replacement backup");
    assert_ne!(
        super::journal::regular_file_identity(&backup).unwrap(),
        backup_identity,
        "replacement must not inherit the backup file identity"
    );
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let published_identity = super::journal::regular_file_identity(&destination).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(published_identity)],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };

    assert!(rollback_archive_journal(&journal).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"new-partial");
    assert_eq!(std::fs::read(&backup).unwrap(), b"attacker replacement");
    std::fs::remove_file(retained_backup).expect("release retained backup");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn committed_archive_cleanup_rejects_replaced_backup() {
    let root = temp_root("zinnia-journal-committed-replaced-backup");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity(&backup).unwrap();
    let retained_backup = root.join("retained-backup-identity");
    std::fs::hard_link(&backup, &retained_backup).expect("retain backup identity");
    std::fs::remove_file(&backup).expect("remove original backup name");
    std::fs::write(&backup, b"attacker replacement").expect("replacement backup");
    std::fs::write(&destination, b"new-committed").expect("committed archive");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&destination).unwrap(),
        )],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::Committed),
    };

    assert!(cleanup_committed_archive_journal(&journal).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"new-committed");
    assert_eq!(std::fs::read(&backup).unwrap(), b"attacker replacement");
    assert!(stage.is_dir());
    std::fs::remove_file(retained_backup).expect("release retained backup");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_continues_after_unpublished_volume_identity() {
    // Crash after publishing volume 0 but before recording volume 1's identity
    // must still delete the published volume and restore backups.
    let root = temp_root("zinnia-journal-partial-identities");
    let stage = root.join(".zinnia-archive-abc");
    let first = root.join("out.7z.001");
    let second = root.join("out.7z.002");
    std::fs::create_dir_all(&stage).expect("stage");
    let first_backup = archive_backup_path(&stage, 0);
    let second_backup = archive_backup_path(&stage, 1);
    std::fs::write(&first_backup, b"old-1").expect("backup0");
    std::fs::write(&second_backup, b"old-2").expect("backup1");
    let first_backup_identity = super::journal::regular_file_identity(&first_backup).unwrap();
    let second_backup_identity = super::journal::regular_file_identity(&second_backup).unwrap();
    std::fs::write(&first, b"new-1").expect("published first");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: root.join("out.7z"),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![first.clone(), second.clone()],
        previous_archive_identities: vec![
            Some(first_backup_identity),
            Some(second_backup_identity),
        ],
        next_archive_family: vec![first.clone(), second.clone()],
        next_archive_identities: vec![
            Some(super::journal::regular_file_identity(&first).unwrap()),
            None,
        ],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    rollback_archive_journal(&journal).expect("rollback partial multi-volume");
    assert_eq!(std::fs::read(&first).unwrap(), b"old-1");
    assert_eq!(std::fs::read(&second).unwrap(), b"old-2");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_preserves_published_volume_without_identity() {
    // A legacy or torn journal with no identity cannot prove that the present
    // path is still Zinnia's output. Recovery must preserve it and its backup.
    let root = temp_root("zinnia-journal-unrecorded-publish");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity(&backup).unwrap();
    std::fs::write(&destination, b"new-unrecorded").expect("published");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![None],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    assert!(rollback_archive_journal(&journal).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"new-unrecorded");
    assert_eq!(
        std::fs::read(archive_backup_path(&stage, 0)).unwrap(),
        b"old"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_restores_backup_when_prerecorded_publish_is_missing() {
    // New archive promotion records the staged identity before publishing. A
    // crash before the rename leaves the target absent but the identity filled.
    let root = temp_root("zinnia-journal-prerecorded-missing-publish");
    let stage = root.join(".zinnia-archive-abc");
    let staged = stage.join("out.7z");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(&staged, b"new-staged").expect("staged output");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity(&backup).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&staged).unwrap(),
        )],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    rollback_archive_journal(&journal).expect("restore backup before publish");
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    assert_eq!(std::fs::read(&staged).unwrap(), b"new-staged");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_preserves_a_replacement_output() {
    let root = temp_root("zinnia-journal-replacement");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity(&backup).unwrap();
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let published_identity = super::journal::regular_file_identity(&destination).unwrap();
    // Keep the published inode/file ID allocated while replacing the destination.
    // Otherwise ext4 may reuse it immediately and make this identity-safety test
    // pass or fail based on allocator timing.
    let retained_published_file = root.join("published-identity");
    std::fs::hard_link(&destination, &retained_published_file).expect("retain published file");
    std::fs::remove_file(&destination).expect("remove partial");
    std::fs::write(&destination, b"user replacement").expect("replacement");
    assert_ne!(
        super::journal::regular_file_identity(&destination).unwrap(),
        published_identity,
        "replacement must not inherit the published file identity"
    );
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(published_identity)],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    assert!(rollback_archive_journal(&journal).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"user replacement");
    assert_eq!(
        std::fs::read(archive_backup_path(&stage, 0)).unwrap(),
        b"old"
    );
    std::fs::remove_file(retained_published_file).expect("release retained file");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn explicit_archive_phase_controls_recovery_across_partial_backup_cleanup() {
    let root = temp_root("zinnia-journal-phase");
    let stage = root.join(".zinnia-archive-abc");
    let first = root.join("out.7z.001");
    let second = root.join("out.7z.002");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(&first, b"new-1").expect("first");
    std::fs::write(&second, b"new-2").expect("second");
    let second_backup = archive_backup_path(&stage, 1);
    std::fs::write(&second_backup, b"old-2").expect("remaining backup");
    let second_backup_identity = super::journal::regular_file_identity(&second_backup).unwrap();
    let mut journal = CleanupJournal {
        stage: stage.clone(),
        destination: root.join("out.7z"),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        previous_archive_family: vec![first.clone(), second.clone()],
        previous_archive_identities: vec![None, Some(second_backup_identity)],
        next_archive_family: vec![first.clone(), second.clone()],
        next_archive_identities: vec![
            Some(super::journal::regular_file_identity(&first).unwrap()),
            Some(super::journal::regular_file_identity(&second).unwrap()),
        ],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    assert!(!archive_journal_is_committed(&journal));

    journal.archive_phase = Some(ArchiveJournalPhase::Committed);
    assert!(archive_journal_is_committed(&journal));
    cleanup_committed_archive_journal(&journal).expect("committed cleanup");
    assert_eq!(std::fs::read(&first).unwrap(), b"new-1");
    assert_eq!(std::fs::read(&second).unwrap(), b"new-2");
    assert!(!archive_backup_path(&stage, 1).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn parse_7z_version_reads_common_banners() {
    assert_eq!(
        parse_7z_version("7-Zip 26.02 (x64)\n"),
        Some("26.02".to_string())
    );
    assert_eq!(
        parse_7z_version("7-Zip (z) 24.09 (arm64)\n"),
        Some("24.09".to_string())
    );
    assert_eq!(parse_7z_version("not a banner"), None);
}

#[test]
fn commit_failure_scrub_skips_stages_with_recovery_backups() {
    let root = temp_root("zinnia-scrub-policy");
    let stage = root.join(".out.7z.zinnia-archive-abc");
    let staged = stage.join("out.7z");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(&staged, b"new").expect("staged");
    std::fs::write(archive_backup_path(&stage, 0), b"old").expect("backup");

    let plan_with_backup = CleanupPlan {
        staged_extract: None,
        staged_archive: Some((staged.clone(), destination.clone())),
        staged_input_archive: None,
        cache_dir: None,
        max_extract_bytes: None,
        min_free_bytes: None,
    };
    assert!(archive_stage_has_recovery_backups(&stage));
    assert!(!commit_failure_should_scrub_staging(
        &plan_with_backup,
        "Could not publish archive"
    ));

    std::fs::remove_file(archive_backup_path(&stage, 0)).expect("remove backup");
    assert!(!archive_stage_has_recovery_backups(&stage));
    assert!(commit_failure_should_scrub_staging(
        &plan_with_backup,
        "Could not publish archive"
    ));

    let extract_stage = root.join(".zinnia-extract-abc");
    std::fs::create_dir_all(&extract_stage).expect("extract stage");
    let plan_extract = CleanupPlan {
        staged_extract: Some((extract_stage, root.join("dest"))),
        staged_archive: None,
        staged_input_archive: None,
        cache_dir: None,
        max_extract_bytes: None,
        min_free_bytes: None,
    };
    assert!(!commit_failure_should_scrub_staging(
        &plan_extract,
        "Could not promote staged extraction"
    ));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn version_cmp_orders_numeric_segments() {
    assert_eq!(
        version_cmp("26.03", "26.02"),
        Some(std::cmp::Ordering::Greater)
    );
    assert_eq!(
        version_cmp("26.02", "26.02"),
        Some(std::cmp::Ordering::Equal)
    );
    assert_eq!(
        version_cmp("25.01", "26.02"),
        Some(std::cmp::Ordering::Less)
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_rar_extract_blocked_through_attested_26_02() {
    store_probed_7z_version(Some("26.02".to_string()));
    assert!(windows_rar_extract_blocked());
    store_probed_7z_version(Some("26.03".to_string()));
    assert!(!windows_rar_extract_blocked());
    store_probed_7z_version(None);
    assert!(windows_rar_extract_blocked());
}
