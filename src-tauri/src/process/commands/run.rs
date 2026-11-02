//! Run-7z preparation helpers (preflight, compound TAR) and command bodies.

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use super::super::archive_snapshot::assert_archive_identity_unchanged;
use super::super::commit::validate_staged_tree;
use super::super::commit::{
    commit_cleanup, commit_failure_should_scrub_staging, rollback_cleanup, PublishStrategy,
};
use super::super::journal::{clear_cleanup_journal, write_cleanup_journal, CleanupJournalGuard};
use super::super::quota::monitor_extract_quota_with_manifest;
use super::super::recovery::{
    recover_interrupted_transaction, retract_scrub_archive_journal_or_fail,
    wait_for_startup_recovery,
};
use super::super::staging::{
    assert_extract_archive_members_safe_with_summary, create_publish_stage_dir_inside,
    operation_output_path, prepare_cleanup_plan_with_cancel, rewrite_archive_output,
    rewrite_archive_update_output, rewrite_extract_archive, rewrite_extract_output,
};
use super::super::{
    ensure_idle_mut, lock_process, release_preparation_failure_best_effort,
    release_prepare_slot_best_effort, release_snapshot_handles, ArchiveIoDiagnostics,
    ArchiveManifestSummary, CleanupPlan, RunningProcess,
};
use super::argv::{apply_backend_link_switches, harden_7z_args, pin_existing_zip_output_type};
use super::spawn::{
    collect_command_output, complete_password_transport, mask_password_arg_tokens,
    spawn_7z_noninteractive, terminate_registered_child_async,
};
use super::{
    assert_probed_version_matches_bundle, parse_7z_version, parse_run_7z_request, Run7zRequest,
};
use crate::output::{sanitize_output, MAX_OUTPUT_BYTES};
use crate::progress::parse_progress_line;

pub(super) fn release_snapshot_handles_for_plan(plan: &CleanupPlan) {
    if let Some(stage) = plan
        .staged_input_archive
        .as_ref()
        .and_then(|path| path.parent())
    {
        release_snapshot_handles(stage);
    }
}
pub(super) fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

pub(super) fn archive_path_from_args(args: &[String]) -> Option<std::path::PathBuf> {
    let separator = args.iter().position(|arg| arg == "--")?;
    match args.first().map(String::as_str) {
        Some("x" | "l" | "t") => args.get(separator + 1).map(std::path::PathBuf::from),
        Some("a" | "u") => args[1..separator]
            .iter()
            .find(|arg| !arg.starts_with('-'))
            .map(std::path::PathBuf::from),
        _ => None,
    }
}

pub(super) fn relocate_extract_stage_inside_destination(
    app: &tauri::AppHandle,
    plan: &mut CleanupPlan,
) -> Result<(), String> {
    relocate_extract_stage_inside_destination_with_journal(plan, |plan| {
        write_cleanup_journal(app, plan).map(|_| ())
    })
}

/// Move an empty sibling extraction stage under an existing destination after
/// member preflight proves that the archive contains no links. The journal
/// callback is kept as a seam so the transaction mutation and rollback paths
/// are exercised by unit tests without manufacturing a Tauri app handle.
pub(crate) fn relocate_extract_stage_inside_destination_with_journal<F>(
    plan: &mut CleanupPlan,
    write_journal: F,
) -> Result<(), String>
where
    F: FnOnce(&CleanupPlan) -> Result<(), String>,
{
    let (old_stage, destination) = plan
        .staged_extract
        .as_ref()
        .cloned()
        .ok_or_else(|| "Extraction plan has no stage to relocate.".to_string())?;
    if old_stage.parent() == Some(destination.as_path()) {
        return Ok(());
    }
    crate::path_safety::assert_real_directory(&destination)
        .map_err(|error| format!("Extraction destination changed before staging: {error}"))?;
    let old_identity = plan
        .stage_identity(&old_stage)
        .cloned()
        .ok_or_else(|| "Extraction stage has no creation-bound identity.".to_string())?;
    let created =
        match create_publish_stage_dir_inside(&destination, "extract", plan.cache_dir.as_deref()) {
            Ok(created) => created,
            Err(error) => {
                // Inside-destination staging is an optimization. ACLs, remote
                // filesystems, or custom policies may reject a hidden child even
                // though the already-created sibling stage can still publish via
                // its authenticated target-local fallback.
                eprintln!("Could not use inside-destination extraction stage: {error}");
                return Ok(());
            }
        };
    let new_stage = created.path.clone();
    let new_identity = created.identity.clone();

    plan.staged_extract = Some((new_stage.clone(), destination.clone()));
    let Some((_, identity)) = plan
        .stage_identities
        .iter_mut()
        .find(|(path, _)| path.as_path() == old_stage.as_path())
    else {
        let _ = super::super::journal::remove_directory_if_matches(&new_stage, &new_identity);
        return Err("Extraction plan lost its original stage identity.".to_string());
    };
    *identity = new_identity.clone();
    if let Some((path, _)) = plan
        .stage_identities
        .iter_mut()
        .find(|(path, _)| path.as_path() == old_stage.as_path())
    {
        *path = new_stage.clone();
    }

    // Write new journal before removing old stage. If old cleanup fails, its
    // pending-stage record remains an inert orphan for startup scrub.
    if let Err(error) = write_journal(plan) {
        plan.staged_extract = Some((old_stage.clone(), destination));
        if let Some((path, identity)) = plan
            .stage_identities
            .iter_mut()
            .find(|(path, _)| path.as_path() == new_stage.as_path())
        {
            *path = old_stage.clone();
            *identity = old_identity.clone();
        }
        let _ = super::super::journal::remove_directory_if_matches(&new_stage, &new_identity);
        if let Some(cache_dir) = &plan.cache_dir {
            let _ = super::super::journal::unregister_pending_stage(cache_dir, &new_stage);
        }
        return Err(error);
    }
    if let Err(error) =
        super::super::journal::remove_directory_if_matches(&old_stage, &old_identity)
    {
        eprintln!("Could not remove empty sibling extraction stage after relocation: {error}");
    } else if let Some(cache_dir) = &plan.cache_dir {
        let _ = super::super::journal::unregister_pending_stage(cache_dir, &old_stage);
    }
    Ok(())
}

#[derive(Clone, Debug, Default)]
pub(super) struct CompressInputPreflight {
    pub(super) input_scan_ms: u64,
    pub(super) input_scan_strategy: Option<String>,
}

fn compress_input_scan_strategy(args: &[String]) -> Option<String> {
    if !matches!(args.first().map(String::as_str), Some("a" | "u")) {
        return None;
    }
    let separator = args.iter().position(|arg| arg == "--")?;
    if args[separator + 1..].iter().all(|path| {
        std::fs::symlink_metadata(path)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
    }) {
        Some("regular-files-bypass".to_string())
    } else {
        Some("bounded-directory-probe".to_string())
    }
}

