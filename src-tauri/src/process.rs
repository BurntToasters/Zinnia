//! 7z process lifecycle: single-slot state, shared drain helper, run/probe/cancel.

use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::output::{append_limited_output, sanitize_output, Utf8StreamDecoder, MAX_OUTPUT_BYTES};
use crate::progress::parse_progress_line;
use crate::validation::validate_run_7z_args;

static RECOVERY_LOCK: Mutex<()> = Mutex::new(());
/// Set after the startup maintenance thread finishes its one-shot recovery pass.
/// `run_7z` waits for this so it cannot race startup recovery against a live journal.
static STARTUP_RECOVERY_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(cfg!(test));
/// Last startup recovery failure (cleared when recovery succeeds or was a no-op).
static STARTUP_RECOVERY_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// Parsed bundled 7-Zip version from the last successful `probe_7z` (e.g. "26.02").
static PROBED_7Z_VERSION: Mutex<Option<String>> = Mutex::new(None);

/// Windows RAR extract stays blocked for CVE-2026-58052 through this version inclusive.
#[cfg(target_os = "windows")]
const WINDOWS_RAR_EXTRACT_BLOCKED_THROUGH: &str = "26.02";

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
    abort_reason: Option<String>,
    cleanup_plan: Option<CleanupPlan>,
}

#[derive(Clone, Debug)]
struct CleanupPlan {
    // Every extraction is directed to a sibling staging directory first. This
    // keeps failed/cancelled jobs from leaving partial files in an existing
    // user directory and gives us a contained place to inspect before promote.
    staged_extract: Option<(std::path::PathBuf, std::path::PathBuf)>,
    // Create/update output is written to a sibling staging basename. This also
    // covers split-volume families (`.001`, `.002`, ...).
    staged_archive: Option<(std::path::PathBuf, std::path::PathBuf)>,
    /// Sibling names in the extract stage parent after the stage dir is created.
    /// Used to detect writes that escape the `-o` stage root.
    extract_parent_names: Option<std::collections::HashSet<std::ffi::OsString>>,
    max_extract_bytes: Option<u64>,
    min_free_bytes: Option<u64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CleanupJournal {
    stage: std::path::PathBuf,
    destination: std::path::PathBuf,
    archive: bool,
    previous_archive_family: Vec<std::path::PathBuf>,
    #[serde(default)]
    next_archive_family: Vec<std::path::PathBuf>,
}

const MOVE_PLAN_FILE_NAME: &str = "move-plan.json";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct MoveRecord {
    source: std::path::PathBuf,
    target: std::path::PathBuf,
}

fn cleanup_journal_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("active-transaction.json"))
}

fn write_cleanup_journal(app: &tauri::AppHandle, plan: &CleanupPlan) -> Result<bool, String> {
    let journal = if let Some((stage, destination)) = &plan.staged_extract {
        Some(CleanupJournal {
            stage: stage.clone(),
            destination: destination.clone(),
            archive: false,
            previous_archive_family: Vec::new(),
            next_archive_family: Vec::new(),
        })
    } else if let Some((staged_archive, destination)) = &plan.staged_archive {
        Some(CleanupJournal {
            stage: staged_archive
                .parent()
                .ok_or_else(|| "Archive staging directory is missing.".to_string())?
                .to_path_buf(),
            destination: destination.clone(),
            archive: true,
            previous_archive_family: archive_family(destination)?,
            next_archive_family: Vec::new(),
        })
    } else {
        None
    };
    let Some(journal) = journal else {
        return Ok(false);
    };
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&cleanup_journal_path(app)?, &json)?;
    Ok(true)
}

fn update_archive_journal(app: &tauri::AppHandle, plan: &CleanupPlan) -> Result<(), String> {
    let Some((staged, destination)) = &plan.staged_archive else {
        return Ok(());
    };
    let stage = staged
        .parent()
        .ok_or_else(|| "Archive staging directory is missing.".to_string())?
        .to_path_buf();
    let next_archive_family = archive_family(staged)?
        .iter()
        .map(|source| archive_destination_for(staged, destination, source))
        .collect::<Result<Vec<_>, _>>()?;
    let journal = CleanupJournal {
        stage,
        destination: destination.clone(),
        archive: true,
        previous_archive_family: archive_family(destination)?,
        next_archive_family,
    };
    let json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&cleanup_journal_path(app)?, &json)
}

