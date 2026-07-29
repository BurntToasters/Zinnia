//! Tauri commands: run/probe/cancel 7z and shared command-output drain.

use shared_child::SharedChild;
use std::{
    io::Write,
    process::Stdio,
    sync::{Arc, Mutex, RwLock},
};
use tauri::async_runtime::{block_on, channel, Receiver, Sender};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::output::{append_limited_output, sanitize_output, Utf8StreamDecoder, MAX_OUTPUT_BYTES};
use crate::progress::parse_progress_line;
use crate::validation::validate_run_7z_args;

use super::archive_snapshot::assert_archive_identity_unchanged;
use super::commit::{commit_cleanup, commit_failure_should_scrub_staging, rollback_cleanup};
use super::journal::{clear_cleanup_journal, write_cleanup_journal, CleanupJournalGuard};
use super::quota::monitor_extract_quota;
use super::recovery::{
    recover_interrupted_transaction, retract_scrub_archive_journal_or_fail,
    wait_for_startup_recovery,
};
use super::staging::{
    assert_extract_archive_members_safe, operation_output_path, prepare_cleanup_plan,
    rewrite_archive_output, rewrite_extract_archive, rewrite_extract_output,
};
use super::{
    ensure_idle, lock_process, release_prepare_slot_best_effort, RunResult, RunningProcess,
};

fn read_command_stream<R, F>(reader: R, tx: Sender<CommandEvent>, wrap: F)
where
    R: std::io::Read,
    F: Fn(Vec<u8>) -> CommandEvent + Copy,
{
    let mut reader = reader;
    const MAX_STREAM_RECORD_BYTES: usize = 16 * 1024;
    let mut buffer = [0u8; 8 * 1024];
    let mut pending = Vec::with_capacity(MAX_STREAM_RECORD_BYTES);
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                for byte in &buffer[..read] {
                    pending.push(*byte);
                    if *byte == b'\n' || pending.len() == MAX_STREAM_RECORD_BYTES {
                        let bytes = std::mem::replace(
                            &mut pending,
                            Vec::with_capacity(MAX_STREAM_RECORD_BYTES),
                        );
                        let tx = tx.clone();
                        let _ = block_on(async move { tx.send(wrap(bytes)).await });
                    }
                }
            }
            Err(error) => {
                let tx = tx.clone();
                let _ =
                    block_on(async move { tx.send(CommandEvent::Error(error.to_string())).await });
                break;
            }
        }
    }
    if !pending.is_empty() {
        let tx = tx.clone();
        let _ = block_on(async move { tx.send(wrap(pending)).await });
    }
}

struct ManagedListFile(std::path::PathBuf);

impl Drop for ManagedListFile {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Could not remove the temporary 7-Zip list file: {error}");
            }
        }
        if let Some(parent) = self.0.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

pub(crate) fn rewrite_args_for_managed_listfile(
    args: &mut Vec<String>,
    listfile_reference: String,
) -> Result<Vec<String>, String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "The 7-Zip command is missing its path separator.".to_string())?;
    let command = args.first().map(String::as_str);
    let (archive, selected_start) = match command {
        Some("a" | "u") => (None, separator + 1),
        Some("x") => (
            Some(
                args.get(separator + 1)
                    .cloned()
                    .ok_or_else(|| "Extraction command is missing its archive.".to_string())?,
            ),
            separator + 2,
        ),
        _ => {
            return Err("This 7-Zip command does not support managed path list files.".to_string())
        }
    };
    if selected_start >= args.len() {
        return Err("The 7-Zip command has no selected paths to place in a list file.".to_string());
    }
    let selected = args[selected_start..].to_vec();
    args.truncate(separator);
    if !args.iter().any(|arg| arg.eq_ignore_ascii_case("-scsUTF-8")) {
        args.insert(1, "-scsUTF-8".to_string());
    }
    if let Some(archive) = archive {
        // `@listfile` must occur before `--` to be expanded, but extraction's
        // archive must remain the first positional argument.
        args.push(archive);
    }
    args.push(listfile_reference);
    Ok(selected)
}