pub(super) fn assert_compress_inputs_are_real_paths<C>(
    app: &tauri::AppHandle,
    args: &[String],
    should_cancel: C,
) -> Result<CompressInputPreflight, String>
where
    C: Fn() -> bool + Sync,
{
    let Some(cmd) = args.first().map(String::as_str) else {
        return Ok(CompressInputPreflight::default());
    };
    if cmd != "a" && cmd != "u" {
        return Ok(CompressInputPreflight::default());
    }
    let Some(separator) = args.iter().position(|arg| arg == "--") else {
        return Ok(CompressInputPreflight::default());
    };
    let inputs: Vec<String> = args.iter().skip(separator + 1).cloned().collect();
    let single_stream = args.iter().any(|arg| {
        matches!(
            arg.to_ascii_lowercase().as_str(),
            "-tgzip" | "-tbzip2" | "-txz"
        )
    });
    if single_stream && inputs.len() != 1 {
        return Err(
            "GZIP, BZIP2, and XZ compression require exactly one regular input file.".to_string(),
        );
    }
    let output = operation_output_path(args)
        .ok_or_else(|| "Compression command is missing its output archive path.".to_string())?;
    let output_parent = output
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .canonicalize()
        .map_err(|error| format!("Could not resolve archive output parent: {error}"))?;
    let output_name = output
        .file_name()
        .ok_or_else(|| "Archive output has no file name.".to_string())?;
    let resolved_output = output_parent.join(output_name);
    let mut top_level_names = std::collections::HashMap::<String, String>::new();
    let mut needs_recursive_probe = false;
    let input_scan_started = std::time::Instant::now();
    for path in &inputs {
        if should_cancel() {
            return Err("Compress input scan was cancelled.".to_string());
        }
        let fs_path = std::path::Path::new(path);
        let meta = match std::fs::symlink_metadata(fs_path) {
            Ok(meta) => meta,
            Err(error) => {
                return Err(format!("Unable to read input path '{path}': {error}"));
            }
        };
        if crate::path_safety::is_link_or_reparse(&meta) {
            if meta.file_type().is_symlink() {
                if let Some(tmp_root) = crate::tempdir::managed_convert_tmp_root_for(app, fs_path) {
                    crate::path_safety::assert_relative_symlink_within_root(&tmp_root, fs_path)?;
                    continue;
                }
            }
            return Err(format!(
                "Choose the real file or folder, not a symbolic link or reparse point: {path}"
            ));
        }
        if single_stream && !meta.is_file() {
            return Err(format!(
                "GZIP, BZIP2, and XZ compression require one regular file, not a directory or special entry: {path}"
            ));
        }
        if meta.is_dir() {
            needs_recursive_probe = true;
        }
        let canonical = fs_path
            .canonicalize()
            .map_err(|error| format!("Could not resolve input path '{path}': {error}"))?;
        if (meta.is_dir() && resolved_output.starts_with(&canonical))
            || (meta.is_file() && canonical == resolved_output)
        {
            return Err(format!(
                "The output archive cannot be placed inside a selected input directory or used as its own input: {}",
                resolved_output.display()
            ));
        }
        let name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Input path has an invalid file name: {path}"))?;
        // Archive roots become one top-level namespace. Reject collisions
        // case-insensitively so archives behave consistently after moving
        // between Windows, macOS, and Linux filesystems.
        let portable_name = name.to_lowercase();
        if let Some(previous) = top_level_names.insert(portable_name, path.clone()) {
            if previous != *path {
                return Err(format!(
                    "Selected inputs have the same top-level archive name: '{previous}' and '{path}'. Rename one item or add their common parent folder."
                ));
            }
        }
    }
    if !needs_recursive_probe {
        return Ok(CompressInputPreflight {
            input_scan_ms: elapsed_ms(input_scan_started),
            input_scan_strategy: compress_input_scan_strategy(args),
        });
    }
    super::super::compress_preflight::assert_compress_inputs_safe_with_cancel(
        &inputs,
        should_cancel,
    )?;
    Ok(CompressInputPreflight {
        input_scan_ms: elapsed_ms(input_scan_started),
        input_scan_strategy: compress_input_scan_strategy(args),
    })
}

/// Check whether the owning window cancelled while an operation is in its
/// pre-spawn phase. Callers that have already created staging must roll it
/// back before releasing the slot.
pub(super) fn preparation_was_cancelled(state: &RunningProcess) -> Result<bool, String> {
    Ok(lock_process(state)?.cancelling)
}

/// Release a pre-spawn operation that has no staging resources to clean up.
pub(super) fn abort_cancelled_preparation(state: &RunningProcess) -> Result<(), String> {
    let mut process = lock_process(state)?;
    if !process.cancelling {
        return Ok(());
    }
    process.release_prepare_slot();
    Err("Archive operation was cancelled during preparation.".to_string())
}

fn live_child_blocks_preparation_rollback(state: &RunningProcess) -> bool {
    match lock_process(state) {
        Ok(process) => process.child.is_some(),
        Err(_) => true,
    }
}

pub(super) fn checkpoint_cleanup_plan(state: &RunningProcess, cleanup_plan: &CleanupPlan) {
    match state.0.lock() {
        Ok(mut process) => process.cleanup_plan = Some(cleanup_plan.clone()),
        Err(poisoned) => poisoned.into_inner().cleanup_plan = Some(cleanup_plan.clone()),
    }
}

/// Settle a pre-spawn failure using the same nested ownership rule as post-child
/// finalization: release only after rollback and journal cleanup both succeed.
pub(crate) fn settle_preparation_failure<R, J>(
    state: &RunningProcess,
    cleanup_plan: &CleanupPlan,
    error: impl Into<String>,
    rollback: R,
    clear_journal: J,
) -> String
where
    R: FnOnce() -> Result<(), String>,
    J: FnOnce() -> Result<(), String>,
{
    let error = error.into();
    checkpoint_cleanup_plan(state, cleanup_plan);
    if live_child_blocks_preparation_rollback(state) {
        return format!(
            "{error} 7-Zip is still running; staging was kept and the operation slot was not released."
        );
    }
    if let Err(rollback_error) = rollback() {
        return format!("{error}; staging cleanup also failed: {rollback_error}");
    }
    if let Err(journal_error) = clear_journal() {
        return format!("{error}; recovery journal cleanup also failed: {journal_error}");
    }
    release_preparation_failure_best_effort(state);
    error
}

/// Roll back every pre-spawn resource before releasing the single-operation
/// slot. Keeping this sequence in one function prevents new error paths from
/// forgetting the journal or leaving `preparing`/`cancelling` set.
pub(crate) fn finalize_preparation_error(
    state: &RunningProcess,
    cleanup_plan: &CleanupPlan,
    journal_guard: Option<&mut CleanupJournalGuard>,
    error: impl Into<String>,
) -> String {
    release_snapshot_handles_for_plan(cleanup_plan);
    settle_preparation_failure(
        state,
        cleanup_plan,
        error,
        || rollback_cleanup(cleanup_plan),
        || match journal_guard {
            Some(guard) => guard.clear(),
            None => Ok(()),
        },
    )
}

/// Settle post-child finalization without conflating the archive operation's
/// result with recovery ownership. An outer error means cleanup is incomplete
/// and deliberately retains the slot. An inner error is returned only after
/// the durable journal has been cleared and the slot released.
pub(crate) fn settle_archive_finalization<F>(
    state: &RunningProcess,
    finalize_result: Result<Result<(), String>, String>,
    clear_journal: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    let operation_result = finalize_result?;
    // Finalization completed; a transient unlink error must not wedge the slot.
    // Startup recovery treats a committed journal as cleanup-safe.
    let journal_result = clear_journal();
    {
        let mut process = state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        process.child = None;
        process.release_prepare_slot();
    }
    journal_result?;
    operation_result
}