fn clear_cleanup_journal(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cleanup_journal_path(app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => crate::settings_store::sync_parent_directory(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn sync_directory(path: &std::path::Path) -> Result<(), String> {
    crate::fs_secure::sync_directory(path)
}

fn archive_journal_has_backups(journal: &CleanupJournal) -> bool {
    journal
        .previous_archive_family
        .iter()
        .enumerate()
        .any(|(index, _)| journal.stage.join(format!("backup-{index}")).is_file())
}

fn archive_journal_stage_retains_outputs(journal: &CleanupJournal) -> bool {
    journal.next_archive_family.iter().any(|destination| {
        destination
            .file_name()
            .map(|name| journal.stage.join(name).is_file())
            .unwrap_or(false)
    })
}

/// Promote finished successfully when next outputs are recorded, no backups remain,
/// and the stage no longer holds unpublished archive members. Leftover empty stage
/// dirs must not trigger destructive rollback of the published archive.
fn archive_journal_is_committed(journal: &CleanupJournal) -> bool {
    !journal.next_archive_family.is_empty()
        && !archive_journal_has_backups(journal)
        && !archive_journal_stage_retains_outputs(journal)
}

fn rollback_archive_journal(journal: &CleanupJournal) -> Result<(), String> {
    let candidates = if journal.next_archive_family.is_empty() {
        archive_family(&journal.destination)?
    } else {
        journal.next_archive_family.clone()
    };
    for current in candidates {
        let prior_index = journal
            .previous_archive_family
            .iter()
            .position(|target| target == &current);
        // Only delete a destination when we can restore a backup, or when it is a
        // newly published volume (not in previous family) during an incomplete promote.
        let should_remove = match prior_index {
            Some(index) => journal.stage.join(format!("backup-{index}")).is_file(),
            None => true,
        };
        if should_remove {
            remove_regular_file_if_present(&current)?;
        }
    }
    for (index, target) in journal.previous_archive_family.iter().enumerate() {
        let backup = journal.stage.join(format!("backup-{index}"));
        if backup.is_file() {
            std::fs::rename(&backup, target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Mark the one-shot startup recovery pass complete (success or failure).
pub fn mark_startup_recovery_done() {
    STARTUP_RECOVERY_DONE.store(true, std::sync::atomic::Ordering::Release);
}

pub fn set_startup_recovery_error(message: Option<String>) {
    if let Ok(mut guard) = STARTUP_RECOVERY_ERROR.lock() {
        *guard = message;
    }
}

#[tauri::command]
pub fn get_startup_recovery_status() -> Option<String> {
    STARTUP_RECOVERY_ERROR
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

fn store_probed_7z_version(version: Option<String>) {
    if let Ok(mut guard) = PROBED_7Z_VERSION.lock() {
        *guard = version;
    }
}

#[allow(dead_code)] // Attested version for Windows RAR gate and future callers.
pub fn probed_7z_version() -> Option<String> {
    PROBED_7Z_VERSION.lock().ok().and_then(|guard| guard.clone())
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
fn version_cmp(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let parse = |value: &str| -> Option<Vec<u32>> {
        value
            .split('.')
            .map(|part| part.parse::<u32>().ok())
            .collect()
    };
    Some(parse(a)?.cmp(&parse(b)?))
}

#[cfg(target_os = "windows")]
fn windows_rar_extract_blocked() -> bool {
    match probed_7z_version() {
        Some(version) => {
            match version_cmp(&version, WINDOWS_RAR_EXTRACT_BLOCKED_THROUGH) {
                Some(std::cmp::Ordering::Greater) => false,
                _ => true,
            }
        }
        // Fail closed until probe attests a safe runtime.
        None => true,
    }
}

async fn wait_for_startup_recovery() {
    // Back off instead of a 1ms spin. Do not force-complete on timeout; that let
    // run_7z claim the slot then block on RECOVERY_LOCK with a misleading "busy" UI.
    let mut delay_ms = 10u64;
    while !STARTUP_RECOVERY_DONE.load(std::sync::atomic::Ordering::Acquire) {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = (delay_ms + 10).min(50);
    }
}

pub fn recover_interrupted_transaction(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cleanup_journal_path(app)?;
    // Fast path: with no journal there is nothing to recover. Skip the lock so a
    // concurrent startup maintenance pass cannot delay the first extract.
    if !path.exists() {
        return Ok(());
    }
    let _recovery_guard = RECOVERY_LOCK
        .lock()
        .map_err(|_| "Archive recovery lock is unavailable.".to_string())?;
    // Re-check under the lock; another thread may have cleared it.
    let json = match std::fs::read_to_string(&path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let journal: CleanupJournal = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let stage_name = journal
        .stage
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if journal.stage.parent() != journal.destination.parent()
        || !is_safe_stage_dir_name(stage_name)
    {
        return Err("Refusing unsafe interrupted-transaction recovery path.".to_string());
    }
    let metadata = match std::fs::symlink_metadata(&journal.stage) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return clear_cleanup_journal(app)
        }
        Err(error) => return Err(error.to_string()),
    };
    if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err("Refusing unsafe interrupted-transaction staging directory.".to_string());
    }

    if journal.archive {
        if archive_journal_is_committed(&journal) {
            // Publish already succeeded; only clear leftovers. Never delete destinations.
            let _ = std::fs::remove_dir_all(&journal.stage);
            if let Some(parent) = journal.stage.parent() {
                let _ = sync_directory(parent);
            }
            return clear_cleanup_journal(app);
        }
        rollback_archive_journal(&journal)?;
    } else {
        rollback_persisted_move_plan(&journal.stage, &journal.destination)?;
    }
    std::fs::remove_dir_all(&journal.stage).map_err(|e| e.to_string())?;
    if let Some(parent) = journal.stage.parent() {
        sync_directory(parent)?;
    }
    clear_cleanup_journal(app)
}

/// Stage dirs are created as `.<basename>.zinnia-(extract|archive)-<32 hex>`.
fn is_safe_stage_dir_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    for marker in [".zinnia-extract-", ".zinnia-archive-"] {
        if let Some(idx) = rest.rfind(marker) {
            let token = &rest[idx + marker.len()..];
            return token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit());
        }
    }
    false
}

fn remove_regular_file_if_present(path: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata)
            if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
        {
            Err(format!(
                "Refusing to remove unexpected recovery target {}.",
                path.display()
            ))
        }
        Ok(_) => std::fs::remove_file(path).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

struct CleanupJournalGuard {
    app: tauri::AppHandle,
    active: bool,
}

impl CleanupJournalGuard {
    fn new(app: tauri::AppHandle, active: bool) -> Self {
        Self { app, active }
    }

    fn clear(&mut self) -> Result<(), String> {
        if self.active {
            clear_cleanup_journal(&self.app)?;
            self.active = false;
        }
        Ok(())
    }
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

fn lock_process(state: &RunningProcess) -> Result<std::sync::MutexGuard<'_, ProcessState>, String> {
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

// For a compress/update command, the output archive is the single positional
// arg before `--`. For extract, the -o<dir> destination is returned.
fn operation_output_path(args: &[String]) -> Option<std::path::PathBuf> {
    let cmd = args.first().map(String::as_str)?;
    match cmd {
        "a" | "u" => {
            let separator = args.iter().position(|a| a == "--")?;
            args[1..separator]
                .iter()
                .find(|a| !a.starts_with('-'))
                .map(std::path::PathBuf::from)
        }
        "x" => {
            // Find -o<dir> in the args before --
            let separator = args.iter().position(|a| a == "--").unwrap_or(args.len());
            args[1..separator]
                .iter()
                .find(|a| a.to_lowercase().starts_with("-o"))
                .map(|a| std::path::PathBuf::from(&a[2..]))
        }
        _ => None,
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("Secure randomness unavailable: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn resolve_new_target(target: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Could not resolve output parent directory: {e}"))?;
    let name = target
        .file_name()
        .ok_or_else(|| "Output path must have a file or directory name.".to_string())?;
    Ok(canonical_parent.join(name))
}

fn path_entry_exists(path: &std::path::Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn assert_real_directory(path: &std::path::Path) -> Result<(), String> {
    crate::path_safety::assert_real_directory(path).map_err(|error| {
        if error.starts_with("Path is not a real directory") {
            format!("Extraction path is not a real directory: {}", path.display())
        } else {
            error
        }
    })
}

/// Re-check every ancestor from `destination` through `target`'s parent immediately
/// before publish so a same-user TOCTOU cannot swap an intermediate directory for a
/// symlink/reparse point between planning and rename.
///
/// Residual same-user race remains between this check and the subsequent rename/
/// hard_link; closing that fully needs no-follow directory handles (platform APIs).
fn assert_safe_extract_target_ancestors(
    destination: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    assert_real_directory(destination)?;
    let Some(parent) = target.parent() else {
        return Ok(());
    };
    if parent == destination {
        return Ok(());
    }
    let relative = parent.strip_prefix(destination).map_err(|_| {
        format!(
            "Extraction target escaped destination: {}",
            target.display()
        )
    })?;
    let mut cursor = destination.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        assert_real_directory(&cursor)?;
    }
    Ok(())
}

fn resolve_existing_target(
    target: &std::path::Path,
    expected_directory: bool,
) -> Result<std::path::PathBuf, String> {
    if expected_directory {
        crate::path_safety::assert_real_directory(target).map_err(|error| {
            if error.contains("not a real directory") {
                "Extraction destination is not a directory.".to_string()
            } else if error.contains("symbolic link") || error.contains("reparse") {
                "Output target cannot be a symbolic link or reparse point.".to_string()
            } else {
                error
            }
        })?;
    } else {
        crate::path_safety::assert_real_file(target).map_err(|error| {
            if error.contains("not a regular file") {
                "Archive output is not a regular file.".to_string()
            } else if error.contains("symbolic link") || error.contains("reparse") {
                "Output target cannot be a symbolic link or reparse point.".to_string()
            } else {
                error
            }
        })?;
    }
    target.canonicalize().map_err(|e| e.to_string())
}

fn create_private_stage_dir(
    target: &std::path::Path,
    purpose: &str,
) -> Result<std::path::PathBuf, String> {
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("output");
    for _ in 0..32 {
        let candidate = parent.join(format!(".{name}.zinnia-{purpose}-{}", random_token()?));
        match crate::fs_secure::create_private_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create secure staging directory: {error}"
                ))
            }
        }
    }
    Err("Could not reserve a unique staging directory.".to_string())
}

fn next_extract_stage_path(target: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if path_entry_exists(target)? {
        let meta = std::fs::symlink_metadata(target).map_err(|e| e.to_string())?;
        crate::path_safety::reject_link_or_reparse(target, &meta).map_err(|_| {
            "Extraction destination cannot be a symbolic link or reparse point.".to_string()
        })?;
        if !meta.is_dir() {
            return Err("Extraction destination is not a directory.".to_string());
        }
    }
    create_private_stage_dir(target, "extract")
}

fn rewrite_extract_output(args: &mut [String], staged_dir: &std::path::Path) -> Result<(), String> {
    let output = format!("-o{}", staged_dir.to_string_lossy());
    let Some(arg) = args
        .iter_mut()
        .find(|arg| arg.to_ascii_lowercase().starts_with("-o"))
    else {
        return Err("Extraction command is missing an output directory.".to_string());
    };
    *arg = output;
    Ok(())
}

fn rewrite_archive_output(args: &mut [String], staged: &std::path::Path) -> Result<(), String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "Compression command is missing '--'.".to_string())?;
    let Some(arg) = args[1..separator]
        .iter_mut()
        .find(|arg| !arg.starts_with('-'))
    else {
        return Err("Compression command is missing an output archive.".to_string());
    };
    *arg = staged.to_string_lossy().to_string();
    Ok(())
}

