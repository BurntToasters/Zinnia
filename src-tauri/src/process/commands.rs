//! Tauri commands: run/probe/cancel 7z and shared command-output drain.

use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::output::{append_limited_output, sanitize_output, Utf8StreamDecoder, MAX_OUTPUT_BYTES};
use crate::progress::parse_progress_line;
use crate::validation::validate_run_7z_args;

use super::archive_snapshot::assert_archive_identity_unchanged;
use super::commit::{commit_cleanup, commit_failure_should_scrub_staging, rollback_cleanup};
use super::journal::{write_cleanup_journal, CleanupJournalGuard};
use super::quota::monitor_extract_quota;
use super::recovery::{recover_interrupted_transaction, wait_for_startup_recovery};
use super::staging::{
    assert_extract_archive_members_safe, operation_output_path, prepare_cleanup_plan,
    rewrite_archive_output, rewrite_extract_archive, rewrite_extract_output,
};
use super::{ensure_idle, lock_process, RunResult, RunningProcess};

/// Parsed bundled 7-Zip version from the last successful `probe_7z` (e.g. "26.02").
static PROBED_7Z_VERSION: Mutex<Option<String>> = Mutex::new(None);

/// Windows RAR extract stays blocked for CVE-2026-58052 through this version inclusive.
#[cfg(target_os = "windows")]
const WINDOWS_RAR_EXTRACT_BLOCKED_THROUGH: &str = "26.02";

pub(crate) fn store_probed_7z_version(version: Option<String>) {
    if let Ok(mut guard) = PROBED_7Z_VERSION.lock() {
        *guard = version;
    }
}

#[allow(dead_code)] // Attested version for Windows RAR gate and future callers.
pub fn probed_7z_version() -> Option<String> {
    PROBED_7Z_VERSION
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Parse a 7-Zip version token (e.g. "26.02") from `7z i` / banner output.
pub fn parse_7z_version(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        // Examples: "7-Zip 26.02 (x64)", "7-Zip (z) 24.09"
        if let Some(rest) = trimmed.strip_prefix("7-Zip") {
            let rest = rest.trim_start();
            let rest = rest
                .strip_prefix("(z)")
                .map(str::trim_start)
                .unwrap_or(rest);
            let token = rest.split_whitespace().next()?;
            if token.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return Some(token.to_string());
            }
        }
    }
    None
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
pub(crate) fn version_cmp(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let parse = |value: &str| -> Option<Vec<u32>> {
        value
            .split('.')
            .map(|part| part.parse::<u32>().ok())
            .collect()
    };
    Some(parse(a)?.cmp(&parse(b)?))
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_rar_extract_blocked() -> bool {
    match probed_7z_version() {
        Some(version) => match version_cmp(&version, WINDOWS_RAR_EXTRACT_BLOCKED_THROUGH) {
            Some(std::cmp::Ordering::Greater) => false,
            _ => true,
        },
        // Fail closed until probe attests a safe runtime.
        None => true,
    }
}

pub fn is_non_running_kill_error(message: &str) -> bool {
    message.contains("finished")
        || message.contains("not running")
        || message.contains("No such process")
}

pub(crate) struct CollectedOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    pub(crate) exit: Option<TerminatedPayload>,
}