fn prepare_managed_listfile(args: &mut Vec<String>) -> Result<Option<ManagedListFile>, String> {
    let Some(separator) = args.iter().position(|arg| arg == "--") else {
        return Ok(None);
    };
    let selected_start = match args.first().map(String::as_str) {
        Some("a" | "u") => separator + 1,
        Some("x") => separator + 2,
        _ => return Ok(None),
    };
    if selected_start >= args.len() {
        return Ok(None);
    }
    let token = super::staging::random_token()?;
    let private_dir = std::env::temp_dir().join(format!("zinnia-7z-list-{token}"));
    crate::fs_secure::create_private_dir(&private_dir)
        .map_err(|error| format!("Could not secure the 7-Zip list directory: {error}"))?;
    let listfile = ManagedListFile(private_dir.join("items.txt"));
    let selected =
        rewrite_args_for_managed_listfile(args, format!("@{}", listfile.0.to_string_lossy()))?;
    if selected.iter().any(|path| path.contains(['\r', '\n'])) {
        return Err(
            "A selected path contains a line break and cannot be placed in a managed 7-Zip list file."
                .to_string(),
        );
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(&listfile.0)
        .map_err(|error| format!("Could not create a private 7-Zip list file: {error}"))?;
    for path in &selected {
        file.write_all(path.as_bytes())
            .and_then(|_| file.write_all(b"\r\n"))
            .map_err(|error| format!("Could not write the 7-Zip list file: {error}"))?;
    }
    file.flush()
        .map_err(|error| format!("Could not finish the 7-Zip list file: {error}"))?;
    Ok(Some(listfile))
}

pub(crate) fn terminate_child(child: &Arc<SharedChild>) {
    let _ = child.kill();
    match child.wait_timeout(std::time::Duration::from_secs(5)) {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => {
            // Never hold the command/UI path indefinitely if termination failed.
            // Keep an owner alive and reap asynchronously if the process exits later.
            let child = Arc::clone(child);
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

/// Remove an attached 7-Zip password from the child argv and return it for
/// prompt-based stdin transport. Create/update do not prompt automatically, so
/// they require one bare `-p`; list/test/extract prompt when needed.
pub(crate) fn prepare_password_transport(args: &mut Vec<String>) -> Result<Option<String>, String> {
    let switch_end = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let mut password = None;
    for arg in args.iter().take(switch_end).skip(1) {
        if arg.len() > 2
            && arg
                .get(..2)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("-p"))
        {
            if password.is_some() {
                return Err("Password switch may appear only once.".to_string());
            }
            password = Some(arg[2..].to_string());
        }
    }
    if password
        .as_deref()
        .is_some_and(|value| value.contains(['\r', '\n']))
    {
        return Err("Archive passwords cannot contain line breaks.".to_string());
    }

    let command_uses_explicit_prompt = matches!(args.first().map(String::as_str), Some("a" | "u"));
    let mut first_bare_password = None;
    let mut rewritten = Vec::with_capacity(args.len());
    for (index, arg) in std::mem::take(args).into_iter().enumerate() {
        let is_password_switch = index > 0
            && index < switch_end
            && arg
                .get(..2)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("-p"));
        if !is_password_switch {
            rewritten.push(arg);
        } else if arg.len() == 2 && first_bare_password.is_none() {
            first_bare_password = Some(arg);
        }
    }

    if let Some(bare_password) = first_bare_password {
        rewritten.insert(1, bare_password);
    } else if password.is_some() && command_uses_explicit_prompt {
        rewritten.insert(1, "-p".to_string());
    }
    *args = rewritten;
    Ok(password)
}

/// Secret still owed to 7-Zip stdin after the child is registered for cancel.
pub(crate) struct PendingPassword(String);

type Spawned7z = (
    Receiver<CommandEvent>,
    Arc<SharedChild>,
    Option<PendingPassword>,
);

/// Blocking implementation: write the deferred password after
/// `RunningProcess.child` is set so cancel can kill 7-Zip if the stdin write
/// blocks (e.g. an unexpectedly full pipe on Windows' smaller default pipe
/// buffer, or 7-Zip not reading for some other reason).
fn complete_password_transport_blocking(
    child: &Arc<SharedChild>,
    pending: PendingPassword,
) -> Result<(), String> {
    let password = pending.0;
    let child_for_password = child.clone();
    let (password_tx, password_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (|| {
            let mut stdin = child_for_password
                .take_stdin()
                .ok_or_else(|| "Could not open 7-Zip password input.".to_string())?;
            for _ in 0..3 {
                stdin
                    .write_all(password.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .map_err(|error| format!("Could not provide the archive password: {error}"))?;
            }
            drop(stdin);
            Ok::<_, String>(())
        })();
        if result.is_err() {
            terminate_child(&child_for_password);
        }
        let _ = password_tx.send(result);
    });
    match password_rx.recv() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            terminate_child(child);
            Err("Password setup for 7-Zip did not complete.".to_string())
        }
    }
}