fn directory_entry_names(
    dir: &std::path::Path,
) -> Result<std::collections::HashSet<std::ffi::OsString>, String> {
    let mut names = std::collections::HashSet::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        names.insert(entry.file_name());
    }
    Ok(names)
}

fn assert_extract_parent_unchanged(
    stage: &std::path::Path,
    expected: &std::collections::HashSet<std::ffi::OsString>,
) -> Result<(), String> {
    let parent = stage
        .parent()
        .ok_or_else(|| "Staged extract has no parent directory.".to_string())?;
    let current = directory_entry_names(parent)?;
    for name in &current {
        if !expected.contains(name) {
            return Err(format!(
                "Extraction wrote outside the staging directory: {}",
                parent.join(name).display()
            ));
        }
    }
    Ok(())
}

fn prepare_cleanup_plan(args: &[String]) -> Result<CleanupPlan, String> {
    let Some(target) = operation_output_path(args) else {
        return Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            extract_parent_names: None,
            max_extract_bytes: None,
            min_free_bytes: None,
        });
    };

    match args.first().map(String::as_str) {
        Some("x") => {
            let destination = if path_entry_exists(&target)? {
                resolve_existing_target(&target, true)
                    .map_err(|e| format!("Could not resolve the extraction destination: {e}"))?
            } else {
                resolve_new_target(&target)?
            };
            let separator = args
                .iter()
                .position(|arg| arg == "--")
                .unwrap_or(args.len());
            let archive_size = args
                .get(separator + 1)
                .and_then(|path| std::fs::metadata(path).ok())
                .map_or(0, |metadata| metadata.len());
            const MAX_EXTRACT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
            const MIN_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
            let ratio_limit = archive_size.saturating_mul(1000).min(MAX_EXTRACT_BYTES);
            let free_space = available_space_for_path(&destination)?;
            let reserve = (free_space / 10).max(MIN_DISK_RESERVE_BYTES);
            let disk_limit = free_space.saturating_sub(reserve);
            if disk_limit == 0 {
                return Err(format!(
                    "Not enough free space to extract safely ({} MiB available).",
                    free_space / (1024 * 1024)
                ));
            }
            let max_extract_bytes = ratio_limit.min(disk_limit);
            let stage = next_extract_stage_path(&destination)?;
            let parent = stage
                .parent()
                .ok_or_else(|| "Staged extract has no parent directory.".to_string())?;
            let extract_parent_names = directory_entry_names(parent)?;
            Ok(CleanupPlan {
                staged_extract: Some((stage, destination)),
                staged_archive: None,
                extract_parent_names: Some(extract_parent_names),
                max_extract_bytes: Some(max_extract_bytes),
                min_free_bytes: Some(reserve),
            })
        }
        Some("a") => {
            let target = if path_entry_exists(&target)? {
                resolve_existing_target(&target, false)?
            } else {
                resolve_new_target(&target)?
            };
            let stage_dir = create_private_stage_dir(&target, "archive")?;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                extract_parent_names: None,
                max_extract_bytes: None,
                min_free_bytes: None,
            })
        }
        Some("u") => {
            if !path_entry_exists(&target)? {
                return Err("Update requires an existing output archive file.".to_string());
            }
            let target = resolve_existing_target(&target, false)?;
            let stage_dir = create_private_stage_dir(&target, "archive")?;
            let staged = stage_dir.join(
                target
                    .file_name()
                    .ok_or_else(|| "Archive output has no file name.".to_string())?,
            );
            if let Err(error) = std::fs::copy(&target, &staged) {
                let _ = std::fs::remove_dir_all(&stage_dir);
                return Err(format!("Could not stage the archive for update: {error}"));
            }
            Ok(CleanupPlan {
                staged_extract: None,
                staged_archive: Some((staged, target)),
                extract_parent_names: None,
                max_extract_bytes: None,
                min_free_bytes: None,
            })
        }
        _ => Ok(CleanupPlan {
            staged_extract: None,
            staged_archive: None,
            extract_parent_names: None,
            max_extract_bytes: None,
            min_free_bytes: None,
        }),
    }
}

