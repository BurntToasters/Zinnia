//! Spawn 7-Zip, stream I/O, and password transport.

use shared_child::SharedChild;
use std::io::Write;
use std::process::Stdio;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use tauri::async_runtime::{block_on, channel, Receiver, Sender};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::output::{append_limited_output, Utf8StreamDecoder};

use super::super::ArchiveIoDiagnostics;
use super::argv::{prepare_managed_listfile, ManagedListFile};
use super::{lock_process, RunResult, RunningProcess};

fn drain_command_stream_pipe<R: std::io::Read>(mut reader: R) {
    let mut sink = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut sink) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}
pub(crate) fn read_command_stream<R, F>(reader: R, tx: Sender<CommandEvent>, wrap: F)
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
                    // 7-Zip refreshes progress with carriage returns. Emit at
                    // either line boundary so a later status segment cannot
                    // hide the percentage that preceded it in the same record.
                    if matches!(*byte, b'\r' | b'\n') || pending.len() == MAX_STREAM_RECORD_BYTES {
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

pub(crate) fn terminate_child(child: &Arc<SharedChild>) -> Result<(), String> {
    terminate_child_with_timeout(child, std::time::Duration::from_secs(5))
}

pub(crate) fn terminate_child_with_timeout(
    child: &Arc<SharedChild>,
    timeout: std::time::Duration,
) -> Result<(), String> {
    if let Err(error) = child.kill() {
        let msg = error.to_string();
        if !super::is_non_running_kill_error(&msg) {
            return Err(format!("Could not stop 7-Zip: {msg}"));
        }
    }
    interpret_terminate_wait(child.wait_timeout(timeout))
}

pub(crate) fn interpret_terminate_wait(
    result: std::io::Result<Option<std::process::ExitStatus>>,
) -> Result<(), String> {
    match result {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err("7-Zip did not exit after terminate (waited 5s).".to_string()),
        Err(error) => Err(format!("Could not wait for 7-Zip to exit: {error}")),
    }
}

/// Kill and wait for a child that may be in the process slot. On failure keep
/// the handle and `cancelling` so rollback cannot race a still-running 7-Zip.
pub(crate) fn terminate_registered_child(
    state: &RunningProcess,
    child: &Arc<SharedChild>,
) -> Result<(), String> {
    match terminate_child(child) {
        Ok(()) => {
            if let Ok(mut process) = lock_process(state) {
                if process
                    .child
                    .as_ref()
                    .is_some_and(|owned| Arc::ptr_eq(owned, child))
                {
                    process.child = None;
                }
            }
            Ok(())
        }
        Err(error) => {
            if let Ok(mut process) = lock_process(state) {
                process.cancelling = true;
                if process.child.is_none() {
                    process.child = Some(Arc::clone(child));
                }
            }
            Err(error)
        }
    }
}

pub(crate) async fn terminate_registered_child_async(
    app: &tauri::AppHandle,
    child: &Arc<SharedChild>,
) -> Result<(), String> {
    let app = app.clone();
    let child = child.clone();
    tokio::task::spawn_blocking(move || {
        let state = app.state::<RunningProcess>();
        terminate_registered_child(&state, &child)
    })
    .await
    .map_err(|error| format!("Child termination worker failed: {error}"))?
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
        .is_some_and(password_contains_line_break)
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

fn password_contains_line_break(value: &str) -> bool {
    value.contains(['\r', '\n', '\0', '\u{2028}', '\u{2029}'])
}

/// Secret still owed to 7-Zip stdin after the child is registered for cancel.
pub(crate) struct PendingPassword {
    password: String,
    /// Create/update need password + confirmation. Extract/list/test need one
    /// prompt answer. Avoid pre-writing three large copies into a small pipe.
    prompt_writes: u8,
}

type Spawned7z = (
    Receiver<CommandEvent>,
    Arc<SharedChild>,
    Option<PendingPassword>,
);

struct SpawnOutputConfig {
    listfile: Option<ManagedListFile>,
    #[cfg(test)]
    test_hooks: Option<OutputReaderTestHooks>,
}

#[cfg(test)]
struct OutputReaderTestHooks {
    reader_gate: Option<Arc<(Mutex<bool>, std::sync::Condvar)>>,
    panic_stdout_reader: bool,
    child_waited: std::sync::mpsc::Sender<()>,
    output_finished: std::sync::mpsc::Sender<()>,
}

fn send_command_event(tx: &Sender<CommandEvent>, event: CommandEvent) {
    let tx = tx.clone();
    let _ = block_on(async move { tx.send(event).await });
}

fn spawn_child_output(
    command: &mut std::process::Command,
    state: &RunningProcess,
    options: SpawnOutputConfig,
) -> Result<(Receiver<CommandEvent>, Arc<SharedChild>), String> {
    let SpawnOutputConfig {
        listfile,
        #[cfg(test)]
        test_hooks,
    } = options;

    let child = Arc::new(SharedChild::spawn(command).map_err(|error| error.to_string())?);
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
            return Err(match terminate_registered_child(state, &child) {
                Ok(()) => error,
                Err(termination_error) => {
                    format!("{error}; also could not stop 7-Zip: {termination_error}")
                }
            });
        }
    };

    // This bounded channel accommodates ordinary banners and prompts while
    // password input is written. The caller drains it as the child runs; if
    // the receiver closes, readers still continue draining their pipes.
    let (tx, rx) = channel(512);
    let mut readers: Vec<(&'static str, std::thread::JoinHandle<()>)> = Vec::with_capacity(2);
    let streams = [
        (
            "stdout",
            Box::new(stdout) as Box<dyn std::io::Read + Send>,
            CommandEvent::Stdout as fn(Vec<u8>) -> CommandEvent,
        ),
        (
            "stderr",
            Box::new(stderr) as Box<dyn std::io::Read + Send>,
            CommandEvent::Stderr as fn(Vec<u8>) -> CommandEvent,
        ),
    ];
    for (name, reader, wrap) in streams {
        let reader_tx = tx.clone();
        #[cfg(test)]
        let reader_gate = test_hooks
            .as_ref()
            .and_then(|hooks| hooks.reader_gate.clone());
        #[cfg(test)]
        let panic_reader = name == "stdout"
            && test_hooks
                .as_ref()
                .is_some_and(|hooks| hooks.panic_stdout_reader);
        let reader = std::thread::spawn(move || {
            let panic_tx = reader_tx.clone();
            let mut reader_slot = Some(reader);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                #[cfg(test)]
                if let Some(reader_gate) = reader_gate {
                    let (released, changed) = &*reader_gate;
                    let mut released = released
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    while !*released {
                        released = changed
                            .wait(released)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                }
                #[cfg(test)]
                if panic_reader {
                    panic!("test-only 7-Zip stdout reader panic");
                }
                let reader = reader_slot
                    .take()
                    .expect("command output reader should be present");
                read_command_stream(reader, reader_tx, wrap);
            }));
            if result.is_err() {
                // Dropping a pipe reader without draining can SIGPIPE the child
                // before its other output stream is written.
                if let Some(reader) = reader_slot.take() {
                    drain_command_stream_pipe(reader);
                }
                send_command_event(
                    &panic_tx,
                    CommandEvent::Error(format!("7-Zip {name} reader thread panicked.")),
                );
            }
        });
        readers.push((name, reader));
    }

    let wait_child = child.clone();
    let wait_tx = tx.clone();
    std::thread::spawn(move || {
        let wait_result = wait_child.wait();
        #[cfg(test)]
        if let Some(hooks) = &test_hooks {
            let _ = hooks.child_waited.send(());
        }

        let status = match wait_result {
            Ok(status) => Some(status),
            Err(error) => {
                send_command_event(
                    &wait_tx,
                    CommandEvent::Error(format!("Could not wait for 7-Zip: {error}")),
                );
                if let Err(termination_error) = terminate_child(&wait_child) {
                    send_command_event(
                        &wait_tx,
                        CommandEvent::Error(format!(
                            "Could not stop 7-Zip after wait failed: {termination_error}"
                        )),
                    );
                }
                None
            }
        };

        for (stream, reader) in readers {
            if reader.join().is_err() {
                send_command_event(
                    &wait_tx,
                    CommandEvent::Error(format!("7-Zip {stream} reader thread panicked.")),
                );
            }
        }

        // Keep the managed listfile alive until the child has exited and both
        // output streams have been drained.
        drop(listfile);

        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.as_ref().and_then(|status| status.signal())
        };
        #[cfg(windows)]
        let signal = None;
        send_command_event(
            &wait_tx,
            CommandEvent::Terminated(TerminatedPayload {
                code: status.as_ref().and_then(|status| status.code()),
                signal,
            }),
        );
        #[cfg(test)]
        if let Some(hooks) = test_hooks {
            let _ = hooks.output_finished.send(());
        }
    });
    drop(tx);
    Ok((rx, child))
}