/// Write the deferred password after `RunningProcess.child` is set so cancel
/// can kill 7-Zip if stdin write blocks.
///
/// Runs the blocking write-and-wait on a dedicated blocking-pool thread
/// instead of directly on the calling async task. `validate_run_7z_args`
/// bounds any single argument (including an attached `-pPASSWORD`) to 8 KiB,
/// but 7-Zip prompts up to three times and this writes on every prompt, so an
/// unusually long password combined with a small OS pipe buffer could still
/// park the calling task's tokio worker thread until cancel intervenes.
/// `spawn_blocking` keeps that wait off the worker pool that services every
/// other in-flight async command.
pub(crate) async fn complete_password_transport(
    child: &Arc<SharedChild>,
    pending: PendingPassword,
) -> Result<(), String> {
    let child = child.clone();
    tokio::task::spawn_blocking(move || complete_password_transport_blocking(&child, pending))
        .await
        .map_err(|error| format!("Password setup worker failed: {error}"))?
}

/// Spawn bundled 7-Zip with a closed/noninteractive stdin while retaining a
/// shared native child handle for cancellation and quota enforcement.
///
/// When a password is required, it is returned as [`PendingPassword`] and must
/// be completed with [`complete_password_transport`] only after the child is
/// stored in `RunningProcess` so cancel can terminate a blocked stdin write.
pub(crate) fn spawn_7z_noninteractive(
    app: &tauri::AppHandle,
    mut args: Vec<String>,
) -> Result<Spawned7z, String> {
    // A command-line password is visible to same-user process inspection on
    // several desktop platforms. Remove it before spawn and answer 7-Zip's
    // password prompt through a short-lived pipe. Multiple copies cover
    // create-time confirmation and a single retry; EOF then guarantees that
    // no unexpected prompt can leave the process waiting forever.
    let password = prepare_password_transport(&mut args)?;
    // Always use a private response list for caller-selected paths. Besides
    // avoiding platform-specific execve/command-line ceilings, this keeps the
    // path transport identical across Windows, macOS, and Linux.
    let listfile = prepare_managed_listfile(&mut args)?;
    let plugin_command = app
        .shell()
        .sidecar("7z")
        .map_err(|error| error.to_string())?
        .args(args);
    let mut command: std::process::Command = plugin_command.into();
    command
        .stdin(if password.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = Arc::new(SharedChild::spawn(&mut command).map_err(|error| error.to_string())?);
    // Take stdout/stderr and start drain threads before writing the password.
    // Writing first can fill the stdin pipe while 7-Zip blocks on a full
    // stdout/stderr pipe (especially on Windows ~4 KiB defaults), deadlocking.
    let setup = (|| {
        let stdout = child
            .take_stdout()
            .ok_or_else(|| "Could not capture 7-Zip stdout.".to_string())?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| "Could not capture 7-Zip stderr.".to_string())?;
        Ok::<_, String>((stdout, stderr))
    })();
    let (stdout, stderr) = match setup {
        Ok(streams) => streams,
        Err(error) => {
            terminate_child(&child);
            return Err(error);
        }
    };
    // Capacity must exceed a typical 7-Zip banner plus prompt on both streams.
    // A size-1 channel lets drain threads block on send while this function still
    // writes the password, filling OS pipes and deadlocking before cancel can run.
    let (tx, rx) = channel(512);
    let readers = Arc::new(RwLock::new(()));
    for (reader, wrap) in [
        (
            Box::new(stdout) as Box<dyn std::io::Read + Send>,
            CommandEvent::Stdout as fn(Vec<u8>) -> CommandEvent,
        ),
        (
            Box::new(stderr) as Box<dyn std::io::Read + Send>,
            CommandEvent::Stderr as fn(Vec<u8>) -> CommandEvent,
        ),
    ] {
        let tx = tx.clone();
        let readers = readers.clone();
        std::thread::spawn(move || {
            let _guard = readers
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            read_command_stream(reader, tx, wrap);
        });
    }
    let wait_child = child.clone();
    std::thread::spawn(move || {
        let event = match wait_child.wait() {
            Ok(status) => {
                // Wait for both pipe readers to finish before termination, so
                // collection never drops the final stdout/stderr records.
                let _guard = readers
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal()
                };
                #[cfg(windows)]
                let signal = None;
                CommandEvent::Terminated(TerminatedPayload {
                    code: status.code(),
                    signal,
                })
            }
            Err(error) => CommandEvent::Error(error.to_string()),
        };
        drop(listfile);
        let _ = block_on(async move { tx.send(event).await });
    });
    Ok((rx, child, password.map(PendingPassword)))
}