fn available_space_for_path(path: &std::path::Path) -> Result<u64, String> {
    let existing = path
        .ancestors()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| "Could not find an existing extraction parent directory.".to_string())?;
    available_space(existing)
}

#[cfg(unix)]
fn available_space(path: &std::path::Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "Extraction path contains an invalid NUL byte.".to_string())?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL terminated and `stats` points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(format!(
            "Could not query free disk space: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: statvfs initialized the structure after returning success.
    let stats = unsafe { stats.assume_init() };
    let available = (stats.f_bavail as u128).saturating_mul(stats.f_frsize as u128);
    Ok(available.min(u64::MAX as u128) as u64)
}

#[cfg(windows)]
fn available_space(path: &std::path::Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0u64;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available: *mut u64,
            total_bytes: *mut u64,
            total_free_bytes: *mut u64,
        ) -> i32;
    }
    // SAFETY: `wide` is NUL terminated and the output pointer is valid.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "Could not query free disk space: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(available)
}

/// Walk a staged extract tree. On success returns `(files, bytes)` counted so far
/// so callers can back off scan frequency when usage is still well under limits.
fn staged_tree_usage(
    root: &std::path::Path,
    max_files: u64,
    max_bytes: u64,
) -> Result<(u64, u64), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = 0u64;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if crate::path_safety::is_link_or_reparse(&metadata) {
                return Err(
                    "Extraction created a symbolic link or reparse point; operation stopped."
                        .to_string(),
                );
            }
            files = files.saturating_add(1);
            bytes = bytes.saturating_add(metadata.len());
            if files > max_files {
                return Err(format!(
                    "Extraction exceeded the safety limit of {max_files} entries."
                ));
            }
            if bytes > max_bytes {
                return Err(format!(
                    "Extraction exceeded its {:.1} GiB safety limit.",
                    max_bytes as f64 / 1_073_741_824.0
                ));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok((files, bytes))
}

async fn monitor_extract_quota(
    app: tauri::AppHandle,
    staged: std::path::PathBuf,
    max_bytes: u64,
    min_free_bytes: u64,
    finished: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let mut next_tree_scan = std::time::Instant::now();
    while !finished.load(std::sync::atomic::Ordering::Relaxed) {
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        if finished.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        // Free-space checks are constant-time and stay frequent. Full recursive scans are
        // adaptive so a very large extraction cannot spend most of its time repeatedly walking
        // the same tree; the mandatory pre-promotion scan remains the final authority.
        let free_path = staged.clone();
        let free_space = tokio::task::spawn_blocking(move || available_space(&free_path)).await;
        let low_space_reason = match free_space {
            Ok(Ok(bytes)) if bytes <= min_free_bytes => Some(format!(
                "Extraction stopped to preserve at least {:.1} GiB of free disk space.",
                min_free_bytes as f64 / 1_073_741_824.0
            )),
            Ok(Err(error)) => Some(format!("Extraction disk-space check failed: {error}")),
            Err(error) => Some(format!("Extraction disk-space task failed: {error}")),
            Ok(Ok(_)) => None,
        };
        if let Some(reason) = low_space_reason {
            stop_extract_for_quota(&app, reason);
            break;
        }
        if std::time::Instant::now() < next_tree_scan {
            continue;
        }

        let scan_started = std::time::Instant::now();
        let scan_path = staged.clone();
        let scan = tokio::task::spawn_blocking(move || {
            staged_tree_usage(&scan_path, MAX_EXTRACT_ENTRIES, max_bytes)
        })
        .await;
        let reason = match scan {
            Ok(Err(reason)) => Some(reason),
            Err(error) => Some(format!("Extraction safety scan failed: {error}")),
            Ok(Ok((files, bytes))) => {
                // Huge extracts: back off harder when still under half the limits so
                // quota monitoring does not dominate I/O with full-tree walks.
                let under_half = files <= MAX_EXTRACT_ENTRIES / 2 && bytes <= max_bytes / 2;
                let multiplier = if under_half { 8 } else { 4 };
                let max_delay = if under_half {
                    std::time::Duration::from_secs(15)
                } else {
                    std::time::Duration::from_secs(8)
                };
                let scan_delay = scan_started.elapsed().saturating_mul(multiplier).clamp(
                    std::time::Duration::from_secs(2),
                    max_delay,
                );
                next_tree_scan = std::time::Instant::now() + scan_delay;
                None
            }
        };
        if let Some(reason) = reason {
            stop_extract_for_quota(&app, reason);
            break;
        }
    }
}

fn stop_extract_for_quota(app: &tauri::AppHandle, reason: String) {
    let state = app.state::<RunningProcess>();
    let child = match lock_process(&state) {
        Ok(mut process) => {
            process.cancelling = true;
            process.abort_reason = Some(reason);
            process.child.take()
        }
        Err(_) => None,
    };
    if let Some(child) = child {
        if let Err(error) = child.kill() {
            if let Ok(mut process) = lock_process(&state) {
                process.abort_reason = Some(format!(
                    "Extraction exceeded a safety limit, but its process could not be stopped: {error}"
                ));
            }
        }
    }
}

