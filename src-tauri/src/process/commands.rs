//! Tauri commands: run/probe/cancel 7z and shared command-output drain.

mod argv;
mod run;
mod spawn;

#[cfg(test)]
pub(crate) use argv::apply_backend_link_switches;
pub(crate) use argv::harden_7z_args;
#[cfg(test)]
pub(crate) use argv::rewrite_args_for_managed_listfile;
pub(crate) use run::extract_warning_is_metadata_only;
#[cfg(test)]
pub(crate) use run::{
    compound_tar_outer_extract_args, compound_tar_outer_unpack_ok,
    relocate_extract_stage_inside_destination_with_journal, settle_preparation_failure,
};
#[cfg(test)]
pub(crate) use run::{
    finalize_preparation_error, is_compound_tar_operation, settle_archive_finalization,
};
#[cfg(test)]
pub(crate) use spawn::spawn_child_output_for_test;
#[cfg(test)]
pub(crate) use spawn::CollectedOutput;
pub(crate) use spawn::{
    collect_command_output, complete_password_transport, spawn_7z_noninteractive, terminate_child,
    terminate_child_with_timeout, terminate_registered_child_async,
};
#[cfg(test)]
pub(crate) use spawn::{interpret_terminate_wait, prepare_password_transport, read_command_stream};

use std::sync::Arc;

use tauri::Manager;

use crate::validation::validate_run_7z_args;

use super::{lock_process, RunResult, RunningProcess};

const MAX_RUN_7Z_REQUEST_BYTES: usize = 64 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Run7zRequest {
    args: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_present_optional_string")]
    expected_archive_identity: Option<String>,
    #[serde(default)]
    include_io_diagnostics: bool,
    #[serde(default, deserialize_with = "deserialize_present_optional_string")]
    mark_of_the_web_source: Option<String>,
}

/// Missing is allowed for non-mutating calls, but mutating commands (`x`, `a`,
/// `u`) must send `absent` or a 64-character hex family token. An explicitly
/// present value must be a string. In particular, JSON `null` must not
/// silently disable the archive identity precondition at the command boundary.
fn deserialize_present_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <String as serde::Deserialize>::deserialize(deserializer).map(Some)
}

pub(super) fn parse_run_7z_request(request_json: &str) -> Result<Run7zRequest, String> {
    if request_json.len() > MAX_RUN_7Z_REQUEST_BYTES {
        return Err("7-Zip request exceeds its aggregate IPC byte limit.".to_string());
    }
    let request: Run7zRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("Invalid 7-Zip request: {error}"))?;
    if let Some(identity) = request.expected_archive_identity.as_deref() {
        let valid = identity == super::staging::ARCHIVE_OUTPUT_ABSENT_TOKEN
            || (identity.len() == 64 && identity.bytes().all(|byte| byte.is_ascii_hexdigit()));
        if !valid {
            return Err("Archive identity token has an invalid shape.".to_string());
        }
    }
    validate_run_7z_args(&request.args)?;
    if matches!(
        request.args.first().map(String::as_str),
        Some("x" | "a" | "u")
    ) && request.expected_archive_identity.is_none()
    {
        return Err("Mutating archive operations require an archive identity token.".to_string());
    }
    if let Some(source) = request.mark_of_the_web_source.as_deref() {
        if request.args.first().map(String::as_str) != Some("a") {
            return Err(
                "A download-marker source is only accepted for archive creation.".to_string(),
            );
        }
        if source.is_empty() || source.len() > 8192 || source.contains('\0') {
            return Err("The download-marker source path is invalid.".to_string());
        }
    }
    Ok(request)
}

pub(crate) const BUNDLED_7Z_VERSION: &str = env!("ZINNIA_BUNDLED_7Z_VERSION");

/// Snapshot an archive create destination at selection time so a long extract
/// cannot treat a new file as intentional overwrite. Hashes the family, so
/// runs off the main thread.
#[tauri::command]
pub async fn archive_output_selection_token(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::staging::archive_output_family_token(&std::path::PathBuf::from(path))
    })
    .await
    .map_err(|error| format!("Selection-token worker failed: {error}"))?
}