pub(crate) fn harden_7z_args(args: &mut Vec<String>) {
    let command = args.first().cloned();
    let command = command.as_deref();
    if matches!(command, Some("a" | "u" | "x" | "l" | "t"))
        && !args.iter().any(|arg| arg.eq_ignore_ascii_case("-spd"))
    {
        args.insert(1, "-spd".to_string());
    }
    #[cfg(target_os = "windows")]
    if matches!(command, Some("a" | "u" | "x" | "l" | "t"))
        && !args.iter().any(|arg| arg.eq_ignore_ascii_case("-sccUTF-8"))
    {
        args.insert(1, "-sccUTF-8".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    if command == Some("x") && !args.iter().any(|arg| arg.eq_ignore_ascii_case("-spod")) {
        args.insert(1, "-spod".to_string());
    }
}

/// Parsed bundled 7-Zip version from the last successful `probe_7z` (e.g. "26.02").
static PROBED_7Z_VERSION: Mutex<Option<String>> = Mutex::new(None);

/// Refuse symlink/reparse *user input paths* for create/update. Nested links
/// inside a real directory are stored via `-snl`/`-snh`. Symlink *members*
/// under a managed convert temp dir are allowed so convert can round-trip
/// top-level links extracted from an archive.
fn assert_compress_inputs_are_real_paths(
    app: &tauri::AppHandle,
    args: &[String],
) -> Result<(), String> {
    let Some(cmd) = args.first().map(String::as_str) else {
        return Ok(());
    };
    if cmd != "a" && cmd != "u" {
        return Ok(());
    }
    let Some(separator) = args.iter().position(|arg| arg == "--") else {
        return Ok(());
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
    for path in &inputs {
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
    super::compress_preflight::assert_no_nested_reparse_for_compress(&inputs)
}

/// Check whether the owning window cancelled while an operation is in its
/// pre-spawn phase. Callers that have already created staging must roll it
/// back before releasing the slot.
fn preparation_was_cancelled(state: &RunningProcess) -> Result<bool, String> {
    Ok(lock_process(state)?.cancelling)
}

/// Release a pre-spawn operation that has no staging resources to clean up.
fn abort_cancelled_preparation(state: &RunningProcess) -> Result<(), String> {
    let mut process = lock_process(state)?;
    if !process.cancelling {
        return Ok(());
    }
    process.release_prepare_slot();
    Err("Archive operation was cancelled during preparation.".to_string())
}

#[tauri::command]
pub async fn probe_compress_inputs(
    paths: Vec<String>,
) -> Result<super::compress_preflight::CompressInputProbe, String> {
    tokio::task::spawn_blocking(move || {
        super::compress_preflight::probe_compress_input_paths(&paths)
    })
    .await
    .map_err(|error| format!("Compress-input probe worker failed: {error}"))?
}

pub(crate) fn store_probed_7z_version(version: Option<String>) {
    if let Ok(mut guard) = PROBED_7Z_VERSION.lock() {
        *guard = version;
    }
}

#[allow(dead_code)] // Retained for diagnostics and future sidecar capability checks.
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
    expected_archive_identity: Option<String>,
    state: tauri::State<'_, RunningProcess>,
) -> Result<RunResult, String> {
    validate_run_7z_args(&args)?;

    // Claim the slot before every potentially slow pre-spawn phase. Without
    // this, Cancel could report "idle" while a recursive input scan or startup
    // recovery wait continued toward a real archive publish.
    {
        let mut process = lock_process(&state)?;
        ensure_idle(&process)?;
        process.preparing = true;
        process.owner_label = Some(window.label().to_string());
        process.abort_reason = None;
    }

    let preflight_app = app.clone();
    let preflight_args = args.clone();
    let preflight_result = tokio::task::spawn_blocking(move || {
        assert_compress_inputs_are_real_paths(&preflight_app, &preflight_args)
    })
    .await;
    abort_cancelled_preparation(&state)?;
    match preflight_result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            release_prepare_slot_best_effort(&state);
            return Err(error);
        }
        Err(error) => {
            release_prepare_slot_best_effort(&state);
            return Err(format!("Compress-input preflight worker failed: {error}"));
        }
    }

    let mut args = args;
    harden_7z_args(&mut args);
    // Always store symlinks/hardlinks as links on create/update (macOS .app /
    // .framework trees). Frontend also passes these; inject here so a malformed
    // webview cannot omit them and cause 7-Zip to follow nested links.
    if matches!(args.first().map(String::as_str), Some("a" | "u")) {
        if !args.iter().any(|arg| arg.eq_ignore_ascii_case("-snl")) {
            args.insert(1, "-snl".to_string());
        }
        if !args.iter().any(|arg| arg.eq_ignore_ascii_case("-snh")) {
            args.insert(1, "-snh".to_string());
        }
    }
    // Windows: propagate Mark-of-the-Web (Zone.Identifier) from the archive onto
    // extracted files. macOS/Linux 7-Zip builds reject -snz.
    #[cfg(target_os = "windows")]
    if args.first().map(String::as_str) == Some("x")
        && !args.iter().any(|arg| arg.eq_ignore_ascii_case("-snz"))
    {
        args.insert(1, "-snz".to_string());
    }

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
    }
    abort_cancelled_preparation(&state)?;

    // Startup recovery may take time on a large interrupted transaction. The
    // operation already owns its prepare slot, so Cancel is meaningful here.
    wait_for_startup_recovery().await;
    abort_cancelled_preparation(&state)?;

    if let Err(error) = recover_interrupted_transaction(&app) {
        if let Ok(mut process) = lock_process(&state) {
            process.release_prepare_slot();
        }
        return Err(format!(
            "A previous archive transaction still requires recovery: {error}"
        ));
    }
    abort_cancelled_preparation(&state)?;

    let plan_args = args.clone();
    let plan_expected_identity = expected_archive_identity.clone();
    let cache_dir = match app.path().app_cache_dir() {
        Ok(dir) => Some(dir),
        Err(error) => {
            if let Ok(mut process) = lock_process(&state) {
                process.release_prepare_slot();
            }
            return Err(format!("Could not resolve app cache directory: {error}"));
        }
    };
    let cleanup_plan = match tokio::task::spawn_blocking(move || {
        prepare_cleanup_plan(&plan_args, cache_dir, plan_expected_identity.as_deref())
    })
    .await
    {
        Ok(Ok(plan)) => plan,
        Ok(Err(error)) => {
            if let Ok(mut process) = lock_process(&state) {
                process.release_prepare_slot();
            }
            return Err(error);
        }
        Err(error) => {
            if let Ok(mut process) = lock_process(&state) {
                process.release_prepare_slot();
            }
            return Err(format!("Archive preparation task failed: {error}"));
        }
    };

    // This worker may have created a private stage. Roll it back before
    // releasing ownership so another operation cannot race the cleanup.
    if preparation_was_cancelled(&state)? {
        let rollback_error = rollback_cleanup(&cleanup_plan).err();
        release_prepare_slot_best_effort(&state);
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Archive operation was cancelled during preparation.; staging cleanup also failed: {rollback_error}"
            ),
            None => "Archive operation was cancelled during preparation.".to_string(),
        });
    }

    // Persist the journal as soon as staging exists so a crash during rewrite
    // or member preflight can still recover the stage path.
    let journal_active = match write_cleanup_journal(&app, &cleanup_plan) {
        Ok(active) => active,
        Err(error) => {
            let rollback_error = rollback_cleanup(&cleanup_plan).err();
            if let Ok(mut process) = lock_process(&state) {
                process.release_prepare_slot();
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
            let rollback_error = rollback_cleanup(&cleanup_plan).err();
            let journal_error = if rollback_error.is_none() {
                journal_guard.clear().err()
            } else {
                None
            };
            if let Ok(mut process) = lock_process(&state) {
                process.release_prepare_slot();
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
                    process.child = None;
                    process.release_prepare_slot();
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
            let rollback_error = rollback_cleanup(&cleanup_plan).err();
            let journal_error = if rollback_error.is_none() {
                journal_guard.clear().err()
            } else {
                None
            };
            if let Ok(mut process) = lock_process(&state) {
                process.release_prepare_slot();
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
            process.release_prepare_slot();
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
                process.release_prepare_slot();
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

    // Do not spawn a child after a Cancel that arrived during synchronous
    // rewrite/identity work. This keeps Cancel from becoming a false UI-only
    // acknowledgement immediately before a create/update publish.
    if preparation_was_cancelled(&state)? {
        let rollback_error = rollback_cleanup(&cleanup_plan).err();
        let journal_error = if rollback_error.is_none() {
            journal_guard.clear().err()
        } else {
            None
        };
        release_prepare_slot_best_effort(&state);
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Archive operation was cancelled during preparation.; staging cleanup also failed: {rollback_error}"
            ),
            None => match journal_error {
                Some(journal_error) => format!(
                    "Archive operation was cancelled during preparation.; recovery journal cleanup also failed: {journal_error}"
                ),
                None => "Archive operation was cancelled during preparation.".to_string(),
            },
        });
    }

    let mut rx = {
        let (rx, child, pending_password) = match spawn_7z_noninteractive(
            &app,
            execution_args.clone(),
        ) {
            Ok(result) => result,
            Err(e) => {
                let rollback_error = rollback_cleanup(&cleanup_plan).err();
                let journal_error = if rollback_error.is_none() {
                    journal_guard.clear().err()
                } else {
                    None
                };
                if let Ok(mut process) = lock_process(&state) {
                    process.release_prepare_slot();
                }
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

        // Scoped so the `MutexGuard` this binds is provably dropped (not just
        // logically unreachable after a `return`) before the `.await` below:
        // `RunningProcess` is not `Send`-friendly to hold across an await
        // point in a `#[tauri::command] async fn`, since Tauri's IPC layer
        // requires every command future to be `Send`.
        {
            let mut process = match lock_process(&state) {
                Ok(process) => process,
                Err(error) => {
                    terminate_child(&child);
                    let rollback_error = rollback_cleanup(&cleanup_plan).err();
                    let journal_error = if rollback_error.is_none() {
                        journal_guard.clear().err()
                    } else {
                        None
                    };
                    release_prepare_slot_best_effort(&state);
                    return Err(match rollback_error {
                        Some(rollback_error) => {
                            format!("{error}; staging cleanup also failed: {rollback_error}")
                        }
                        None => match journal_error {
                            Some(journal_error) => {
                                format!(
                                    "{error}; recovery journal cleanup also failed: {journal_error}"
                                )
                            }
                            None => error,
                        },
                    });
                }
            };
            if process.cancelling {
                process.child = None;
                // Keep preparing/cancelling until rollback and journal clear finish.
                drop(process);
                terminate_child(&child);
                let rollback_error = rollback_cleanup(&cleanup_plan).err();
                let journal_error = if rollback_error.is_none() {
                    journal_guard.clear().err()
                } else {
                    None
                };
                release_prepare_slot_best_effort(&state);
                return Err(match rollback_error {
                    Some(rollback_error) => format!(
                        "Archive operation was cancelled during preparation.; staging cleanup also failed: {rollback_error}"
                    ),
                    None => match journal_error {
                        Some(journal_error) => format!(
                            "Archive operation was cancelled during preparation.; recovery journal cleanup also failed: {journal_error}"
                        ),
                        None => "Archive operation was cancelled during preparation.".to_string(),
                    },
                });
            }

            // Register the child before password stdin so cancel can kill a blocked write.
            process.child = Some(child.clone());
            process.owner_label = Some(window.label().to_string());
            process.cleanup_plan = Some(cleanup_plan.clone());
        }

        if let Some(pending_password) = pending_password {
            if let Err(error) = complete_password_transport(&child, pending_password).await {
                let cancelled = lock_process(&state)
                    .map(|process| process.cancelling)
                    .unwrap_or(false);
                if let Ok(mut process) = lock_process(&state) {
                    process.child = None;
                }
                let rollback_error = rollback_cleanup(&cleanup_plan).err();
                let journal_error = if rollback_error.is_none() {
                    journal_guard.clear().err()
                } else {
                    None
                };
                release_prepare_slot_best_effort(&state);
                let error = if cancelled {
                    "Archive operation was cancelled during preparation.".to_string()
                } else {
                    error
                };
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("{error}; staging cleanup also failed: {rollback_error}")
                    }
                    None => match journal_error {
                        Some(journal_error) => {
                            format!(
                                "{error}; recovery journal cleanup also failed: {journal_error}"
                            )
                        }
                        None => error,
                    },
                });
            }
        }

        let mut process = match lock_process(&state) {
            Ok(process) => process,
            Err(error) => {
                terminate_child(&child);
                let rollback_error = rollback_cleanup(&cleanup_plan).err();
                let journal_error = if rollback_error.is_none() {
                    journal_guard.clear().err()
                } else {
                    None
                };
                release_prepare_slot_best_effort(&state);
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("{error}; staging cleanup also failed: {rollback_error}")
                    }
                    None => match journal_error {
                        Some(journal_error) => {
                            format!(
                                "{error}; recovery journal cleanup also failed: {journal_error}"
                            )
                        }
                        None => error,
                    },
                });
            }
        };
        if process.cancelling {
            process.child = None;
            drop(process);
            terminate_child(&child);
            let rollback_error = rollback_cleanup(&cleanup_plan).err();
            let journal_error = if rollback_error.is_none() {
                journal_guard.clear().err()
            } else {
                None
            };
            release_prepare_slot_best_effort(&state);
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "Archive operation was cancelled during preparation.; staging cleanup also failed: {rollback_error}"
                ),
                None => match journal_error {
                    Some(journal_error) => format!(
                        "Archive operation was cancelled during preparation.; recovery journal cleanup also failed: {journal_error}"
                    ),
                    None => "Archive operation was cancelled during preparation.".to_string(),
                },
            });
        }

        process.preparing = false;
        process.cancelling = false;
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
            let _ = emit_window.emit("7z-progress", crate::output::sanitize_output(chunk));
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
                        // Retract any partial publishes from the journal BEFORE
                        // clearing it  -  clearing alone left destinations orphaned
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
                                    Ok(()) => Err(error),
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
    window: tauri::Window,
    state: tauri::State<'_, RunningProcess>,
) -> Result<String, String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    const PROBE_OUTPUT_LIMIT: usize = 4096;

    {
        let mut process = lock_process(&state)?;
        ensure_idle(&process)?;
        process.preparing = true;
        process.owner_label = Some(window.label().to_string());
    }

    let result = async {
        let (mut rx, child, _pending_password) =
            spawn_7z_noninteractive(&app, vec!["i".to_string()])?;
        {
            let mut process = lock_process(&state)?;
            if process.cancelling {
                drop(process);
                terminate_child(&child);
                return Err("7z runtime probe was cancelled.".to_string());
            }
            process.child = Some(child.clone());
        }

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
                terminate_child(&child);
                store_probed_7z_version(None);
                Err("7z runtime probe timed out.".to_string())
            }
        }
    }
    .await;

    if let Ok(mut process) = lock_process(&state) {
        if process.owner_label.as_deref() == Some(window.label()) {
            process.child = None;
            process.release_prepare_slot();
        }
    }

    result
}