// `on_stdout_line` runs per decoded stdout chunk for progress streaming.
pub(crate) async fn collect_command_output<F>(
    rx: &mut tauri::async_runtime::Receiver<CommandEvent>,
    max_bytes: usize,
    mut on_stdout_line: F,
) -> CollectedOutput
where
    F: FnMut(&str),
{
    let mut out = CollectedOutput {
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        exit: None,
    };
    let mut stdout_decoder = Utf8StreamDecoder::default();
    let mut stderr_decoder = Utf8StreamDecoder::default();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let chunk = stdout_decoder.push(&line);
                on_stdout_line(&chunk);
                append_limited_output(
                    &mut out.stdout,
                    &chunk,
                    max_bytes,
                    &mut out.stdout_truncated,
                );
            }
            CommandEvent::Stderr(line) => {
                let chunk = stderr_decoder.push(&line);
                append_limited_output(
                    &mut out.stderr,
                    &chunk,
                    max_bytes,
                    &mut out.stderr_truncated,
                );
            }
            CommandEvent::Terminated(payload) => {
                let stdout_tail = stdout_decoder.finish();
                if !stdout_tail.is_empty() {
                    on_stdout_line(&stdout_tail);
                    append_limited_output(
                        &mut out.stdout,
                        &stdout_tail,
                        max_bytes,
                        &mut out.stdout_truncated,
                    );
                }
                let stderr_tail = stderr_decoder.finish();
                append_limited_output(
                    &mut out.stderr,
                    &stderr_tail,
                    max_bytes,
                    &mut out.stderr_truncated,
                );
                out.exit = Some(payload);
                break;
            }
            _ => {}
        }
    }

    out
}