#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(crate) fn spawn_child_output_for_test(
    command: &mut std::process::Command,
    reader_gate: Option<Arc<(Mutex<bool>, std::sync::Condvar)>>,
    panic_stdout_reader: bool,
) -> Result<
    (
        Receiver<CommandEvent>,
        Arc<SharedChild>,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Receiver<()>,
    ),
    String,
> {
    let state = RunningProcess::new();
    let (child_waited_tx, child_waited_rx) = std::sync::mpsc::channel();
    let (output_finished_tx, output_finished_rx) = std::sync::mpsc::channel();
    let (rx, child) = spawn_child_output(
        command,
        &state,
        SpawnOutputConfig {
            listfile: None,
            test_hooks: Some(OutputReaderTestHooks {
                reader_gate,
                panic_stdout_reader,
                child_waited: child_waited_tx,
                output_finished: output_finished_tx,
            }),
        },
    )?;
    Ok((rx, child, child_waited_rx, output_finished_rx))
}

fn complete_password_transport_blocking(
    child: &Arc<SharedChild>,
    pending: PendingPassword,
) -> Result<(), String> {
    let PendingPassword {
        password,
        prompt_writes,
    } = pending;
    let child_for_password = child.clone();
    let (password_tx, password_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (|| {
            let mut stdin = child_for_password
                .take_stdin()
                .ok_or_else(|| "Could not open 7-Zip password input.".to_string())?;
            for _ in 0..prompt_writes.max(1) {
                stdin
                    .write_all(password.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .map_err(|error| format!("Could not provide the archive password: {error}"))?;
            }
            drop(stdin);
            Ok::<_, String>(())
        })();
        if result.is_err() {
            let _ = terminate_child(&child_for_password);
        }
        let _ = password_tx.send(result);
    });
    match password_rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            let terminate = terminate_child(child);
            Err(match terminate {
                Ok(()) => "Password setup for 7-Zip timed out and the process was stopped."
                    .to_string(),
                Err(error) => format!(
                    "Password setup for 7-Zip timed out, and the process could not be stopped safely: {error}"
                ),
            })
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = terminate_child(child);
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
/// Mask attached `-p`/`-P` password tokens in a kept-alive arg vector. Overwrite
/// bytes before truncating so the old password is not left in the String's
/// allocation when a parent-side clone survives finalization.
pub(crate) fn mask_password_arg_tokens(args: &mut [String]) {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    for arg in args.iter_mut().take(separator) {
        let lower = arg.to_ascii_lowercase();
        if lower.starts_with("-p") && lower != "-p***" {
            // `-p` is ASCII; replacing every remaining byte with `*` keeps the
            // string valid UTF-8 even when the password contained multibyte
            // characters. `as_bytes_mut` is safe here because only ASCII bytes
            // are written.
            // SAFETY: the branch above checked that the first two bytes are the ASCII `-p` prefix.
            // Every byte from index 2 on is overwritten with ASCII `*` before `arg` is used again,
            // so the String is valid UTF-8 when the borrow ends. The `truncate(2)` below then lands
            // on a char boundary.
            let bytes = unsafe { arg.as_bytes_mut() };
            for byte in bytes.iter_mut().skip(2) {
                *byte = b'*';
            }
            arg.truncate(2);
            arg.push_str("***");
        }
    }
}

pub(crate) fn spawn_7z_noninteractive(
    app: &tauri::AppHandle,
    mut args: Vec<String>,
    state: &RunningProcess,
) -> Result<Spawned7z, String> {
    // A command-line password is visible to same-user process inspection on
    // several desktop platforms. Remove it before spawn and answer 7-Zip's
    // password prompt through a short-lived pipe. Create/update write the
    // password twice (value + confirmation); other commands write once. EOF
    // then guarantees that no unexpected prompt can leave the process waiting.
    let seven_zip_command = args.first().cloned();
    let password = prepare_password_transport(&mut args)?;
    let has_password = password.is_some();
    let prompt_writes = if matches!(seven_zip_command.as_deref(), Some("a" | "u")) {
        2
    } else {
        1
    };
    let pending_password = password.map(|password| PendingPassword {
        password,
        prompt_writes,
    });
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
        .stdin(if has_password {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The shared helper starts pipe readers before returning, so deferred
    // password transport can begin only after stdout/stderr are being drained.
    let (rx, child) = spawn_child_output(
        &mut command,
        state,
        SpawnOutputConfig {
            listfile,
            #[cfg(test)]
            test_hooks: None,
        },
    )?;
    Ok((rx, child, pending_password))
}
pub(crate) struct CollectedOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    pub(crate) exit: Option<TerminatedPayload>,
    pub(crate) stream_error: Option<String>,
}

impl CollectedOutput {
    pub(crate) fn exit_code(&self) -> i32 {
        if self.stream_error.is_some() {
            return -1;
        }
        self.exit
            .as_ref()
            .and_then(|payload| payload.code)
            .unwrap_or(-1)
    }

    pub(crate) fn output_is_complete(&self) -> bool {
        self.stream_error.is_none()
            && self.exit.is_some()
            && !self.stdout_truncated
            && !self.stderr_truncated
    }

    pub(crate) fn accepts_exit_one_with(
        &self,
        classifier: impl FnOnce(&str, &str) -> bool,
    ) -> bool {
        self.exit_code() == 1 && self.output_is_complete() && classifier(&self.stdout, &self.stderr)
    }

    #[cfg(test)]
    pub(crate) fn into_run_result(
        self,
        was_cancelled: bool,
        warning_code: Option<i32>,
    ) -> RunResult {
        self.into_run_result_with_metadata(was_cancelled, warning_code, None, None)
    }

    pub(crate) fn into_run_result_with_metadata(
        self,
        was_cancelled: bool,
        warning_code: Option<i32>,
        archive_identity_after: Option<String>,
        io_diagnostics: Option<ArchiveIoDiagnostics>,
    ) -> RunResult {
        // A cancelled operation is rolled back by the finalizer. Never report
        // the child’s successful exit (or a metadata-only warning) after that
        // rollback, or the UI will present a cancelled operation as Done.
        let code = if was_cancelled {
            -1
        } else if warning_code.is_some() {
            0
        } else {
            self.exit_code()
        };
        RunResult {
            stdout: crate::output::strip_control_chars(&self.stdout),
            stderr: crate::output::strip_control_chars(&self.stderr),
            code,
            warning_code: if was_cancelled { None } else { warning_code },
            stdout_truncated: self.stdout_truncated,
            stderr_truncated: self.stderr_truncated,
            archive_identity_after,
            io_diagnostics,
        }
    }
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
        stream_error: None,
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
            CommandEvent::Error(error) => {
                let detail = format!("7-Zip process error: {error}\n");
                append_limited_output(
                    &mut out.stderr,
                    &detail,
                    max_bytes,
                    &mut out.stderr_truncated,
                );
                // Keep receiving until Terminated. Reader threads send through
                // the same bounded channel and the waiter emits Terminated
                // only after both readers finish; stopping here can leave a
                // sibling reader blocked forever on a full channel, wedging
                // cancellation and window close.
                if out.stream_error.is_none() {
                    out.stream_error = Some(error);
                }
            }
            _ => {}
        }
    }

    out
}
