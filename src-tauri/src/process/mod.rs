//! 7z process lifecycle: single-slot state, shared drain helper, run/probe/cancel.

use shared_child::SharedChild;
use std::sync::Mutex;

mod archive_snapshot;
mod commands;
mod commit;
mod compress_preflight;
mod journal;
mod quota;
mod recovery;
mod staging;

#[cfg(test)]
mod tests;

// Public API + tauri command companions (needed by generate_handler!).
#[allow(unused_imports)] // re-exported for main.rs / invoke_handler
pub use commands::{
    archive_output_selection_token, cancel_7z, is_7z_running, is_non_running_kill_error,
    parse_7z_version, probe_7z, probe_compress_inputs, probed_7z_version, run_7z,
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
    __cmd__archive_output_selection_token, __cmd__cancel_7z, __cmd__is_7z_running, __cmd__probe_7z,
    __cmd__probe_compress_inputs, __cmd__run_7z,
    __tauri_command_name_archive_output_selection_token, __tauri_command_name_cancel_7z,
    __tauri_command_name_is_7z_running, __tauri_command_name_probe_7z,
    __tauri_command_name_probe_compress_inputs, __tauri_command_name_run_7z,
};
#[doc(hidden)]
pub use recovery::{
    __cmd__get_startup_recovery_status, __tauri_command_name_get_startup_recovery_status,
};

// Bridge helpers that `archive_snapshot` still calls via `super::`.
pub(crate) use archive_snapshot::archive_identity_token;
pub(crate) use journal::unregister_pending_stage;
pub(crate) use quota::available_space_for_path;
pub(crate) use staging::create_private_stage_dir;

pub(crate) use commands::terminate_child;

#[cfg(test)]
pub(crate) use commands::{
    apply_backend_link_switches, collect_command_output, compound_tar_outer_extract_args,
    compound_tar_outer_unpack_ok, extract_warning_is_metadata_only, finalize_preparation_error,
    interpret_terminate_wait, is_compound_tar_operation, prepare_password_transport,
    rewrite_args_for_managed_listfile,
};
#[cfg(test)]
pub(crate) use commit::publish_file_no_replace;
#[cfg(test)]
pub(crate) use commit::staged_tree_contains_symlink;
#[cfg(test)]
pub(crate) use commit::{
    archive_backup_path, archive_stage_has_recovery_backups, assert_safe_extract_target_ancestors,
    commit_failure_should_scrub_staging, merge_staged_extract, merge_staged_extract_with_commit,
    promote_archive_family, rollback_cleanup, rollback_persisted_move_plan, validate_move_record,
    write_move_plan, MAX_EXTRACTED_BYTES,
};
#[cfg(test)]
pub(crate) use journal::{
    is_safe_stage_dir_name, move_identity_log_path, move_plan_path, read_pending_stages,
    register_pending_stage, unregister_plan_stages, ArchiveJournalPhase, CleanupJournal,
    ExtractJournalPhase, ExtractStagePlacement, MoveRecord,
};
#[cfg(test)]
pub(crate) use quota::staged_tree_usage;
#[cfg(test)]
pub(crate) use recovery::{
    archive_journal_is_committed, cleanup_committed_archive_journal,
    cleanup_extract_journal_artifacts, extract_journal_is_committed, recover_missing_extract_stage,
    retract_scrub_archive_journal_at, rollback_archive_journal,
};
#[cfg(test)]
pub(crate) use staging::{
    archive_output_family_token, assert_slt_archive_members_safe, extract_member_list_args,
    listing_preflight_exit_is_acceptable, operation_output_path, prepare_cleanup_plan,
    random_token, ARCHIVE_OUTPUT_ABSENT_TOKEN,
};

#[derive(serde::Serialize)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning_code: Option<i32>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