pub(crate) fn is_compound_tar_operation(args: &[String]) -> bool {
    if !matches!(args.first().map(String::as_str), Some("x" | "l" | "t")) {
        return false;
    }
    let Some(separator) = args.iter().position(|arg| arg == "--") else {
        return false;
    };
    let Some(path) = args.get(separator + 1) else {
        return false;
    };
    let lower = path.to_ascii_lowercase();
    [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

/// 7-Zip exit 1 is publishable only for known metadata-only warnings. Data,
/// path, password, and unknown warnings remain fail-closed and roll back.
pub(crate) fn extract_warning_is_metadata_only(stdout: &str, stderr: &str) -> bool {
    let output = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    let unsafe_markers = [
        "dangerous link",
        "cannot open",
        "cannot create",
        "cannot set length",
        "crc failed",
        "data error",
        "unexpected end",
        "wrong password",
        "unsupported method",
        "no files to process",
    ];
    if unsafe_markers.iter().any(|marker| output.contains(marker)) {
        return false;
    }
    let allowed_markers = [
        "cannot set owner",
        "cannot set file attribute",
        "cannot set file time",
        "data after the end of archive",
        "data after the end of the payload data",
        "archive is open with offset",
    ];
    if !allowed_markers.iter().any(|marker| output.contains(marker)) {
        return false;
    }

    // 7-Zip writes diagnostic detail to stderr. Reject an unfamiliar stderr
    // line even when a known metadata warning also occurred.
    if stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .any(|line| {
            let line = line.to_ascii_lowercase();
            !allowed_markers.iter().any(|marker| line.contains(marker))
        })
    {
        return false;
    }
    // Some builds put warnings on stdout. Normal progress is allowed, but any
    // unknown warning/error-labelled line makes exit 1 fail closed. 7-Zip's
    // summary lines use "Errors:" / "System errors:" (plural), which neither
    // `contains("warning")` nor `starts_with("error:")` catches.
    !stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .any(|line| {
            let line = line.to_ascii_lowercase();
            (line.contains("warning")
                || line.starts_with("error:")
                || line.starts_with("errors:")
                || line.contains("system error"))
                && !line.starts_with("warnings:")
                && !allowed_markers.iter().any(|marker| line.contains(marker))
        })
}

fn find_single_compound_tar(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if crate::path_safety::is_link_or_reparse(&metadata) {
                return Err(
                    "The outer compressed stream produced a link instead of a TAR file."
                        .to_string(),
                );
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                files.push(path);
            } else {
                return Err("The outer compressed stream produced a special file.".to_string());
            }
        }
    }
    if files.len() != 1 {
        return Err(format!(
            "A compound TAR stream must expand to exactly one TAR file; found {} files.",
            files.len()
        ));
    }
    let file = files.pop().expect("length checked");
    if !crate::archive_detect::path_has_tar_signature(&file)? {
        return Err("The outer compressed stream did not contain a valid TAR archive.".to_string());
    }
    Ok(file)
}

pub(crate) fn compound_tar_outer_extract_args(
    snapshot: &std::path::Path,
    outer_stage: &std::path::Path,
) -> Vec<String> {
    let mut outer_args = vec![
        "x".to_string(),
        "-spd".to_string(),
        "-snld10".to_string(),
        "-aou".to_string(),
        format!("-o{}", outer_stage.to_string_lossy()),
        "--".to_string(),
        snapshot.to_string_lossy().into_owned(),
    ];
    harden_7z_args(&mut outer_args);
    apply_backend_link_switches(&mut outer_args);
    outer_args
}

pub(crate) fn compound_tar_outer_unpack_ok(code: i32, stdout: &str, stderr: &str) -> bool {
    code == 0 || (code == 1 && extract_warning_is_metadata_only(stdout, stderr))
}

pub(super) async fn prepare_compound_tar_snapshot(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    cleanup_plan: &mut CleanupPlan,
) -> Result<(), String> {
    let snapshot = cleanup_plan.staged_input_archive.clone().ok_or_else(|| {
        "Compound TAR extraction is missing its private input snapshot.".to_string()
    })?;
    let snapshot_parent = snapshot
        .parent()
        .ok_or_else(|| "Compound TAR snapshot has no private parent directory.".to_string())?;
    let token = super::super::staging::random_token()?;
    let outer_stage = snapshot_parent.join(format!(".zinnia-compound-{token}"));
    crate::fs_secure::create_private_dir(&outer_stage)
        .map_err(|error| format!("Could not create compound TAR staging: {error}"))?;

    let result = async {
        let outer_args = compound_tar_outer_extract_args(&snapshot, &outer_stage);
        let (_, _, outer_manifest) = assert_extract_archive_members_safe_with_summary(
            app,
            state,
            &outer_args,
            cleanup_plan.max_extract_bytes,
        )
        .await?;
        let (mut rx, child, pending_password) = spawn_7z_noninteractive(app, outer_args, state)?;
        {
            let cancelling = lock_process(state)?.cancelling;
            if cancelling {
                terminate_registered_child_async(app, &child).await?;
                return Err("Archive operation was cancelled during preparation.".to_string());
            }
            let mut process = lock_process(state)?;
            process.child = Some(child.clone());
            process.cleanup_plan = Some(cleanup_plan.clone());
        }
        if let Some(password) = pending_password {
            if let Err(error) = complete_password_transport(&child, password).await {
                terminate_registered_child_async(app, &child).await?;
                return Err(error);
            }
        }

        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let quota_task = cleanup_plan
            .max_extract_bytes
            .zip(cleanup_plan.min_free_bytes)
            .map(|(max_bytes, min_free_bytes)| {
                tauri::async_runtime::spawn(monitor_extract_quota_with_manifest(
                    app.clone(),
                    outer_stage.clone(),
                    max_bytes,
                    min_free_bytes,
                    finished.clone(),
                    Some(outer_manifest.clone()),
                ))
            });
        let collected = collect_command_output(&mut rx, MAX_OUTPUT_BYTES, |_| {}).await;
        finished.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(task) = quota_task {
            let _ = task.await;
        }
        if collected.stream_error.is_some() || collected.exit.is_none() {
            terminate_registered_child_async(app, &child).await?;
        }
        let (cancelled, abort_reason) = {
            let mut process = lock_process(state)?;
            process.child = None;
            (process.cancelling, process.abort_reason.clone())
        };
        if cancelled {
            return Err(abort_reason.unwrap_or_else(|| {
                "Archive operation was cancelled during compound TAR preparation.".to_string()
            }));
        }
        let code = collected.exit_code();
        if !collected.output_is_complete()
            || !compound_tar_outer_unpack_ok(code, &collected.stdout, &collected.stderr)
        {
            let detail = sanitize_output(if collected.stderr.trim().is_empty() {
                collected.stdout.trim()
            } else {
                collected.stderr.trim()
            });
            return Err(if detail.is_empty() {
                format!("Could not unpack the outer compressed stream (exit {code}).")
            } else {
                format!("Could not unpack the outer compressed stream: {detail}")
            });
        }

        let max_bytes = cleanup_plan.max_extract_bytes.unwrap_or(u64::MAX);
        validate_staged_tree(&outer_stage, max_bytes)?;
        let inner = find_single_compound_tar(&outer_stage)?;
        let promoted = snapshot_parent.join(format!(".zinnia-compound-{token}.tar"));
        std::fs::rename(&inner, &promoted)
            .map_err(|error| format!("Could not stage the inner TAR archive: {error}"))?;
        crate::fs_secure::remove_dir_all_for_cleanup(&outer_stage)
            .map_err(|error| format!("Could not finish compound TAR staging cleanup: {error}"))?;
        cleanup_plan.staged_input_archive = Some(promoted);
        if let Ok(mut process) = lock_process(state) {
            process.cleanup_plan = Some(cleanup_plan.clone());
        }
        Ok(())
    }
    .await;

    if result.is_err() {
        let keep_stage = lock_process(state)
            .map(|process| process.child.is_some())
            .unwrap_or(true);
        if !keep_stage {
            let _ = crate::fs_secure::remove_dir_all_for_cleanup(&outer_stage);
        }
    }
    result
}

