//! Unit tests for the process module.

use super::archive_snapshot::{
    archive_file_identity, archive_input_family, assert_archive_identity_unchanged,
    stage_extract_input,
};
use super::commands::{settle_archive_finalization, settle_preparation_failure};
use super::commit::copy_file_no_replace;
use super::*;

fn temp_root(prefix: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "{prefix}-{}",
        random_token().expect("random test token")
    ))
}

fn extract_identity(archive: &std::path::Path) -> String {
    archive_identity_token(archive).expect("extract identity token")
}

fn output_identity(path: &std::path::Path) -> String {
    archive_output_family_token(path).expect("output identity token")
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
    if std::env::var_os("ZINNIA_REQUIRE_7Z").is_some() {
        panic!("bundled 7z binary not found (ZINNIA_REQUIRE_7Z=1; run npm run prepare:7z)");
    }
    None
}

fn zips_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("zips")
        .canonicalize()
        .expect("zips/ fixture directory")
}

fn copy_zips_fixture(dest_dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let source = zips_dir().join(name);
    assert!(source.is_file(), "zips/{name} must exist");
    let dest = dest_dir.join(name);
    std::fs::copy(&source, &dest).expect("copy fixture into temp");
    dest
}

fn fixture_payload() -> String {
    std::fs::read_to_string(zips_dir().join("hello.txt")).expect("zips/hello.txt")
}

fn find_named_file(root: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|file_name| file_name == name) {
                return Some(path);
            }
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
fn running_process_is_busy_after_stale_update_reservation_expires() {
    let state = RunningProcess::new();
    assert!(!running_process_is_busy(&state));
    {
        let mut process = lock_process(&state).expect("process lock");
        process.preparing = true;
    }
    assert!(running_process_is_busy(&state));
}

#[test]
fn harden_7z_args_forces_aes256_on_password_zip() {
    let mut args = vec![
        "u".to_string(),
        "-psecret".to_string(),
        "-mem=ZipCrypto".to_string(),
        "out.zip".to_string(),
        "--".to_string(),
        "in.txt".to_string(),
    ];
    super::commands::harden_7z_args(&mut args);
    assert_eq!(
        args.iter()
            .filter(|arg| arg.to_ascii_lowercase().starts_with("-mem="))
            .count(),
        1
    );
    assert!(args
        .iter()
        .any(|arg| arg.eq_ignore_ascii_case("-mem=AES256")));
    assert!(!args
        .iter()
        .any(|arg| arg.eq_ignore_ascii_case("-mem=zipcrypto")));
}

#[test]
fn preparation_failure_release_clears_every_soft_lock_field() {
    let state = RunningProcess::new();
    {
        let mut process = lock_process(&state).expect("process lock");
        process.preparing = true;
        process.cancelling = true;
        process.owner_label = Some("main".to_string());
        process.abort_reason = Some("test".to_string());
    }

    release_preparation_failure_best_effort(&state);

    let process = lock_process(&state).expect("released process lock");
    assert!(process.child.is_none());
    assert!(!process.preparing);
    assert!(!process.cancelling);
    assert!(process.owner_label.is_none());
    assert!(process.abort_reason.is_none());
    assert!(process.cleanup_plan.is_none());
}

#[test]
fn preparation_cleanup_releases_only_after_every_recovery_boundary_succeeds() {
    fn preparing_state() -> RunningProcess {
        RunningProcess(std::sync::Mutex::new(ProcessState {
            preparing: true,
            cancelling: true,
            owner_label: Some("main".to_string()),
            abort_reason: Some("cancelled".to_string()),
            ..ProcessState::idle()
        }))
    }

    let plan = CleanupPlan {
        staged_extract: None,
        staged_archive: None,
        expected_archive_family: Vec::new(),
        staged_input_archive: None,
        cache_dir: None,
        stage_identities: Vec::new(),
        max_extract_bytes: None,
        min_free_bytes: None,
    };

    let cleaned = preparing_state();
    let message =
        settle_preparation_failure(&cleaned, &plan, "operation failed", || Ok(()), || Ok(()));
    assert_eq!(message, "operation failed");
    let cleaned_state = lock_process(&cleaned).expect("cleaned state");
    assert!(ensure_idle(&cleaned_state).is_ok());
    assert!(cleaned_state.cleanup_plan.is_none());
    drop(cleaned_state);

    let rollback_owned = preparing_state();
    let clear_called = std::cell::Cell::new(false);
    let message = settle_preparation_failure(
        &rollback_owned,
        &plan,
        "operation failed",
        || Err("rollback failed".to_string()),
        || {
            clear_called.set(true);
            Ok(())
        },
    );
    assert!(message.contains("operation failed"));
    assert!(message.contains("rollback failed"));
    assert!(
        !clear_called.get(),
        "journal must remain after rollback failure"
    );
    let rollback_state = lock_process(&rollback_owned).expect("rollback-owned state");
    assert!(ensure_idle(&rollback_state).is_err());
    assert!(rollback_state.preparing);
    assert!(rollback_state.cancelling);
    assert_eq!(rollback_state.owner_label.as_deref(), Some("main"));
    assert_eq!(rollback_state.abort_reason.as_deref(), Some("cancelled"));
    assert!(rollback_state.cleanup_plan.is_some());
    drop(rollback_state);

    let journal_owned = preparing_state();
    let message = settle_preparation_failure(
        &journal_owned,
        &plan,
        "operation failed",
        || Ok(()),
        || Err("journal clear failed".to_string()),
    );
    assert!(message.contains("operation failed"));
    assert!(message.contains("journal clear failed"));
    let journal_state = lock_process(&journal_owned).expect("journal-owned state");
    assert!(ensure_idle(&journal_state).is_err());
    assert!(journal_state.preparing);
    assert!(journal_state.cancelling);
    assert_eq!(journal_state.owner_label.as_deref(), Some("main"));
    assert_eq!(journal_state.abort_reason.as_deref(), Some("cancelled"));
    assert!(journal_state.cleanup_plan.is_some());
}

#[test]
fn finalization_releases_only_after_cleanup_completes() {
    fn finalizing_state() -> RunningProcess {
        RunningProcess(std::sync::Mutex::new(ProcessState {
            cancelling: true,
            owner_label: Some("main".to_string()),
            ..ProcessState::idle()
        }))
    }

    let cleaned = finalizing_state();
    let clear_called = std::cell::Cell::new(false);
    let error = settle_archive_finalization(&cleaned, Ok(Err("commit failed".to_string())), || {
        clear_called.set(true);
        Ok(())
    })
    .expect_err("operation error must be preserved");
    assert_eq!(error, "commit failed");
    assert!(clear_called.get());
    assert!(ensure_idle(&lock_process(&cleaned).expect("cleaned state")).is_ok());

    let recovery_owned = finalizing_state();
    let clear_called = std::cell::Cell::new(false);
    let error = settle_archive_finalization(
        &recovery_owned,
        Err("recovery required".to_string()),
        || {
            clear_called.set(true);
            Ok(())
        },
    )
    .expect_err("incomplete cleanup must fail");
    assert_eq!(error, "recovery required");
    assert!(!clear_called.get());
    assert!(ensure_idle(&lock_process(&recovery_owned).expect("owned state")).is_err());

    let journal_owned = finalizing_state();
    let error = settle_archive_finalization(&journal_owned, Ok(Ok(())), || {
        Err("journal retained".to_string())
    })
    .expect_err("journal failure must retain ownership");
    assert_eq!(error, "journal retained");
    assert!(ensure_idle(&lock_process(&journal_owned).expect("journal state")).is_err());
}