/// Cancel the in-flight 7z job owned by this window.
///
/// Returns `Ok(true)` when a child was killed or a prepare slot was marked
/// cancelling. Returns `Ok(false)` when idle (nothing to kill). Callers should
/// still treat a user Cancel click as abort intent (skip password retry / break
/// batch loops) even when this returns false.
#[tauri::command]
pub fn cancel_7z(
    window: tauri::Window,
    state: tauri::State<'_, RunningProcess>,
) -> Result<bool, String> {
    let (child, armed) = {
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
                (Some(child), true)
            }
            None if process.preparing => {
                process.cancelling = true;
                (None, true)
            }
            None => (None, false),
        }
    };

    if let Some(child) = child {
        match child.kill() {
            Ok(()) => Ok(true),
            Err(e) => {
                let msg = e.to_string();
                if is_non_running_kill_error(&msg) {
                    Ok(true)
                } else {
                    // Put the handle back so a later cancel can retry the kill.
                    if let Ok(mut process) = lock_process(&state) {
                        if process.child.is_none() {
                            process.child = Some(child);
                        }
                    }
                    eprintln!("Failed to kill 7z process: {msg}");
                    Err(format!("Could not stop 7z safely: {msg}. Restart Zinnia before starting another operation."))
                }
            }
        }
    } else {
        Ok(armed)
    }
}

#[tauri::command]
pub fn is_7z_running(
    window: tauri::Window,
    mode: Option<String>,
    state: tauri::State<'_, RunningProcess>,
) -> Result<bool, String> {
    let mut process = lock_process(&state)?;
    match mode.as_deref() {
        None | Some("check") => {
            Ok(process.child.is_some() || process.preparing || process.cancelling)
        }
        Some("reserve_update") => {
            if process.child.is_some() || process.preparing || process.cancelling {
                return Ok(true);
            }
            process.preparing = true;
            process.owner_label = Some(window.label().to_string());
            process.abort_reason = Some("Installing application update".to_string());
            Ok(false)
        }
        Some("release_update") => {
            if process.child.is_some() {
                return Err("Cannot release update reservation while 7-Zip is running.".to_string());
            }
            if process.preparing {
                if process.owner_label.as_deref() != Some(window.label()) {
                    return Err(
                        "Only the window that reserved update installation may release it."
                            .to_string(),
                    );
                }
                process.release_prepare_slot();
            }
            Ok(false)
        }
        Some(_) => Err("Unknown archive-operation status mode.".to_string()),
    }
}
