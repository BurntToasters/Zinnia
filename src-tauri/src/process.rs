//! 7z process lifecycle: single-slot state, shared drain helper, run/probe/cancel.

use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::output::{append_limited_output, sanitize_output, MAX_OUTPUT_BYTES};
use crate::progress::parse_progress_line;
use crate::validation::validate_run_7z_args;

#[derive(serde::Serialize)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

pub struct ProcessState {
    pub child: Option<CommandChild>,
    pub cancelling: bool,
    pub owner_label: Option<String>,
    // Partial compress output to delete if the op is cancelled.
    pub cleanup_target: Option<std::path::PathBuf>,
}

impl ProcessState {
    pub fn idle() -> Self {
        ProcessState {
            child: None,
            cancelling: false,
            owner_label: None,
            cleanup_target: None,
        }
    }
}

pub struct RunningProcess(pub Mutex<ProcessState>);

impl RunningProcess {
    pub fn new() -> Self {
        RunningProcess(Mutex::new(ProcessState::idle()))
    }
}

fn lock_process(state: &RunningProcess) -> Result<std::sync::MutexGuard<'_, ProcessState>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Process lock poisoned".to_string())
}

pub fn ensure_idle(state: &ProcessState) -> Result<(), String> {
    if state.child.is_some() || state.cancelling {
        Err("Another archive operation is already running.".to_string())
    } else {
        Ok(())
    }
}

// For a compress (`a`) command, the output archive is the single positional
// arg before `--`. Returned so a cancelled op can delete the partial file.
fn compress_output_path(args: &[String]) -> Option<std::path::PathBuf> {
    if args.first().map(String::as_str) != Some("a") {
        return None;
    }
    let separator = args.iter().position(|a| a == "--")?;
    args[1..separator]
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(std::path::PathBuf::from)
}

pub fn is_non_running_kill_error(message: &str) -> bool {
    message.contains("finished")
        || message.contains("not running")
        || message.contains("No such process")
}

struct CollectedOutput {
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
    exit: Option<TerminatedPayload>,
}

// `on_stdout_line` runs per stdout chunk for progress streaming; pass a no-op to skip.
async fn collect_command_output<F>(
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

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let chunk = String::from_utf8_lossy(&line);
                on_stdout_line(&chunk);
                append_limited_output(&mut out.stdout, &chunk, max_bytes, &mut out.stdout_truncated);
            }
            CommandEvent::Stderr(line) => {
                let chunk = String::from_utf8_lossy(&line);
                append_limited_output(&mut out.stderr, &chunk, max_bytes, &mut out.stderr_truncated);
            }
            CommandEvent::Terminated(payload) => {
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

    let cleanup_target = compress_output_path(&args);

    let command = app
        .shell()
        .sidecar("7z")
        .map_err(|e| e.to_string())?
        .args(args);

    let mut rx = {
        let mut process = lock_process(&state)?;
        ensure_idle(&process)?;

        let (rx, child) = command.spawn().map_err(|e| e.to_string())?;
        process.child = Some(child);
        process.cancelling = false;
        process.owner_label = Some(window.label().to_string());
        process.cleanup_target = cleanup_target.clone();
        rx
    };

    let emit_window = window.clone();
    let collected = collect_command_output(&mut rx, MAX_OUTPUT_BYTES, |chunk| {
        let _ = emit_window.emit("7z-progress", chunk.to_string());
        if let Some(update) = parse_progress_line(chunk) {
            let _ = emit_window.emit("7z-progress-structured", update);
        }
    })
    .await;

    // Reset state without `?`: a poisoned lock here must not discard the 7z result.
    let was_cancelled = match lock_process(&state) {
        Ok(mut process) => {
            let cancelled = process.cancelling;
            process.child = None;
            process.cancelling = false;
            process.owner_label = None;
            process.cleanup_target = None;
            cancelled
        }
        Err(e) => {
            eprintln!("Process lock unavailable after run: {e}");
            false
        }
    };

    if was_cancelled {
        if let Some(target) = &cleanup_target {
            if let Err(e) = std::fs::remove_file(target) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Could not remove partial archive {}: {e}", target.display());
                }
            }
        }
        let _ = window.emit("7z-cancelled", ());
    }

    let exit_code = collected
        .exit
        .and_then(|payload| payload.code)
        .unwrap_or(-1);

    Ok(RunResult {
        stdout: sanitize_output(&collected.stdout),
        stderr: sanitize_output(&collected.stderr),
        code: exit_code,
        stdout_truncated: collected.stdout_truncated,
        stderr_truncated: collected.stderr_truncated,
    })
}

#[tauri::command]
pub async fn probe_7z(app: tauri::AppHandle) -> Result<(), String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    const PROBE_OUTPUT_LIMIT: usize = 4096;

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
        if code == 0 || code == 1 {
            return Ok(());
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
            let _ = child.kill();
            Err("7z runtime probe timed out.".to_string())
        }
    }
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
            None => {
                process.cancelling = false;
                process.owner_label = None;
                process.cleanup_target = None;
                None
            }
        }
    };

    if let Some(child) = child {
        match child.kill() {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                let mut process = lock_process(&state)?;
                if is_non_running_kill_error(&msg) {
                    process.cancelling = false;
                    process.owner_label = None;
                    Ok(())
                } else {
                    eprintln!("Failed to kill 7z process: {msg}");
                    process.cancelling = false;
                    process.owner_label = None;
                    Err(msg)
                }
            }
        }
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn compress_output_path_finds_archive_for_add() {
        let args = vec![
            "a".to_string(),
            "-t7z".to_string(),
            "/tmp/out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert_eq!(
            compress_output_path(&args),
            Some(std::path::PathBuf::from("/tmp/out.7z"))
        );
    }

    #[test]
    fn compress_output_path_none_for_extract() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert_eq!(compress_output_path(&args), None);
    }

    #[test]
    fn kill_error_detection_handles_known_messages() {
        assert!(is_non_running_kill_error("process already finished"));
        assert!(is_non_running_kill_error("child process is not running"));
        assert!(!is_non_running_kill_error("permission denied"));
    }
}