struct OperationLivenessGuard(Arc<std::sync::atomic::AtomicBool>);

impl Drop for OperationLivenessGuard {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

struct SnapshotHandleGuard(Option<std::path::PathBuf>);

impl Drop for SnapshotHandleGuard {
    fn drop(&mut self) {
        if let Some(stage) = self.0.take() {
            super::super::release_snapshot_handles(&stage);
        }
    }
}

pub(super) async fn run_7z_inner(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_json: String,
    state: tauri::State<'_, super::super::RunningProcess>,
) -> Result<super::super::RunResult, String> {
    // Tauri must allocate the outer string before command dispatch; keeping the
    // nested request as one bounded string prevents an additional unbounded
    // Vec<String> deserialization at the command boundary. Drop the aggregate
    // copy immediately after parsing so password-bearing arguments do not stay
    // live through the operation.
    let Run7zRequest {
        args,
        expected_archive_identity,
        include_io_diagnostics,
        mark_of_the_web_source,
    } = parse_run_7z_request(&request_json)?;
    drop(request_json);
    let mark_of_the_web_source = match mark_of_the_web_source {
        Some(source) => Some(crate::quarantine::validated_mark_of_the_web_source(
            &source,
        )?),
        None => None,
    };
    let operation_started = std::time::Instant::now();
    let mut io_diagnostics = include_io_diagnostics.then(ArchiveIoDiagnostics::default);

    // Claim the slot before every potentially slow pre-spawn phase. Without
    // this, Cancel could report "idle" while a recursive input scan or startup
    // recovery wait continued toward a real archive publish.
    let operation_liveness = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let _operation_liveness_guard = OperationLivenessGuard(operation_liveness.clone());
    {
        let mut process = lock_process(&state)?;
        ensure_idle_mut(&mut process)?;
        process.preparing = true;
        process.owner_label = Some(window.label().to_string());
        process.abort_reason = None;
        process.operation_liveness = Some(operation_liveness);
    }

    let validation_started = std::time::Instant::now();
    let preflight_app = app.clone();
    let preflight_result = tokio::task::spawn_blocking(move || {
        let result = assert_compress_inputs_are_real_paths(&preflight_app, &args, || {
            let state = preflight_app.state::<RunningProcess>();
            state
                .0
                .lock()
                .map(|process| process.cancelling)
                .unwrap_or(true)
        });
        (args, result)
    })
    .await;
    abort_cancelled_preparation(&state)?;
    let mut args = match preflight_result {
        Ok((args, Ok(preflight))) => {
            if let Some(diagnostics) = io_diagnostics.as_mut() {
                let total = elapsed_ms(validation_started);
                diagnostics.phase_times.input_scan = preflight.input_scan_ms;
                diagnostics.phase_times.validation = total.saturating_sub(preflight.input_scan_ms);
                diagnostics.strategies.input_scan = preflight.input_scan_strategy.clone();
            }
            args
        }
        Ok((_args, Err(error))) => {
            release_prepare_slot_best_effort(&state);
            return Err(error);
        }
        Err(error) => {
            release_prepare_slot_best_effort(&state);
            return Err(format!("Compress-input preflight worker failed: {error}"));
        }
    };
    pin_existing_zip_output_type(&mut args);
    harden_7z_args(&mut args);
    apply_backend_link_switches(&mut args);
    let compound_tar_operation = is_compound_tar_operation(&args);
    // Listing and test commands do not create a cleanup plan, so retain the
    // identity proof explicitly. The frontend uses this value to reject a
    // stale browse/test result; keeping the initial token here also lets the
    // backend fail closed when a caller omitted the optional precondition.
    let mut non_mutating_archive_proof: Option<(std::path::PathBuf, String)> = None;
    let mut archive_quarantine: Option<Vec<u8>> = None;

    if let Some("x" | "l" | "t") = args.first().map(String::as_str) {
        let separator = match args.iter().position(|arg| arg == "--") {
            Some(separator) => separator,
            None => {
                release_prepare_slot_best_effort(&state);
                return Err("Archive command is missing '--'.".to_string());
            }
        };
        let archive = match args.get(separator + 1) {
            Some(archive) => archive,
            None => {
                release_prepare_slot_best_effort(&state);
                return Err("Archive command is missing an archive path.".to_string());
            }
        };
        let validation = crate::archive_detect::validate_archive_path(archive);
        if !validation.valid {
            release_prepare_slot_best_effort(&state);
            return Err(validation
                .reason
                .unwrap_or_else(|| "Archive path failed validation.".to_string()));
        }
        if args.first().map(String::as_str) == Some("x") {
            match crate::quarantine::read_quarantine(std::path::Path::new(archive)) {
                Ok(value) => archive_quarantine = value,
                Err(error) => {
                    release_prepare_slot_best_effort(&state);
                    return Err(error);
                }
            }
        }
        if matches!(args.first().map(String::as_str), Some("l" | "t")) {
            let archive_path = std::path::PathBuf::from(archive);
            let initial_identity =
                match super::super::archive_snapshot::archive_identity_token(&archive_path) {
                    Ok(identity) => identity,
                    Err(error) => {
                        release_prepare_slot_best_effort(&state);
                        return Err(format!(
                            "Could not capture archive identity before listing/test: {error}"
                        ));
                    }
                };
            if expected_archive_identity
                .as_deref()
                .is_some_and(|expected| expected != initial_identity)
            {
                release_prepare_slot_best_effort(&state);
                return Err(
                "Archive changed after it was browsed; review the current contents before listing/testing."
                    .to_string(),
            );
            }
            non_mutating_archive_proof = Some((archive_path, initial_identity));
        }
    }
    if window.label().starts_with("extract-") {
        if args.first().map(String::as_str) != Some("x") {
            release_prepare_slot_best_effort(&state);
            return Err("Quick-extract windows may only start extraction commands.".to_string());
        }
        let requested = match operation_output_path(&args) {
            Some(requested) => requested,
            None => {
                release_prepare_slot_best_effort(&state);
                return Err("Extraction command is missing an output directory.".to_string());
            }
        };
        if let Err(error) =
            crate::launch::assert_extract_bound_destination(&app, window.label(), &requested)
        {
            release_prepare_slot_best_effort(&state);
            return Err(error);
        }
        let archive = match args
            .iter()
            .position(|arg| arg == "--")
            .and_then(|sep| args.get(sep + 1))
        {
            Some(archive) => std::path::PathBuf::from(archive),
            None => {
                release_prepare_slot_best_effort(&state);
                return Err("Extraction command is missing an archive path.".to_string());
            }
        };
        if let Err(error) =
            crate::launch::assert_extract_bound_archive(&app, window.label(), &archive)
        {
            release_prepare_slot_best_effort(&state);
            return Err(error);
        }
    }
    abort_cancelled_preparation(&state)?;

    // Startup recovery may take time on a large interrupted transaction. The
    // operation already owns its prepare slot, so Cancel is meaningful here.
    let recovery_started = std::time::Instant::now();
    if let Err(error) = wait_for_startup_recovery().await {
        release_prepare_slot_best_effort(&state);
        return Err(error);
    }
    abort_cancelled_preparation(&state)?;

    let recovery_app = app.clone();
    let recovery_result =
        tokio::task::spawn_blocking(move || recover_interrupted_transaction(&recovery_app))
            .await
            .map_err(|error| format!("Archive recovery worker failed: {error}"))?;
    if let Err(error) = recovery_result {
        release_prepare_slot_best_effort(&state);
        return Err(format!(
            "A previous archive transaction still requires recovery: {error}"
        ));
    }
    if let Some(diagnostics) = io_diagnostics.as_mut() {
        diagnostics.phase_times.recovery = elapsed_ms(recovery_started);
    }
    abort_cancelled_preparation(&state)?;

    let mut blocking_plan_args = args.clone();
    let plan_expected_identity = expected_archive_identity.clone();
    let plan_app = app.clone();
    let cache_dir = match app.path().app_cache_dir() {
        Ok(dir) => Some(dir),
        Err(error) => {
            release_prepare_slot_best_effort(&state);
            return Err(format!("Could not resolve app cache directory: {error}"));
        }
    };
    let plan_started = std::time::Instant::now();
    let mut cleanup_plan = match tokio::task::spawn_blocking(move || {
        let result = prepare_cleanup_plan_with_cancel(
            &blocking_plan_args,
            cache_dir,
            plan_expected_identity.as_deref(),
            || {
                let state = plan_app.state::<RunningProcess>();
                state
                    .0
                    .lock()
                    .map(|process| process.cancelling)
                    .unwrap_or(true)
            },
        );
        mask_password_arg_tokens(&mut blocking_plan_args);
        result
    })
    .await
    {
        Ok(Ok(plan)) => plan,
        Ok(Err(error)) => {
            let (message, recovery_required) = error.into_parts();
            if recovery_required {
                return Err(format!(
                "{message}; preparation ownership was retained and the operation slot was not released."
            ));
            }
            release_prepare_slot_best_effort(&state);
            return Err(message);
        }
        Err(error) => {
            release_prepare_slot_best_effort(&state);
            return Err(format!("Archive preparation task failed: {error}"));
        }
    };
    let _snapshot_handle_guard = SnapshotHandleGuard(
        cleanup_plan
            .staged_input_archive
            .as_ref()
            .and_then(|path| path.parent().map(std::path::Path::to_path_buf)),
    );
    if let Some(diagnostics) = io_diagnostics.as_mut() {
        let duration = elapsed_ms(plan_started);
        if cleanup_plan.staged_input_archive.is_some() {
            diagnostics.phase_times.snapshot = duration;
        }
        if cleanup_plan.staged_input_archive.is_some() {
            diagnostics.strategies.snapshot = cleanup_plan
                .snapshot_strategy
                .map(super::super::archive_snapshot::SnapshotStrategy::label)
                .map(str::to_string);
        }
        if cleanup_plan.staged_extract.is_some() {
            diagnostics.strategies.stage = Some("sibling-stage".to_string());
        }
    }
    // Checkpoint ownership before any member preflight, compound child, journal
    // write, or cancellation branch can fail.
    checkpoint_cleanup_plan(&state, &cleanup_plan);

    // This worker may have created a private stage. Roll it back before
    // releasing ownership so another operation cannot race the cleanup.
    if preparation_was_cancelled(&state)? {
        return Err(finalize_preparation_error(
            &state,
            &cleanup_plan,
            None,
            "Archive operation was cancelled during preparation.",
        ));
    }

    if compound_tar_operation {
        if let Err(error) = prepare_compound_tar_snapshot(&app, &state, &mut cleanup_plan).await {
            return Err(finalize_preparation_error(
                &state,
                &cleanup_plan,
                None,
                error,
            ));
        }
    }

    // Persist the journal as soon as staging exists so a crash during rewrite
    // or member preflight can still recover the stage path.
    // A write error can occur after the atomic rename but during parent sync,
    // so treat the journal as possibly active until an explicit clear succeeds.
    let mut journal_guard = CleanupJournalGuard::new(app.clone(), true);
    match write_cleanup_journal(&app, &cleanup_plan) {
        Ok(active) => {
            journal_guard = CleanupJournalGuard::new(app.clone(), active);
            #[cfg(feature = "e2e")]
            crate::process::e2e_crash::crash_point("after-journal");
        }
        Err(error) => {
            return Err(finalize_preparation_error(
                &state,
                &cleanup_plan,
                Some(&mut journal_guard),
                format!("Could not create recovery journal: {error}"),
            ));
        }
    }

    let mut snapshot_args = args.clone();
    if let Some(staged_archive) = &cleanup_plan.staged_input_archive {
        if let Err(error) = rewrite_extract_archive(&mut snapshot_args, staged_archive) {
            return Err(finalize_preparation_error(
                &state,
                &cleanup_plan,
                Some(&mut journal_guard),
                error,
            ));
        }
    }
    let member_preflight_started = std::time::Instant::now();
    let mut extract_manifest: Option<ArchiveManifestSummary> = None;
    let extract_archive_identity = if cleanup_plan.staged_extract.is_some() {
        match assert_extract_archive_members_safe_with_summary(
            &app,
            &state,
            &snapshot_args,
            cleanup_plan.max_extract_bytes,
        )
        .await
        {
            Ok((archive, identity, manifest)) => {
                extract_manifest = Some(manifest);
                Some((archive, identity))
            }
            Err(error) => {
                return Err(finalize_preparation_error(
                    &state,
                    &cleanup_plan,
                    Some(&mut journal_guard),
                    error,
                ));
            }
        }
    } else {
        None
    };
    if let Some(diagnostics) = io_diagnostics.as_mut() {
        diagnostics.phase_times.member_preflight = elapsed_ms(member_preflight_started);
        if let Some(manifest) = extract_manifest.as_ref() {
            if manifest.has_links() {
                diagnostics.strategies.stage = Some("link-bearing-sibling-safety".to_string());
            }
        }
    }
    if cleanup_plan.extract_destination_preexisting
        && extract_manifest
            .as_ref()
            .is_some_and(|manifest| !manifest.has_links())
    {
        if let Err(error) = relocate_extract_stage_inside_destination(&app, &mut cleanup_plan) {
            return Err(finalize_preparation_error(
                &state,
                &cleanup_plan,
                Some(&mut journal_guard),
                error,
            ));
        }
        if let Some(diagnostics) = io_diagnostics.as_mut() {
            // Relocation deliberately falls back with Ok(()) when a custom
            // ACL, remote filesystem, or hidden-child policy rejects the
            // inside stage. Classify the actual resulting location rather
            // than reporting the attempted optimization as selected.
            let inside_destination = cleanup_plan
                .staged_extract
                .as_ref()
                .is_some_and(|(stage, destination)| stage.parent() == Some(destination.as_path()));
            diagnostics.strategies.stage = Some(
                if inside_destination {
                    "inside-destination-no-links"
                } else {
                    "sibling-stage-existing-destination-fallback"
                }
                .to_string(),
            );
        }
    }

    let mut execution_args = args.clone();
    if let Some(staged_archive) = &cleanup_plan.staged_input_archive {
        if let Err(error) = rewrite_extract_archive(&mut execution_args, staged_archive) {
            return Err(finalize_preparation_error(
                &state,
                &cleanup_plan,
                Some(&mut journal_guard),
                error,
            ));
        }
    }
    let rewrite_result = if let Some((staged, _)) = &cleanup_plan.staged_extract {
        rewrite_extract_output(&mut execution_args, staged)
    } else if let Some((staged, _)) = &cleanup_plan.staged_archive {
        if execution_args.first().map(String::as_str) == Some("u") {
            rewrite_archive_update_output(&mut execution_args, staged)
        } else {
            rewrite_archive_output(&mut execution_args, staged)
        }
    } else {
        Ok(())
    };
    if let Err(error) = rewrite_result {
        return Err(finalize_preparation_error(
            &state,
            &cleanup_plan,
            Some(&mut journal_guard),
            error,
        ));
    }

    if let Some((archive, expected_identity)) = &extract_archive_identity {
        if let Err(error) = assert_archive_identity_unchanged(archive, expected_identity) {
            return Err(finalize_preparation_error(
                &state,
                &cleanup_plan,
                Some(&mut journal_guard),
                error,
            ));
        }
    }

    // Do not spawn a child after a Cancel that arrived during synchronous
    // rewrite/identity work. This keeps Cancel from becoming a false UI-only
    // acknowledgement immediately before a create/update publish.
    if preparation_was_cancelled(&state)? {
        return Err(finalize_preparation_error(
            &state,
            &cleanup_plan,
            Some(&mut journal_guard),
            "Archive operation was cancelled during preparation.",
        ));
    }

    let seven_zip_started = std::time::Instant::now();
    let (mut rx, child) = {
        let (rx, child, pending_password) =
            match spawn_7z_noninteractive(&app, execution_args.clone(), &state) {
                Ok(result) => result,
                Err(e) => {
                    return Err(finalize_preparation_error(
                        &state,
                        &cleanup_plan,
                        Some(&mut journal_guard),
                        e.to_string(),
                    ));
                }
            };

        // The child's argv is already sanitized; drop the parent-side copies.
        mask_password_arg_tokens(&mut args);
        mask_password_arg_tokens(&mut execution_args);
        mask_password_arg_tokens(&mut snapshot_args);

        // Scoped so the `MutexGuard` this binds is provably dropped (not just
        // logically unreachable after a `return`) before the `.await` below:
        // `RunningProcess` is not `Send`-friendly to hold across an await
        // point in a `#[tauri::command] async fn`, since Tauri's IPC layer
        // requires every command future to be `Send`.
        {
            let registration: Result<bool, String> = (|| {
                let mut process = lock_process(&state)?;
                if process.cancelling {
                    return Ok(true);
                }
                // Register the child before password stdin so cancel can kill a blocked write.
                process.child = Some(child.clone());
                process.owner_label = Some(window.label().to_string());
                process.cleanup_plan = Some(cleanup_plan.clone());
                Ok(false)
            })();
            match registration {
                Err(error) => {
                    terminate_registered_child_async(&app, &child).await?;
                    return Err(finalize_preparation_error(
                        &state,
                        &cleanup_plan,
                        Some(&mut journal_guard),
                        error,
                    ));
                }
                Ok(true) => {
                    terminate_registered_child_async(&app, &child).await?;
                    return Err(finalize_preparation_error(
                        &state,
                        &cleanup_plan,
                        Some(&mut journal_guard),
                        "Archive operation was cancelled during preparation.",
                    ));
                }
                Ok(false) => {}
            }
        }

        if let Some(pending_password) = pending_password {
            if let Err(error) = complete_password_transport(&child, pending_password).await {
                let cancelled = lock_process(&state)
                    .map(|process| process.cancelling)
                    .unwrap_or(false);
                terminate_registered_child_async(&app, &child).await?;
                let error = if cancelled {
                    "Archive operation was cancelled during preparation.".to_string()
                } else {
                    error
                };
                return Err(finalize_preparation_error(
                    &state,
                    &cleanup_plan,
                    Some(&mut journal_guard),
                    error,
                ));
            }
        }

        let registration: Result<bool, String> = (|| {
            let mut process = lock_process(&state)?;
            if process.cancelling {
                return Ok(true);
            }
            process.preparing = false;
            process.cancelling = false;
            Ok(false)
        })();
        match registration {
            Err(error) => {
                terminate_registered_child_async(&app, &child).await?;
                return Err(finalize_preparation_error(
                    &state,
                    &cleanup_plan,
                    Some(&mut journal_guard),
                    error,
                ));
            }
            Ok(true) => {
                terminate_registered_child_async(&app, &child).await?;
                return Err(finalize_preparation_error(
                    &state,
                    &cleanup_plan,
                    Some(&mut journal_guard),
                    "Archive operation was cancelled during preparation.",
                ));
            }
            Ok(false) => {}
        }
        (rx, child)
    };

    let emit_window = window.clone();
    let heartbeat_window = window.clone();
    let progress_target = tauri::EventTarget::webview_window(window.label());
    let heartbeat_target = progress_target.clone();
    let last_progress_activity =
        std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    let heartbeat_activity = last_progress_activity.clone();
    let heartbeat_task = tauri::async_runtime::spawn(async move {
        let quiet_for = std::time::Duration::from_secs(30);
        let mut interval = tokio::time::interval(quiet_for);
        // Tokio's first interval tick is immediate. Consume it so the first
        // check means the child has actually been running for 30s.
        interval.tick().await;
        loop {
            interval.tick().await;
            let is_quiet = heartbeat_activity
                .lock()
                .map(|instant| instant.elapsed() >= quiet_for)
                .unwrap_or(true);
            if !is_quiet {
                continue;
            }
            let _ = heartbeat_window.emit_to(
                heartbeat_target.clone(),
                "7z-progress-structured",
                crate::progress::ProgressUpdate {
                    percent: None,
                    files_done: None,
                    current_file: Some("Working…".to_string()),
                },
            );
        }
    });
    let quota_started = std::time::Instant::now();
    let quota_finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let quota_task = cleanup_plan
        .staged_extract
        .as_ref()
        .and_then(|(staged, _)| {
            cleanup_plan
                .max_extract_bytes
                .zip(cleanup_plan.min_free_bytes)
                .map(|(max_bytes, min_free_bytes)| {
                    tauri::async_runtime::spawn(monitor_extract_quota_with_manifest(
                        app.clone(),
                        staged.clone(),
                        max_bytes,
                        min_free_bytes,
                        quota_finished.clone(),
                        extract_manifest.clone(),
                    ))
                })
        });
    let quota_enabled = quota_task.is_some();
    let mut last_raw_progress_emit = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_millis(100))
        .unwrap_or_else(std::time::Instant::now);
    let mut last_structured_progress_emit = last_raw_progress_emit;

