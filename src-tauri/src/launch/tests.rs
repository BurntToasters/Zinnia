//! Launch module unit tests.

use super::extract_window::{
    bump_extract_warm_idle_generation, extract_session_init_script, warm_idle_timer_still_owns,
    EXTRACT_WARM_IDLE_ACTIVE, EXTRACT_WARM_IDLE_GENERATION,
};
use super::open_path::{derive_extract_destination_path, normalize_destination_path};
use super::open_routing::{
    enqueue_pending_batch, looks_like_archive_path, parse_open_request_args,
    parse_open_request_args_ex, parse_shell_handoff_contents, record_shell_handoff_error,
    should_queue_extract_to_main, should_use_extract_window, take_shell_handoff_error,
};
use super::OpenPathsPayload;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Url;

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

#[test]
fn e2e_session_active_defaults_off() {
    #[cfg(not(feature = "e2e"))]
    {
        assert!(
            !super::e2e_session_active(),
            "packaged/release builds must ignore ZINNIA_E2E"
        );
    }
    #[cfg(feature = "e2e")]
    {
        if std::env::var("ZINNIA_E2E").ok().as_deref() == Some("1") {
            return;
        }
        assert!(!super::e2e_session_active());
    }
}

#[test]
fn shell_handoff_error_is_consumed_once() {
    record_shell_handoff_error("bad handoff".to_string());
    assert_eq!(take_shell_handoff_error().as_deref(), Some("bad handoff"));
    assert_eq!(take_shell_handoff_error(), None);
}

#[test]
fn extract_session_init_script_escapes_js_line_separators() {
    let script = extract_session_init_script("foo\u{2028}bar.zip", "a\u{2029}b", true);
    assert!(
        script.contains("\\u2028"),
        "U+2028 must be escaped for JS embedding: {script}"
    );
    assert!(
        script.contains("\\u2029"),
        "U+2029 must be escaped for JS embedding: {script}"
    );
    assert!(
        !script.contains('\u{2028}') && !script.contains('\u{2029}'),
        "raw line separators must not appear in init script"
    );
    assert!(script.contains("__ZINNIA_EXTRACT__"));
    assert!(script.contains("\"destinationExists\":true"));
}

#[test]
fn native_context_menu_guard_script_blocks_until_debug_flag() {
    let script = super::webview_context_menu::NATIVE_CONTEXT_MENU_GUARD_SCRIPT;
    assert!(script.contains("__ZINNIA_ALLOW_NATIVE_CONTEXT_MENU__"));
    assert!(script.contains("__ZINNIA_NATIVE_CONTEXT_MENU_GUARD__"));
    assert!(script.contains("preventDefault"));
    assert!(script.contains("contextmenu"));
}

#[test]
fn derive_extract_destination_matches_frontend_rules() {
    assert_eq!(
        derive_extract_destination_path("/downloads/example.zip"),
        Some(std::path::PathBuf::from("/downloads/example"))
    );
    assert_eq!(
        derive_extract_destination_path("/downloads/example.tar.gz"),
        Some(std::path::PathBuf::from("/downloads/example"))
    );
    assert_eq!(
        derive_extract_destination_path(r"C:\downloads\example.7z"),
        Some(std::path::PathBuf::from(r"C:\downloads\example"))
    );
    assert_eq!(
        derive_extract_destination_path("/downloads/example.custom"),
        Some(std::path::PathBuf::from(
            "/downloads/example.custom_extracted"
        ))
    );
    assert_eq!(
        derive_extract_destination_path("/example.zip"),
        Some(std::path::PathBuf::from("/example"))
    );
    assert_eq!(
        derive_extract_destination_path(r"C:\example.zip"),
        Some(std::path::PathBuf::from(r"C:\example"))
    );
    assert_eq!(
        derive_extract_destination_path("   "),
        Some(std::path::PathBuf::from("   _extracted"))
    );
    assert_eq!(
        derive_extract_destination_path("/downloads/..zip"),
        Some(std::path::PathBuf::from("/downloads/_extracted"))
    );
    assert_eq!(
        derive_extract_destination_path("/downloads/...zip"),
        Some(std::path::PathBuf::from("/downloads/_extracted"))
    );
    assert_eq!(
        derive_extract_destination_path("/downloads/....zip"),
        Some(std::path::PathBuf::from("/downloads/_extracted"))
    );
    assert_eq!(
        derive_extract_destination_path("/downloads/notes. .zip"),
        Some(std::path::PathBuf::from("/downloads/_extracted"))
    );
}

