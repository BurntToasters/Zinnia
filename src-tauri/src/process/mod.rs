//! 7z process lifecycle: single-slot state, shared drain helper, run/probe/cancel.

use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

mod archive_snapshot;
mod commands;
mod commit;
mod journal;
mod quota;
mod recovery;
mod staging;

#[cfg(test)]
mod tests;

// Public API + tauri command companions (needed by generate_handler!).
#[allow(unused_imports)] // re-exported for main.rs / invoke_handler
pub use commands::{
    cancel_7z, is_7z_running, is_non_running_kill_error, parse_7z_version, probe_7z,
    probed_7z_version, run_7z,
};
#[allow(unused_imports)]
pub use journal::cleanup_orphan_stages;
#[allow(unused_imports)]
pub use recovery::{
    get_startup_recovery_status, mark_startup_recovery_done, recover_interrupted_transaction,
    set_startup_recovery_error,
};

// `#[tauri::command]` emits these beside each command; generate_handler looks them
// up on the same path as the function (`process::run_7z` → `process::__cmd__run_7z`).
#[doc(hidden)]
pub use commands::{
    __cmd__cancel_7z, __cmd__is_7z_running, __cmd__probe_7z, __cmd__run_7z,
    __tauri_command_name_cancel_7z, __tauri_command_name_is_7z_running,
    __tauri_command_name_probe_7z, __tauri_command_name_run_7z,
};
#[doc(hidden)]
pub use recovery::{
    __cmd__get_startup_recovery_status, __tauri_command_name_get_startup_recovery_status,
};

// Bridge helpers that `archive_snapshot` still calls via `super::`.
pub(crate) use journal::unregister_pending_stage;
pub(crate) use quota::available_space_for_path;
pub(crate) use staging::{create_private_stage_dir, resolve_existing_target};

#[cfg(test)]
pub(crate) use commands::version_cmp;
#[cfg(all(test, target_os = "windows"))]
pub(crate) use commands::{store_probed_7z_version, windows_rar_extract_blocked};
#[cfg(test)]
pub(crate) use commit::{
    archive_stage_has_recovery_backups, assert_safe_extract_target_ancestors,
    commit_failure_should_scrub_staging, merge_staged_extract, promote_archive_family,
    rollback_cleanup, rollback_persisted_move_plan, write_move_plan, MAX_EXTRACTED_BYTES,
};
#[cfg(test)]
pub(crate) use journal::{
    is_safe_stage_dir_name, read_pending_stages, register_pending_stage, unregister_plan_stages,
    CleanupJournal, MoveRecord,
};
#[cfg(test)]
pub(crate) use quota::staged_tree_usage;
#[cfg(test)]
pub(crate) use recovery::{archive_journal_is_committed, rollback_archive_journal};
#[cfg(test)]
pub(crate) use staging::{
    assert_extract_parent_unchanged, assert_slt_archive_members_safe, directory_entry_names,
    extract_member_list_args, operation_output_path, prepare_cleanup_plan, random_token,
};

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
    pub preparing: bool,
    pub cancelling: bool,
    pub owner_label: Option<String>,
    pub(crate) abort_reason: Option<String>,
    pub(crate) cleanup_plan: Option<CleanupPlan>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanupPlan {
    // Every extraction is directed to a sibling staging directory first. This
    // keeps failed/cancelled jobs from leaving partial files in an existing
    // user directory and gives us a contained place to inspect before promote.
    pub(crate) staged_extract: Option<(std::path::PathBuf, std::path::PathBuf)>,
    // Create/update output is written to a sibling staging basename. This also
    // covers split-volume families (`.001`, `.002`, ...).
    pub(crate) staged_archive: Option<(std::path::PathBuf, std::path::PathBuf)>,
    /// Private snapshot used by both member preflight and extraction. This
    /// avoids reopening a user-controlled source path between the two steps.
    pub(crate) staged_input_archive: Option<std::path::PathBuf>,
    /// Sibling names in the extract stage parent after the stage dir is created.
    /// Used to detect *new* names that escape the `-o` stage root. Writes into
    /// existing siblings are blocked by archive-member path preflight.
    pub(crate) extract_parent_names: Option<std::collections::HashSet<std::ffi::OsString>>,
    /// App cache dir used to register pending stage paths for orphan cleanup.
    pub(crate) cache_dir: Option<std::path::PathBuf>,
    pub(crate) max_extract_bytes: Option<u64>,
    pub(crate) min_free_bytes: Option<u64>,
}

impl ProcessState {
    pub fn idle() -> Self {
        ProcessState {
            child: None,
            preparing: false,
            cancelling: false,
            owner_label: None,
            abort_reason: None,
            cleanup_plan: None,
        }
    }
}

pub struct RunningProcess(pub Mutex<ProcessState>);

impl RunningProcess {
    pub fn new() -> Self {
        RunningProcess(Mutex::new(ProcessState::idle()))
    }
}

pub(crate) fn lock_process(
    state: &RunningProcess,
) -> Result<std::sync::MutexGuard<'_, ProcessState>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Process lock poisoned".to_string())
}

// By design, only one 7z process runs at a time across all windows.
// A second invocation (e.g. a concurrent extract window) gets a clear error;
// the frontend prevents this in normal flow. This keeps resource use
// predictable and avoids partial-output races on shared state.
pub fn ensure_idle(state: &ProcessState) -> Result<(), String> {
    if state.child.is_some() || state.preparing || state.cancelling {
        Err("Another archive operation is already running.".to_string())
    } else {
        Ok(())
    }
}