    // Every mutating command uses a non-interactive overwrite policy and bare
    // password prompts are rejected by validation. Silence is therefore not a
    // reliable hang signal: large compression/update phases may legitimately
    // emit nothing for a long time.
    let collected = collect_command_output(&mut rx, MAX_OUTPUT_BYTES, |chunk| {
        // 7z can produce one stdout chunk per file. Keep IPC bounded so a
        // large archive cannot make the webview spend more time rendering
        // progress than extracting. Structured state is still emitted as
        // soon as it is available.
        if last_raw_progress_emit.elapsed() >= std::time::Duration::from_millis(75) {
            let _ = emit_window.emit_to(
                progress_target.clone(),
                "7z-progress",
                crate::output::strip_control_chars(chunk),
            );
            last_raw_progress_emit = std::time::Instant::now();
            if let Ok(mut activity) = last_progress_activity.lock() {
                *activity = last_raw_progress_emit;
            }
        }
        if let Some(update) = parse_progress_line(chunk) {
            if last_structured_progress_emit.elapsed() >= std::time::Duration::from_millis(75) {
                let _ =
                    emit_window.emit_to(progress_target.clone(), "7z-progress-structured", update);
                last_structured_progress_emit = std::time::Instant::now();
                if let Ok(mut activity) = last_progress_activity.lock() {
                    *activity = last_structured_progress_emit;
                }
            }
        }
    })
    .await;
    heartbeat_task.abort();
    let _ = heartbeat_task.await;
    quota_finished.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(task) = quota_task {
        let _ = task.await;
    }
    if let Some(diagnostics) = io_diagnostics.as_mut() {
        diagnostics.phase_times.seven_zip_execution = elapsed_ms(seven_zip_started);
        diagnostics.phase_times.quota_monitoring = if quota_enabled {
            elapsed_ms(quota_started)
        } else {
            0
        };
        if quota_enabled {
            diagnostics.strategies.quota = Some("manifest-headroom-and-final-scan".to_string());
        }
    }

