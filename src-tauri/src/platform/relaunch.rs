//! Restart that lets the old process exit before the new one is opened.
//!
//! `relaunch()` from tauri-plugin-process runs `open -n` while the old process
//! is still alive, so a pinned Dock tile stays on the old instance and a second
//! tile appears. On macOS the helper below waits for the old PID to exit first.

#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};

/// `$1` is the old PID and `$2` the bundle path; nothing is interpolated.
/// The poll is bounded (600 x 0.1 s) so a stuck process cannot hang the helper.
#[cfg(any(target_os = "macos", test))]
const RELAUNCH_HELPER_SCRIPT: &str = r#"
i=0
while kill -0 "$1" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    exit 1
  fi
  /bin/sleep 0.1
done
exec /usr/bin/open "$2"
"#;

/// Returns `<X>.app` for an executable at `<X>.app/Contents/MacOS/<bin>`.
#[cfg(any(target_os = "macos", test))]
fn bundle_root_for_exe(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn spawn_relaunch_helper(pid: u32, bundle: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    // Own process group, so the helper is not killed with the old process.
    Command::new("/bin/sh")
        .arg("-c")
        .arg(RELAUNCH_HELPER_SCRIPT)
        .arg("sh")
        .arg(pid.to_string())
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(drop)
}

/// Starts the helper and exits. Returns false when the caller must fall back.
#[cfg(target_os = "macos")]
fn relaunch_through_helper(app: &tauri::AppHandle) -> bool {
    let Some(bundle) = std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_root_for_exe(&exe))
    else {
        return false;
    };
    match spawn_relaunch_helper(std::process::id(), &bundle) {
        Ok(()) => {
            // Normal exit path, so ExitRequested handling still applies.
            app.exit(0);
            true
        }
        Err(error) => {
            eprintln!("Failed to start relaunch helper: {error}");
            false
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn relaunch_through_helper(_app: &tauri::AppHandle) -> bool {
    false
}

#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    if !relaunch_through_helper(&app) {
        app.request_restart();
    }
}

#[cfg(test)]
mod tests {
    use super::{bundle_root_for_exe, RELAUNCH_HELPER_SCRIPT};
    use std::path::{Path, PathBuf};

    #[test]
    fn bundle_root_found_for_installed_executable() {
        assert_eq!(
            bundle_root_for_exe(Path::new("/Applications/Zinnia.app/Contents/MacOS/zinnia")),
            Some(PathBuf::from("/Applications/Zinnia.app"))
        );
    }

    #[test]
    fn bundle_root_keeps_spaces_quotes_and_dollars_in_path() {
        let exe = Path::new("/Users/me/My \"Apps\" $HOME/Zin nia.app/Contents/MacOS/zinnia");
        assert_eq!(
            bundle_root_for_exe(exe),
            Some(PathBuf::from("/Users/me/My \"Apps\" $HOME/Zin nia.app"))
        );
    }

    #[test]
    fn bundle_root_rejects_dev_build_paths() {
        assert_eq!(
            bundle_root_for_exe(Path::new("/repo/src-tauri/target/debug/zinnia")),
            None
        );
    }

    #[test]
    fn bundle_root_rejects_wrong_layouts() {
        for exe in [
            "/Applications/Zinnia.app/Contents/Resources/zinnia",
            "/Applications/Zinnia.app/MacOS/zinnia",
            "/Applications/Zinnia/Contents/MacOS/zinnia",
            "/Applications/.app/Contents/MacOS/zinnia",
            "/Contents/MacOS/zinnia",
            "zinnia",
        ] {
            assert_eq!(bundle_root_for_exe(Path::new(exe)), None, "{exe}");
        }
    }

    #[test]
    fn helper_script_reads_pid_and_bundle_only_from_positional_args() {
        assert!(RELAUNCH_HELPER_SCRIPT.contains("kill -0 \"$1\""));
        assert!(RELAUNCH_HELPER_SCRIPT.contains("exec /usr/bin/open \"$2\""));
        assert!(RELAUNCH_HELPER_SCRIPT.contains("/bin/sleep 0.1"));
        assert!(!RELAUNCH_HELPER_SCRIPT.contains("-n"));
    }

    #[test]
    fn helper_script_gives_up_after_about_sixty_seconds_without_opening() {
        // 600 polls of 0.1 s; the timeout branch exits before `open` is reached.
        assert!(RELAUNCH_HELPER_SCRIPT.contains("-gt 600"));
        let exit_at = RELAUNCH_HELPER_SCRIPT.find("exit 1").expect("timeout exit");
        let open_at = RELAUNCH_HELPER_SCRIPT.find("/usr/bin/open").expect("open");
        assert!(exit_at < open_at);
    }
}
