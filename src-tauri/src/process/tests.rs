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
fn extraction_uses_a_staging_directory() {
    let root = temp_root("zinnia-extract-plan-test");
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
    assert_ne!(staged, target);
    rollback_cleanup(&plan).expect("rollback");
    let _ = std::fs::remove_dir_all(root);
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
    let snapshot = stage_extract_input(&archive, None).expect("snapshot");
    std::fs::write(&archive, b"changed!").expect("mutate source");
    assert_eq!(
        std::fs::read(&snapshot.path).expect("snapshot data"),
        b"original"
    );
    assert_eq!(snapshot.total_len, 8);
    let _ = std::fs::remove_dir_all(snapshot.path.parent().expect("stage"));
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
        move_plan_sidecar: false,
        previous_archive_family: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&destination).unwrap(),
        )],
        archive_phase: None,
    };
    assert!(archive_journal_is_committed(&journal));
    assert_eq!(std::fs::read(&destination).unwrap(), b"published");
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
        move_plan_sidecar: false,
        previous_archive_family: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&destination).unwrap(),
        )],
        archive_phase: None,
    };
    assert!(!archive_journal_is_committed(&journal));
    rollback_archive_journal(&journal).expect("rollback partial new archive");
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_restores_backups_for_update() {
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
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity(&destination).unwrap(),
        )],
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    assert!(!archive_journal_is_committed(&journal));
    rollback_archive_journal(&journal).expect("rollback update");
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
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
    std::fs::write(archive_backup_path(&stage, 0), b"old-1").expect("backup0");
    std::fs::write(archive_backup_path(&stage, 1), b"old-2").expect("backup1");
    std::fs::write(&first, b"new-1").expect("published first");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: root.join("out.7z"),
        archive: true,
        move_plan_sidecar: false,
        previous_archive_family: vec![first.clone(), second.clone()],
        next_archive_family: vec![first.clone(), second.clone()],
        next_archive_identities: vec![
            Some(super::journal::regular_file_identity(&first).unwrap()),
            None,
        ],
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    rollback_archive_journal(&journal).expect("rollback partial multi-volume");
    assert_eq!(std::fs::read(&first).unwrap(), b"old-1");
    assert_eq!(std::fs::read(&second).unwrap(), b"old-2");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_clears_published_volume_without_identity() {
    // Crash after publish_file_no_replace but before record_archive_journal_published.
    let root = temp_root("zinnia-journal-unrecorded-publish");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(archive_backup_path(&stage, 0), b"old").expect("backup");
    std::fs::write(&destination, b"new-unrecorded").expect("published");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![None],
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    rollback_archive_journal(&journal).expect("rollback unrecorded publish");
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_preserves_a_replacement_output() {
    let root = temp_root("zinnia-journal-replacement");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(archive_backup_path(&stage, 0), b"old").expect("backup");
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
        move_plan_sidecar: false,
        previous_archive_family: vec![destination.clone()],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(published_identity)],
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
    std::fs::write(archive_backup_path(&stage, 1), b"old-2").expect("remaining backup");
    let mut journal = CleanupJournal {
        stage: stage.clone(),
        destination: root.join("out.7z"),
        archive: true,
        move_plan_sidecar: false,
        previous_archive_family: vec![first.clone(), second.clone()],
        next_archive_family: vec![first.clone(), second.clone()],
        next_archive_identities: vec![
            Some(super::journal::regular_file_identity(&first).unwrap()),
            Some(super::journal::regular_file_identity(&second).unwrap()),
        ],
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