    // Child no longer reads input. Release Windows source locks before commit
    // removes hard-link snapshot entries; guard still covers every early exit.
    release_snapshot_handles_for_plan(&cleanup_plan);

    if collected.stream_error.is_some() || collected.exit.is_none() {
        terminate_registered_child_async(&app, &child).await?;
    }

    let exit_code = collected.exit_code();
    let listing_or_test = matches!(args.first().map(String::as_str), Some("l" | "t"));
    let warning_code = ((cleanup_plan.staged_extract.is_some() || listing_or_test)
        && collected.accepts_exit_one_with(extract_warning_is_metadata_only))
    .then_some(exit_code);

    // Keep `cancelling` true as a general finalizing/busy marker until all
    // staged output has been committed or rolled back.
    let (was_cancelled, abort_reason) = match lock_process(&state) {
        Ok(mut process) => {
            let cancel_flag = process.cancelling;
            let abort_reason = process.abort_reason.take();
            process.child = None;
            process.preparing = false;
            process.cancelling = true;
            (cancel_flag, abort_reason)
        }
        Err(e) => {
            eprintln!("Process lock unavailable after run: {e}");
            (false, None)
        }
    };

    // Commit/rollback can walk, rename, sync, and delete large trees. Keep that
    // off the async runtime so other Tauri tasks are not blocked.
    let finalize_app = app.clone();
    let finalize_plan = cleanup_plan.clone();
    let finalize_entry_count = extract_manifest
        .as_ref()
        .map(|manifest| manifest.entry_count);
    // `u` writes a complete new archive into the stage, which sheds the
    // original's quarantine / Zone.Identifier unless it is carried over.
    let finalize_carries_update_marker = args.first().map(String::as_str) == Some("u");
    let finalize_update_marker_identity = finalize_carries_update_marker
        .then(|| {
            cleanup_plan
                .staged_archive
                .as_ref()
                .and_then(|(_, destination)| {
                    cleanup_plan
                        .expected_archive_family
                        .iter()
                        .find(|snapshot| snapshot.path == *destination)
                        .or_else(|| cleanup_plan.expected_archive_family.first())
                        .map(|snapshot| snapshot.identity.clone())
                })
        })
        .flatten();
    let finalize_marker_source = mark_of_the_web_source.clone();
    let finalize_emit = emit_window.clone();
    let finalize_target = progress_target.clone();
    let finalization_publish_strategy = Arc::new(Mutex::new(None::<PublishStrategy>));
    let publish_strategy_slot = finalization_publish_strategy.clone();
    let finalization_started = std::time::Instant::now();
    let finalize_join = tokio::task::spawn_blocking(move || {
    // Exit 1 is usually partial data. Publish only the narrow metadata-only
    // warning class identified above; every other warning rolls back.
    // The outer Result tracks whether cleanup is complete. The inner Result
    // preserves an operation error that is safe to return after ownership is
    // released (for example a commit error followed by a successful scrub).
    let commit_ok = !was_cancelled && (exit_code == 0 || warning_code.is_some());
    if !commit_ok {
        if let Err(error) = rollback_cleanup(&finalize_plan) {
            Err(format!("7z operation ended, but rollback failed: {error}"))
        } else {
            Ok(Ok(()))
        }
    } else {
        if let Some((staged, destination)) = finalize_plan.staged_archive.as_ref() {
            let marker_result = if finalize_carries_update_marker {
                Some(crate::quarantine::copy_mark_of_the_web_to_family_with_identity(
                    destination.as_path(),
                    finalize_update_marker_identity.as_ref(),
                    staged,
                ))
            } else {
                finalize_marker_source.as_ref().map(|source| {
                    crate::quarantine::copy_mark_of_the_web_to_family_from_validated(
                        source, staged,
                    )
                })
            };
            if let Some(Err(error)) = marker_result {
                return match rollback_cleanup(&finalize_plan) {
                    Ok(()) => Ok(Err(format!(
                        "{error} The archive was rolled back so an unmarked archive was not published."
                    ))),
                    Err(rollback_error) => {
                        Err(format!("{error}; rollback also failed: {rollback_error}"))
                    }
                };
            }
        }
        if let Some((stage, _)) = finalize_plan.staged_extract.as_ref() {
            if let Err(error) =
                super::super::commit::ensure_extract_stage_has_output(stage, finalize_entry_count)
            {
                return match rollback_cleanup(&finalize_plan) {
                    Ok(()) => Ok(Err(format!(
                        "{error} The extraction was rolled back so nothing was published."
                    ))),
                    Err(rollback_error) => {
                        Err(format!("{error}; rollback also failed: {rollback_error}"))
                    }
                };
            }
        }
        if let (Some(value), Some((stage, _))) =
            (archive_quarantine.as_deref(), finalize_plan.staged_extract.as_ref())
        {
            if let Err(error) = crate::quarantine::apply_quarantine_tree(stage, value) {
                return match rollback_cleanup(&finalize_plan) {
                    Ok(()) => Ok(Err(format!(
                        "{error} The extraction was rolled back so unquarantined files were not published."
                    ))),
                    Err(rollback_error) => Err(format!(
                        "{error}; rollback also failed: {rollback_error}"
                    )),
                };
            }
        }
        if let Some((stage, _)) = finalize_plan.staged_extract.as_ref() {
            if let Err(error) = super::super::commit::clear_staged_directory_shell_attributes(stage) {
                return match rollback_cleanup(&finalize_plan) {
                    Ok(()) => Ok(Err(format!(
                        "{error} The extraction was rolled back so nothing was published."
                    ))),
                    Err(rollback_error) => Err(format!(
                        "{error}; rollback also failed: {rollback_error}"
                    )),
                };
            }
        }
        let _ = finalize_emit.emit_to(
            finalize_target,
            "7z-progress-structured",
            crate::progress::ProgressUpdate {
                percent: Some(100),
                files_done: None,
                current_file: Some("Finalizing…".to_string()),
            },
        );
        #[cfg(feature = "e2e")]
        crate::process::e2e_crash::crash_point("before-promote");
        match commit_cleanup(&finalize_app, &finalize_plan) {
            Ok(strategy) => {
                if let Some(strategy) = strategy {
                    if let Ok(mut slot) = publish_strategy_slot.lock() {
                        *slot = Some(strategy);
                    }
                }
                Ok(Ok(()))
            }
            Err(error) => {
                if commit_failure_should_scrub_staging(&finalize_plan, &error) {
                    // Safe orphan scrub (add-mode / no recovery backups).
                    // Retract any partial publishes from the journal BEFORE
                    // clearing it; clearing alone left destinations orphaned
                    // when live retract during commit also failed.
                    match rollback_cleanup(&finalize_plan) {
                        Ok(()) => {
                            if let Err(retract_error) =
                                retract_scrub_archive_journal_or_fail(&finalize_app)
                            {
                                return Err(format!(
                                    "{error}; also failed to retract partial archive outputs: {retract_error}"
                                ));
                            }
                            match clear_cleanup_journal(&finalize_app) {
                                // Cleanup is complete. Preserve the original
                                // operation failure, but release ownership below.
                                Ok(()) => Ok(Err(error)),
                                Err(journal_error) => Err(format!(
                                    "{error}; also failed to clear recovery journal: {journal_error}"
                                )),
                            }
                        }
                        Err(rollback_error) => Err(format!(
                            "{error}; also failed to clean staging: {rollback_error}"
                        )),
                    }
                } else {
                    // Keep stage for journal recovery (update backups / extract merge).
                    Err(format!(
                        "{error} Staging was kept for recovery; restart Zinnia if output looks wrong."
                    ))
                }
            }
        }
    }
})
.await;