#[test]
fn rollback_cleanup_reports_pending_registry_failure() {
    let root = temp_root("zinnia-rollback-registry-failure");
    let cache = root.join("cache");
    std::fs::create_dir_all(&cache).expect("cache directory");
    let anchor = root.join("archive.7z");
    std::fs::write(&anchor, b"archive").expect("archive input");
    let created =
        create_private_stage_dir(&anchor, "input", Some(&cache)).expect("registered input stage");
    std::fs::write(cache.join("pending-stages.json"), b"{")
        .expect("corrupt pending-stage registry");
    let staged_input = created.path.join("archive.7z");
    let plan = CleanupPlan {
        staged_extract: None,
        staged_archive: None,
        expected_archive_family: Vec::new(),
        staged_input_archive: Some(staged_input),
        cache_dir: Some(cache),
        stage_identities: vec![(created.path.clone(), created.identity)],
        max_extract_bytes: None,
        min_free_bytes: None,
    };

    let error = rollback_cleanup(&plan).expect_err("registry failure must retain ownership");
    assert!(
        error.contains("expected a sequence") || error.contains("invalid type"),
        "unexpected error: {error}"
    );
    assert!(
        created.path.exists(),
        "stage must remain while its durable artifact identities cannot be read"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extract_injects_snld10_for_nested_framework_symlinks() {
    let mut args = vec![
        "x".to_string(),
        "-aou".to_string(),
        "-o/tmp/out".to_string(),
        "--".to_string(),
        "archive.zip".to_string(),
    ];
    apply_backend_link_switches(&mut args);
    assert!(
        args.iter().any(|arg| arg == "-snld10"),
        "extract must inject -snld10: {args:?}"
    );
    assert_eq!(
        args.iter()
            .filter(|arg| arg.to_ascii_lowercase().starts_with("-snld"))
            .count(),
        1,
        "exactly one -snld* switch: {args:?}"
    );
}

#[test]
fn extract_forces_backend_snld10_over_caller_level() {
    let mut args = vec![
        "x".to_string(),
        "-snld20".to_string(),
        "-aou".to_string(),
        "-o/tmp/out".to_string(),
        "--".to_string(),
        "archive.zip".to_string(),
    ];
    apply_backend_link_switches(&mut args);
    assert!(args.iter().any(|arg| arg == "-snld10"));
    assert!(!args.iter().any(|arg| arg == "-snld20"));
}

#[test]
fn create_still_injects_snl_and_snh() {
    let mut args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        "out.7z".to_string(),
        "--".to_string(),
        "input.txt".to_string(),
    ];
    apply_backend_link_switches(&mut args);
    assert!(args.iter().any(|arg| arg.eq_ignore_ascii_case("-snl")));
    assert!(args.iter().any(|arg| arg.eq_ignore_ascii_case("-snh")));
    assert!(!args
        .iter()
        .any(|arg| arg.to_ascii_lowercase().starts_with("-snld")));
}

#[test]
fn compound_tar_operations_are_detected_for_extract_list_and_test() {
    for command in ["x", "l", "t"] {
        let args = vec![
            command.to_string(),
            "--".to_string(),
            "/tmp/source.TAR.GZ".to_string(),
        ];
        assert!(is_compound_tar_operation(&args), "{command}");
    }
    assert!(!is_compound_tar_operation(&[
        "x".to_string(),
        "--".to_string(),
        "/tmp/source.gz".to_string(),
    ]));
}

#[test]
fn compound_tar_outer_unpack_accepts_metadata_only_exit_one() {
    assert!(compound_tar_outer_unpack_ok(0, "", ""));
    assert!(compound_tar_outer_unpack_ok(
        1,
        "WARNING: There are data after the end of archive",
        ""
    ));
    assert!(!compound_tar_outer_unpack_ok(
        1,
        "Warnings: 1",
        "WARNING: CRC Failed"
    ));
    assert!(!compound_tar_outer_unpack_ok(
        2,
        "",
        "ERROR: broken archive"
    ));
}

#[test]
fn compound_tar_outer_extract_args_harden_and_link_policy() {
    let args = compound_tar_outer_extract_args(
        std::path::Path::new("/tmp/source.tar.gz"),
        std::path::Path::new("/tmp/outer-stage"),
    );
    assert_eq!(args.first().map(String::as_str), Some("x"));
    assert!(args.iter().any(|arg| arg.eq_ignore_ascii_case("-snld10")));
    assert!(args.iter().any(|arg| arg == "--"));
    #[cfg(not(target_os = "windows"))]
    assert!(args.iter().any(|arg| arg.eq_ignore_ascii_case("-spod")));
    #[cfg(target_os = "windows")]
    {
        assert!(args.iter().any(|arg| arg.eq_ignore_ascii_case("-sccUTF-8")));
        assert!(args.iter().any(|arg| arg.eq_ignore_ascii_case("-snz")));
        assert!(args.iter().any(|arg| arg.eq_ignore_ascii_case("-sns-")));
    }
    let source = include_str!("commands.rs");
    assert!(source.contains("compound_tar_outer_extract_args(&snapshot, &outer_stage)"));
    assert!(
        source.contains("compound_tar_outer_unpack_ok(code, &collected.stdout, &collected.stderr)")
    );
}

#[test]
fn exit_one_publish_allows_only_known_metadata_warnings() {
    assert!(extract_warning_is_metadata_only(
        "Warnings: 1",
        "WARNING: Cannot set file time"
    ));
    assert!(extract_warning_is_metadata_only(
        "WARNING: There are data after the end of archive",
        ""
    ));
    assert!(!extract_warning_is_metadata_only(
        "Warnings: 1",
        "WARNING: CRC Failed"
    ));
    assert!(!extract_warning_is_metadata_only(
        "Warnings: 1",
        "WARNING: something new and unknown"
    ));
    assert!(!extract_warning_is_metadata_only(
        "WARNING: Cannot set file time",
        "ERROR: Dangerous link path was ignored"
    ));
    assert!(!extract_warning_is_metadata_only(
        "WARNING: Cannot set file time",
        "WARNING: unknown second problem"
    ));
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
    terminate_child(&child).expect("terminate child");
    assert!(child.try_wait().expect("poll reaped child").is_some());
}

#[test]
fn interpret_terminate_wait_treats_timeout_as_failure() {
    assert!(interpret_terminate_wait(Ok(None)).is_err());
}

#[test]
fn finalize_preparation_error_keeps_slot_when_child_is_still_running() {
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
    let state = RunningProcess(std::sync::Mutex::new({
        let mut process = ProcessState::idle();
        process.child = Some(child.clone());
        process.preparing = true;
        process.cancelling = true;
        process.owner_label = Some("main".to_string());
        process.abort_reason = Some("cancelled".to_string());
        process
    }));
    let plan = CleanupPlan {
        staged_extract: None,
        staged_archive: None,
        expected_archive_family: Vec::new(),
        staged_input_archive: None,
        cache_dir: None,
        stage_identities: Vec::new(),
        max_extract_bytes: None,
        min_free_bytes: None,
    };
    let message = finalize_preparation_error(&state, &plan, None, "stream error");
    assert!(
        message.contains("still running"),
        "unexpected finalize message: {message}"
    );
    {
        let process = state.0.lock().expect("process lock");
        assert!(process.child.is_some(), "live child must stay in the slot");
        assert!(process.preparing, "prepare slot must stay reserved");
        assert!(
            process.cancelling,
            "cancellation ownership must be retained"
        );
        assert_eq!(process.owner_label.as_deref(), Some("main"));
        assert_eq!(process.abort_reason.as_deref(), Some("cancelled"));
        assert!(
            process.cleanup_plan.is_some(),
            "cleanup plan must be checkpointed"
        );
    }
    terminate_child(&child).expect("reap test child");
}

#[test]
fn stream_error_does_not_fake_child_exit() {
    tauri::async_runtime::block_on(async {
        let (tx, mut rx) =
            tauri::async_runtime::channel::<tauri_plugin_shell::process::CommandEvent>(4);
        tx.send(tauri_plugin_shell::process::CommandEvent::Error(
            "broken pipe".to_string(),
        ))
        .await
        .expect("send stream error");
        drop(tx);
        let collected = collect_command_output(&mut rx, 1024, |_| {}).await;
        assert!(
            collected.exit.is_none(),
            "a stream error must not be treated as child death"
        );
        assert_eq!(collected.stream_error.as_deref(), Some("broken pipe"));
    });
}

#[test]
fn truncated_output_never_authorizes_exit_one_acceptance() {
    tauri::async_runtime::block_on(async {
        let (tx, mut rx) =
            tauri::async_runtime::channel::<tauri_plugin_shell::process::CommandEvent>(4);
        tx.send(tauri_plugin_shell::process::CommandEvent::Stdout(
            b"WARNING: Cannot set ACL\n".to_vec(),
        ))
        .await
        .expect("send stdout");
        tx.send(tauri_plugin_shell::process::CommandEvent::Terminated(
            tauri_plugin_shell::process::TerminatedPayload {
                code: Some(1),
                signal: None,
            },
        ))
        .await
        .expect("send exit");
        drop(tx);
        let collected = collect_command_output(&mut rx, 4, |_| {}).await;
        assert!(collected.stdout_truncated);
        assert!(!collected.accepts_exit_one_with(|_, _| true));
    });
}

#[test]
fn stale_update_reservation_does_not_block_quit_after_ttl() {
    let mut process = ProcessState::idle();
    process.preparing = true;
    process.abort_reason = Some("Installing application update".to_string());
    process.update_reserved_at = Some(
        std::time::Instant::now()
            .checked_sub(UPDATE_RESERVATION_TTL + std::time::Duration::from_secs(1))
            .expect("reservation instant"),
    );
    assert!(process.blocks_quit_for_update_install());
    process.expire_stale_update_reservation();
    assert!(!process.blocks_quit_for_update_install());
    assert!(!process.preparing);
    assert!(process.update_reserved_at.is_none());
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
fn archive_update_rejects_a_changed_selected_archive() {
    let root = temp_root("zinnia-update-identity");
    std::fs::create_dir_all(&root).expect("root");
    let archive = root.join("archive.7z");
    let input = root.join("input.txt");
    std::fs::write(&archive, b"old archive bytes").expect("archive");
    std::fs::write(&input, b"input").expect("input");
    let identity = archive_identity_token(&archive).expect("identity");
    std::fs::write(&archive, b"replacement archive bytes").expect("replacement");
    let args = vec![
        "u".to_string(),
        archive.to_string_lossy().to_string(),
        "--".to_string(),
        input.to_string_lossy().to_string(),
    ];

    let error = prepare_cleanup_plan(&args, None, Some(&identity))
        .expect_err("changed archive must not be updated");
    assert!(error.contains("changed after it was selected"));
    assert_eq!(
        std::fs::read(&archive).expect("archive remains"),
        b"replacement archive bytes"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn create_password_transport_uses_one_bare_prompt_without_secret_in_argv() {
    for command in ["a", "u"] {
        let mut args = vec![
            command.to_string(),
            "-t7z".to_string(),
            "-pPASSWORD".to_string(),
            "archive.7z".to_string(),
            "--".to_string(),
            "-preserved-input-name".to_string(),
        ];

        let password = prepare_password_transport(&mut args).expect("password transport");

        assert_eq!(password.as_deref(), Some("PASSWORD"));
        assert_eq!(args.get(1).map(String::as_str), Some("-p"));
        assert_eq!(
            args.iter()
                .filter(|arg| arg.eq_ignore_ascii_case("-p"))
                .count(),
            1
        );
        assert!(!args.iter().any(|arg| arg.contains("PASSWORD")));
        assert!(args.iter().any(|arg| arg == "-preserved-input-name"));
    }
}

#[test]
fn password_transport_rejects_duplicate_attached_password_switches() {
    let mut args = vec![
        "a".to_string(),
        "-pone".to_string(),
        "-pTWO".to_string(),
        "archive.7z".to_string(),
        "--".to_string(),
        "input.txt".to_string(),
    ];
    let original = args.clone();

    assert_eq!(
        prepare_password_transport(&mut args),
        Err("Password switch may appear only once.".to_string())
    );
    assert_eq!(args, original);
}

#[test]
fn password_transport_preserves_password_like_paths_after_separator() {
    let mut args = vec![
        "u".to_string(),
        "-psecret".to_string(),
        "archive.7z".to_string(),
        "--".to_string(),
        "-pinput-name".to_string(),
    ];

    let password = prepare_password_transport(&mut args).expect("password transport");

    assert_eq!(password.as_deref(), Some("secret"));
    assert_eq!(args, ["u", "-p", "archive.7z", "--", "-pinput-name"]);
}

#[test]
fn password_transport_rejects_line_breaks() {
    for password_arg in ["-pfirst\nsecond", "-pfirst\rsecond"] {
        let mut args = vec![
            "a".to_string(),
            password_arg.to_string(),
            "archive.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];

        assert_eq!(
            prepare_password_transport(&mut args),
            Err("Archive passwords cannot contain line breaks.".to_string())
        );
    }
}

#[test]
fn password_transport_collapses_bare_duplicates_without_inventing_a_secret() {
    let mut args = vec![
        "a".to_string(),
        "-p".to_string(),
        "-P".to_string(),
        "archive.7z".to_string(),
        "--".to_string(),
        "input.txt".to_string(),
    ];

    let password = prepare_password_transport(&mut args).expect("password transport");

    assert_eq!(password, None);
    assert_eq!(
        args.iter()
            .filter(|arg| arg.eq_ignore_ascii_case("-p"))
            .count(),
        1
    );
}

#[test]
fn password_transport_treats_empty_attached_password_as_bare_prompt() {
    let mut args = vec![
        "a".to_string(),
        "-p".to_string(),
        "archive.7z".to_string(),
        "--".to_string(),
        "input.txt".to_string(),
    ];

    let password = prepare_password_transport(&mut args).expect("password transport");

    assert_eq!(password, None);
    assert_eq!(args, ["a", "-p", "archive.7z", "--", "input.txt"]);
}

#[test]
fn read_password_transport_relies_on_automatic_prompt() {
    for command in ["l", "t", "x"] {
        let mut args = vec![
            command.to_string(),
            "-psecret-value".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];

        let password = prepare_password_transport(&mut args).expect("password transport");

        assert_eq!(password.as_deref(), Some("secret-value"));
        assert!(!args.iter().any(|arg| arg.starts_with("-p")));
        assert!(!args.iter().any(|arg| arg.contains("secret-value")));
    }
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
fn existing_extraction_destination_stages_beside_destination() {
    let root = temp_root("zinnia-extract-existing-plan-test");
    std::fs::create_dir_all(&root).expect("test directory");
    let archive = root.join("archive.7z");
    std::fs::write(&archive, b"archive").expect("test archive");
    let destination = root.join("existing-dest");
    std::fs::create_dir_all(&destination).expect("existing destination");
    let args = vec![
        "x".to_string(),
        format!("-o{}", destination.display()),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let identity = extract_identity(&archive);
    let plan = prepare_cleanup_plan(&args, None, Some(&identity)).expect("cleanup plan");
    let (staged, target) = plan.staged_extract.clone().expect("staging plan");
    assert_eq!(staged.parent(), target.parent());
    assert_ne!(staged.parent(), Some(target.as_path()));
    assert_eq!(
        ExtractStagePlacement::from_paths(&staged, &target),
        Ok(ExtractStagePlacement::Sibling)
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
    let identity = extract_identity(&archive);
    let plan = prepare_cleanup_plan(&args, None, Some(&identity)).expect("cleanup plan");
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
        prepare_cleanup_plan(&existing_args, None, Some(&extract_identity(&archive)))
            .expect("existing destination plan");
    let (existing_stage, existing_target) = existing_plan
        .staged_extract
        .as_ref()
        .expect("existing stage");
    assert_eq!(existing_stage.parent(), existing_target.parent());
    assert!(existing_target.is_absolute());
    rollback_cleanup(&existing_plan).expect("existing rollback");

    let new_destination = volume_root.join("new");
    let new_args = vec![
        "x".to_string(),
        format!("-o{}", new_destination.display()),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let new_plan = prepare_cleanup_plan(&new_args, None, Some(&extract_identity(&archive)))
        .expect("new destination plan");
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
        super::commands::apply_backend_link_switches(&mut args);

        let plan = prepare_cleanup_plan(
            &args,
            Some(cache.clone()),
            Some(&extract_identity(&archive)),
        )
        .expect("prepare production plan");
        let staged_snapshot = plan
            .staged_input_archive
            .as_ref()
            .expect("private archive snapshot");
        let (staged_output, resolved_destination) =
            plan.staged_extract.as_ref().expect("publish stage");
        assert_eq!(staged_output.parent(), resolved_destination.parent());
        assert_ne!(staged_output.parent(), Some(resolved_destination.as_path()));

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
fn real_7z_extracts_zips_hello_7z_through_snapshot_publish() {
    let Some(binary) = bundled_7z_test_binary() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };
    let root = temp_root("zinnia-fixture-7z");
    let cache = root.join("cache");
    std::fs::create_dir_all(&root).expect("root");
    let archive = copy_zips_fixture(&root, "hello.7z");
    let destination = root.join("out");
    let mut args = vec![
        "x".to_string(),
        "-aou".to_string(),
        format!("-o{}", destination.display()),
        "--".to_string(),
        archive.to_string_lossy().into_owned(),
    ];
    crate::validation::validate_run_7z_args(&args).expect("valid extract arguments");
    super::commands::harden_7z_args(&mut args);
    super::commands::apply_backend_link_switches(&mut args);

    let plan = prepare_cleanup_plan(&args, Some(cache), Some(&extract_identity(&archive)))
        .expect("prepare plan");
    let staged_snapshot = plan
        .staged_input_archive
        .as_ref()
        .expect("private archive snapshot");
    let (staged_output, resolved_destination) =
        plan.staged_extract.as_ref().expect("publish stage");
    let mut execution_args = args.clone();
    super::staging::rewrite_extract_archive(&mut execution_args, staged_snapshot)
        .expect("rewrite snapshot input");
    super::staging::rewrite_extract_output(&mut execution_args, staged_output)
        .expect("rewrite publish stage");
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
    let published = find_named_file(&destination, "hello.txt").expect("published hello.txt");
    assert_eq!(
        std::fs::read_to_string(published).unwrap(),
        fixture_payload()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn real_7z_extracts_zips_hello_tar_gz_through_compound_two_pass() {
    let Some(binary) = bundled_7z_test_binary() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };
    let root = temp_root("zinnia-fixture-tgz");
    let cache = root.join("cache");
    std::fs::create_dir_all(&root).expect("root");
    let archive = copy_zips_fixture(&root, "hello.tar.gz");
    let destination = root.join("out");
    let mut args = vec![
        "x".to_string(),
        "-aou".to_string(),
        format!("-o{}", destination.display()),
        "--".to_string(),
        archive.to_string_lossy().into_owned(),
    ];
    crate::validation::validate_run_7z_args(&args).expect("valid extract arguments");
    super::commands::harden_7z_args(&mut args);
    super::commands::apply_backend_link_switches(&mut args);
    assert!(
        is_compound_tar_operation(&args),
        "hello.tar.gz must use the compound TAR path"
    );

    let plan = prepare_cleanup_plan(&args, Some(cache), Some(&extract_identity(&archive)))
        .expect("prepare plan");
    let staged_snapshot = plan
        .staged_input_archive
        .as_ref()
        .expect("private archive snapshot");
    let (staged_output, resolved_destination) =
        plan.staged_extract.as_ref().expect("publish stage");
    let snapshot_parent = staged_snapshot.parent().expect("snapshot parent");
    let outer_stage = snapshot_parent.join("outer");
    std::fs::create_dir_all(&outer_stage).expect("outer stage");
    let outer_args = compound_tar_outer_extract_args(staged_snapshot, &outer_stage);
    let outer = std::process::Command::new(&binary)
        .args(&outer_args)
        .output()
        .expect("outer extract");
    assert!(
        compound_tar_outer_unpack_ok(
            outer.status.code().unwrap_or(1),
            &String::from_utf8_lossy(&outer.stdout),
            &String::from_utf8_lossy(&outer.stderr)
        ),
        "outer compound extract failed: {}",
        String::from_utf8_lossy(&outer.stderr)
    );
    let inner_tar = find_named_file(&outer_stage, "hello.tar").expect("inner hello.tar");
    std::fs::create_dir_all(staged_output).expect("inner stage");
    let inner = std::process::Command::new(&binary)
        .args(["x", &format!("-o{}", staged_output.display()), "-aou", "--"])
        .arg(&inner_tar)
        .output()
        .expect("inner extract");
    assert!(
        inner.status.success(),
        "inner tar extract failed: {}",
        String::from_utf8_lossy(&inner.stderr)
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
    let published = find_named_file(&destination, "hello.txt").expect("published hello.txt");
    assert_eq!(
        std::fs::read_to_string(published).unwrap(),
        fixture_payload()
    );
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
    let create_plan = prepare_cleanup_plan(
        &create_args,
        Some(cache.clone()),
        Some(ARCHIVE_OUTPUT_ABSENT_TOKEN),
    )
    .expect("prepare create plan");
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
    let update_plan = prepare_cleanup_plan(
        &update_args,
        Some(cache),
        Some(&output_identity(&destination)),
    )
    .expect("prepare update plan");
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(super::journal::FileIdentity::Unix {
            device: 1,
            inode: 2,
            fingerprint: None,
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
    assert_eq!(decoded.extract_phase, Some(ExtractJournalPhase::InProgress));
    assert_eq!(
        decoded.extract_stage_identity,
        journal.extract_stage_identity
    );
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
        move_plan_identity: None,
        move_identity_log_identity: None,
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
    legacy
        .as_object_mut()
        .expect("journal object")
        .remove("move_plan_identity");
    legacy
        .as_object_mut()
        .expect("journal object")
        .remove("move_identity_log_identity");
    let decoded: CleanupJournal = serde_json::from_value(legacy).expect("decode legacy journal");
    assert_eq!(decoded.extract_stage_placement, None);
    assert_eq!(decoded.extract_phase, None);
    assert_eq!(decoded.extract_stage_identity, None);
    assert_eq!(decoded.move_plan_identity, None);
    assert_eq!(decoded.move_identity_log_identity, None);
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
    let plan =
        prepare_cleanup_plan(&args, None, Some(&output_identity(&target))).expect("cleanup plan");
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

#[cfg(unix)]
#[test]
fn merge_publish_applies_destination_parent_mode_to_directories() {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    let root = temp_root("zinnia-merge-dir-mode");
    let destination = root.join("destination");
    std::fs::DirBuilder::new()
        .mode(0o755)
        .recursive(true)
        .create(&destination)
        .expect("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&staged)
        .expect("private stage");
    let nested = staged.join("folder");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&nested)
        .expect("private nested dir");
    std::fs::write(nested.join("file.txt"), b"payload").expect("nested file");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).expect("merge");

    let published = destination.join("folder");
    let mode = std::fs::metadata(&published)
        .expect("published dir")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o755,
        "merged directory must inherit destination mode"
    );
    assert_eq!(
        std::fs::read(published.join("file.txt")).expect("file"),
        b"payload"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn create_refuses_output_that_appeared_after_absent_selection() {
    let root = temp_root("zinnia-create-absent-toctou");
    std::fs::create_dir_all(&root).expect("test directory");
    let input = root.join("input.txt");
    std::fs::write(&input, b"payload").expect("input");
    let destination = root.join("converted.7z");
    // Selection snapshotted "absent", but the path exists when create prepares.
    std::fs::write(&destination, b"race").expect("raced output");
    let args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        destination.to_string_lossy().to_string(),
        "--".to_string(),
        input.to_string_lossy().to_string(),
    ];
    let error = prepare_cleanup_plan(&args, None, Some("absent"))
        .expect_err("absent selection must refuse a newly present output");
    assert!(
        error.contains("appeared after it was selected"),
        "unexpected error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn create_accepts_absent_selection_when_output_still_missing() {
    let root = temp_root("zinnia-create-absent-ok");
    std::fs::create_dir_all(&root).expect("test directory");
    let input = root.join("input.txt");
    std::fs::write(&input, b"payload").expect("input");
    let destination = root.join("converted.7z");
    let args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        destination.to_string_lossy().to_string(),
        "--".to_string(),
        input.to_string_lossy().to_string(),
    ];
    let plan = prepare_cleanup_plan(&args, None, Some("absent")).expect("absent create plan");
    assert!(plan.expected_archive_family.is_empty());
    rollback_cleanup(&plan).expect("rollback");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn create_refuses_split_volume_that_appeared_after_absent_selection() {
    let root = temp_root("zinnia-create-split-toctou");
    std::fs::create_dir_all(&root).expect("test directory");
    let input = root.join("input.txt");
    std::fs::write(&input, b"payload").expect("input");
    let destination = root.join("converted.7z");
    std::fs::write(root.join("converted.7z.001"), b"race").expect("raced volume");
    let args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        destination.to_string_lossy().to_string(),
        "--".to_string(),
        input.to_string_lossy().to_string(),
    ];
    let error = prepare_cleanup_plan(&args, None, Some(ARCHIVE_OUTPUT_ABSENT_TOKEN))
        .expect_err("absent selection must refuse a newly present split volume");
    assert!(
        error.contains("appeared after it was selected"),
        "unexpected error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_output_family_token_covers_split_volumes() {
    let root = temp_root("zinnia-family-token");
    std::fs::create_dir_all(&root).expect("test directory");
    let destination = root.join("converted.7z");
    let first = root.join("converted.7z.001");
    let second = root.join("converted.7z.002");
    std::fs::write(&first, b"one").expect("volume 1");
    std::fs::write(&second, b"two").expect("volume 2");
    let token = archive_output_family_token(&destination).expect("family token");
    assert_ne!(token, ARCHIVE_OUTPUT_ABSENT_TOKEN);
    std::fs::write(&first, b"changed").expect("mutate volume");
    let changed = archive_output_family_token(&destination).expect("changed family token");
    assert_ne!(token, changed);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_commit_point_precedes_stage_cleanup() {
    let root = temp_root("zinnia-extract-commit-point");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("new.txt"), b"new").expect("staged file");
    let stage_identity = super::journal::path_identity(&staged).expect("stage identity");
    let committed = std::cell::Cell::new(false);

    merge_staged_extract_with_commit(
        &staged,
        &destination,
        &stage_identity,
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
    let stage_identity = super::journal::path_identity(&staged).expect("stage identity");

    let error = merge_staged_extract_with_commit(
        &staged,
        &destination,
        &stage_identity,
        MAX_EXTRACTED_BYTES,
        || Err("journal write failed".to_string()),
    )
    .expect_err("commit marker failure must abort");

    assert!(error.contains("journal write failed"));
    assert_eq!(
        std::fs::read(&source).expect("restored staged source"),
        b"new"
    );
    assert!(!destination.join("new.txt").exists());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_file(move_identity_log_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_commit_marker_failure_preserves_new_destination_for_recovery() {
    let root = temp_root("zinnia-new-extract-commit-rollback");
    let destination = root.join("destination");
    let staged = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("new.txt"), b"new").expect("staged file");
    let stage_identity = super::journal::path_identity(&staged).expect("stage identity");

    let error = merge_staged_extract_with_commit(
        &staged,
        &destination,
        &stage_identity,
        MAX_EXTRACTED_BYTES,
        || Err("journal write failed".to_string()),
    )
    .expect_err("commit marker failure must abort");

    assert!(error.contains("journal write failed"));
    assert!(error.contains("preserved"));
    assert!(!staged.exists());
    assert_eq!(
        std::fs::read(destination.join("new.txt")).expect("preserved destination"),
        b"new"
    );
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
    assert!(std::fs::metadata(&published)
        .unwrap()
        .permissions()
        .readonly());
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
fn contained_dangling_symlink_publishes_into_existing_destination() {
    use std::os::unix::fs::symlink;

    let root = temp_root("zinnia-dangling-symlink-publish");
    let staged = root.join(".zinnia-extract-test");
    let destination = root.join("out");
    std::fs::create_dir_all(&staged).expect("stage");
    std::fs::create_dir_all(&destination).expect("destination");
    symlink("generated-later.txt", staged.join("current")).expect("dangling link");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect("contained dangling link should publish");
    assert_eq!(
        std::fs::read_link(destination.join("current")).expect("published link"),
        std::path::PathBuf::from("generated-later.txt")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
fn try_windows_symlink_file(target: &str, link: &std::path::Path) -> Result<(), String> {
    match std::os::windows::fs::symlink_file(target, link) {
        Ok(()) => Ok(()),
        Err(error) => {
            if std::env::var_os("ZINNIA_REQUIRE_WINDOWS_SYMLINK_TESTS").is_some() {
                panic!(
                    "Windows symlink creation failed while ZINNIA_REQUIRE_WINDOWS_SYMLINK_TESTS is set: {error}"
                );
            }
            Err(error.to_string())
        }
    }
}

#[cfg(windows)]
#[test]
fn contained_dangling_symlink_publishes_into_existing_destination_windows() {
    let root = temp_root("zinnia-dangling-symlink-publish-win");
    let staged = root.join(".zinnia-extract-test");
    let destination = root.join("out");
    std::fs::create_dir_all(&staged).expect("stage");
    std::fs::create_dir_all(&destination).expect("destination");
    let link = staged.join("current");
    if let Err(error) = try_windows_symlink_file("generated-later.txt", &link) {
        eprintln!(
            "skipping contained_dangling_symlink_publishes_into_existing_destination_windows: {error} (enable Developer Mode or set ZINNIA_REQUIRE_WINDOWS_SYMLINK_TESTS=1)"
        );
        let _ = std::fs::remove_dir_all(root);
        return;
    }

    let entry = super::journal::path_entry_identity(&link)
        .expect("Windows symlink entry identity must succeed");
    let fingerprinted = super::journal::path_identity_with_fingerprint(&link)
        .expect("Windows symlink fingerprint must succeed");
    assert!(
        super::journal::file_identities_match(&entry, &fingerprinted),
        "entry identity and fingerprinted identity must match"
    );
    assert!(
        super::journal::path_identity(&link).is_err(),
        "regular path_identity must keep rejecting symlink reparse points"
    );

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect("contained dangling link should publish on Windows");
    assert_eq!(
        std::fs::read_link(destination.join("current")).expect("published link"),
        std::path::PathBuf::from("generated-later.txt")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn nested_symlink_directory_merges_into_existing_destination_windows() {
    let root = temp_root("zinnia-nested-symlink-merge-win");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(staged.join("tree")).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination");
    std::fs::write(staged.join("tree/payload.txt"), b"nested").expect("payload");
    let link = staged.join("tree/current");
    if let Err(error) = try_windows_symlink_file("payload.txt", &link) {
        eprintln!(
            "skipping nested_symlink_directory_merges_into_existing_destination_windows: {error} (enable Developer Mode or set ZINNIA_REQUIRE_WINDOWS_SYMLINK_TESTS=1)"
        );
        let _ = std::fs::remove_dir_all(root);
        return;
    }

    assert!(
        staged_tree_contains_symlink(&staged.join("tree")).expect("scan tree"),
        "helper must detect nested symlink before publish planning"
    );
    assert!(
        !staged_tree_contains_symlink(&destination).expect("empty destination"),
        "destination without links must scan clean"
    );

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect("directory containing a symlink must merge-publish on Windows");
    assert_eq!(
        std::fs::read(destination.join("tree/payload.txt")).expect("payload"),
        b"nested"
    );
    assert_eq!(
        std::fs::read_link(destination.join("tree/current")).expect("published nested link"),
        std::path::PathBuf::from("payload.txt")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn staged_tree_without_symlinks_is_reported_clean() {
    let root = temp_root("zinnia-tree-scan-clean");
    std::fs::create_dir_all(root.join("nested")).expect("tree");
    std::fs::write(root.join("nested/file.txt"), b"ok").expect("file");
    assert!(!staged_tree_contains_symlink(&root).expect("scan"));
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
fn staged_absolute_symlink_remapped_under_extract_root_is_still_rejected() {
    // 7-Zip -snld10 can rewrite absolute archive links so they point at an
    // absolute path under `-o` and still exit 0. Publish must keep rejecting
    // absolute symlink targets.
    use std::os::unix::fs::symlink;
    let root = temp_root("zinnia-abs-symlink-remap");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(staged.join("safe")).expect("staged tree");
    std::fs::write(staged.join("safe/a.txt"), b"ok").expect("payload");
    symlink(staged.join("etc/passwd"), staged.join("safe/abs-link"))
        .expect("absolute remapped link");

    let error = merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect_err("absolute remapped link must fail closed");
    assert!(
        error.contains("absolute symbolic link"),
        "unexpected error: {error}"
    );
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn staged_in_tree_hardlinks_are_allowed() {
    let root = temp_root("zinnia-hardlink-ok");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("a.txt"), b"shared").expect("payload");
    std::fs::hard_link(staged.join("a.txt"), staged.join("a-hard.txt")).expect("hard link");

    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).expect("in-tree hardlinks ok");
    assert_eq!(
        std::fs::read(destination.join("a-hard.txt")).expect("hardlink payload"),
        b"shared"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn staged_external_hardlink_alias_is_rejected() {
    let root = temp_root("zinnia-hardlink-escape");
    let staged = root.join("staged");
    let destination = root.join("destination");
    let outside = root.join("outside.txt");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(&outside, b"secret").expect("outside payload");
    std::fs::hard_link(&outside, staged.join("alias.txt")).expect("external hard link");

    let error = merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect_err("external hardlink alias must fail closed");
    assert!(
        error.contains("hard link that aliases a file outside"),
        "unexpected error: {error}"
    );
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

/// `-snld10` can materialize a dangling link that leaves one archive subtree
/// but remains inside the extraction root. Zinnia should publish it.
#[cfg(unix)]
#[test]
fn snld10_extract_contained_dangling_symlink_is_published() {
    let Some(binary) = bundled_7z_test_binary() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };

    let root = temp_root("zinnia-snld10-escape");
    std::fs::create_dir_all(root.join("safe/nested")).expect("source tree");
    std::fs::write(root.join("safe/a.txt"), b"ok").expect("payload");
    std::os::unix::fs::symlink("../../outside", root.join("safe/nested/escape"))
        .expect("escape link");
    let archive = root.join("escape.tar");
    let tar = std::process::Command::new("tar")
        .current_dir(&root)
        .args(["-cf", archive.to_str().expect("archive utf8"), "safe"])
        .output()
        .expect("tar create");
    assert!(
        tar.status.success(),
        "tar failed: {}",
        String::from_utf8_lossy(&tar.stderr)
    );

    let blocked = root.join("blocked");
    let without_snld = std::process::Command::new(&binary)
        .args([
            "x",
            &format!("-o{}", blocked.display()),
            "-aou",
            "--",
            archive.to_str().expect("archive utf8"),
        ])
        .output()
        .expect("default extract");
    assert!(
        !without_snld.status.success(),
        "default 7-Zip must reject escaping relative symlink"
    );

    let staged = root.join("staged");
    let with_snld = std::process::Command::new(&binary)
        .args([
            "x",
            &format!("-o{}", staged.display()),
            "-aou",
            "-snld10",
            "--",
            archive.to_str().expect("archive utf8"),
        ])
        .output()
        .expect("snld10 extract");
    assert!(
        with_snld.status.success(),
        "fixture expects -snld10 to materialize the escape link: {}",
        String::from_utf8_lossy(&with_snld.stderr)
    );
    assert!(staged
        .join("safe/nested/escape")
        .symlink_metadata()
        .expect("escape entry")
        .file_type()
        .is_symlink());

    let destination = root.join("destination");
    merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
        .expect("contained dangling symlink should publish");
    assert_eq!(
        std::fs::read_link(destination.join("safe/nested/escape")).expect("published link"),
        std::path::PathBuf::from("../../outside")
    );
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
fn assert_safe_extract_target_ancestors_rejects_parent_dir_escape() {
    let root = temp_root("zinnia-parent-dir-escape");
    let destination = root.join("destination");
    let sibling = root.join("sibling");
    std::fs::create_dir_all(destination.join("nested")).expect("destination");
    std::fs::create_dir_all(&sibling).expect("sibling");
    let escaped = destination.join("..").join("sibling").join("evil.txt");
    let error = assert_safe_extract_target_ancestors(&destination, &escaped)
        .expect_err("parent-dir escape must fail");
    assert!(
        error.contains("escaped destination"),
        "unexpected error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn validate_move_record_rejects_parent_dir_escape() {
    let root = temp_root("zinnia-move-plan-escape");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged");
    std::fs::create_dir_all(&destination).expect("destination");
    let record = MoveRecord {
        source: staged.join("file.txt"),
        target: destination.join("..").join("evil.txt"),
        publish_temp: None,
        publish_identity: None,
    };
    let error = validate_move_record(&staged, &destination, &record)
        .expect_err("parent-dir escape must fail");
    assert!(
        error.contains("unsafe extraction recovery move plan"),
        "unexpected error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(not(windows))]
#[test]
fn persisted_move_plan_rolls_back_a_partial_merge() {
    let root = temp_root("zinnia-move-recovery-test");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    std::fs::write(&target, b"partially published").expect("partial target");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(
            super::journal::path_identity_with_fingerprint(&target).expect("publish identity"),
        ),
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("durable move plan");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        None,
    )
    .expect("rollback plan");

    assert_eq!(
        std::fs::read(&source).expect("restored source"),
        b"partially published"
    );
    assert!(!target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(not(windows))]
#[test]
fn inside_destination_move_plan_rolls_back_a_partial_merge() {
    let root = temp_root("zinnia-inside-move-recovery-test");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("inside-destination stage");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    std::fs::write(&source, b"partially published").expect("staged source");
    std::fs::rename(&source, &target).expect("partial promotion");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(
            super::journal::path_identity_with_fingerprint(&target).expect("publish identity"),
        ),
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("durable sidecar move plan");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        None,
    )
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

#[cfg(not(windows))]
#[test]
fn persisted_move_plan_preserves_a_target_modified_in_place() {
    let root = temp_root("zinnia-move-recovery-in-place-edit");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    std::fs::write(&target, b"published").expect("published target");
    let published =
        super::journal::path_identity_with_fingerprint(&target).expect("published snapshot");
    std::fs::write(&target, b"user edit").expect("in-place edit");
    let plan = vec![MoveRecord {
        source,
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(published),
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("move plan");

    let error = rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        None,
    )
    .expect_err("modified target must be preserved");
    assert!(error.contains("changed after publication"));
    assert_eq!(std::fs::read(&target).unwrap(), b"user edit");
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn persisted_move_plan_preserves_a_published_directory_with_edited_children() {
    let root = temp_root("zinnia-directory-recovery-in-place-edit");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("folder");
    let target = destination.join("folder");
    std::fs::create_dir_all(&target).expect("published directory");
    std::fs::write(target.join("child.txt"), b"published").expect("published child");
    let published =
        super::journal::path_identity_with_fingerprint(&target).expect("published snapshot");
    std::fs::write(target.join("child.txt"), b"user edit").expect("in-place child edit");
    let plan = vec![MoveRecord {
        source,
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(published),
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("move plan");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        None,
    )
    .expect_err("modified directory must be preserved");
    assert_eq!(
        std::fs::read(target.join("child.txt")).unwrap(),
        b"user edit"
    );
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(not(windows))]
#[test]
fn hardlink_partial_publish_rollback_uses_recorded_identity() {
    use super::commit::rollback_move_records;

    let root = temp_root("zinnia-hardlink-rollback");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    std::fs::write(&source, b"staged copy").expect("staged source");
    std::fs::write(&target, b"published").expect("published target");
    let identity = super::journal::path_identity(&target).expect("target identity");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(identity),
    }];
    rollback_move_records(&staged, &destination, &plan).expect("identity retract");
    assert!(source.exists());
    assert!(!target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(not(windows))]
#[test]
fn directory_partial_publish_rollback_removes_owned_tree() {
    use super::commit::rollback_move_records;

    let root = temp_root("zinnia-dir-rollback-owned");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("folder");
    let target = destination.join("folder");
    std::fs::create_dir_all(&source).expect("staged directory");
    std::fs::write(source.join("a.txt"), b"staged").expect("staged child");
    std::fs::create_dir_all(&target).expect("published directory");
    std::fs::write(target.join("a.txt"), b"published").expect("published child");
    let identity = super::journal::path_identity(&target).expect("target identity");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(identity),
    }];
    rollback_move_records(&staged, &destination, &plan).expect("owned directory retract");
    assert!(source.exists());
    assert!(!target.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(not(windows))]
#[test]
fn directory_partial_publish_rollback_preserves_replacement_tree() {
    use super::commit::rollback_move_records;

    let root = temp_root("zinnia-dir-rollback-replace");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("folder");
    let target = destination.join("folder");
    std::fs::create_dir_all(&source).expect("staged directory");
    std::fs::write(source.join("a.txt"), b"staged").expect("staged child");
    std::fs::create_dir_all(&target).expect("owned directory");
    std::fs::write(target.join("a.txt"), b"owned").expect("owned child");
    let identity = super::journal::path_identity(&target).expect("owned identity");
    std::fs::remove_dir_all(&target).expect("remove owned directory");
    std::fs::create_dir_all(&target).expect("replacement directory");
    std::fs::write(target.join("victim.txt"), b"keep me").expect("replacement child");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(identity),
    }];
    rollback_move_records(&staged, &destination, &plan)
        .expect_err("replacement directory must be preserved");
    assert_eq!(
        std::fs::read(target.join("victim.txt")).expect("replacement survived"),
        b"keep me"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn windows_rejects_publish_identity_without_publish_path() {
    use super::commit::rollback_move_records;

    let root = temp_root("zinnia-windows-identity-without-temp");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    std::fs::write(&source, b"staged copy").expect("staged source");
    std::fs::write(&target, b"published").expect("published target");
    let identity = super::journal::path_identity(&target).expect("target identity");
    let plan = vec![MoveRecord {
        source,
        target,
        publish_temp: None,
        publish_identity: Some(identity),
    }];
    let err = rollback_move_records(&staged, &destination, &plan)
        .expect_err("Windows requires publish_temp with identity");
    assert!(
        err.contains("without a publish path"),
        "unexpected rejection: {err}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn hardlink_partial_publish_rollback_fails_closed_without_identity() {
    use super::commit::rollback_move_records;

    let root = temp_root("zinnia-hardlink-rollback-missing-id");
    let staged = root.join("staged");
    let destination = root.join("destination");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::create_dir_all(&destination).expect("destination tree");
    let source = staged.join("new.txt");
    let target = destination.join("new.txt");
    std::fs::write(&source, b"staged copy").expect("staged source");
    std::fs::write(&target, b"published").expect("published target");
    let plan = vec![MoveRecord {
        source,
        target,
        publish_temp: None,
        publish_identity: None,
    }];
    assert!(rollback_move_records(&staged, &destination, &plan).is_err());
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
    let publish_identity =
        super::journal::path_identity_with_fingerprint(&publish_temp).expect("publish identity");
    let target = destination.join("new.txt");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: Some(publish_temp.clone()),
        publish_identity: Some(publish_identity),
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("target-local move plan");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        None,
    )
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
    let publish_identity =
        super::journal::path_identity_with_fingerprint(&publish_temp).expect("publish identity");
    let target = destination.join("new.txt");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: Some(publish_temp.clone()),
        publish_identity: None,
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("base move plan");

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
    drop(log);
    let move_identity_log_identity =
        super::journal::regular_file_identity_with_fingerprint(&move_identity_log_path(&staged))
            .expect("identity log identity");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        Some(&move_identity_log_identity),
    )
    .expect("hydrate identity log and remove verified copy");

    assert_eq!(std::fs::read(&source).unwrap(), b"staged source");
    assert!(!destination
        .join(".zinnia-publish-0123456789abcdef0123456789abcdef")
        .exists());
    assert!(!target.exists());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_file(move_identity_log_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(not(windows))]
#[test]
fn identity_log_hydration_uses_latest_record_per_index() {
    use std::io::Write as _;

    let root = temp_root("zinnia-identity-log-latest-wins");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("stage");
    let source = staged.join("new.txt");
    std::fs::write(&source, b"staged source").expect("source");

    // Copy-fallback publish (rename/hard-link unavailable) journals a pre-copy
    // source identity and then a post-copy target identity with `publish_temp`
    // unset on every non-Windows-target-local path.
    let target = destination.join("new.txt");
    std::fs::write(&target, b"corrected copy").expect("published target");
    let pre_copy_identity = super::journal::path_identity(&source).expect("source identity");
    let post_copy_identity =
        super::journal::path_identity_with_fingerprint(&target).expect("target identity");
    assert_ne!(pre_copy_identity, post_copy_identity);

    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: None,
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("move plan");

    let mut log = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(move_identity_log_path(&staged))
        .expect("identity log");
    for identity in [pre_copy_identity, post_copy_identity.clone()] {
        let record = serde_json::json!({
            "index": 0,
            "identity": identity,
        });
        writeln!(log, "{}", serde_json::to_string(&record).unwrap()).expect("record");
    }
    log.sync_all().expect("sync log");
    drop(log);
    let move_identity_log_identity =
        super::journal::regular_file_identity_with_fingerprint(&move_identity_log_path(&staged))
            .expect("identity log identity");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        Some(&move_identity_log_identity),
    )
    .expect("hydrate must accept copy-fallback correction records");

    assert_eq!(std::fs::read(&source).unwrap(), b"staged source");
    assert!(!target.exists());
    let _ = std::fs::remove_file(move_plan_path(&staged));
    let _ = std::fs::remove_file(move_identity_log_path(&staged));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn identity_log_hydration_uses_latest_record_with_publish_temp() {
    use std::io::Write as _;

    let root = temp_root("zinnia-identity-log-latest-wins-win");
    let destination = root.join("destination");
    let staged = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&staged).expect("stage");
    let source = staged.join("new.txt");
    std::fs::write(&source, b"staged source").expect("source");

    let publish_temp = destination.join(".zinnia-publish-0123456789abcdef0123456789abcdef");
    std::fs::write(&publish_temp, b"corrected copy").expect("publish temp");
    let pre_copy_identity = super::journal::path_identity(&source).expect("source identity");
    let post_copy_identity =
        super::journal::path_identity_with_fingerprint(&publish_temp).expect("publish identity");
    assert_ne!(pre_copy_identity, post_copy_identity);

    let target = destination.join("new.txt");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: Some(publish_temp.clone()),
        publish_identity: None,
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("move plan");

    let mut log = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(move_identity_log_path(&staged))
        .expect("identity log");
    for identity in [pre_copy_identity, post_copy_identity.clone()] {
        let record = serde_json::json!({
            "index": 0,
            "publish_temp": publish_temp,
            "identity": identity,
        });
        writeln!(log, "{}", serde_json::to_string(&record).unwrap()).expect("record");
    }
    log.sync_all().expect("sync log");
    drop(log);
    let move_identity_log_identity =
        super::journal::regular_file_identity_with_fingerprint(&move_identity_log_path(&staged))
            .expect("identity log identity");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        Some(&move_identity_log_identity),
    )
    .expect("hydrate must accept Windows publish-temp correction records");

    assert_eq!(std::fs::read(&source).unwrap(), b"staged source");
    assert!(!publish_temp.exists());
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
    let move_plan_identity = write_move_plan(&staged, &plan).expect("target-local move plan");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        None,
    )
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
    std::fs::rename(&source, &target).expect("partial promotion");
    let plan = vec![MoveRecord {
        source: source.clone(),
        target: target.clone(),
        publish_temp: None,
        publish_identity: Some(
            super::journal::path_identity_with_fingerprint(&target).expect("publish identity"),
        ),
    }];
    let move_plan_identity = write_move_plan(&staged, &plan).expect("move plan");

    rollback_persisted_move_plan(
        &staged,
        &destination,
        false,
        Some(&move_plan_identity),
        None,
    )
    .expect("rollback link");

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

    let unsafe_symlink = "\
Path = Libraries
Symbolic Link = ../../escape.txt
Size = 0
";
    let err = assert_slt_archive_members_safe(unsafe_symlink, "/tmp/archive.7z")
        .expect_err("symlink escape target");
    assert!(err.contains("../../escape.txt"));

    let unsafe_hardlink = "\
Path = twin.txt
Hard Link = /tmp/outside.txt
Size = 0
";
    let err = assert_slt_archive_members_safe(unsafe_hardlink, "/tmp/archive.7z")
        .expect_err("hardlink absolute target");
    assert!(err.contains("/tmp/outside.txt"));

    let safe_symlink = "\
Path = Libraries
Symbolic Link = Versions/Current/Libraries
Size = 0
";
    assert_slt_archive_members_safe(safe_symlink, "/tmp/archive.7z")
        .expect("relative in-tree link");

    let common_unix_symlink = "\
Path = bin/tool
Symbolic Link = ../lib/tool
Size = 0
";
    assert_slt_archive_members_safe(common_unix_symlink, "/tmp/archive.7z")
        .expect("contained parent-relative link");

    assert_slt_archive_members_safe("", "/tmp/empty.7z").expect("empty archive");
    assert!(assert_slt_archive_members_safe("unexpected schema", "/tmp/archive.7z").is_err());
}

#[test]
fn slt_declared_size_is_rejected_before_extraction() {
    let listing = "\
Path = /tmp/archive.7z
Size = 999999
----------
Path = one.bin
Size = 6
Path = two.bin
Size = 5
";
    assert_slt_declared_size_within_limit(listing, "/tmp/archive.7z", 11)
        .expect("declared member bytes at limit");
    assert!(assert_slt_declared_size_within_limit(listing, "/tmp/archive.7z", 10).is_err());
}

#[test]
fn slt_declared_size_counts_member_named_like_archive_basename() {
    let listing = "\
Path = archive.7z
Size = 100
Path = folder/file.txt
Size = 11
";
    assert_slt_archive_members_safe(listing, "/tmp/archive.7z").expect("basename is a member");
    assert_slt_declared_size_within_limit(listing, "/tmp/archive.7z", 111)
        .expect("basename member bytes count toward the declared-size budget");
    assert!(assert_slt_declared_size_within_limit(listing, "/tmp/archive.7z", 110).is_err());
}

#[test]
fn mutating_prepare_rejects_omitted_identity() {
    let root = temp_root("zinnia-mutating-identity-required");
    std::fs::create_dir_all(&root).expect("test directory");
    let archive = root.join("archive.7z");
    std::fs::write(&archive, b"archive").expect("test archive");
    let destination = root.join("out");
    let extract_args = vec![
        "x".to_string(),
        format!("-o{}", destination.display()),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let error = prepare_cleanup_plan(&extract_args, None, None)
        .expect_err("extract without identity must fail closed");
    assert!(
        error.contains("identity token"),
        "unexpected extract error: {error}"
    );

    let output = root.join("output.7z");
    let create_args = vec![
        "a".to_string(),
        "-t7z".to_string(),
        output.to_string_lossy().to_string(),
        "--".to_string(),
        archive.to_string_lossy().to_string(),
    ];
    let error = prepare_cleanup_plan(&create_args, None, None)
        .expect_err("create without identity must fail closed");
    assert!(
        error.contains("identity token"),
        "unexpected create error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn listing_exit_1_fails_closed_unless_metadata_only() {
    let visible_only = "\
Path = visible.txt
Size = 4
";
    assert_slt_archive_members_safe(visible_only, "/tmp/archive.7z")
        .expect("partial listing looks safe on its own");
    assert!(listing_preflight_exit_is_acceptable(0, visible_only, ""));
    assert!(listing_preflight_exit_is_acceptable(
        1,
        "WARNING: There are data after the end of archive\nPath = visible.txt\nSize = 4\n",
        "",
    ));
    assert!(
        !listing_preflight_exit_is_acceptable(1, visible_only, "WARNING: CRC Failed\n",),
        "CRC warnings must not publish a truncated listing that omitted members"
    );
    assert!(!listing_preflight_exit_is_acceptable(
        1,
        visible_only,
        "WARNING: Unexpected end of data\n",
    ));
    assert!(!listing_preflight_exit_is_acceptable(2, visible_only, ""));
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
fn archive_identity_token_is_stable_and_changes_for_same_path_replacement() {
    let root = temp_root("zinnia-archive-identity-token");
    std::fs::create_dir_all(&root).expect("root");
    let archive = root.join("archive.7z");
    let old_archive = root.join("old-archive.7z");
    std::fs::write(&archive, b"same bytes").expect("first archive");
    let first = archive_identity_token(&archive).expect("first token");
    assert_eq!(
        archive_identity_token(&archive).expect("repeat token"),
        first
    );

    std::fs::rename(&archive, &old_archive).expect("retain old identity");
    std::fs::write(&archive, b"same bytes").expect("replacement archive");
    let replacement = archive_identity_token(&archive).expect("replacement token");
    assert_ne!(replacement, first);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_destination_fingerprint_detects_in_place_content_change() {
    let root = temp_root("zinnia-destination-fingerprint");
    std::fs::create_dir_all(&root).expect("test root");
    let archive = root.join("existing.7z");
    std::fs::write(&archive, b"old bytes").expect("old archive");
    let expected = super::commit::archive_destination_family_snapshot(&archive).expect("snapshot");

    std::fs::write(&archive, b"new bytes").expect("in-place replacement");

    let error = super::commit::assert_archive_destination_unchanged(&archive, &expected)
        .expect_err("content change must abort publication");
    assert!(error.contains("changed"));
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
    let snapshot = stage_extract_input(&archive, None, None).expect("snapshot");
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
fn extraction_snapshot_prefers_source_filesystem_when_cache_is_available() {
    let root = temp_root("zinnia-archive-snapshot-cache");
    let source = root.join("source");
    let cache = root.join("cache");
    std::fs::create_dir_all(&source).expect("source");
    let archive = source.join("archive.7z");
    std::fs::write(&archive, b"archive").expect("archive");

    let snapshot = stage_extract_input(&archive, Some(&cache), None).expect("snapshot");
    let stage = snapshot.path.parent().expect("stage");
    let canonical_source = source.canonicalize().expect("canonical source");
    assert_eq!(stage.parent(), Some(canonical_source.as_path()));

    let registered = read_pending_stages(&cache).expect("pending-stage registry");
    let stage_text = stage.to_string_lossy().to_string();
    assert!(registered.iter().any(|path| path == &stage_text));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extraction_snapshot_honors_preparation_cancel() {
    let root = temp_root("zinnia-archive-snapshot-cancel");
    std::fs::create_dir_all(&root).expect("root");
    let archive = root.join("archive.7z");
    std::fs::write(&archive, vec![0u8; 2 * 1024 * 1024]).expect("archive");

    let error =
        super::archive_snapshot::stage_extract_input_with_cancel(&archive, None, None, || true)
            .expect_err("cancelled snapshot");
    assert!(error.contains("cancelled"));
    assert_eq!(
        std::fs::read_dir(&root)
            .expect("root listing")
            .filter_map(Result::ok)
            .count(),
        1,
        "cancelled snapshot must remove its stage"
    );

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
fn archive_snapshot_treats_ordinary_numbered_file_as_not_split() {
    let root = temp_root("zinnia-ordinary-numbered-file");
    std::fs::create_dir_all(&root).expect("root");
    // No archive-extension base and no sibling `.002`: not a split volume.
    let photo = root.join("photo.123");
    std::fs::write(&photo, b"not an archive volume").expect("photo");
    assert_eq!(
        archive_input_family(&photo).expect("ordinary file is its own family"),
        vec![photo.clone()]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_snapshot_collects_bare_numbered_split_family_with_sibling_002() {
    let root = temp_root("zinnia-bare-split-snapshot");
    std::fs::create_dir_all(&root).expect("root");
    // No recognized archive extension in the base name, but a `.002` sibling
    // proves this really is a split-volume family.
    let first = root.join("backup.001");
    let second = root.join("backup.002");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&second, b"second").expect("second");
    assert_eq!(
        archive_input_family(&first).expect("family"),
        vec![first.clone(), second.clone()]
    );
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

    let snapshot = stage_extract_input(&final_volume, None, None).expect("snapshot");
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

    let plan = prepare_cleanup_plan(&args, None, Some(&extract_identity(&final_volume)))
        .expect("cleanup plan");
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
fn archive_snapshot_rejects_numbered_family_gaps() {
    let root = temp_root("zinnia-split-family-gap");
    std::fs::create_dir_all(&root).expect("root");
    let first = root.join("archive.7z.001");
    let third = root.join("archive.7z.003");
    std::fs::write(&first, b"first").expect("first");
    std::fs::write(&third, b"third").expect("third");

    let error = archive_input_family(&first).expect_err("gap must fail closed");
    assert!(error.contains("numbering gap"), "unexpected error: {error}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn pending_stage_registry_round_trips() {
    let cache = temp_root("zinnia-pending-stages");
    std::fs::create_dir_all(&cache).expect("cache");
    let stage = cache.join(".out.zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&stage).expect("stage");
    let identity = super::journal::path_identity(&stage).expect("stage identity");
    register_pending_stage(&cache, &stage, &identity).expect("register");
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
    let identity = super::journal::path_identity(&stage).expect("stage identity");
    register_pending_stage(&cache, &stage, &identity).expect("register");

    let plan = CleanupPlan {
        staged_extract: None,
        staged_archive: Some((staged, root.join("out.7z"))),
        expected_archive_family: Vec::new(),
        staged_input_archive: None,
        cache_dir: Some(cache.clone()),
        stage_identities: vec![(stage.clone(), identity)],
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
    assert_eq!(
        read_pending_stages(&cache).expect("backup still tracked"),
        vec![stage.to_string_lossy().to_string()]
    );
    std::fs::remove_file(archive_backup_path(&stage, 0)).expect("remove backup sibling");
    unregister_plan_stages(&plan);
    assert!(read_pending_stages(&cache).expect("cleared").is_empty());

    let _ = std::fs::remove_dir_all(cache);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_windows_file_identity_json_remains_compatible() {
    let identity: super::journal::FileIdentity =
        serde_json::from_str(r#"{"platform":"windows","volume_serial_number":7,"file_index":9}"#)
            .expect("deserialize legacy Windows identity");
    assert_eq!(
        identity,
        super::journal::FileIdentity::Windows {
            volume_serial_number: 7,
            file_index: 9,
            volume_serial_number_64: None,
            file_id_128: None,
            fingerprint: None,
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
        fingerprint: None,
    };
    let same = expected.clone();
    let legacy_fields_only_match = FileIdentity::Windows {
        volume_serial_number: 7,
        file_index: 9,
        volume_serial_number_64: Some(700),
        file_id_128: Some([2; 16]),
        fingerprint: None,
    };
    assert!(file_identities_match(&same, &expected));
    assert!(!file_identities_match(&legacy_fields_only_match, &expected));

    let legacy_expected = FileIdentity::Windows {
        volume_serial_number: 7,
        file_index: 9,
        volume_serial_number_64: None,
        file_id_128: None,
        fingerprint: None,
    };
    assert!(file_identities_match(&same, &legacy_expected));

    let malformed_partial_expected = FileIdentity::Windows {
        volume_serial_number: 7,
        file_index: 9,
        volume_serial_number_64: Some(700),
        file_id_128: None,
        fingerprint: None,
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity_with_fingerprint(&destination).unwrap(),
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
        move_plan_identity: None,
        move_identity_log_identity: None,
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
fn missing_new_destination_stage_preserves_ambiguous_destination() {
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(stage_identity),
        extract_phase: Some(ExtractJournalPhase::InProgress),
        archive_phase: None,
    };

    let error = recover_missing_extract_stage(&journal)
        .expect_err("an in-progress missing sibling stage must remain ambiguous");
    assert!(error.contains("preserved"), "unexpected error: {error}");
    assert!(!stage.exists());
    assert_eq!(
        std::fs::read(destination.join("new.txt")).expect("preserved destination"),
        b"new"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn missing_new_destination_stage_preserves_an_identity_mismatch() {
    let root = temp_root("zinnia-missing-new-destination-replacement");
    std::fs::create_dir_all(&root).expect("test root");
    let destination = root.join("destination");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&stage).expect("stage");
    std::fs::write(stage.join("user.txt"), b"same bytes").expect("stage content");
    let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
    let replacement = root.join("replacement");
    std::fs::create_dir(&replacement).expect("replacement directory");
    std::fs::write(replacement.join("user.txt"), b"same bytes")
        .expect("matching replacement content");
    std::fs::remove_dir_all(&stage).expect("remove original stage");
    std::fs::rename(&replacement, &destination).expect("install replacement destination");

    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: true,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(stage_identity),
        extract_phase: Some(ExtractJournalPhase::InProgress),
        archive_phase: None,
    };

    assert!(
        recover_missing_extract_stage(&journal).is_err(),
        "replacement destination must not be recognized as the published stage"
    );
    assert_eq!(
        std::fs::read(destination.join("user.txt")).expect("preserved replacement"),
        b"same bytes"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn missing_committed_extract_stage_preserves_the_destination() {
    let root = temp_root("zinnia-missing-committed-stage");
    let destination = root.join("destination");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&stage).expect("committed stage");
    std::fs::write(stage.join("published.txt"), b"published").expect("published file");
    let stage_identity =
        super::journal::path_identity_with_fingerprint(&stage).expect("stage identity");
    std::fs::rename(&stage, &destination).expect("publish stage");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: true,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(stage_identity),
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(
            super::journal::path_identity(&stage).expect("stage identity"),
        ),
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

    let error = rollback_persisted_move_plan(&stage, &destination, false, None, None)
        .expect_err("symlinked sidecar must be rejected");
    assert!(error.contains("sidecar") || error.contains("link"));
    assert_eq!(
        std::fs::read(&outside).expect("outside file preserved"),
        b"not a move plan"
    );
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity_with_fingerprint(&destination).unwrap(),
        )],
        extract_stage_identity: Some(super::journal::path_identity(&stage).unwrap()),
        extract_phase: None,
        archive_phase: None,
    };
    assert!(!archive_journal_is_committed(&journal));
    rollback_archive_journal(&journal).expect("rollback partial new archive");
    assert!(!destination.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn scrub_retract_skips_missing_journal() {
    let root = temp_root("zinnia-scrub-missing-journal");
    let path = root.join("active-transaction.json");
    retract_scrub_archive_journal_at(&path).expect("missing journal is fine");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn scrub_retract_fails_closed_on_corrupt_journal() {
    let root = temp_root("zinnia-scrub-corrupt-journal");
    std::fs::create_dir_all(&root).expect("root");
    let path = root.join("active-transaction.json");
    std::fs::write(&path, b"{not-json").expect("corrupt journal");
    let error = retract_scrub_archive_journal_at(&path).expect_err("corrupt journal");
    assert!(error.contains("parse") || error.contains("Could not parse"));
    assert!(path.is_file(), "corrupt journal must remain for recovery");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn scrub_retract_removes_partial_archive_publish() {
    let root = temp_root("zinnia-scrub-retract-partial");
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity_with_fingerprint(&destination).unwrap(),
        )],
        extract_stage_identity: Some(super::journal::path_identity(&stage).unwrap()),
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };
    let path = root.join("active-transaction.json");
    std::fs::write(
        &path,
        serde_json::to_string(&journal).expect("serialize journal"),
    )
    .expect("write journal");

    retract_scrub_archive_journal_at(&path).expect("retract partial publish");
    assert!(!destination.exists());
    assert!(
        path.is_file(),
        "scrub caller clears the journal after retract"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn scrub_retract_ignores_non_archive_journals() {
    let root = temp_root("zinnia-scrub-extract-journal");
    let destination = root.join("destination");
    let stage = destination.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&stage).expect("stage");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::InsideDestination),
        move_plan_sidecar: true,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: None,
        extract_phase: Some(ExtractJournalPhase::InProgress),
        archive_phase: None,
    };
    let path = root.join("active-transaction.json");
    std::fs::write(
        &path,
        serde_json::to_string(&journal).expect("serialize journal"),
    )
    .expect("write journal");
    retract_scrub_archive_journal_at(&path).expect("extract journals do not scrub-retract");
    assert!(stage.is_dir());
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity_with_fingerprint(&destination).unwrap(),
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
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let published_identity =
        super::journal::regular_file_identity_with_fingerprint(&destination).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(published_identity)],
        extract_stage_identity: Some(super::journal::path_identity(&stage).unwrap()),
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };

    rollback_archive_journal(&journal).expect("rollback verified update");
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    assert!(!backup.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_rejects_same_inode_rewritten_backup() {
    let root = temp_root("zinnia-journal-same-inode-rewrite");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
    // Overwrite the backup path in place so inode/file-id stay the same while
    // bytes change. Recovery must refuse this without a matching fingerprint.
    std::fs::write(&backup, b"attacker rewrite").expect("rewrite same path");
    assert!(
        super::journal::file_identities_match(
            &super::journal::regular_file_identity(&backup).unwrap(),
            &backup_identity
        ),
        "in-place rewrite should keep the inode/file-id identity"
    );
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let published_identity =
        super::journal::regular_file_identity_with_fingerprint(&destination).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
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
    assert_eq!(std::fs::read(&backup).unwrap(), b"attacker rewrite");
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
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
    let retained_backup = root.join("retained-backup-identity");
    std::fs::hard_link(&backup, &retained_backup).expect("retain backup identity");
    std::fs::remove_file(&backup).expect("remove original backup name");
    std::fs::write(&backup, b"attacker replacement").expect("replacement backup");
    assert_ne!(
        super::journal::regular_file_identity_with_fingerprint(&backup).unwrap(),
        backup_identity,
        "replacement must not inherit the backup file identity"
    );
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let published_identity =
        super::journal::regular_file_identity_with_fingerprint(&destination).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
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
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
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
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity_with_fingerprint(&destination).unwrap(),
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
    let first_backup_identity =
        super::journal::regular_file_identity_with_fingerprint(&first_backup).unwrap();
    let second_backup_identity =
        super::journal::regular_file_identity_with_fingerprint(&second_backup).unwrap();
    std::fs::write(&first, b"new-1").expect("published first");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: root.join("out.7z"),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: vec![first.clone(), second.clone()],
        previous_archive_identities: vec![
            Some(first_backup_identity),
            Some(second_backup_identity),
        ],
        next_archive_family: vec![first.clone(), second.clone()],
        next_archive_identities: vec![
            Some(super::journal::regular_file_identity_with_fingerprint(&first).unwrap()),
            None,
        ],
        extract_stage_identity: Some(super::journal::path_identity(&stage).unwrap()),
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
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
    std::fs::write(&destination, b"new-unrecorded").expect("published");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
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
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(
            super::journal::regular_file_identity_with_fingerprint(&staged).unwrap(),
        )],
        extract_stage_identity: Some(super::journal::path_identity(&stage).unwrap()),
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
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
    std::fs::write(&destination, b"new-partial").expect("partial new");
    let published_identity =
        super::journal::regular_file_identity_with_fingerprint(&destination).unwrap();
    // Keep the published inode/file ID allocated while replacing the destination.
    // Otherwise ext4 may reuse it immediately and make this identity-safety test
    // pass or fail based on allocator timing.
    let retained_published_file = root.join("published-identity");
    std::fs::hard_link(&destination, &retained_published_file).expect("retain published file");
    std::fs::remove_file(&destination).expect("remove partial");
    std::fs::write(&destination, b"user replacement").expect("replacement");
    assert_ne!(
        super::journal::regular_file_identity_with_fingerprint(&destination).unwrap(),
        published_identity,
        "replacement must not inherit the published file identity"
    );
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
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
fn archive_journal_rollback_preserves_an_output_modified_in_place() {
    let root = temp_root("zinnia-journal-in-place-edit");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    let backup = archive_backup_path(&stage, 0);
    std::fs::write(&backup, b"old").expect("backup");
    let backup_identity = super::journal::regular_file_identity_with_fingerprint(&backup).unwrap();
    std::fs::write(&destination, b"published").expect("published output");
    let published_identity =
        super::journal::regular_file_identity_with_fingerprint(&destination).unwrap();
    std::fs::write(&destination, b"user edit").expect("in-place edit");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: vec![destination.clone()],
        previous_archive_identities: vec![Some(backup_identity)],
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(published_identity)],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };

    rollback_archive_journal(&journal).expect_err("modified output must be preserved");
    assert_eq!(std::fs::read(&destination).unwrap(), b"user edit");
    assert_eq!(std::fs::read(&backup).unwrap(), b"old");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_retracts_unfingerprinted_matching_output() {
    let root = temp_root("zinnia-journal-unfingerprinted-retract");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(&destination, b"published").expect("published output");
    let identity_only = super::journal::regular_file_identity(&destination).unwrap();
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(identity_only)],
        extract_stage_identity: Some(super::journal::path_identity(&stage).unwrap()),
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };

    rollback_archive_journal(&journal).expect("matching inode can be retracted");
    assert!(
        !destination.exists(),
        "copy-fallback output should be removed"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_journal_rollback_preserves_replaced_unfingerprinted_output() {
    let root = temp_root("zinnia-journal-unfingerprinted-replaced");
    let stage = root.join(".zinnia-archive-abc");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("stage");
    std::fs::write(&destination, b"published").expect("published output");
    let identity_only = super::journal::regular_file_identity(&destination).unwrap();
    // Replace via a sibling rename so the new file cannot inherit the old
    // inode (tmpfs on Linux CI reuses inodes after unlink+recreate).
    let replacement = root.join("replacement.7z");
    std::fs::write(&replacement, b"user replacement").expect("replacement");
    std::fs::rename(&replacement, &destination).expect("replace destination");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination: destination.clone(),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: vec![destination.clone()],
        next_archive_identities: vec![Some(identity_only)],
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::InProgress),
    };

    rollback_archive_journal(&journal).expect_err("replaced inode must be preserved");
    assert_eq!(std::fs::read(&destination).unwrap(), b"user replacement");
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
    let second_backup_identity =
        super::journal::regular_file_identity_with_fingerprint(&second_backup).unwrap();
    let mut journal = CleanupJournal {
        stage: stage.clone(),
        destination: root.join("out.7z"),
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: vec![first.clone(), second.clone()],
        previous_archive_identities: vec![None, Some(second_backup_identity)],
        next_archive_family: vec![first.clone(), second.clone()],
        next_archive_identities: vec![
            Some(super::journal::regular_file_identity_with_fingerprint(&first).unwrap()),
            Some(super::journal::regular_file_identity_with_fingerprint(&second).unwrap()),
        ],
        extract_stage_identity: Some(super::journal::path_identity(&stage).unwrap()),
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
        expected_archive_family: Vec::new(),
        staged_input_archive: None,
        cache_dir: None,
        stage_identities: Vec::new(),
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
    assert!(!commit_failure_should_scrub_staging(
        &plan_with_backup,
        "Archive was committed, but recovery artifact cleanup failed; published archives were preserved: sync failed"
    ));
    assert!(!commit_failure_should_scrub_staging(
        &plan_with_backup,
        "Archive recovery ownership update failed: pending registry unavailable"
    ));

    let extract_stage = root.join(".zinnia-extract-abc");
    std::fs::create_dir_all(&extract_stage).expect("extract stage");
    let plan_extract = CleanupPlan {
        staged_extract: Some((extract_stage, root.join("dest"))),
        staged_archive: None,
        expected_archive_family: Vec::new(),
        staged_input_archive: None,
        cache_dir: None,
        stage_identities: Vec::new(),
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
fn stage_replacement_between_creation_and_journal_write_cannot_claim_ownership() {
    let root = temp_root("zinnia-stage-journal-replacement");
    std::fs::create_dir_all(&root).expect("test root");
    let destination = root.join("out.7z");
    let created = super::staging::create_publish_stage_dir(&destination, "archive", None)
        .expect("create archive stage");
    let stage = created.path.clone();
    let retained = root.join("retained-created-stage");
    std::fs::rename(&stage, &retained).expect("retain created stage");
    std::fs::create_dir(&stage).expect("replacement stage");
    std::fs::write(stage.join("user.txt"), b"replacement").expect("replacement content");
    let plan = CleanupPlan {
        staged_extract: None,
        staged_archive: Some((stage.join("out.7z"), destination)),
        expected_archive_family: Vec::new(),
        staged_input_archive: None,
        cache_dir: None,
        stage_identities: vec![(stage.clone(), created.identity)],
        max_extract_bytes: None,
        min_free_bytes: None,
    };

    let error = super::journal::captured_plan_stage_identity(&plan, &stage)
        .expect_err("replacement must not acquire the created stage identity");
    assert!(error.contains("changed"));
    assert_eq!(
        std::fs::read(stage.join("user.txt")).expect("preserved replacement"),
        b"replacement"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_stage_identity_mismatch_is_preserved_during_cleanup() {
    let root = temp_root("zinnia-archive-stage-mismatch");
    let stage = root.join(".zinnia-archive-0123456789abcdef0123456789abcdef");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("created stage");
    let identity = super::journal::path_identity(&stage).expect("created identity");
    std::fs::remove_dir(&stage).expect("remove created stage");
    std::fs::create_dir(&stage).expect("replacement stage");
    std::fs::write(stage.join("user.txt"), b"replacement").expect("replacement content");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination,
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(identity),
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::Committed),
    };

    assert!(cleanup_committed_archive_journal(&journal).is_err());
    assert_eq!(
        std::fs::read(stage.join("user.txt")).expect("preserved replacement"),
        b"replacement"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_archive_stage_without_identity_fails_closed() {
    let root = temp_root("zinnia-legacy-archive-stage");
    let stage = root.join(".zinnia-archive-0123456789abcdef0123456789abcdef");
    let destination = root.join("out.7z");
    std::fs::create_dir_all(&stage).expect("legacy stage");
    std::fs::write(stage.join("legacy.txt"), b"legacy").expect("legacy content");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination,
        archive: true,
        extract_stage_placement: None,
        move_plan_sidecar: false,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: None,
        extract_phase: None,
        archive_phase: Some(ArchiveJournalPhase::Committed),
    };

    assert!(cleanup_committed_archive_journal(&journal).is_err());
    assert_eq!(
        std::fs::read(stage.join("legacy.txt")).expect("preserved legacy stage"),
        b"legacy"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn quarantine_cleanup_preserves_replacement_after_identity_validation() {
    let root = temp_root("zinnia-quarantine-cleanup-race");
    std::fs::create_dir_all(&root).expect("test root");
    let path = root.join("recovery.json");
    std::fs::write(&path, b"recorded").expect("recorded file");
    let identity =
        super::journal::regular_file_identity_with_fingerprint(&path).expect("recorded identity");
    super::journal::ensure_recovery_path_unchanged(&path, &identity).expect("pre-race validation");
    let retained = root.join("retained-recorded-file");
    std::fs::rename(&path, &retained).expect("retain recorded object");
    std::fs::write(&path, b"replacement").expect("replacement file");

    let error = super::journal::remove_recovery_regular_file_if_matches(&path, &identity)
        .expect_err("replacement must fail closed after quarantine");
    assert!(error.contains("preserved") || error.contains("identity"));
    assert_eq!(
        std::fs::read(&path).expect("preserved replacement"),
        b"replacement"
    );
    assert_eq!(
        std::fs::read(&retained).expect("retained original"),
        b"recorded"
    );
    assert!(std::fs::read_dir(&root)
        .expect("test root entries")
        .all(|entry| !entry
            .expect("directory entry")
            .file_name()
            .to_string_lossy()
            .starts_with(".zinnia-quarantine-")));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn extract_stage_identity_mismatch_preserves_stage_and_sidecars() {
    let root = temp_root("zinnia-extract-stage-mismatch");
    let destination = root.join("destination");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&stage).expect("created stage");
    let identity = super::journal::path_identity(&stage).expect("created identity");
    let retained = root.join("retained-created-stage");
    std::fs::rename(&stage, &retained).expect("retain created stage");
    std::fs::create_dir(&stage).expect("replacement stage");
    std::fs::write(stage.join("user.txt"), b"replacement").expect("replacement content");
    let sidecar = move_plan_path(&stage);
    std::fs::write(&sidecar, b"replacement sidecar").expect("replacement sidecar");
    let journal = CleanupJournal {
        stage: stage.clone(),
        destination,
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: true,
        move_plan_identity: None,
        move_identity_log_identity: None,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(identity),
        extract_phase: Some(ExtractJournalPhase::Committed),
        archive_phase: None,
    };

    assert!(cleanup_extract_journal_artifacts(&journal).is_err());
    assert_eq!(
        std::fs::read(stage.join("user.txt")).expect("preserved replacement"),
        b"replacement"
    );
    assert_eq!(
        std::fs::read(&sidecar).expect("preserved replacement sidecar"),
        b"replacement sidecar"
    );
    assert!(
        retained.is_dir(),
        "creation-owned stage was retained separately"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn whole_stage_commit_failure_preserves_callback_replacement_destination() {
    let root = temp_root("zinnia-whole-stage-callback-replacement");
    let destination = root.join("destination");
    let staged = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    let retained_publish = root.join("retained-published-stage");
    std::fs::create_dir_all(&staged).expect("staged tree");
    std::fs::write(staged.join("published.txt"), b"published").expect("staged content");
    let stage_identity = super::journal::path_identity(&staged).expect("stage identity");

    let error = merge_staged_extract_with_commit(
        &staged,
        &destination,
        &stage_identity,
        MAX_EXTRACTED_BYTES,
        || {
            std::fs::rename(&destination, &retained_publish).expect("retain published stage");
            std::fs::create_dir(&destination).expect("replacement destination");
            std::fs::write(destination.join("user.txt"), b"replacement")
                .expect("replacement content");
            Err("journal write failed".to_string())
        },
    )
    .expect_err("commit-marker failure must retain recovery ownership");

    assert!(error.contains("journal write failed"));
    assert!(error.contains("preserved"));
    assert_eq!(
        std::fs::read(destination.join("user.txt")).expect("preserved replacement"),
        b"replacement"
    );
    assert_eq!(
        std::fs::read(retained_publish.join("published.txt")).expect("retained publication"),
        b"published"
    );
    assert!(!staged.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_pending_stage_record_preserves_present_directory() {
    let cache = temp_root("zinnia-legacy-pending-stage");
    std::fs::create_dir_all(&cache).expect("cache");
    let stage = cache.join(".zinnia-input-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&stage).expect("legacy stage");
    std::fs::write(stage.join("legacy.txt"), b"legacy").expect("legacy content");
    let legacy_json = serde_json::to_string(&vec![stage.to_string_lossy().to_string()])
        .expect("legacy registry json");
    std::fs::write(cache.join("pending-stages.json"), legacy_json).expect("legacy registry");

    cleanup_orphan_stages_at(&cache).expect("fail-closed legacy cleanup");

    assert_eq!(
        std::fs::read(stage.join("legacy.txt")).expect("preserved legacy stage"),
        b"legacy"
    );
    assert_eq!(
        read_pending_stages(&cache).expect("retained legacy record"),
        vec![stage.to_string_lossy().to_string()]
    );
    let _ = std::fs::remove_dir_all(cache);
}

#[test]
fn pending_stage_identity_mismatch_preserves_replacement() {
    let cache = temp_root("zinnia-pending-stage-mismatch");
    std::fs::create_dir_all(&cache).expect("cache");
    let stage = cache.join(".zinnia-input-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&stage).expect("created stage");
    let identity = super::journal::path_identity(&stage).expect("created identity");
    register_pending_stage(&cache, &stage, &identity).expect("register stage");
    let retained = cache.join("retained-created-stage");
    std::fs::rename(&stage, &retained).expect("retain created stage");
    std::fs::create_dir(&stage).expect("replacement stage");
    std::fs::write(stage.join("user.txt"), b"replacement").expect("replacement content");

    cleanup_orphan_stages_at(&cache).expect("fail-closed mismatch cleanup");

    assert_eq!(
        std::fs::read(stage.join("user.txt")).expect("preserved replacement"),
        b"replacement"
    );
    assert_eq!(
        read_pending_stages(&cache).expect("retained current record"),
        vec![stage.to_string_lossy().to_string()]
    );
    assert!(retained.is_dir());
    let _ = std::fs::remove_dir_all(cache);
}

fn artifact_extract_journal(
    stage: std::path::PathBuf,
    destination: std::path::PathBuf,
    stage_identity: super::journal::FileIdentity,
    move_plan_identity: Option<super::journal::FileIdentity>,
    move_identity_log_identity: Option<super::journal::FileIdentity>,
) -> CleanupJournal {
    CleanupJournal {
        stage,
        destination,
        archive: false,
        extract_stage_placement: Some(ExtractStagePlacement::Sibling),
        move_plan_sidecar: true,
        move_plan_identity,
        move_identity_log_identity,
        previous_archive_family: Vec::new(),
        previous_archive_identities: Vec::new(),
        next_archive_family: Vec::new(),
        next_archive_identities: Vec::new(),
        extract_stage_identity: Some(stage_identity),
        extract_phase: Some(ExtractJournalPhase::Committed),
        archive_phase: None,
    }
}

fn create_test_identity_log(
    stage: &std::path::Path,
    contents: &[u8],
) -> super::journal::FileIdentity {
    let path = move_identity_log_path(stage);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&path).expect("create identity log");
    std::io::Write::write_all(&mut file, contents).expect("write identity log");
    file.sync_all().expect("sync identity log");
    drop(file);
    super::journal::regular_file_identity_with_fingerprint(&path).expect("identity log identity")
}

#[test]
fn move_plan_create_new_preserves_preexisting_file() {
    let root = temp_root("zinnia-move-plan-create-new");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&stage).expect("stage");
    let plan_path = move_plan_path(&stage);
    std::fs::write(&plan_path, b"preexisting user file").expect("preexisting plan path");

    let error = write_move_plan(&stage, &[]).expect_err("move plan must not overwrite");
    assert!(!error.is_empty());
    assert_eq!(std::fs::read(&plan_path).unwrap(), b"preexisting user file");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn replaced_move_plan_is_preserved_during_committed_cleanup() {
    let root = temp_root("zinnia-replaced-move-plan-cleanup");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    let destination = root.join("destination");
    std::fs::create_dir_all(&stage).expect("stage");
    let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
    let plan_identity = write_move_plan(&stage, &[]).expect("move plan identity");
    let retained = root.join("retained-owned-plan");
    std::fs::rename(move_plan_path(&stage), &retained).expect("retain owned plan");
    std::fs::write(move_plan_path(&stage), b"replacement").expect("replacement plan");
    let journal = artifact_extract_journal(
        stage.clone(),
        destination,
        stage_identity,
        Some(plan_identity),
        None,
    );

    cleanup_extract_journal_artifacts(&journal).expect_err("replacement must fail closed");
    assert_eq!(
        std::fs::read(move_plan_path(&stage)).unwrap(),
        b"replacement"
    );
    assert!(stage.is_dir());
    assert!(retained.is_file());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn replaced_identity_log_prevalidation_preserves_valid_move_plan() {
    let root = temp_root("zinnia-replaced-identity-log-cleanup");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    let destination = root.join("destination");
    std::fs::create_dir_all(&stage).expect("stage");
    let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
    let plan_identity = write_move_plan(&stage, &[]).expect("move plan identity");
    let log_identity = create_test_identity_log(&stage, b"owned\n");
    let retained = root.join("retained-owned-log");
    std::fs::rename(move_identity_log_path(&stage), &retained).expect("retain owned log");
    std::fs::write(move_identity_log_path(&stage), b"replacement\n").expect("replacement log");
    let journal = artifact_extract_journal(
        stage.clone(),
        destination,
        stage_identity,
        Some(plan_identity),
        Some(log_identity),
    );

    cleanup_extract_journal_artifacts(&journal).expect_err("replacement must fail closed");
    assert!(
        move_plan_path(&stage).is_file(),
        "complete validation must happen before deleting the valid plan"
    );
    assert_eq!(
        std::fs::read(move_identity_log_path(&stage)).unwrap(),
        b"replacement\n"
    );
    assert!(stage.is_dir());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn identity_log_modified_in_place_is_preserved() {
    let root = temp_root("zinnia-modified-identity-log-cleanup");
    let stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    let destination = root.join("destination");
    std::fs::create_dir_all(&stage).expect("stage");
    let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
    let plan_identity = write_move_plan(&stage, &[]).expect("move plan identity");
    let log_identity = create_test_identity_log(&stage, b"owned\n");
    std::fs::write(move_identity_log_path(&stage), b"edited in place\n").expect("edit log");
    let journal = artifact_extract_journal(
        stage.clone(),
        destination,
        stage_identity,
        Some(plan_identity),
        Some(log_identity),
    );

    cleanup_extract_journal_artifacts(&journal).expect_err("in-place edit must fail closed");
    assert_eq!(
        std::fs::read(move_identity_log_path(&stage)).unwrap(),
        b"edited in place\n"
    );
    assert!(move_plan_path(&stage).is_file());
    assert!(stage.is_dir());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn committed_missing_stage_cleans_matching_sidecars_but_preserves_replacement() {
    let root = temp_root("zinnia-missing-stage-sidecar-cleanup");
    let destination = root.join("destination");

    let matching_stage = root.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(&matching_stage).expect("matching stage");
    let matching_stage_identity =
        super::journal::path_identity(&matching_stage).expect("matching stage identity");
    let matching_plan = write_move_plan(&matching_stage, &[]).expect("matching plan");
    let matching_log = create_test_identity_log(&matching_stage, b"");
    std::fs::remove_dir(&matching_stage).expect("remove matching stage");
    let matching_journal = artifact_extract_journal(
        matching_stage.clone(),
        destination.clone(),
        matching_stage_identity,
        Some(matching_plan),
        Some(matching_log),
    );
    cleanup_extract_journal_artifacts(&matching_journal).expect("authenticated cleanup");
    assert!(!move_plan_path(&matching_stage).exists());
    assert!(!move_identity_log_path(&matching_stage).exists());

    let replaced_stage = root.join(".zinnia-extract-fedcba9876543210fedcba9876543210");
    std::fs::create_dir_all(&replaced_stage).expect("replaced stage");
    let replaced_stage_identity =
        super::journal::path_identity(&replaced_stage).expect("replaced stage identity");
    let replaced_plan = write_move_plan(&replaced_stage, &[]).expect("owned plan");
    let replaced_log = create_test_identity_log(&replaced_stage, b"");
    std::fs::remove_dir(&replaced_stage).expect("remove replaced stage");
    let retained = root.join("retained-owned-missing-stage-plan");
    std::fs::rename(move_plan_path(&replaced_stage), &retained).expect("retain owned plan");
    std::fs::write(move_plan_path(&replaced_stage), b"replacement").expect("replacement plan");
    let replaced_journal = artifact_extract_journal(
        replaced_stage.clone(),
        destination,
        replaced_stage_identity,
        Some(replaced_plan),
        Some(replaced_log),
    );
    cleanup_extract_journal_artifacts(&replaced_journal)
        .expect_err("missing stage does not authorize a replacement sibling");
    assert_eq!(
        std::fs::read(move_plan_path(&replaced_stage)).unwrap(),
        b"replacement"
    );
    assert!(move_identity_log_path(&replaced_stage).is_file());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn orphan_cleanup_removes_authenticated_sidecars_with_stage_present_or_missing() {
    for (suffix, remove_stage) in [
        ("0123456789abcdef0123456789abcdef", false),
        ("fedcba9876543210fedcba9876543210", true),
    ] {
        let cache = temp_root("zinnia-orphan-sidecar-cleanup");
        std::fs::create_dir_all(&cache).expect("cache");
        let stage = cache.join(format!(".zinnia-extract-{suffix}"));
        std::fs::create_dir(&stage).expect("stage");
        let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
        register_pending_stage(&cache, &stage, &stage_identity).expect("register stage");
        let plan_identity = write_move_plan(&stage, &[]).expect("move plan");
        let log_identity = create_test_identity_log(&stage, b"");
        super::journal::record_pending_move_plan_identity(
            &cache,
            &stage,
            &stage_identity,
            &plan_identity,
        )
        .expect("record plan identity");
        super::journal::record_pending_move_identity_log_identity(
            &cache,
            &stage,
            &stage_identity,
            &log_identity,
        )
        .expect("record log identity");
        if remove_stage {
            std::fs::remove_dir(&stage).expect("remove stage before orphan cleanup");
        }

        cleanup_orphan_stages_at(&cache).expect("orphan cleanup");
        assert!(!stage.exists());
        assert!(!move_plan_path(&stage).exists());
        assert!(!move_identity_log_path(&stage).exists());
        assert!(read_pending_stages(&cache).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(cache);
    }
}

#[test]
fn orphan_archive_backups_require_complete_matching_identity_set() {
    let cache = temp_root("zinnia-orphan-archive-backups");
    std::fs::create_dir_all(&cache).expect("cache");
    let matching_stage = cache.join(".zinnia-archive-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&matching_stage).expect("matching stage");
    let matching_stage_identity =
        super::journal::path_identity(&matching_stage).expect("matching stage identity");
    register_pending_stage(&cache, &matching_stage, &matching_stage_identity)
        .expect("register matching stage");
    for index in 0..2 {
        let backup = archive_backup_path(&matching_stage, index);
        std::fs::write(&backup, format!("backup-{index}")).expect("matching backup");
        let identity =
            super::journal::regular_file_identity_with_fingerprint(&backup).expect("backup id");
        super::journal::record_pending_archive_backup_identity(
            &cache,
            &matching_stage,
            &matching_stage_identity,
            index,
            2,
            &identity,
        )
        .expect("record backup identity");
    }
    cleanup_orphan_stages_at(&cache).expect("matching backup cleanup");
    assert!(!matching_stage.exists());
    assert!(!archive_backup_path(&matching_stage, 0).exists());
    assert!(!archive_backup_path(&matching_stage, 1).exists());

    let replaced_stage = cache.join(".zinnia-archive-fedcba9876543210fedcba9876543210");
    std::fs::create_dir(&replaced_stage).expect("replaced stage");
    let replaced_stage_identity =
        super::journal::path_identity(&replaced_stage).expect("replaced stage identity");
    register_pending_stage(&cache, &replaced_stage, &replaced_stage_identity)
        .expect("register replaced stage");
    for index in 0..2 {
        let backup = archive_backup_path(&replaced_stage, index);
        std::fs::write(&backup, format!("owned-{index}")).expect("owned backup");
        let identity =
            super::journal::regular_file_identity_with_fingerprint(&backup).expect("backup id");
        super::journal::record_pending_archive_backup_identity(
            &cache,
            &replaced_stage,
            &replaced_stage_identity,
            index,
            2,
            &identity,
        )
        .expect("record backup identity");
    }
    let retained = cache.join("retained-owned-backup-one");
    std::fs::rename(archive_backup_path(&replaced_stage, 1), &retained)
        .expect("retain owned backup one");
    std::fs::write(archive_backup_path(&replaced_stage, 1), b"replacement")
        .expect("replacement backup one");

    cleanup_orphan_stages_at(&cache).expect("fail-closed orphan pass");
    assert!(
        archive_backup_path(&replaced_stage, 0).is_file(),
        "backup zero must survive full-set prevalidation failure"
    );
    assert_eq!(
        std::fs::read(archive_backup_path(&replaced_stage, 1)).unwrap(),
        b"replacement"
    );
    assert!(replaced_stage.is_dir());
    assert_eq!(
        read_pending_stages(&cache).unwrap(),
        vec![replaced_stage.to_string_lossy().to_string()]
    );
    let _ = std::fs::remove_dir_all(cache);
}

#[test]
fn legacy_identity_less_current_pending_record_fails_closed_for_sibling() {
    let cache = temp_root("zinnia-legacy-current-pending-sidecar");
    std::fs::create_dir_all(&cache).expect("cache");
    let stage = cache.join(".zinnia-extract-0123456789abcdef0123456789abcdef");
    std::fs::create_dir(&stage).expect("stage");
    let stage_identity = super::journal::path_identity(&stage).expect("stage identity");
    std::fs::write(move_plan_path(&stage), b"legacy unowned sibling").expect("legacy sidecar");
    let legacy_current = serde_json::json!([{
        "path": stage.to_string_lossy(),
        "identity": stage_identity,
    }]);
    std::fs::write(
        super::journal::pending_stages_path(&cache),
        serde_json::to_vec(&legacy_current).unwrap(),
    )
    .expect("legacy current registry");

    cleanup_orphan_stages_at(&cache).expect("fail-closed orphan cleanup");
    assert!(stage.is_dir());
    assert_eq!(
        std::fs::read(move_plan_path(&stage)).unwrap(),
        b"legacy unowned sibling"
    );
    assert_eq!(
        read_pending_stages(&cache).unwrap(),
        vec![stage.to_string_lossy().to_string()]
    );
    let _ = std::fs::remove_dir_all(cache);
}
