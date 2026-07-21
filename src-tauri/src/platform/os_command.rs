//! Timed OS command capture and process-tree kill helpers.

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::process::{Command, Output, Stdio};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_OS_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn command_output_reader<R>(
    pipe: R,
) -> std::sync::mpsc::Receiver<std::io::Result<(Vec<u8>, bool)>>
where
    R: std::io::Read + Send + 'static,
{
    use std::io::Read as _;

    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = pipe
            .take((MAX_OS_COMMAND_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| {
                let overflowed = bytes.len() > MAX_OS_COMMAND_OUTPUT_BYTES;
                bytes.truncate(MAX_OS_COMMAND_OUTPUT_BYTES);
                (bytes, overflowed)
            });
        let _ = sender.send(result);
    });
    receiver
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn receive_command_output(
    receiver: std::sync::mpsc::Receiver<std::io::Result<(Vec<u8>, bool)>>,
    deadline: std::time::Instant,
    stream_name: &str,
) -> std::io::Result<Vec<u8>> {
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    let (bytes, overflowed) = receiver
        .recv_timeout(remaining)
        .map_err(|error| match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("OS integration command {stream_name} did not close before timeout"),
            ),
            std::sync::mpsc::RecvTimeoutError::Disconnected => std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("OS integration command {stream_name} reader stopped unexpectedly"),
            ),
        })??;
    if overflowed {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "OS integration command {stream_name} exceeded the {} KiB output limit",
                MAX_OS_COMMAND_OUTPUT_BYTES / 1024
            ),
        ));
    }
    Ok(bytes)
}

/// Kill the spawned command and any descendants that may still hold stdout/stderr
/// pipes open (e.g. `sh -c 'sleep 5 & exit 0'`).
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn kill_command_process_tree(pid: u32, child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // Negative PID signals the process group created via `process_group(0)`.
        let _ = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /T terminates the full tree; trusted OS helpers only.
        // CREATE_NO_WINDOW avoids a console flash in the GUI subsystem app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn command_output_with_timeout(
    command: &mut Command,
    timeout: std::time::Duration,
) -> std::io::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Own process group so timeout can reap background grandchildren that
        // inherit the pipes after the shell exits.
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        // GUI subsystem: hide console windows for whoami/powershell/icacls helpers.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .map(command_output_reader)
        .ok_or_else(|| std::io::Error::other("Could not capture OS command stdout"))?;
    let stderr = child
        .stderr
        .take()
        .map(command_output_reader)
        .ok_or_else(|| std::io::Error::other("Could not capture OS command stderr"))?;
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                kill_command_process_tree(pid, &mut child);
                return Err(error);
            }
        }
        if std::time::Instant::now() >= deadline {
            kill_command_process_tree(pid, &mut child);
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "OS integration command timed out",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    let stdout = match receive_command_output(stdout, deadline, "stdout") {
        Ok(bytes) => bytes,
        Err(error) => {
            kill_command_process_tree(pid, &mut child);
            return Err(error);
        }
    };
    let stderr = match receive_command_output(stderr, deadline, "stderr") {
        Ok(bytes) => bytes,
        Err(error) => {
            kill_command_process_tree(pid, &mut child);
            return Err(error);
        }
    };
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[cfg(unix)]
    #[test]
    fn os_command_capture_collects_bounded_stdout_and_stderr() {
        let output = command_output_with_timeout(
            Command::new("sh").args(["-c", "printf ok; printf warning >&2"]),
            std::time::Duration::from_secs(2),
        )
        .expect("command output");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ok");
        assert_eq!(output.stderr, b"warning");
    }

    #[cfg(unix)]
    #[test]
    fn os_command_capture_rejects_oversized_output() {
        let error = command_output_with_timeout(
            Command::new("dd").args(["if=/dev/zero", "bs=1048577", "count=1"]),
            std::time::Duration::from_secs(5),
        )
        .expect_err("oversized output must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("output limit"));
    }

    #[cfg(unix)]
    #[test]
    fn os_command_capture_does_not_wait_forever_for_inherited_pipes() {
        let started = std::time::Instant::now();
        let error = command_output_with_timeout(
            Command::new("sh").args(["-c", "sleep 5 & exit 0"]),
            std::time::Duration::from_millis(200),
        )
        .expect_err("inherited pipe must respect timeout");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        // Process-group kill should reap the background sleep so this returns
        // promptly instead of waiting out the full sleep.
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }
}