    let finalize_result = match finalize_join {
        Ok(result) => result,
        Err(error) => Err(format!("Archive finalization task failed: {error}")),
    };
    if let Some(diagnostics) = io_diagnostics.as_mut() {
        diagnostics.phase_times.finalization = elapsed_ms(finalization_started);
    }
    // Keep the operation slot fail-closed until finalization and durable
    // journal removal both succeed. A cleanup-complete operation error is
    // returned only after the slot is released.
    settle_archive_finalization(&state, finalize_result, || journal_guard.clear())?;
    if let Some(diagnostics) = io_diagnostics.as_mut() {
        if let Ok(strategy) = finalization_publish_strategy.lock() {
            if let Some(strategy) = *strategy {
                diagnostics.strategies.publish = Some(strategy.label().to_string());
            }
        }
    }
    if let Some(reason) = abort_reason {
        return Err(reason);
    }

    // Snapshot handles only protect preflight/extraction. Release them before
    // final identity lookup so Windows share-deny handles cannot block the
    // normal archive identity reader.
    release_snapshot_handles_for_plan(&cleanup_plan);
    let archive_identity_after = if !was_cancelled {
        if let Some((archive_path, initial_identity)) = non_mutating_archive_proof {
            let final_identity = super::super::archive_snapshot::archive_identity_token(&archive_path)
            .map_err(|error| {
                format!(
                    "Could not prove archive identity after listing/test; operation was not accepted: {error}"
                )
            })?;
            if final_identity != initial_identity
                || expected_archive_identity
                    .as_deref()
                    .is_some_and(|expected| expected != final_identity)
            {
                return Err(
                "Archive changed while listing/testing was running; operation was not accepted."
                    .to_string(),
            );
            }
            Some(final_identity)
        } else {
            archive_path_from_args(&args)
                .and_then(|path| super::super::archive_snapshot::archive_identity_token(&path).ok())
        }
    } else {
        None
    };
    if let Some(diagnostics) = io_diagnostics.as_mut() {
        diagnostics.phase_times.total = elapsed_ms(operation_started);
    }
    Ok(collected.into_run_result_with_metadata(
        was_cancelled,
        warning_code,
        archive_identity_after,
        io_diagnostics,
    ))
}