#[tauri::command]
pub async fn run_7z(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: Vec<String>,
    state: tauri::State<'_, RunningProcess>,
) -> Result<RunResult, String> {
    validate_run_7z_args(&args)?;

    if let Some("x" | "l" | "t") = args.first().map(String::as_str) {
        let separator = args
            .iter()
            .position(|arg| arg == "--")
            .ok_or_else(|| "Archive command is missing '--'.".to_string())?;
        let archive = args
            .get(separator + 1)
            .ok_or_else(|| "Archive command is missing an archive path.".to_string())?;
        let validation = crate::archive_detect::validate_archive_path(archive);
        if !validation.valid {
            return Err(validation
                .reason
                .unwrap_or_else(|| "Archive path failed validation.".to_string()));
        }
        #[cfg(target_os = "windows")]
        if args.first().map(String::as_str) == Some("x")
            && crate::archive_detect::is_rar_archive_file(std::path::Path::new(archive))?
            && windows_rar_extract_blocked()
        {
            return Err("RAR extraction is temporarily disabled on Windows while conflicting CVE-2026-58052 affected-version data is resolved. Install a future Zinnia release after the bundled runtime has been conclusively verified.".to_string());
        }
    }
    if window.label().starts_with("extract-") {
        if args.first().map(String::as_str) != Some("x") {
            return Err("Quick-extract windows may only start extraction commands.".to_string());
        }
        let Some(requested) = operation_output_path(&args) else {
            return Err("Extraction command is missing an output directory.".to_string());
        };
        crate::launch::assert_extract_bound_destination(&app, window.label(), &requested)?;
    }

    // Serialize past the one-shot startup recovery before claiming the operation slot.
    wait_for_startup_recovery().await;

    {
        let mut process = lock_process(&state)?;
        ensure_idle(&process)?;
        process.preparing = true;
        process.owner_label = Some(window.label().to_string());
        process.abort_reason = None;
    }

    if let Err(error) = recover_interrupted_transaction(&app) {
        if let Ok(mut process) = lock_process(&state) {
            process.preparing = false;
            process.owner_label = None;
        }
        return Err(format!(
            "A previous archive transaction still requires recovery: {error}"
        ));
    }

    let plan_args = args.clone();
    let cache_dir = match app.path().app_cache_dir() {
        Ok(dir) => Some(dir),
        Err(error) => {
            if let Ok(mut process) = lock_process(&state) {
                process.preparing = false;
                process.owner_label = None;
            }
            return Err(format!("Could not resolve app cache directory: {error}"));
        }
    };
    let cleanup_plan = match tokio::task::spawn_blocking(move || {
        prepare_cleanup_plan(&plan_args, cache_dir)
    })
    .await
    {
        Ok(Ok(plan)) => plan,
        Ok(Err(error)) => {
            if let Ok(mut process) = lock_process(&state) {
                process.preparing = false;
                process.owner_label = None;
            }
            return Err(error);
        }
        Err(error) => {
            if let Ok(mut process) = lock_process(&state) {
                process.preparing = false;
                process.owner_label = None;
            }
            return Err(format!("Archive preparation task failed: {error}"));
        }
    };

    // Persist the journal as soon as staging exists so a crash during rewrite
    // or member preflight can still recover the stage path.
    let journal_active = match write_cleanup_journal(&app, &cleanup_plan) {
        Ok(active) => active,
        Err(error) => {
            let rollback_error = rollback_cleanup(&cleanup_plan).err();
            if let Ok(mut process) = lock_process(&state) {
                process.preparing = false;
                process.owner_label = None;
            }
            return Err(match rollback_error {
                Some(rollback_error) => {
                    format!("Could not create recovery journal: {error}; rollback also failed: {rollback_error}")
                }
                None => format!("Could not create recovery journal: {error}"),
            });
        }
    };
    let mut journal_guard = CleanupJournalGuard::new(app.clone(), journal_active);

    let mut snapshot_args = args.clone();
    if let Some(staged_archive) = &cleanup_plan.staged_input_archive {
        if let Err(error) = rewrite_extract_archive(&mut snapshot_args, staged_archive) {
            let _ = rollback_cleanup(&cleanup_plan);
            if let Ok(mut process) = lock_process(&state) {
                process.preparing = false;
                process.owner_label = None;
            }
            return Err(error);
        }
    }
    let extract_archive_identity = if cleanup_plan.staged_extract.is_some() {
        match assert_extract_archive_members_safe(&app, &state, &snapshot_args).await {
            Ok(identity) => Some(identity),
            Err(error) => {
                let rollback_error = rollback_cleanup(&cleanup_plan).err();
                let journal_error = if rollback_error.is_none() {
                    journal_guard.clear().err()
                } else {
                    None
                };
                if let Ok(mut process) = lock_process(&state) {
                    process.preparing = false;
                    process.owner_label = None;
                    process.child = None;
                }
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("{error}; staging cleanup also failed: {rollback_error}")
                    }
                    None => {
                        match journal_error {
                            Some(journal_error) => {
                                format!("{error}; recovery journal cleanup also failed: {journal_error}")
                            }
                            None => error,
                        }
                    }
                });
            }
        }
    } else {
        None
    };

    let mut execution_args = args.clone();
    if let Some(staged_archive) = &cleanup_plan.staged_input_archive {
        if let Err(error) = rewrite_extract_archive(&mut execution_args, staged_archive) {
            let _ = rollback_cleanup(&cleanup_plan);
            if let Ok(mut process) = lock_process(&state) {
                process.preparing = false;
                process.owner_label = None;
            }
            return Err(error);
        }
    }
    let rewrite_result = if let Some((staged, _)) = &cleanup_plan.staged_extract {
        rewrite_extract_output(&mut execution_args, staged)
    } else if let Some((staged, _)) = &cleanup_plan.staged_archive {
        rewrite_archive_output(&mut execution_args, staged)
    } else {
        Ok(())
    };
    if let Err(error) = rewrite_result {
        let rollback_error = rollback_cleanup(&cleanup_plan).err();
        let journal_error = if rollback_error.is_none() {
            journal_guard.clear().err()
        } else {
            None
        };
        if let Ok(mut process) = lock_process(&state) {
            process.preparing = false;
            process.owner_label = None;
        }
        return Err(match rollback_error {
            Some(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            None => match journal_error {
                Some(journal_error) => {
                    format!("{error}; recovery journal cleanup also failed: {journal_error}")
                }
                None => error,
            },
        });
    }

    if let Some((archive, expected_identity)) = &extract_archive_identity {
        if let Err(error) = assert_archive_identity_unchanged(archive, expected_identity) {
            let rollback_error = rollback_cleanup(&cleanup_plan).err();
            let journal_error = if rollback_error.is_none() {
                journal_guard.clear().err()
            } else {
                None
            };
            if let Ok(mut process) = lock_process(&state) {
                process.preparing = false;
                process.owner_label = None;
            }
            return Err(match rollback_error {
                Some(rollback_error) => {
                    format!("{error}; staging cleanup also failed: {rollback_error}")
                }
                None => match journal_error {
                    Some(journal_error) => {
                        format!("{error}; recovery journal cleanup also failed: {journal_error}")
                    }
                    None => error,
                },
            });
        }
    }

    let mut rx = {
        let command = match app.shell().sidecar("7z") {
            Ok(command) => command.args(execution_args.clone()),
            Err(e) => {
                if let Ok(mut process) = lock_process(&state) {
                    process.preparing = false;
                    process.owner_label = None;
                }
                let rollback_error = rollback_cleanup(&cleanup_plan).err();
                let journal_error = if rollback_error.is_none() {
                    journal_guard.clear().err()
                } else {
                    None
                };
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("{e}; staging cleanup also failed: {rollback_error}")
                    }
                    None => match journal_error {
                        Some(journal_error) => {
                            format!("{e}; recovery journal cleanup also failed: {journal_error}")
                        }
                        None => e.to_string(),
                    },
                });
            }
        };

        let mut process = lock_process(&state)?;
        if process.cancelling {
            process.preparing = false;
            process.cancelling = false;
            process.owner_label = None;
            drop(process);
            rollback_cleanup(&cleanup_plan)?;
            journal_guard.clear()?;
            return Err("Archive operation was cancelled during preparation.".to_string());
        }

        let (rx, child) = match command.spawn() {
            Ok(result) => result,
            Err(e) => {
                let rollback_error = rollback_cleanup(&cleanup_plan).err();
                let journal_error = if rollback_error.is_none() {
                    journal_guard.clear().err()
                } else {
                    None
                };
                process.preparing = false;
                process.owner_label = None;
                return Err(match rollback_error {
                    Some(rollback_error) => format!("{e}; rollback also failed: {rollback_error}"),
                    None => match journal_error {
                        Some(journal_error) => {
                            format!("{e}; recovery journal cleanup also failed: {journal_error}")
                        }
                        None => e.to_string(),
                    },
                });
            }
        };
        process.child = Some(child);
        process.preparing = false;
        process.cancelling = false;
        process.owner_label = Some(window.label().to_string());
        process.cleanup_plan = Some(cleanup_plan.clone());
        rx
    };

    let emit_window = window.clone();
    let quota_finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let quota_task = cleanup_plan
        .staged_extract
        .as_ref()
        .and_then(|(staged, _)| {
            cleanup_plan
                .max_extract_bytes
                .zip(cleanup_plan.min_free_bytes)
                .map(|(max_bytes, min_free_bytes)| {
                    tauri::async_runtime::spawn(monitor_extract_quota(
                        app.clone(),
                        staged.clone(),
                        max_bytes,
                        min_free_bytes,
                        quota_finished.clone(),
                    ))
                })
        });
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
            let _ = emit_window.emit("7z-progress", chunk.to_string());
            last_raw_progress_emit = std::time::Instant::now();
        }
        if let Some(update) = parse_progress_line(chunk) {
            if last_structured_progress_emit.elapsed() >= std::time::Duration::from_millis(75) {
                let _ = emit_window.emit("7z-progress-structured", update);
                last_structured_progress_emit = std::time::Instant::now();
            }
        }
    })
    .await;
    quota_finished.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(task) = quota_task {
        let _ = task.await;
    }

    let exit_code = collected
        .exit
        .as_ref()
        .and_then(|payload| payload.code)
        .unwrap_or(-1);

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
    let finalize_window = window.clone();
    let finalize_emit = emit_window.clone();
    let finalize_join = tokio::task::spawn_blocking(move || {
        if was_cancelled || exit_code != 0 {
            if let Err(error) = rollback_cleanup(&finalize_plan) {
                Err(format!("7z operation ended, but rollback failed: {error}"))
            } else {
                if was_cancelled {
                    let _ = finalize_window.emit("7z-cancelled", ());
                }
                Ok(())
            }
        } else {
            let _ = finalize_emit.emit(
                "7z-progress-structured",
                crate::progress::ProgressUpdate {
                    percent: Some(100),
                    files_done: None,
                    current_file: Some("Finalizing…".to_string()),
                },
            );
            match commit_cleanup(&finalize_app, &finalize_plan) {
                Ok(()) => Ok(()),
                Err(error) => {
                    if commit_failure_should_scrub_staging(&finalize_plan, &error) {
                        // Safe orphan scrub (add-mode / no recovery backups).
                        match rollback_cleanup(&finalize_plan) {
                            Ok(()) => Err(error),
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

    // Always clear the operation slot, including when the blocking task panics.
    // Leaving `cancelling` set would soft-lock every later run_7z until restart.
    if let Ok(mut process) = lock_process(&state) {
        process.child = None;
        process.preparing = false;
        process.cancelling = false;
        process.owner_label = None;
        process.abort_reason = None;
        process.cleanup_plan = None;
    }

    let finalize_result = match finalize_join {
        Ok(result) => result,
        Err(error) => Err(format!("Archive finalization task failed: {error}")),
    };
    finalize_result?;
    journal_guard.clear()?;
    if let Some(reason) = abort_reason {
        return Err(reason);
    }

    Ok(RunResult {
        stdout: sanitize_output(&collected.stdout),
        stderr: sanitize_output(&collected.stderr),
        code: exit_code,
        stdout_truncated: collected.stdout_truncated,
        stderr_truncated: collected.stderr_truncated,
    })
}

#[tauri::command]
pub async fn probe_7z(
    app: tauri::AppHandle,
    state: tauri::State<'_, RunningProcess>,
) -> Result<String, String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    const PROBE_OUTPUT_LIMIT: usize = 4096;

    {
        let mut process = lock_process(&state)?;
        ensure_idle(&process)?;
        process.preparing = true;
        process.owner_label = Some("__probe__".to_string());
    }

    let result = async {
        let command = app
            .shell()
            .sidecar("7z")
            .map_err(|e| e.to_string())?
            .args(["i"]);

        let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

        let probe = async {
            let collected = collect_command_output(&mut rx, PROBE_OUTPUT_LIMIT, |_| {}).await;

            let Some(payload) = collected.exit else {
                return Err("7z probe exited before reporting status.".to_string());
            };

            let code = payload.code.unwrap_or(-1);
            let combined = format!("{}\n{}", collected.stdout, collected.stderr);
            if code == 0 || code == 1 {
                let version = parse_7z_version(&combined).unwrap_or_else(|| "unknown".to_string());
                store_probed_7z_version(Some(version.clone()));
                return Ok(version);
            }

            store_probed_7z_version(None);
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
                let _ = child.kill();
                store_probed_7z_version(None);
                Err("7z runtime probe timed out.".to_string())
            }
        }
    }
    .await;

    if let Ok(mut process) = lock_process(&state) {
        if process.owner_label.as_deref() == Some("__probe__") {
            process.preparing = false;
            process.owner_label = None;
            process.cancelling = false;
        }
    }

    result
}

#[tauri::command]
pub fn cancel_7z(
    window: tauri::Window,
    state: tauri::State<'_, RunningProcess>,
) -> Result<(), String> {
    let child = {
        let mut process = lock_process(&state)?;
        if let Some(owner) = &process.owner_label {
            if owner != window.label() {
                return Err(
                    "Only the window that started this operation can cancel it.".to_string()
                );
            }
        }
        match process.child.take() {
            Some(child) => {
                process.cancelling = true;
                Some(child)
            }
            None if process.preparing => {
                process.cancelling = true;
                None
            }
            None => None,
        }
    };

    if let Some(child) = child {
        match child.kill() {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if is_non_running_kill_error(&msg) {
                    Ok(())
                } else {
                    eprintln!("Failed to kill 7z process: {msg}");
                    Err(format!("Could not stop 7z safely: {msg}. Restart Zinnia before starting another operation."))
                }
            }
        }
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn is_7z_running(state: tauri::State<'_, RunningProcess>) -> Result<bool, String> {
    let process = lock_process(&state)?;
    Ok(process.child.is_some() || process.preparing || process.cancelling)
}