pub struct ProcessState {
    /// Native shared handle. Passwords use a bounded pipe; all other commands
    /// receive EOF so unexpected 7-Zip prompts cannot hang the app.
    pub child: Option<std::sync::Arc<SharedChild>>,
    pub preparing: bool,
    pub cancelling: bool,
    pub owner_label: Option<String>,
    pub(crate) abort_reason: Option<String>,
    /// When set, `preparing` was reserved for an app update install. Auto-clear
    /// if the webview dies without `release_update` (soft-lock watchdog).
    pub(crate) update_reserved_at: Option<std::time::Instant>,
    pub(crate) cleanup_plan: Option<CleanupPlan>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanupPlan {
    // Every extraction is directed to a contained sibling staging directory
    // first (never inside the user destination). Existing destinations still
    // receive destination ACL/mode via target-local publish / parent-mode apply.
    pub(crate) staged_extract: Option<(std::path::PathBuf, std::path::PathBuf)>,
    // Create/update output is written to a sibling staging basename. This also
    // covers split-volume families (`.001`, `.002`, ...).
    pub(crate) staged_archive: Option<(std::path::PathBuf, std::path::PathBuf)>,
    /// Exact destination family observed before 7-Zip starts. Publication must
    /// match it byte-for-byte so a sync client/editor cannot be overwritten by
    /// a stale long-running create or update.
    pub(crate) expected_archive_family: Vec<ArchiveDestinationSnapshot>,
    /// Private snapshot used by both member preflight and extraction. This
    /// avoids reopening a user-controlled source path between the two steps.
    pub(crate) staged_input_archive: Option<std::path::PathBuf>,
    /// App cache dir used to register pending stage paths for orphan cleanup.
    pub(crate) cache_dir: Option<std::path::PathBuf>,
    pub(crate) max_extract_bytes: Option<u64>,
    pub(crate) min_free_bytes: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ArchiveDestinationSnapshot {
    pub(crate) path: std::path::PathBuf,
    pub(crate) identity: journal::FileIdentity,
    pub(crate) len: u64,
    pub(crate) modified: Option<std::time::SystemTime>,
    pub(crate) sha256: [u8; 32],
}

/// Crash-recovery only. Frontend heartbeats refresh `update_reserved_at` while
/// native install is alive; this TTL must outlast expected auth prompts
/// (pkexec / AppleScript) without unlocking a still-running installer.
pub(crate) const UPDATE_RESERVATION_TTL: std::time::Duration = std::time::Duration::from_secs(1800);

impl ProcessState {
    pub fn idle() -> Self {
        ProcessState {
            child: None,
            preparing: false,
            cancelling: false,
            owner_label: None,
            abort_reason: None,
            update_reserved_at: None,
            cleanup_plan: None,
        }
    }

    /// Release the prepare/cancel soft-lock without touching a live child.
    /// Every prepare-exit path that does not enter running/finalize must call this
    /// so `cancelling` cannot strand `ensure_idle` until restart.
    pub fn release_prepare_slot(&mut self) {
        self.preparing = false;
        self.cancelling = false;
        self.owner_label = None;
        self.abort_reason = None;
        self.update_reserved_at = None;
        self.cleanup_plan = None;
    }

    /// Refresh the update soft-lock clock while native installation is still
    /// alive. Only the reserving window may touch.
    pub(crate) fn touch_update_reservation(&mut self, owner_label: &str) -> Result<(), String> {
        if self.abort_reason.as_deref() != Some("Installing application update") {
            return Err("No update installation reservation is active.".to_string());
        }
        if self.owner_label.as_deref() != Some(owner_label) {
            return Err(
                "Only the window that reserved update installation may refresh it.".to_string(),
            );
        }
        self.update_reserved_at = Some(std::time::Instant::now());
        Ok(())
    }

    /// Drop a stale update reservation left behind when the webview crashes or
    /// never reaches `release_update` after `reserve_update`. Heartbeats from a
    /// live install reset the clock, so this only fires after the UI is gone.
    pub(crate) fn expire_stale_update_reservation(&mut self) {
        let Some(reserved_at) = self.update_reserved_at else {
            return;
        };
        if reserved_at.elapsed() < UPDATE_RESERVATION_TTL {
            return;
        }
        if self.child.is_some() {
            return;
        }
        if self.abort_reason.as_deref() != Some("Installing application update") {
            return;
        }
        self.release_prepare_slot();
    }

    pub(crate) fn blocks_quit_for_update_install(&self) -> bool {
        self.child.is_none()
            && self.preparing
            && self.update_reserved_at.is_some()
            && self.abort_reason.as_deref() == Some("Installing application update")
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

/// Free the prepare slot even if the mutex is poisoned (best-effort unwind).
pub(crate) fn release_prepare_slot_best_effort(state: &RunningProcess) {
    match state.0.lock() {
        Ok(mut process) => process.release_prepare_slot(),
        Err(poisoned) => poisoned.into_inner().release_prepare_slot(),
    }
}

/// Release a failed pre-spawn operation after its child, if any, was stopped.
/// This is separate from `release_prepare_slot` so ordinary reservation cleanup
/// cannot accidentally discard a live child handle.
pub(crate) fn release_preparation_failure_best_effort(state: &RunningProcess) {
    match state.0.lock() {
        Ok(mut process) => {
            process.child = None;
            process.release_prepare_slot();
        }
        Err(poisoned) => {
            let mut process = poisoned.into_inner();
            process.child = None;
            process.release_prepare_slot();
        }
    }
}

// By design, only one 7z process runs at a time across all windows.
// A second invocation (e.g. a concurrent extract window) gets a clear error;
// the frontend prevents this in normal flow. This keeps resource use
// predictable and avoids partial-output races on shared state.
pub fn ensure_idle(state: &ProcessState) -> Result<(), String> {
    if archive_slot_is_busy(state) {
        Err("Another archive operation is already running.".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn archive_slot_is_busy(state: &ProcessState) -> bool {
    state.child.is_some() || state.preparing || state.cancelling
}

pub(crate) fn running_process_is_busy(state: &RunningProcess) -> bool {
    match state.0.lock() {
        Ok(mut process) => {
            process.expire_stale_update_reservation();
            archive_slot_is_busy(&process)
        }
        Err(_) => true,
    }
}

pub(crate) fn ensure_idle_mut(state: &mut ProcessState) -> Result<(), String> {
    state.expire_stale_update_reservation();
    ensure_idle(state)
}