pub(super) async fn probe_7z_inner(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, super::super::RunningProcess>,
) -> Result<String, String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    // `7z i` prints the full codec table. Keep collection bounded, but leave
    // headroom for bundled and future 7-Zip builds.
    const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
    let operation_liveness = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let _operation_liveness_guard = OperationLivenessGuard(operation_liveness.clone());

    {
        let mut process = lock_process(&state)?;
        ensure_idle_mut(&mut process)?;
        process.preparing = true;
        process.owner_label = Some(window.label().to_string());
        process.operation_liveness = Some(operation_liveness);
    }

    let result = async {
        let (mut rx, child, _pending_password) =
            spawn_7z_noninteractive(&app, vec!["i".to_string()], &state)?;
        {
            let cancelling = lock_process(&state)?.cancelling;
            if cancelling {
                terminate_registered_child_async(&app, &child).await?;
                return Err("7z runtime probe was cancelled.".to_string());
            }
            let mut process = lock_process(&state)?;
            process.child = Some(child.clone());
        }

        let probe = async {
            let collected = collect_command_output(&mut rx, PROBE_OUTPUT_LIMIT, |_| {}).await;
            if collected.stream_error.is_some() || collected.exit.is_none() {
                terminate_registered_child_async(&app, &child).await?;
            }

            if collected.exit.is_none() {
                return Err("7z probe exited before reporting status.".to_string());
            }

            let code = collected.exit_code();
            if !collected.output_is_complete() {
                return Err("7z probe output exceeded its safety limit.".to_string());
            }
            let combined = format!("{}\n{}", collected.stdout, collected.stderr);
            if code == 0 {
                let version = parse_7z_version(&combined).unwrap_or_else(|| "unknown".to_string());
                assert_probed_version_matches_bundle(&version)?;
                return Ok(version);
            }

            let mut message = format!("7z probe exited with code {code}.");
            let clean_stderr = sanitize_output(collected.stderr.trim());
            let clean_stdout = sanitize_output(collected.stdout.trim());
            if !clean_stderr.is_empty() {
                message.push_str(&format!(" stderr: {clean_stderr}"));
            } else if !clean_stdout.is_empty() {
                message.push_str(&format!(" output: {clean_stdout}"));
            }
            Err(message)
        };

        match tokio::time::timeout(PROBE_TIMEOUT, probe).await {
            Ok(result) => result,
            Err(_) => {
                terminate_registered_child_async(&app, &child).await?;
                Err("7z runtime probe timed out.".to_string())
            }
        }
    }
    .await;

    match state.0.lock() {
        Ok(mut process) => {
            if process.owner_label.as_deref() == Some(window.label())
                && (result.is_ok() || process.child.is_none())
            {
                process.child = None;
                process.release_prepare_slot();
            }
        }
        Err(poisoned) => {
            let mut process = poisoned.into_inner();
            process.child = None;
            process.release_prepare_slot();
        }
    }

    result
}