fn archive_family(base: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let parent = base.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Archive output has an invalid file name.".to_string())?;
    let mut family = Vec::new();
    match std::fs::symlink_metadata(base) {
        Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_file() => {
            return Err(format!(
                "Archive output is not a regular file: {}",
                base.display()
            ));
        }
        Ok(_) => family.push(base.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // 7-Zip volumes are a contiguous sequence beginning at .001. Do not sweep
    // arbitrary numeric suffixes such as `archive.7z.2024`; those may be
    // unrelated user files.
    for index in 1..=1_000_000u32 {
        let candidate = parent.join(format!("{name}.{index:03}"));
        let meta = match std::fs::symlink_metadata(&candidate) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        };
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_file() {
            return Err(format!(
                "Archive volume is not a regular file: {}",
                candidate.display()
            ));
        }
        family.push(candidate);
    }
    family.sort();
    Ok(family)
}

fn archive_destination_for(
    staged_base: &std::path::Path,
    destination_base: &std::path::Path,
    staged_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if staged_path == staged_base {
        return Ok(destination_base.to_path_buf());
    }
    let staged_name = staged_base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid staged archive name.".to_string())?;
    let path_name = staged_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid staged volume name.".to_string())?;
    let suffix = path_name
        .strip_prefix(staged_name)
        .ok_or_else(|| "Staged volume does not match its archive basename.".to_string())?;
    let destination_name = destination_base
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid destination archive name.".to_string())?;
    Ok(destination_base.with_file_name(format!("{destination_name}{suffix}")))
}

fn publish_file_no_replace(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    let source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    source_file.sync_all().map_err(|e| e.to_string())?;
    drop(source_file);
    if std::fs::hard_link(source, target).is_err() {
        // FAT-family and some network filesystems do not support hard links.
        // Reserve the target with create_new and stream the staged file into it;
        // this is slower but retains no-clobber semantics on those filesystems.
        let copy_result = (|| -> Result<(), String> {
            let mut input = crate::path_safety::open_regular_file_nofollow(source)?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|e| {
                    format!("Could not reserve archive output {}: {e}", target.display())
                })?;
            std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            let permissions = std::fs::metadata(source)
                .map_err(|e| e.to_string())?
                .permissions();
            std::fs::set_permissions(target, permissions).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = copy_result {
            let _ = std::fs::remove_file(target);
            return Err(error);
        }
    }
    if let Err(error) = std::fs::remove_file(source) {
        let _ = std::fs::remove_file(target);
        return Err(format!(
            "Could not finish publishing archive output {}: {error}",
            target.display()
        ));
    }
    Ok(())
}

fn promote_archive_family(
    staged: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let staged_family = archive_family(staged)?;
    if staged_family.is_empty() {
        return Err("7z reported success but produced no staged archive output.".to_string());
    }

    let stage_dir = staged
        .parent()
        .ok_or_else(|| "Staged archive has no parent directory.".to_string())?;
    let existing = archive_family(destination)?;
    let mut backups: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for (index, path) in existing.into_iter().enumerate() {
        let backup = stage_dir.join(format!("backup-{index}"));
        if let Err(e) = std::fs::rename(&path, &backup) {
            let mut restore_errors = Vec::new();
            for (previous_backup, previous_path) in backups.into_iter().rev() {
                if let Err(restore_error) = std::fs::rename(&previous_backup, &previous_path) {
                    restore_errors.push(format!(
                        "Could not restore {}: {restore_error}",
                        previous_path.display()
                    ));
                }
            }
            let error = format!(
                "Could not protect existing archive volume {}: {e}",
                path.display()
            );
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; recovery also failed: {}",
                    restore_errors.join("; ")
                ))
            };
        }
        backups.push((backup, path));
    }
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    sync_directory(stage_dir)?;

    let mut promoted = Vec::new();
    let result = (|| {
        for source in staged_family {
            let target = archive_destination_for(staged, destination, &source)?;
            publish_file_no_replace(&source, &target)?;
            promoted.push((target, source));
        }
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        let mut recovery_errors = Vec::new();
        for (target, source) in promoted.into_iter().rev() {
            if let Err(e) = std::fs::rename(&target, &source) {
                recovery_errors.push(format!(
                    "Could not return {} to staging: {e}",
                    target.display()
                ));
            }
        }
        for (backup, target) in backups.into_iter().rev() {
            if let Err(e) = std::fs::rename(&backup, &target) {
                recovery_errors.push(format!("Could not restore {}: {e}", target.display()));
            }
        }
        return if recovery_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}; recovery also failed: {}",
                recovery_errors.join("; ")
            ))
        };
    }

    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }

    for (backup, _) in backups {
        std::fs::remove_file(&backup).map_err(|e| {
            format!(
                "Archive was published, but backup cleanup failed for {}: {e}",
                backup.display()
            )
        })?;
    }
    sync_directory(stage_dir)?;
    std::fs::remove_dir(stage_dir).map_err(|e| {
        format!(
            "Archive was published, but staging directory cleanup failed for {}: {e}",
            stage_dir.display()
        )
    })?;
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn rollback_cleanup(plan: &CleanupPlan) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Some((staged, _)) = &plan.staged_extract {
        if let Err(e) = std::fs::remove_dir_all(staged) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove partial extract directory {}: {e}",
                    staged.display()
                ));
            }
        }
    }
    if let Some((staged, _)) = &plan.staged_archive {
        let stage_dir = staged.parent().unwrap_or(staged);
        if let Err(e) = std::fs::remove_dir_all(stage_dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "Could not remove partial archive staging directory {}: {e}",
                    stage_dir.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn auto_rename_path(
    path: &std::path::Path,
    reserved: &std::collections::HashSet<std::path::PathBuf>,
) -> Result<std::path::PathBuf, String> {
    if !reserved.contains(path) && !path_entry_exists(path)? {
        return Ok(path.to_path_buf());
    }
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("file");
    let extension = path.extension().and_then(|v| v.to_str());
    for index in 1..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem}_{index}.{extension}"),
            None => format!("{stem}_{index}"),
        };
        let candidate = parent.join(name);
        if !reserved.contains(&candidate) && !path_entry_exists(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not find a free conflict-safe name for {}.",
        path.display()
    ))
}

const MAX_EXTRACT_ENTRIES: u64 = 1_000_000;
const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

