//! Windows default-app ProgId queries for OS Integration.

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

use super::os_command::command_output_with_timeout;
use super::{
    archive_status, handler_is_zinnia, ArchiveDefaultStatus, ARCHIVE_DEFAULT_TARGETS,
    ZINNIA_BUNDLE_ID,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Parse a `reg query` REG_SZ / REG_EXPAND_SZ line for `value_name`.
pub(crate) fn parse_reg_sz(stdout: &str, value_name: &str) -> Option<String> {
    let want = value_name.trim().to_ascii_lowercase();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("HKEY_") {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        let name_matches = if want == "(default)" {
            lower.starts_with("(default)")
        } else {
            lower.starts_with(&want)
                && lower
                    .as_bytes()
                    .get(want.len())
                    .is_none_or(|b| b.is_ascii_whitespace())
        };
        if !name_matches {
            continue;
        }
        for marker in ["REG_SZ", "REG_EXPAND_SZ"] {
            if let Some(pos) = trimmed.find(marker) {
                let rest = trimmed[pos + marker.len()..].trim();
                if !rest.is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
    }
    None
}

fn reg_query(key: &str, value: Option<&str>) -> Option<String> {
    let mut command = Command::new("reg");
    command.arg("query").arg(key);
    match value {
        Some(name) => {
            command.args(["/v", name]);
        }
        None => {
            command.arg("/ve");
        }
    }
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command_output_with_timeout(&mut command, Duration::from_secs(5)).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_reg_sz(&text, value.unwrap_or("(Default)"))
}

fn current_progid(extension: &str) -> Option<String> {
    let user_choice = format!(
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{extension}\UserChoice"
    );
    if let Some(progid) = reg_query(&user_choice, Some("ProgId")) {
        return Some(progid);
    }
    let hkcu = format!(r"HKCU\Software\Classes\.{extension}");
    if let Some(progid) = reg_query(&hkcu, None) {
        return Some(progid);
    }
    let hkcr = format!(r"HKCR\.{extension}");
    reg_query(&hkcr, None)
}

fn open_command_for_progid(progid: &str) -> Option<String> {
    let hkcu = format!(r"HKCU\Software\Classes\{progid}\shell\open\command");
    if let Some(command) = reg_query(&hkcu, None) {
        return Some(command);
    }
    let hkcr = format!(r"HKCR\{progid}\shell\open\command");
    reg_query(&hkcr, None)
}

fn command_launches_zinnia(command: &str) -> bool {
    let lower = command.to_ascii_lowercase().replace('/', "\\");
    lower.contains("\\zinnia.exe") || lower.contains("\"zinnia.exe")
}

fn progid_is_zinnia(progid: &str) -> bool {
    if handler_is_zinnia(progid) {
        return true;
    }
    open_command_for_progid(progid)
        .as_deref()
        .is_some_and(command_launches_zinnia)
}

fn status_for_target(target: super::ArchiveDefaultTarget) -> ArchiveDefaultStatus {
    let progid = current_progid(target.extension);
    let is_zinnia = progid.as_deref().is_some_and(progid_is_zinnia);
    let current_handler = match (is_zinnia, progid) {
        (true, Some(p)) if handler_is_zinnia(&p) => Some(p),
        (true, _) => Some(ZINNIA_BUNDLE_ID.to_string()),
        (false, p) => p,
    };
    let status = if is_zinnia {
        "Default"
    } else if current_handler.is_some() {
        "Different default app"
    } else {
        "Choose in Windows Settings."
    };
    archive_status(target, current_handler, false, status)
}

pub(crate) fn windows_query_archive_defaults() -> Vec<ArchiveDefaultStatus> {
    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .filter(|target| target.key != "rar")
        .map(|target| status_for_target(*target))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reg_sz_reads_progid_and_default() {
        let progid_out = "\r\nHKEY_CURRENT_USER\\Software\\...\\UserChoice\r\n    ProgId    REG_SZ    run.rosie.zinnia.zip\r\n\r\n";
        assert_eq!(
            parse_reg_sz(progid_out, "ProgId").as_deref(),
            Some("run.rosie.zinnia.zip")
        );

        let default_out =
            "\r\nHKEY_CLASSES_ROOT\\.7z\r\n    (Default)    REG_SZ    run.rosie.zinnia.7z\r\n\r\n";
        assert_eq!(
            parse_reg_sz(default_out, "(Default)").as_deref(),
            Some("run.rosie.zinnia.7z")
        );
    }

    #[test]
    fn command_launches_zinnia_detects_install_path() {
        assert!(command_launches_zinnia(
            r#""C:\Users\me\AppData\Local\Zinnia\zinnia.exe" "%1""#
        ));
        assert!(!command_launches_zinnia(
            r#""C:\Program Files\7-Zip\7zFM.exe" "%1""#
        ));
    }
}