#[test]
fn normalize_destination_path_joins_missing_leaf_under_canonical_parent() {
    let base = temp_base("normalize-dest");
    let missing = base.join("fresh-output");
    let normalized = normalize_destination_path(&missing).expect("normalize");
    assert_eq!(
        normalized,
        base.canonicalize().expect("base").join("fresh-output")
    );
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn should_use_extract_window_honors_explicit_extract_mode() {
    let paths = vec!["/tmp/not-an-archive.txt".to_string()];
    assert!(should_use_extract_window(&paths, "extract-explicit"));
}

#[test]
fn should_use_extract_window_accepts_compound_tar() {
    let paths = vec!["/downloads/bundle.tar.gz".to_string()];
    assert!(should_use_extract_window(&paths, "extract-explicit"));
    assert!(should_use_extract_window(&paths, ""));
}

#[test]
fn should_use_extract_window_accepts_single_archive_path() {
    let base = temp_base("extract-mode");
    let file_path = base.join("archive.zip");
    write_zip(&file_path);

    let path = file_path.to_string_lossy().to_string();
    assert!(should_use_extract_window(&[path], ""));

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn should_use_extract_window_rejects_non_archive_path() {
    let base = temp_base("extract-mode");
    let file_path = base.join("plain.txt");
    std::fs::write(&file_path, b"this is plain text").expect("probe file should be written");

    let path = file_path.to_string_lossy().to_string();
    assert!(!should_use_extract_window(&[path], ""));

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn should_use_extract_window_rejects_multiple_paths_without_explicit_mode() {
    let base = temp_base("extract-mode");
    let one = base.join("one.zip");
    let two = base.join("two.zip");
    write_zip(&one);
    write_zip(&two);

    let paths = vec![
        one.to_string_lossy().to_string(),
        two.to_string_lossy().to_string(),
    ];
    assert!(!should_use_extract_window(&paths, ""));

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn should_queue_extract_to_main_when_slot_busy_or_extract_open() {
    assert!(!should_queue_extract_to_main(false, false));
    assert!(should_queue_extract_to_main(true, false));
    assert!(should_queue_extract_to_main(false, true));
    assert!(should_queue_extract_to_main(true, true));
}

#[test]
fn parse_open_request_args_handles_file_urls() {
    let base = temp_base("open-args");
    let file_path = base.join("archive.zip");
    write_zip(&file_path);

    let file_url = Url::from_file_path(&file_path)
        .expect("file URL should be generated")
        .to_string();
    let (paths, mode) = parse_open_request_args(vec![file_url]);

    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0], file_path.to_string_lossy().to_string());
    assert_eq!(mode, "extract");

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parse_open_request_args_preserves_whitespace_in_file_names() {
    let base = temp_base("open-args-spaces");
    let file_path = base.join(" archive.zip");
    write_zip(&file_path);

    let (paths, mode) = parse_open_request_args(vec![file_path.to_string_lossy().to_string()]);

    assert_eq!(paths, vec![file_path.to_string_lossy().to_string()]);
    assert_eq!(mode, "extract");

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parse_open_request_args_ignores_macos_process_serial_number_flag() {
    let base = temp_base("open-args");
    let file_path = base.join("archive.zip");
    write_zip(&file_path);

    let (paths, mode) = parse_open_request_args(vec![
        "-psn_0_12345".to_string(),
        file_path.to_string_lossy().to_string(),
    ]);

    assert_eq!(paths, vec![file_path.to_string_lossy().to_string()]);
    assert_eq!(mode, "extract");

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parse_open_request_args_keeps_file_paths_with_dotdot_in_name() {
    let base = temp_base("open-args");
    let file_path = base.join("name..bak.zip");
    write_zip(&file_path);

    let file_url = Url::from_file_path(&file_path)
        .expect("file URL should be generated")
        .to_string();
    let (paths, mode) = parse_open_request_args(vec![file_url]);

    assert_eq!(paths, vec![file_path.to_string_lossy().to_string()]);
    assert_eq!(mode, "extract");

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parse_open_request_args_sets_extract_mode_for_multiple_archives() {
    let base = temp_base("open-args");
    let one = base.join("one.zip");
    let two = base.join("two.zip");
    write_zip(&one);
    write_zip(&two);

    let (paths, mode) = parse_open_request_args(vec![
        one.to_string_lossy().to_string(),
        two.to_string_lossy().to_string(),
    ]);

    assert_eq!(
        paths,
        vec![
            one.to_string_lossy().to_string(),
            two.to_string_lossy().to_string()
        ]
    );
    assert_eq!(mode, "extract");

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parse_open_request_args_keeps_compress_mode_for_archive_input() {
    let base = temp_base("compress-args");
    let archive = base.join("input.zip");
    write_zip(&archive);

    let (paths, mode) = parse_open_request_args(vec![
        "--compress".to_string(),
        archive.to_string_lossy().to_string(),
    ]);

    assert_eq!(paths, vec![archive.to_string_lossy().to_string()]);
    assert_eq!(mode, "compress");
    assert!(!should_use_extract_window(&paths, &mode));

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parse_open_request_args_keeps_compress_mode_for_folder_input() {
    let base = temp_base("compress-folder");

    let (paths, mode) = parse_open_request_args(vec![
        "--compress".to_string(),
        base.to_string_lossy().to_string(),
    ]);

    assert_eq!(paths, vec![base.to_string_lossy().to_string()]);
    assert_eq!(mode, "compress");
    assert!(!should_use_extract_window(&paths, &mode));

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parse_open_request_args_can_defer_shell_handoff_consume() {
    let argv = [
        "--extract".to_string(),
        "--zinnia-shell-handoff".to_string(),
        "/tmp/zinnia-shell-handoff-{deadbeef}.tmp".to_string(),
    ];
    let (paths, mode) = parse_open_request_args_ex(argv.clone(), false);
    assert!(
        paths.is_empty(),
        "deferred consume must not load handoff paths"
    );
    assert_eq!(mode, "extract");

    // Consuming a missing handoff must not panic; paths stay empty.
    let (consumed_paths, consumed_mode) = parse_open_request_args(argv);
    assert!(consumed_paths.is_empty());
    assert_eq!(consumed_mode, "extract");
}

#[test]
fn shell_handoff_parser_accepts_bounded_absolute_paths() {
    assert_eq!(
        parse_shell_handoff_contents("C:\\one.txt\nC:\\two.txt\n").unwrap(),
        ["C:\\one.txt", "C:\\two.txt"]
    );
    assert_eq!(
        parse_shell_handoff_contents(
            "\\\\server\\share\\one.txt\n//server/share/two.txt\n\\\\?\\UNC\\server\\share\\three.txt\n"
        )
        .unwrap(),
        [
            "\\\\server\\share\\one.txt",
            "//server/share/two.txt",
            "\\\\?\\UNC\\server\\share\\three.txt"
        ]
    );
    assert_eq!(
        parse_shell_handoff_contents(
            "\\\\?\\C:\\one.txt\n\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\two.txt\n"
        )
        .unwrap(),
        [
            "\\\\?\\C:\\one.txt",
            "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\two.txt"
        ]
    );
    assert!(parse_shell_handoff_contents("relative.txt\n").is_err());
    assert!(parse_shell_handoff_contents("C:drive-relative.txt\n").is_err());
    assert!(parse_shell_handoff_contents("\\rooted-current-drive.txt\n").is_err());
    assert!(parse_shell_handoff_contents("\\\\server-only\n").is_err());
    assert!(parse_shell_handoff_contents("\\\\.\\PhysicalDrive0\n").is_err());
    assert!(parse_shell_handoff_contents("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\n").is_err());
    assert!(parse_shell_handoff_contents("C:\\one\r.txt\n").is_err());
}

#[cfg(windows)]
#[test]
fn shell_open_normalization_preserves_volume_guid_namespace() {
    use std::path::PathBuf;

    assert_eq!(
        super::open_path::normalize_shell_open_path(PathBuf::from(r"\\?\C:\folder")),
        PathBuf::from(r"C:\folder")
    );
    assert_eq!(
        super::open_path::normalize_shell_open_path(PathBuf::from(r"\\?\UNC\server\share\folder")),
        PathBuf::from(r"\\server\share\folder")
    );
    let volume = PathBuf::from(r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\folder");
    assert_eq!(
        super::open_path::normalize_shell_open_path(volume.clone()),
        volume
    );
}

#[test]
fn pending_path_queue_accepts_back_to_back_shell_batches() {
    let mut queue = Vec::new();
    for batch in 0..4 {
        let paths = (0..1_000)
            .map(|index| format!("C:\\batch-{batch}-item-{index}"))
            .collect();
        assert!(enqueue_pending_batch(
            &mut queue,
            paths,
            "compress".to_string()
        ));
    }
    assert!(enqueue_pending_batch(
        &mut queue,
        (0..96)
            .map(|index| format!("C:\\final-batch-item-{index}"))
            .collect(),
        "compress".to_string()
    ));
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].paths.len(), 4_096);
}

#[test]
fn pending_path_queue_rejects_work_beyond_its_bounded_headroom() {
    let mut queue = vec![OpenPathsPayload {
        paths: (0..4_096)
            .map(|index| format!("C:\\existing-{index}"))
            .collect(),
        mode: "compress".to_string(),
    }];
    assert!(!enqueue_pending_batch(
        &mut queue,
        vec!["C:\\overflow".to_string()],
        "compress".to_string()
    ));
    assert_eq!(queue[0].paths.len(), 4_096);
}

#[test]
fn pending_path_queue_accepts_duplicate_only_requests_at_capacity() {
    let existing: Vec<String> = (0..4_096)
        .map(|index| format!("C:\\existing-{index}"))
        .collect();
    let mut queue = vec![OpenPathsPayload {
        paths: existing.clone(),
        mode: "compress".to_string(),
    }];
    assert!(enqueue_pending_batch(
        &mut queue,
        existing.into_iter().take(100).collect(),
        "compress".to_string(),
    ));
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].paths.len(), 4_096);
}

fn temp_base(tag: &str) -> std::path::PathBuf {
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "zinnia-{tag}-{}-{}-{sequence}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should work")
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).expect("temp directory should be created");
    base
}

fn write_zip(path: &std::path::Path) {
    std::fs::write(path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
        .expect("probe file should be written");
}

#[test]
fn looks_like_archive_path_rejects_bare_numeric_suffix() {
    assert!(!looks_like_archive_path("/downloads/notes.001"));
    assert!(looks_like_archive_path("/downloads/archive.7z.001"));
    assert!(looks_like_archive_path("/downloads/archive.zip"));
    assert!(looks_like_archive_path("/downloads/archive.tgz"));
    assert!(looks_like_archive_path("/downloads/archive.tbz2"));
    assert!(looks_like_archive_path("/downloads/archive.txz"));
}

#[test]
fn looks_like_split_volume_accepts_sibling_volumes() {
    let base = temp_base("split-volume");
    let first = base.join("chunk.001");
    let second = base.join("chunk.002");
    std::fs::write(&first, b"a").expect("volume 1");
    std::fs::write(&second, b"b").expect("volume 2");
    assert!(looks_like_archive_path(first.to_string_lossy().as_ref()));
    assert!(!looks_like_archive_path(
        base.join("lonely.001").to_string_lossy().as_ref()
    ));
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn warm_idle_generation_advances_when_bumped() {
    let before = EXTRACT_WARM_IDLE_GENERATION.load(Ordering::SeqCst);
    bump_extract_warm_idle_generation();
    let after = EXTRACT_WARM_IDLE_GENERATION.load(Ordering::SeqCst);
    assert!(after > before);
    EXTRACT_WARM_IDLE_ACTIVE.store(false, Ordering::SeqCst);
}

#[test]
fn warm_idle_timer_keeps_ownership_until_leave_bumps() {
    let generation = EXTRACT_WARM_IDLE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    assert!(warm_idle_timer_still_owns(generation));
    bump_extract_warm_idle_generation();
    assert!(!warm_idle_timer_still_owns(generation));
    EXTRACT_WARM_IDLE_ACTIVE.store(false, Ordering::SeqCst);
}