fn assert_path_under_root(root: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        format!(
            "Staged path escaped the extract root: {}",
            path.display()
        )
    })?;
    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Staged path escaped the extract root: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_staged_tree(root: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut entries = 0u64;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        assert_path_under_root(root, &directory)?;
        let meta = std::fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
            return Err(format!("Unsafe staged directory: {}", directory.display()));
        }
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            entries = entries.saturating_add(1);
            if entries > MAX_EXTRACT_ENTRIES {
                return Err(format!(
                    "Archive exceeds the {MAX_EXTRACT_ENTRIES}-entry safety limit."
                ));
            }
            let path = entry.path();
            assert_path_under_root(root, &path)?;
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if crate::path_safety::is_link_or_reparse(&meta) {
                return Err(format!(
                    "Archive contains a symbolic link or reparse point: {}",
                    path.display()
                ));
            }
            if meta.is_dir() {
                pending.push(path);
            } else if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
                if bytes > max_bytes {
                    return Err(format!(
                        "Archive exceeds its {:.1} GiB expanded-size safety limit.",
                        max_bytes as f64 / 1_073_741_824.0
                    ));
                }
            } else {
                return Err(format!(
                    "Archive contains an unsupported entry: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn plan_staged_contents(
    staged: &std::path::Path,
    destination: &std::path::Path,
    reserved: &mut std::collections::HashSet<std::path::PathBuf>,
    plan: &mut Vec<MoveRecord>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(staged).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let meta = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
        let requested_target = destination.join(entry.file_name());
        if meta.is_dir() {
            match std::fs::symlink_metadata(&requested_target) {
                Ok(target_meta)
                    if target_meta.is_dir()
                        && !crate::path_safety::is_link_or_reparse(&target_meta) =>
                {
                    plan_staged_contents(&source, &requested_target, reserved, plan)?;
                    continue;
                }
                Ok(_) => {
                    // Existing symlinks, reparse points, files, and special
                    // nodes are conflicts. Never recurse through them.
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let target = auto_rename_path(&requested_target, reserved)?;
        reserved.insert(target.clone());
        plan.push(MoveRecord { source, target });
    }
    Ok(())
}

fn write_move_plan(staged: &std::path::Path, plan: &[MoveRecord]) -> Result<(), String> {
    let json = serde_json::to_string(plan).map_err(|e| e.to_string())?;
    crate::settings_store::atomic_write_text(&staged.join(MOVE_PLAN_FILE_NAME), &json)
}

fn validate_move_record(
    staged: &std::path::Path,
    destination: &std::path::Path,
    record: &MoveRecord,
) -> Result<(), String> {
    if !record.source.starts_with(staged) || !record.target.starts_with(destination) {
        return Err("Refusing unsafe extraction recovery move plan.".to_string());
    }
    Ok(())
}

fn rollback_move_records(
    staged: &std::path::Path,
    destination: &std::path::Path,
    plan: &[MoveRecord],
) -> Result<(), String> {
    let mut failures = Vec::new();
    for record in plan.iter().rev() {
        if let Err(error) = validate_move_record(staged, destination, record) {
            failures.push(error);
            continue;
        }
        let source_exists = path_entry_exists(&record.source)?;
        let target_metadata = match std::fs::symlink_metadata(&record.target) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                failures.push(error.to_string());
                continue;
            }
        };
        let Some(target_metadata) = target_metadata else {
            if !source_exists {
                failures.push(format!(
                    "Both extraction source and promoted target are missing: {}",
                    record.target.display()
                ));
            }
            continue;
        };
        if source_exists {
            // The move was planned but never executed.
            continue;
        }
        if crate::path_safety::is_link_or_reparse(&target_metadata) {
            failures.push(format!(
                "Refusing to roll back a symbolic-link or reparse-point target: {}",
                record.target.display()
            ));
            continue;
        }
        if let Some(parent) = record.source.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                failures.push(error.to_string());
                continue;
            }
        }
        if let Err(error) = std::fs::rename(&record.target, &record.source) {
            failures.push(format!(
                "Could not roll back {}: {error}",
                record.target.display()
            ));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn rollback_persisted_move_plan(
    staged: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let path = staged.join(MOVE_PLAN_FILE_NAME);
    let json = match std::fs::read_to_string(path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let plan: Vec<MoveRecord> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    rollback_move_records(staged, destination, &plan)
}

fn merge_staged_extract(
    staged: &std::path::Path,
    destination: &std::path::Path,
    max_bytes: u64,
) -> Result<(), String> {
    // Always enforce the operation-specific limit immediately before publish.
    // Fast extractions can finish before the live monitor's first poll.
    validate_staged_tree(staged, max_bytes)?;
    if !path_entry_exists(destination)? {
        if let Some(parent) = destination.parent() {
            assert_real_directory(parent)?;
        }
        // Re-check immediately before rename: a symlink/reparse point must never
        // be published as the destination root.
        match std::fs::symlink_metadata(destination) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(meta) if crate::path_safety::is_link_or_reparse(&meta) => {
                return Err(
                    "Extraction destination became a symbolic link or reparse point during commit."
                        .to_string(),
                );
            }
            Ok(_) => {
                return Err("Extraction destination appeared during commit.".to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
        std::fs::rename(staged, destination).map_err(|e| e.to_string())?;
        if let Some(parent) = destination.parent() {
            sync_directory(parent)?;
        }
        return Ok(());
    }
    assert_real_directory(destination)?;
    let mut reserved = std::collections::HashSet::new();
    let mut plan = Vec::new();
    plan_staged_contents(staged, destination, &mut reserved, &mut plan)?;
    write_move_plan(staged, &plan)?;
    for record in &plan {
        validate_move_record(staged, destination, record)?;
        if let Err(error) = assert_safe_extract_target_ancestors(destination, &record.target) {
            let rollback = rollback_move_records(staged, destination, &plan);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
        if path_entry_exists(&record.target)? {
            let error = format!(
                "Extraction destination changed during commit: {}",
                record.target.display()
            );
            let rollback = rollback_move_records(staged, destination, &plan);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
        let metadata = std::fs::symlink_metadata(&record.source).map_err(|e| e.to_string())?;
        let result = if metadata.is_file() {
            publish_file_no_replace(&record.source, &record.target)
        } else {
            std::fs::rename(&record.source, &record.target).map_err(|e| e.to_string())
        };
        if let Err(error) = result {
            let rollback = rollback_move_records(staged, destination, &plan);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            });
        }
    }
    std::fs::remove_dir_all(staged).map_err(|e| e.to_string())?;
    sync_directory(destination)?;
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn commit_cleanup(app: &tauri::AppHandle, plan: &CleanupPlan) -> Result<(), String> {
    if let Some((staged, destination)) = &plan.staged_extract {
        if let Some(expected) = &plan.extract_parent_names {
            assert_extract_parent_unchanged(staged, expected).map_err(|e| {
                format!("Could not promote staged extraction safely: {e}")
            })?;
        }
        merge_staged_extract(
            staged,
            destination,
            plan.max_extract_bytes.unwrap_or(MAX_EXTRACTED_BYTES),
        )
        .map_err(|e| format!("Could not promote staged extraction safely: {e}"))?;
        crate::launch::remember_openable_directory(app, destination);
    }
    if let Some((staged, destination)) = &plan.staged_archive {
        update_archive_journal(app, plan)?;
        promote_archive_family(staged, destination)?;
        if let Some(parent) = destination.parent() {
            crate::launch::remember_openable_directory(app, parent);
        }
    }
    Ok(())
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

// `on_stdout_line` runs per decoded stdout chunk for progress streaming.
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
    let cleanup_plan =
        match tokio::task::spawn_blocking(move || prepare_cleanup_plan(&plan_args)).await {
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

    let mut execution_args = args.clone();
    let rewrite_result = if let Some((staged, _)) = &cleanup_plan.staged_extract {
        rewrite_extract_output(&mut execution_args, staged)
    } else if let Some((staged, _)) = &cleanup_plan.staged_archive {
        rewrite_archive_output(&mut execution_args, staged)
    } else {
        Ok(())
    };
    if let Err(error) = rewrite_result {
        let rollback_error = rollback_cleanup(&cleanup_plan).err();
        if let Ok(mut process) = lock_process(&state) {
            process.preparing = false;
            process.owner_label = None;
        }
        return Err(match rollback_error {
            Some(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
            None => error,
        });
    }

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

    let finalize_result = if was_cancelled || exit_code != 0 {
        if let Err(error) = rollback_cleanup(&cleanup_plan) {
            Err(format!("7z operation ended, but rollback failed: {error}"))
        } else {
            if was_cancelled {
                let _ = window.emit("7z-cancelled", ());
            }
            Ok(())
        }
    } else {
        let _ = emit_window.emit(
            "7z-progress-structured",
            crate::progress::ProgressUpdate {
                percent: Some(100),
                files_done: None,
                current_file: Some("Finalizing…".to_string()),
            },
        );
        commit_cleanup(&app, &cleanup_plan)
    };

    if let Ok(mut process) = lock_process(&state) {
        process.child = None;
        process.preparing = false;
        process.cancelling = false;
        process.owner_label = None;
        process.abort_reason = None;
        process.cleanup_plan = None;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "{prefix}-{}",
            random_token().expect("random test token")
        ))
    }

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
    fn safe_stage_dir_name_requires_exact_token_pattern() {
        assert!(is_safe_stage_dir_name(
            ".out.zinnia-extract-0123456789abcdef0123456789abcdef"
        ));
        assert!(is_safe_stage_dir_name(
            ".archive.7z.zinnia-archive-fedcba9876543210fedcba9876543210"
        ));
        assert!(!is_safe_stage_dir_name("photos.zinnia-extract-evil"));
        assert!(!is_safe_stage_dir_name(
            ".out.zinnia-extract-0123456789abcdef0123456789abcd"
        ));
        assert!(!is_safe_stage_dir_name(
            "out.zinnia-extract-0123456789abcdef0123456789abcdef"
        ));
    }

    #[test]
    fn operation_output_path_finds_archive_for_add() {
        let args = vec![
            "a".to_string(),
            "-t7z".to_string(),
            "/tmp/out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert_eq!(
            operation_output_path(&args),
            Some(std::path::PathBuf::from("/tmp/out.7z"))
        );
    }

    #[test]
    fn operation_output_path_finds_output_dir_for_extract() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert_eq!(
            operation_output_path(&args),
            Some(std::path::PathBuf::from("/tmp/out"))
        );
    }

    #[test]
    fn operation_output_path_none_for_list() {
        let args = vec!["l".to_string(), "--".to_string(), "archive.7z".to_string()];
        assert_eq!(operation_output_path(&args), None);
    }

    #[test]
    fn extraction_uses_a_staging_directory() {
        let root = temp_root("zinnia-extract-plan-test");
        std::fs::create_dir_all(&root).expect("test directory");
        let args = vec![
            "x".to_string(),
            format!("-o{}", root.display()),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        let plan = prepare_cleanup_plan(&args).expect("cleanup plan");
        let (staged, target) = plan.staged_extract.expect("staging plan");
        assert_ne!(staged, target);
        let _ = std::fs::remove_dir_all(staged);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn existing_archive_is_untouched_after_staged_rollback() {
        let root = temp_root("zinnia-process-test");
        std::fs::create_dir_all(&root).expect("test directory");
        let target = root.join("output.7z");
        std::fs::write(&target, b"original").expect("test archive");

        let args = vec![
            "a".to_string(),
            "-t7z".to_string(),
            target.to_string_lossy().to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        let plan = prepare_cleanup_plan(&args).expect("cleanup plan");
        let staged = plan
            .staged_archive
            .as_ref()
            .map(|(staged, _)| staged.clone())
            .expect("staged archive");
        assert!(target.exists());
        std::fs::write(&staged, b"partial").expect("partial staged archive");
        rollback_cleanup(&plan).expect("rollback should remove staging");
        assert_eq!(
            std::fs::read(&target).expect("restored archive"),
            b"original"
        );
        assert!(!staged.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn nested_extract_merge_does_not_double_remove_directories() {
        let root = temp_root("zinnia-merge-test");
        let staged = root.join("staged");
        let destination = root.join("destination");
        std::fs::create_dir_all(staged.join("nested")).expect("staged tree");
        std::fs::create_dir_all(destination.join("nested")).expect("destination tree");
        std::fs::write(staged.join("nested/new.txt"), b"new").expect("staged file");

        merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
            .expect("merge should succeed");
        assert_eq!(
            std::fs::read(destination.join("nested/new.txt")).expect("promoted file"),
            b"new"
        );
        assert!(!staged.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn final_extract_scan_enforces_operation_specific_quota() {
        let root = temp_root("zinnia-final-quota-test");
        let staged = root.join("staged");
        let destination = root.join("destination");
        std::fs::create_dir_all(&staged).expect("staged tree");
        std::fs::write(staged.join("expanded.bin"), b"12345678").expect("staged file");

        let error = merge_staged_extract(&staged, &destination, 7)
            .expect_err("final scan must reject an over-quota extraction");
        assert!(error.contains("expanded-size safety limit"));
        assert!(!destination.exists());
        assert!(staged.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn staged_symlink_is_rejected_even_for_new_destination() {
        use std::os::unix::fs::symlink;
        let root = temp_root("zinnia-symlink-test");
        let staged = root.join("staged");
        let destination = root.join("destination");
        std::fs::create_dir_all(&staged).expect("staged tree");
        symlink("/tmp", staged.join("unsafe-link")).expect("test symlink");

        assert!(merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES).is_err());
        assert!(!destination.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn existing_destination_symlink_is_never_followed_during_merge() {
        use std::os::unix::fs::symlink;
        let root = temp_root("zinnia-destination-symlink-test");
        let staged = root.join("staged");
        let destination = root.join("destination");
        let outside = root.join("outside");
        std::fs::create_dir_all(staged.join("nested")).expect("staged tree");
        std::fs::create_dir_all(&destination).expect("destination");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(staged.join("nested/new.txt"), b"unsafe").expect("staged file");
        symlink(&outside, destination.join("nested")).expect("destination symlink");

        merge_staged_extract(&staged, &destination, MAX_EXTRACTED_BYTES)
            .expect("symlink must be treated as a conflict");
        assert!(!outside.join("new.txt").exists());
        assert_eq!(
            std::fs::read(destination.join("nested_1/new.txt")).expect("renamed safe output"),
            b"unsafe"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn publish_rejects_symlink_swapped_ancestor_before_rename() {
        use std::os::unix::fs::symlink;
        let root = temp_root("zinnia-toctou-ancestor-test");
        let destination = root.join("destination");
        let outside = root.join("outside");
        let nested = destination.join("nested");
        std::fs::create_dir_all(&nested).expect("destination nested");
        std::fs::create_dir_all(&outside).expect("outside");
        let target = nested.join("new.txt");
        assert_safe_extract_target_ancestors(&destination, &target).expect("real ancestors ok");

        std::fs::remove_dir(&nested).expect("remove nested");
        symlink(&outside, &nested).expect("swap nested for symlink");
        let error = assert_safe_extract_target_ancestors(&destination, &target)
            .expect_err("symlink ancestor must fail");
        assert!(
            error.contains("real directory")
                || error.contains("symbolic link")
                || error.contains("reparse"),
            "unexpected error: {error}"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn persisted_move_plan_rolls_back_a_partial_merge() {
        let root = temp_root("zinnia-move-recovery-test");
        let staged = root.join("staged");
        let destination = root.join("destination");
        std::fs::create_dir_all(&staged).expect("staged tree");
        std::fs::create_dir_all(&destination).expect("destination tree");
        let source = staged.join("new.txt");
        let target = destination.join("new.txt");
        let plan = vec![MoveRecord {
            source: source.clone(),
            target: target.clone(),
        }];
        write_move_plan(&staged, &plan).expect("durable move plan");
        std::fs::write(&target, b"partially published").expect("partial target");

        rollback_persisted_move_plan(&staged, &destination).expect("rollback plan");

        assert_eq!(
            std::fs::read(&source).expect("restored source"),
            b"partially published"
        );
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn split_archive_family_is_promoted_as_one_set() {
        let root = temp_root("zinnia-volume-test");
        std::fs::create_dir_all(&root).expect("test root");
        let stage_dir = root.join("stage");
        std::fs::create_dir(&stage_dir).expect("stage dir");
        let staged = stage_dir.join("output.7z");
        let destination = root.join("output.7z");
        std::fs::write(stage_dir.join("output.7z.001"), b"new-1").expect("stage volume 1");
        std::fs::write(stage_dir.join("output.7z.002"), b"new-2").expect("stage volume 2");
        std::fs::write(root.join("output.7z.001"), b"old-1").expect("old volume 1");
        std::fs::write(root.join("output.7z.002"), b"old-2").expect("old volume 2");
        std::fs::write(root.join("output.7z.003"), b"stale-3").expect("stale volume");
        std::fs::write(root.join("output.7z.2024"), b"unrelated")
            .expect("unrelated numeric suffix");

        promote_archive_family(&staged, &destination).expect("promote volume set");
        assert_eq!(std::fs::read(root.join("output.7z.001")).unwrap(), b"new-1");
        assert_eq!(std::fs::read(root.join("output.7z.002")).unwrap(), b"new-2");
        assert!(!root.join("output.7z.003").exists());
        assert_eq!(
            std::fs::read(root.join("output.7z.2024")).unwrap(),
            b"unrelated"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn kill_error_detection_handles_known_messages() {
        assert!(is_non_running_kill_error("process already finished"));
        assert!(is_non_running_kill_error("child process is not running"));
        assert!(!is_non_running_kill_error("permission denied"));
    }

    #[test]
    fn staged_tree_usage_enforces_entry_and_byte_limits() {
        let root = temp_root("zinnia-quota-test");
        std::fs::create_dir_all(&root).expect("quota test root");
        std::fs::write(root.join("one.bin"), b"1234").expect("first quota file");
        std::fs::write(root.join("two.bin"), b"5678").expect("second quota file");

        assert!(staged_tree_usage(&root, 10, 100).is_ok());
        assert!(staged_tree_usage(&root, 1, 100).is_err());
        assert!(staged_tree_usage(&root, 10, 7).is_err());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extract_parent_snapshot_detects_sibling_escape() {
        let root = temp_root("zinnia-sibling-escape");
        std::fs::create_dir_all(&root).expect("root");
        let stage = root.join(".out.zinnia-extract-abc");
        std::fs::create_dir_all(&stage).expect("stage");
        let expected = directory_entry_names(&root).expect("snapshot");
        std::fs::write(root.join("escaped.txt"), b"leak").expect("escape");
        let err = assert_extract_parent_unchanged(&stage, &expected).expect_err("leak");
        assert!(err.contains("outside the staging directory"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn archive_journal_committed_when_promote_finished_and_stage_empty() {
        let root = temp_root("zinnia-journal-committed");
        let stage = root.join(".zinnia-archive-abc");
        let destination = root.join("out.7z");
        std::fs::create_dir_all(&stage).expect("stage");
        std::fs::write(&destination, b"published").expect("dest");
        let journal = CleanupJournal {
            stage: stage.clone(),
            destination: destination.clone(),
            archive: true,
            previous_archive_family: Vec::new(),
            next_archive_family: vec![destination.clone()],
        };
        assert!(archive_journal_is_committed(&journal));
        assert_eq!(std::fs::read(&destination).unwrap(), b"published");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn archive_journal_not_committed_while_staged_outputs_remain() {
        let root = temp_root("zinnia-journal-incomplete");
        let stage = root.join(".zinnia-archive-abc");
        let destination = root.join("out.7z");
        std::fs::create_dir_all(&stage).expect("stage");
        std::fs::write(stage.join("out.7z"), b"staged").expect("staged output");
        std::fs::write(&destination, b"partial").expect("partial dest");
        let journal = CleanupJournal {
            stage: stage.clone(),
            destination: destination.clone(),
            archive: true,
            previous_archive_family: Vec::new(),
            next_archive_family: vec![destination.clone()],
        };
        assert!(!archive_journal_is_committed(&journal));
        rollback_archive_journal(&journal).expect("rollback partial new archive");
        assert!(!destination.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn archive_journal_rollback_restores_backups_for_update() {
        let root = temp_root("zinnia-journal-update");
        let stage = root.join(".zinnia-archive-abc");
        let destination = root.join("out.7z");
        std::fs::create_dir_all(&stage).expect("stage");
        std::fs::write(stage.join("backup-0"), b"old").expect("backup");
        std::fs::write(&destination, b"new-partial").expect("partial new");
        let journal = CleanupJournal {
            stage: stage.clone(),
            destination: destination.clone(),
            archive: true,
            previous_archive_family: vec![destination.clone()],
            next_archive_family: vec![destination.clone()],
        };
        assert!(!archive_journal_is_committed(&journal));
        rollback_archive_journal(&journal).expect("rollback update");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parse_7z_version_reads_common_banners() {
        assert_eq!(
            parse_7z_version("7-Zip 26.02 (x64)\n"),
            Some("26.02".to_string())
        );
        assert_eq!(
            parse_7z_version("7-Zip (z) 24.09 (arm64)\n"),
            Some("24.09".to_string())
        );
        assert_eq!(parse_7z_version("not a banner"), None);
    }

    #[test]
    fn version_cmp_orders_numeric_segments() {
        assert_eq!(
            version_cmp("26.03", "26.02"),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            version_cmp("26.02", "26.02"),
            Some(std::cmp::Ordering::Equal)
        );
        assert_eq!(
            version_cmp("25.01", "26.02"),
            Some(std::cmp::Ordering::Less)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_rar_extract_blocked_through_attested_26_02() {
        store_probed_7z_version(Some("26.02".to_string()));
        assert!(windows_rar_extract_blocked());
        store_probed_7z_version(Some("26.03".to_string()));
        assert!(!windows_rar_extract_blocked());
        store_probed_7z_version(None);
        assert!(windows_rar_extract_blocked());
    }
}