pub(super) fn assert_probed_version_matches_bundle(version: &str) -> Result<(), String> {
    if version == BUNDLED_7Z_VERSION {
        return Ok(());
    }
    Err(format!(
        "Bundled 7-Zip reported {version}; Zinnia requires {BUNDLED_7Z_VERSION}."
    ))
}

/// Parse a 7-Zip version token (e.g. "26.03") from `7z i` / banner output.
pub fn parse_7z_version(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        // Examples: "7-Zip 26.03 (x64)", "7-Zip (z) 24.09"
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
#[tauri::command]
pub async fn run_7z(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_json: String,
    state: tauri::State<'_, RunningProcess>,
) -> Result<RunResult, String> {
    run::run_7z_inner(app, window, request_json, state).await
}

#[tauri::command]
pub async fn probe_7z(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, RunningProcess>,
) -> Result<String, String> {
    run::probe_7z_inner(app, window, state).await
}

/// Cancel the in-flight 7z job owned by this window.
///
/// Returns `Ok(true)` when a child was killed or a prepare slot was marked
/// cancelling. Returns `Ok(false)` when idle (nothing to kill). Callers should
/// still treat a user Cancel click as abort intent (skip password retry / break
/// batch loops) even when this returns false.
#[tauri::command]
pub async fn cancel_7z(
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
        match process.child.as_ref().map(Arc::clone) {
            Some(child) => {
                process.cancelling = true;
                (Some(child), true)
            }
            None if process.preparing => {
                process.cancelling = true;
                (None, true)
            }
            None if process.cancelling => (None, true),
            None => (None, false),
        }
    };

    if let Some(child) = child {
        let app = window.app_handle().clone();
        terminate_registered_child_async(&app, &child)
            .await
            .map(|()| true)
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
    // A cancelled child can exit after termination fails. Reap it on every
    // status query so IPC callers do not keep seeing a permanently busy slot.
    process.reap_orphaned_child();
    match mode.as_deref() {
        None | Some("check") => {
            process.expire_stale_update_reservation();
            Ok(process.child.is_some() || process.preparing || process.cancelling)
        }
        Some("reserve_update") => {
            process.expire_stale_update_reservation();
            if process.child.is_some() || process.preparing || process.cancelling {
                return Ok(true);
            }
            process.preparing = true;
            process.owner_label = Some(window.label().to_string());
            process.abort_reason = Some(super::UPDATE_INSTALL_RESERVATION_REASON.to_string());
            process.update_reserved_at = Some(std::time::Instant::now());
            Ok(false)
        }
        Some("release_update") => {
            process.expire_stale_update_reservation();
            if process.child.is_some() {
                return Err("Cannot release update reservation while 7-Zip is running.".to_string());
            }
            if process.preparing {
                if process.abort_reason.as_deref() != Some(super::UPDATE_INSTALL_RESERVATION_REASON)
                {
                    return Err("No update installation reservation is active.".to_string());
                }
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
        Some("touch_update") => {
            process.expire_stale_update_reservation();
            process.touch_update_reservation(window.label())?;
            Ok(true)
        }
        Some(_) => Err("Unknown archive-operation status mode.".to_string()),
    }
}

#[cfg(test)]
mod password_scrub_tests {
    use super::spawn::mask_password_arg_tokens;

    #[test]
    fn masks_attached_password_before_the_separator_only() {
        let mut args = vec![
            "a".to_string(),
            "-psecret".to_string(),
            "-mhe=on".to_string(),
            "--".to_string(),
            "-pending.zip".to_string(),
        ];
        mask_password_arg_tokens(&mut args);
        assert_eq!(args[1], "-p***");
        assert_eq!(args[2], "-mhe=on");
        assert_eq!(args[4], "-pending.zip");
    }
}

#[cfg(test)]
mod ipc_envelope_tests {
    use super::{parse_run_7z_request, MAX_RUN_7Z_REQUEST_BYTES};

    #[test]
    fn run_7z_parser_accepts_frontend_camel_case_envelope() {
        let identity = "A".repeat(64);
        let json = serde_json::json!({
            "args": ["x", "-o/tmp/out", "-aou", "-spd", "--", "/tmp/archive.7z"],
            "expectedArchiveIdentity": identity,
        })
        .to_string();
        let request = parse_run_7z_request(&json).expect("frontend envelope");
        assert_eq!(
            request.args,
            ["x", "-o/tmp/out", "-aou", "-spd", "--", "/tmp/archive.7z"]
        );
        assert_eq!(request.expected_archive_identity, Some("A".repeat(64)));

        let omitted = parse_run_7z_request(r#"{"args":["b"]}"#).expect("omitted identity");
        assert_eq!(omitted.expected_archive_identity, None);
        assert!(
            parse_run_7z_request(r#"{"args":["a","-t7z","/tmp/out.7z","--","/tmp/in.txt"]}"#)
                .is_err(),
            "mutating create must require an identity token"
        );
        assert!(
            parse_run_7z_request(
                r#"{"args":["a","-t7z","/tmp/out.7z","--","/tmp/in.txt"],"expectedArchiveIdentity":"absent"}"#
            )
            .is_ok(),
            "absent is a valid create identity"
        );
    }

    #[test]
    fn run_7z_parser_rejects_malformed_unknown_and_invalid_identity_payloads() {
        assert!(parse_run_7z_request("{").is_err());
        assert!(parse_run_7z_request(r#"{"args":["b"],"legacy":[]}"#).is_err());
        for identity in [
            "",
            "present",
            "a/b",
            &"g".repeat(64),
            &"a".repeat(63),
            &"a".repeat(65),
        ] {
            let json = serde_json::json!({
                "args": ["b"],
                "expectedArchiveIdentity": identity,
            })
            .to_string();
            assert!(
                parse_run_7z_request(&json).is_err(),
                "accepted invalid identity {identity:?}"
            );
        }
        for wrong_type in ["null", "1", "[]", "{}"] {
            let json = format!(r#"{{"args":["b"],"expectedArchiveIdentity":{wrong_type}}}"#);
            assert!(
                parse_run_7z_request(&json).is_err(),
                "accepted identity with JSON value {wrong_type}"
            );
        }
        assert!(
            parse_run_7z_request(r#"{"args":["b"],"expectedArchiveIdentity":"absent"}"#).is_ok()
        );
    }

    #[test]
    fn run_7z_parser_enforces_aggregate_count_and_per_string_limits() {
        // Valid JSON whose item count and individual strings are each exactly
        // at their limits, but whose cumulative encoded size exceeds 64 MiB.
        let mut cumulative = String::with_capacity(MAX_RUN_7Z_REQUEST_BYTES + 32 * 1024);
        cumulative.push_str(r#"{"args":["#);
        for index in 0..8192 {
            if index > 0 {
                cumulative.push(',');
            }
            cumulative.push('"');
            for _ in 0..8192 {
                cumulative.push('x');
            }
            cumulative.push('"');
        }
        cumulative.push_str("]}");
        assert!(cumulative.len() > MAX_RUN_7Z_REQUEST_BYTES);
        assert!(parse_run_7z_request(&cumulative).is_err());

        let too_many = serde_json::json!({ "args": vec!["b"; 8193] }).to_string();
        assert!(parse_run_7z_request(&too_many).is_err());

        let long_argument = serde_json::json!({ "args": ["x".repeat(8193)] }).to_string();
        assert!(parse_run_7z_request(&long_argument).is_err());

        let multibyte_argument = serde_json::json!({ "args": ["é".repeat(4097)] }).to_string();
        assert!(parse_run_7z_request(&multibyte_argument).is_err());
    }
}
