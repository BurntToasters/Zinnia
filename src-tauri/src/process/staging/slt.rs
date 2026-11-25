//! 7-Zip SLT member listing and path-safety preflight.

use crate::output::MAX_OUTPUT_BYTES;
use crate::output::{append_limited_output, sanitize_output, Utf8StreamDecoder, WarningScan};
use crate::validation::archive_member_path_is_unsafe;

use crate::process::archive_snapshot::{archive_file_identity, ArchiveFileIdentity};
use crate::process::commands::{
    collect_command_output, extract_warning_is_metadata_only, terminate_registered_child_async,
    CollectedOutput,
};
use crate::process::{lock_process, ArchiveManifestSummary, RunningProcess};
use tauri_plugin_shell::process::CommandEvent;

/// Stdout/stderr cap for backend-owned preflight listings and tests. At about
/// 325 bytes per ZIP `-slt` record this covers roughly 800,000 entries.
pub(crate) const PREFLIGHT_LIST_OUTPUT_LIMIT: usize = 256 * 1024 * 1024;

const LISTING_LINE_LIMIT_BYTES: usize = 256 * 1024;
const LISTING_TEXT_BYTES_PER_ENTRY: u64 = 4 * 1024;

pub(crate) const LISTING_LINE_LIMIT_MESSAGE: &str =
    "This archive has a listing record longer than Zinnia can check safely. Nothing was extracted.";

pub(crate) const MEMBER_LIST_LIMIT_MESSAGE: &str = "This archive lists more entries or listing text than Zinnia can check safely (more than 1,000,000 entries or about 4 GB of listing text). Nothing was extracted.";

#[derive(Clone)]
pub(crate) struct ListingLimits {
    max_entries: u64,
    max_path_bytes: u64,
    max_line_bytes: usize,
    max_total_bytes: u64,
}

impl Default for ListingLimits {
    fn default() -> Self {
        Self {
            max_entries: crate::process::quota::MAX_EXTRACT_ENTRIES,
            max_path_bytes: crate::process::quota::MAX_EXTRACT_PATH_BYTES,
            max_line_bytes: LISTING_LINE_LIMIT_BYTES,
            max_total_bytes: crate::process::quota::MAX_EXTRACT_ENTRIES
                * LISTING_TEXT_BYTES_PER_ENTRY
                + crate::process::quota::MAX_EXTRACT_PATH_BYTES,
        }
    }
}

const PREFLIGHT_BASE_TIMEOUT_SECS: u64 = 120;
const PREFLIGHT_BYTES_PER_EXTRA_SECOND: u64 = 16 * 1024 * 1024;

/// 120 seconds plus one second per 16 MiB of archive bytes, rounded up.
pub(crate) fn preflight_timeout_for_archive_bytes(bytes: u64) -> std::time::Duration {
    let extra_secs = bytes.div_ceil(PREFLIGHT_BYTES_PER_EXTRA_SECOND);
    std::time::Duration::from_secs(PREFLIGHT_BASE_TIMEOUT_SECS.saturating_add(extra_secs))
}

pub(crate) fn preflight_timeout_for_archive(archive: &std::path::Path) -> std::time::Duration {
    preflight_timeout_for_archive_bytes(
        crate::process::archive_snapshot::archive_input_family_bytes(archive),
    )
}

pub(crate) fn preflight_timeout_error(label: &str, timeout: std::time::Duration) -> String {
    format!(
        "{label} timed out after {} seconds. Copy the archive to a faster disk and try again.",
        timeout.as_secs()
    )
}

/// 7-Zip exclusions for extract only. Finder-made ZIPs carry `__MACOSX/._x`
/// AppleDouble members, which on FAT/exFAT would rewrite the metadata of a
/// co-extracted `x`; `.DS_Store` is never wanted in the output.
pub(crate) const EXTRACT_FINDER_METADATA_EXCLUSIONS: [&str; 3] =
    ["-xr!__MACOSX", "-xr!._*", "-xr!.DS_Store"];

/// True for a member that extract skips: a `__MACOSX` path component, a
/// basename starting with `._`, or a `.DS_Store` basename.
pub(crate) fn extract_member_is_finder_metadata(path: &str) -> bool {
    let mut has_macosx = false;
    let mut basename = "";
    for component in path.split(['/', '\\']).filter(|part| !part.is_empty()) {
        has_macosx |= component.eq_ignore_ascii_case("__MACOSX");
        basename = component;
    }
    has_macosx || basename.starts_with("._") || basename.eq_ignore_ascii_case(".DS_Store")
}

/// Build `7z l -slt -ba` args from an extract command, copying switches that
/// affect whether/how the archive can be opened.
pub(crate) fn extract_member_list_args(args: &[String]) -> Result<Vec<String>, String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "Extraction command is missing '--'.".to_string())?;
    let archive = args
        .get(separator + 1)
        .ok_or_else(|| "Extraction command is missing an archive path.".to_string())?;
    let mut list_args = vec!["l".to_string(), "-slt".to_string(), "-ba".to_string()];
    for arg in &args[1..separator] {
        let lower = arg.to_ascii_lowercase();
        if lower.starts_with("-p") || lower.starts_with("-t") {
            list_args.push(arg.clone());
        }
    }
    list_args.push("--".to_string());
    list_args.push(archive.clone());
    crate::process::commands::harden_7z_args(&mut list_args);
    Ok(list_args)
}

/// Inspect `7z l -slt` output and reject members that could escape `-o`.
///
/// Checks `Path =` member names and real 7-Zip `Symbolic Link =` / `Hard Link =`
/// target fields. Link targets are resolved lexically so safe contained links
/// such as `bin/tool -> ../lib/tool` remain supported.
fn link_target_is_absolute(target: &str) -> bool {
    let bytes = target.as_bytes();
    bytes
        .first()
        .is_some_and(|byte| matches!(byte, b'/' | b'\\'))
        || (bytes.len() >= 2 && bytes[1] == b':')
}

fn symbolic_link_target_is_unsafe(member_path: &str, target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    if link_target_is_absolute(target) {
        return true;
    }

    let mut resolved: Vec<&str> = member_path
        .split(['/', '\\'])
        .filter(|component| !component.is_empty() && *component != ".")
        .collect();
    // Symlink targets are relative to the directory containing the link.
    resolved.pop();
    for component in target.split(['/', '\\']) {
        match component {
            "" | "." => {}
            ".." => {
                if resolved.pop().is_none() {
                    return true;
                }
            }
            other => resolved.push(other),
        }
    }
    false
}

fn hard_link_target_is_unsafe(target: &str) -> bool {
    link_target_is_absolute(target) || archive_member_path_is_unsafe(target)
}

pub(crate) fn listing_preflight_exit_is_acceptable(code: i32, stdout: &str, stderr: &str) -> bool {
    code == 0 || (code == 1 && extract_warning_is_metadata_only(stdout, stderr))
}

/// True for a 10-character `ls`-style mode string whose type is a symlink,
/// as 7-Zip prints for archive members that carry Unix attributes.
fn unix_mode_is_symlink(mode: &str) -> bool {
    let bytes = mode.as_bytes();
    bytes.len() == 10
        && bytes[0] == b'l'
        && bytes[1..]
            .iter()
            .all(|byte| matches!(byte, b'r' | b'w' | b'x' | b'-' | b's' | b'S' | b't' | b'T'))
}

#[derive(Default)]
struct PathlessRecord {
    runs: u64,
    in_run: bool,
    invalid: bool,
    size: Option<String>,
    has_content: bool,
}

/// Which bound a declared-size limit enforces, so the refusal names its real cause.
#[derive(Clone, Copy)]
pub(crate) enum DeclaredSizeCause {
    /// Destination free space minus the reserve is the binding bound.
    FreeSpace { free_bytes: Option<u64> },
    /// The compression-ratio cap is the binding bound for this archive size.
    Ratio { archive_bytes: u64 },
}

#[derive(Clone, Copy)]
pub(crate) struct DeclaredSizeLimit {
    pub(crate) max_bytes: u64,
    pub(crate) cause: DeclaredSizeCause,
}

fn declared_size_error(limit: DeclaredSizeLimit, declared_bytes: u64) -> String {
    let needed_gib = declared_bytes as f64 / 1_073_741_824.0;
    match limit.cause {
        DeclaredSizeCause::FreeSpace {
            free_bytes: Some(free_bytes),
        } => format!(
            "Not enough free space: this archive needs about {needed_gib:.1} GiB but only {:.1} GiB is available on the destination volume.",
            free_bytes as f64 / 1_073_741_824.0
        ),
        DeclaredSizeCause::FreeSpace { free_bytes: None } => format!(
            "Not enough free space: this archive needs about {needed_gib:.1} GiB, and the free space on the destination volume could not be read."
        ),
        DeclaredSizeCause::Ratio { archive_bytes } => format!(
            "Archive declares {needed_gib:.1} GiB of extracted data from a {:.1} MiB file, which exceeds the safety ratio for compressed archives.",
            archive_bytes as f64 / 1_048_576.0
        ),
    }
}

/// Classifies the extract budget for a listed archive: the ratio cap when it
/// is the smaller bound, otherwise destination free space.
fn declared_size_limit(
    archive_path: &std::path::Path,
    args: &[String],
    max_bytes: u64,
) -> DeclaredSizeLimit {
    let archive_bytes = crate::process::archive_snapshot::archive_input_family_bytes(archive_path);
    let cause = if max_bytes >= super::extract_ratio_limit(archive_bytes) {
        DeclaredSizeCause::Ratio { archive_bytes }
    } else {
        let free_bytes = super::operation_output_path(args).and_then(|destination| {
            crate::process::quota::free_space_for_path(&destination)
                .ok()
                .flatten()
        });
        DeclaredSizeCause::FreeSpace { free_bytes }
    };
    DeclaredSizeLimit { max_bytes, cause }
}

pub(crate) struct SltManifestParser {
    archive_path: String,
    declared_limit: Option<DeclaredSizeLimit>,
    limits: ListingLimits,
    line: Vec<u8>,
    line_overflowed: bool,
    total_bytes: u64,
    error: Option<String>,
    seen_member: bool,
    summary: ArchiveManifestSummary,
    current_member: Option<String>,
    current_member_excluded: bool,
    pathless: PathlessRecord,
    warnings: WarningScan,
}

impl SltManifestParser {
    pub(crate) fn new(archive_path: &str, declared_limit: Option<DeclaredSizeLimit>) -> Self {
        Self::with_limits(archive_path, declared_limit, ListingLimits::default())
    }

    fn with_limits(
        archive_path: &str,
        declared_limit: Option<DeclaredSizeLimit>,
        limits: ListingLimits,
    ) -> Self {
        Self {
            archive_path: archive_path.to_string(),
            declared_limit,
            limits,
            line: Vec::new(),
            line_overflowed: false,
            total_bytes: 0,
            error: None,
            seen_member: false,
            summary: ArchiveManifestSummary::default(),
            current_member: None,
            current_member_excluded: false,
            pathless: PathlessRecord::default(),
            warnings: WarningScan::default(),
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let mut rest = chunk;
        while let Some(index) = rest.iter().position(|&byte| byte == b'\n') {
            self.total_bytes = self.total_bytes.saturating_add(index as u64 + 1);
            self.append_line_part(&rest[..index]);
            self.end_line(true);
            rest = &rest[index + 1..];
        }
        self.total_bytes = self.total_bytes.saturating_add(rest.len() as u64);
        self.append_line_part(rest);
    }

    pub(crate) fn close(&mut self) {
        if !self.line.is_empty() || self.line_overflowed {
            self.end_line(false);
        }
    }

    pub(crate) fn warnings(&self) -> &WarningScan {
        &self.warnings
    }

    pub(crate) fn finish(mut self) -> Result<ArchiveManifestSummary, String> {
        self.close();
        if let Some(error) = self.error {
            return Err(error);
        }
        // Empty archives legitimately produce no records. Non-empty output with no
        // Path records means the machine-readable schema was not understood; fail
        // closed instead of silently bypassing the safety check.
        if !self.seen_member && self.pathless.has_content {
            return self.finish_pathless();
        }
        Ok(self.summary)
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> usize {
        self.line.capacity()
            + self.current_member.as_ref().map_or(0, String::capacity)
            + self.pathless.size.as_ref().map_or(0, String::capacity)
    }

    fn append_line_part(&mut self, part: &[u8]) {
        if self.line_overflowed || part.is_empty() {
            return;
        }
        if self.line.len() + part.len() > self.limits.max_line_bytes {
            self.line_overflowed = true;
            self.line.clear();
            return;
        }
        self.line.extend_from_slice(part);
    }

    fn end_line(&mut self, terminated: bool) {
        self.check_total_bytes();
        if std::mem::take(&mut self.line_overflowed) {
            self.line.clear();
            self.warnings.mark_unscannable();
            self.set_error(LISTING_LINE_LIMIT_MESSAGE.to_string());
            return;
        }
        let mut bytes = std::mem::take(&mut self.line);
        if terminated && bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        let text = String::from_utf8_lossy(&bytes);
        self.handle_line(&text);
        bytes.clear();
        self.line = bytes;
    }

    fn check_total_bytes(&mut self) {
        if self.total_bytes > self.limits.max_total_bytes {
            self.set_error(MEMBER_LIST_LIMIT_MESSAGE.to_string());
        }
    }

    fn set_error(&mut self, message: String) {
        if self.error.is_none() {
            self.error = Some(message);
        }
    }

    fn handle_line(&mut self, line: &str) {
        self.warnings.push_line(line);
        if self.error.is_some() {
            return;
        }
        self.track_pathless(line);
        if let Err(error) = self.apply_manifest_line(line) {
            self.set_error(error);
        }
    }

    fn track_pathless(&mut self, line: &str) {
        if !line.trim().is_empty() {
            self.pathless.has_content = true;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            self.pathless.in_run = false;
            return;
        }
        // Group by blank lines; `lines()` and `trim_end` also cover CRLF output.
        if !self.pathless.in_run {
            self.pathless.runs += 1;
            self.pathless.in_run = true;
        }
        match trimmed.split_once(" =") {
            Some((key, value))
                if !key.is_empty()
                    && key.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ') =>
            {
                match key {
                    "Path" | "Symbolic Link" | "Hard Link" => self.pathless.invalid = true,
                    "Size" => self.pathless.size = Some(value.trim().to_string()),
                    _ => {}
                }
            }
            _ => self.pathless.invalid = true,
        }
    }

    fn apply_manifest_line(&mut self, line: &str) -> Result<(), String> {
        if let Some(path) = line.strip_prefix("Path = ") {
            if path.is_empty() {
                return Ok(());
            }
            // `-ba` suppresses the archive-container record, so every Path entry is
            // normally a member. Keep exact full-path container tolerance for older
            // sidecars without `-ba`. Never skip a member that only matches the
            // archive basename; that name is a legal archive member.
            if path == self.archive_path {
                self.current_member = None;
                return Ok(());
            }
            self.seen_member = true;
            // Excluded metadata members are never extracted, so they neither
            // consume the entry/path budgets nor contribute declared bytes.
            // Their path is still checked: a listing must stay fail-closed.
            self.current_member_excluded = extract_member_is_finder_metadata(path);
            if !self.current_member_excluded {
                self.summary.entry_count = self.summary.entry_count.saturating_add(1);
                if self.summary.entry_count > self.limits.max_entries {
                    return Err(format!(
                        "Archive exceeds the safety limit of {} entries.",
                        self.limits.max_entries
                    ));
                }
                self.summary.path_bytes = self
                    .summary
                    .path_bytes
                    .checked_add(path.len() as u64)
                    .ok_or_else(|| "Archive path-name safety counter overflowed.".to_string())?;
                if self.summary.path_bytes > self.limits.max_path_bytes {
                    return Err(format!(
                        "Archive exceeds the {} MiB aggregate path-name safety limit.",
                        self.limits.max_path_bytes / (1024 * 1024)
                    ));
                }
            }
            self.current_member = Some(path.to_string());
            if archive_member_path_is_unsafe(path) {
                return Err(format!(
                    "Archive contains an unsafe member path that could escape the extract folder: {path}"
                ));
            }
            return Ok(());
        }
        // ZIP keeps a symlink's target in the member data, so the listing has no
        // `Symbolic Link =` line, only a Unix `l` mode as the last `Attributes`
        // token. Flag it so extraction keeps link-bearing staging and scans;
        // `-snld10` and staged-tree validation still judge the target.
        if let Some(attributes) = line.strip_prefix("Attributes = ") {
            if attributes
                .split_whitespace()
                .next_back()
                .is_some_and(unix_mode_is_symlink)
            {
                self.summary.has_symbolic_links = true;
            }
            return Ok(());
        }
        if let Some(target) = line.strip_prefix("Symbolic Link = ") {
            self.summary.has_symbolic_links = true;
            if target.is_empty() {
                return Ok(());
            }
            let member = self.current_member.as_deref().ok_or_else(|| {
                "Could not associate an archive symbolic-link target with a member path."
                    .to_string()
            })?;
            if symbolic_link_target_is_unsafe(member, target) {
                return Err(format!(
                    "Archive contains an unsafe link target that could escape the extract folder: {target}"
                ));
            }
            return Ok(());
        }
        if let Some(target) = line.strip_prefix("Hard Link = ") {
            self.summary.has_hard_links = true;
            if target.is_empty() {
                return Ok(());
            }
            if self.current_member.is_none() {
                return Err(
                    "Could not associate an archive hard-link target with a member path."
                        .to_string(),
                );
            }
            if hard_link_target_is_unsafe(target) {
                return Err(format!(
                    "Archive contains an unsafe link target that could escape the extract folder: {target}"
                ));
            }
            return Ok(());
        }
        if self.current_member.is_some() && !self.current_member_excluded {
            if let Some(size) = line.strip_prefix("Size = ") {
                let size = size.parse::<u64>().map_err(|_| {
                    "Archive listing contains an invalid declared member size.".to_string()
                })?;
                self.summary.declared_bytes = self
                    .summary
                    .declared_bytes
                    .checked_add(size)
                    .ok_or_else(|| {
                        "Archive declared size overflowed its safety counter.".to_string()
                    })?;
                if let Some(limit) = self.declared_limit {
                    if self.summary.declared_bytes > limit.max_bytes {
                        return Err(declared_size_error(limit, self.summary.declared_bytes));
                    }
                }
            }
        }
        Ok(())
    }

    /// bzip2, xz and similar single-stream formats store no member name, so
    /// `-ba -slt` prints one record without `Path =`. 7-Zip derives the output
    /// name from the archive file name, which cannot escape the destination.
    /// Accept exactly one such key/value record with a `Size` field; anything
    /// else still fails closed.
    fn finish_pathless(&self) -> Result<ArchiveManifestSummary, String> {
        let unparsed = || "Could not parse archive member paths from 7-Zip listing.".to_string();
        if self.pathless.runs != 1 || self.pathless.invalid {
            return Err(unparsed());
        }
        let size = self.pathless.size.as_deref().ok_or_else(unparsed)?;
        let mut summary = ArchiveManifestSummary {
            entry_count: 1,
            declared_size_untrusted: true,
            ..ArchiveManifestSummary::default()
        };
        // The derived output name is at most the archive's own file name.
        summary.path_bytes = std::path::Path::new(&self.archive_path)
            .file_name()
            .map_or(0, |name| name.len() as u64);
        if !size.is_empty() {
            summary.declared_bytes = size.parse::<u64>().map_err(|_| {
                "Archive listing contains an invalid declared member size.".to_string()
            })?;
            if let Some(limit) = self.declared_limit {
                if summary.declared_bytes > limit.max_bytes {
                    return Err(declared_size_error(limit, summary.declared_bytes));
                }
            }
        }
        Ok(summary)
    }
}

#[cfg(test)]
fn parse_slt_archive_manifest(
    slt_output: &str,
    archive_path: &str,
    max_bytes: Option<u64>,
) -> Result<ArchiveManifestSummary, String> {
    let declared_limit = max_bytes.map(|max_bytes| DeclaredSizeLimit {
        max_bytes,
        cause: DeclaredSizeCause::FreeSpace { free_bytes: None },
    });
    let mut parser = SltManifestParser::new(archive_path, declared_limit);
    parser.push(slt_output.as_bytes());
    parser.finish()
}

pub(crate) fn listing_exit_is_acceptable_scanned(
    code: i32,
    warnings: &WarningScan,
    stderr: &str,
) -> bool {
    code == 0 || (code == 1 && warnings.metadata_only(stderr))
}

fn listing_exit_rejection(output: &PreflightOutput, warnings: &WarningScan) -> Option<String> {
    if listing_exit_is_acceptable_scanned(output.code, warnings, &output.stderr) {
        return None;
    }
    let detail = preflight_failure_detail(output);
    let code = output.code;
    Some(if detail.is_empty() {
        format!("Could not list archive members for path safety (exit {code}).")
    } else {
        format!("Could not list archive members for path safety: {detail}")
    })
}

async fn collect_listing_events(
    rx: &mut tauri::async_runtime::Receiver<CommandEvent>,
    parser: &mut SltManifestParser,
) -> CollectedOutput {
    let mut out = CollectedOutput {
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        exit: None,
        stream_error: None,
    };
    let mut stdout_head_truncated = false;
    let mut stdout_decoder = Utf8StreamDecoder::default();
    let mut stderr_decoder = Utf8StreamDecoder::default();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                parser.push(&bytes);
                let head = stdout_decoder.push(&bytes);
                append_limited_output(
                    &mut out.stdout,
                    &head,
                    MAX_OUTPUT_BYTES,
                    &mut stdout_head_truncated,
                );
            }
            CommandEvent::Stderr(bytes) => {
                let text = stderr_decoder.push(&bytes);
                append_limited_output(
                    &mut out.stderr,
                    &text,
                    MAX_OUTPUT_BYTES,
                    &mut out.stderr_truncated,
                );
            }
            CommandEvent::Terminated(payload) => {
                let stdout_tail = stdout_decoder.finish();
                append_limited_output(
                    &mut out.stdout,
                    &stdout_tail,
                    MAX_OUTPUT_BYTES,
                    &mut stdout_head_truncated,
                );
                let stderr_tail = stderr_decoder.finish();
                append_limited_output(
                    &mut out.stderr,
                    &stderr_tail,
                    MAX_OUTPUT_BYTES,
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
                    MAX_OUTPUT_BYTES,
                    &mut out.stderr_truncated,
                );
                if out.stream_error.is_none() {
                    out.stream_error = Some(error);
                }
            }
            _ => {}
        }
    }
    parser.close();
    out
}

#[cfg(test)]
pub(crate) fn assert_slt_archive_members_safe(
    slt_output: &str,
    archive_path: &str,
) -> Result<(), String> {
    parse_slt_archive_manifest(slt_output, archive_path, None).map(|_| ())
}

#[cfg(test)]
pub(crate) fn slt_manifest_has_links(slt_output: &str, archive_path: &str) -> Result<bool, String> {
    parse_slt_archive_manifest(slt_output, archive_path, None).map(|summary| summary.has_links())
}

#[cfg(test)]
pub(crate) fn assert_slt_declared_size_within_limit(
    slt_output: &str,
    archive_path: &str,
    max_bytes: u64,
) -> Result<(), String> {
    parse_slt_archive_manifest(slt_output, archive_path, Some(max_bytes)).map(|_| ())
}

/// Output of a backend-owned preflight 7-Zip child (listing or test).
#[derive(Debug)]
pub(crate) struct PreflightOutput {
    pub(crate) code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Convert a collected child result only when both pipe streams and process
/// termination are complete. Listing callers still classify accepted exit-1
/// metadata warnings after this boundary.
#[cfg(test)]
pub(crate) fn checked_preflight_output(
    collected: CollectedOutput,
    label: &str,
) -> Result<PreflightOutput, String> {
    checked_preflight_output_with_limit(collected, label, None)
}

/// As `checked_preflight_output`, with a caller-specific message for truncation.
pub(crate) fn checked_preflight_output_with_limit(
    collected: CollectedOutput,
    label: &str,
    limit_message: Option<&str>,
) -> Result<PreflightOutput, String> {
    if collected.stdout_truncated || collected.stderr_truncated {
        return Err(match limit_message {
            Some(message) => message.to_string(),
            None => format!("{label} exceeded its output limit; the operation was cancelled."),
        });
    }
    if !collected.output_is_complete() {
        if let Some(error) = collected.stream_error.as_deref() {
            return Err(format!(
                "{label} could not read the complete output stream: {}",
                sanitize_output(error)
            ));
        }
        if collected.exit.is_none() {
            return Err(format!("{label} ended without a termination event."));
        }
        return Err(format!("{label} produced incomplete output."));
    }
    let code = collected.exit_code();
    if code < 0
        || collected
            .exit
            .as_ref()
            .is_some_and(|termination| termination.signal.is_some())
    {
        return Err(format!("{label} did not produce a valid exit status."));
    }
    Ok(PreflightOutput {
        code,
        stdout: collected.stdout,
        stderr: collected.stderr,
    })
}

/// Run a short backend-owned 7-Zip child under the current operation slot.
/// The child is registered before password transport so Cancel can stop it,
/// and the slot's child is cleared again before returning.
async fn collect_registered_preflight(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: Vec<String>,
    timeout: std::time::Duration,
    label: &str,
    #[cfg_attr(not(feature = "e2e"), allow(unused_variables))] pause_point: &str,
    listing: Option<&mut SltManifestParser>,
) -> Result<CollectedOutput, String> {
    let (mut rx, child, pending_password) =
        crate::process::commands::spawn_7z_noninteractive(app, args, state)?;
    #[cfg(feature = "e2e")]
    crate::process::e2e_crash::pause_point(pause_point).await;
    {
        // Check cancelling and register the child under one lock so cancel_7z
        // cannot run between the two and miss the child.
        let cancelling = {
            let mut process = lock_process(state)?;
            if !process.cancelling {
                // Register before password stdin so cancel can kill a blocked write.
                process.child = Some(child.clone());
            }
            process.cancelling
        };
        if cancelling {
            terminate_registered_child_async(app, &child).await?;
            return Err("Operation cancelled.".to_string());
        }
    }
    if let Some(pending_password) = pending_password {
        if let Err(error) =
            crate::process::commands::complete_password_transport(&child, pending_password).await
        {
            let cancelled = lock_process(state)
                .map(|process| process.cancelling)
                .unwrap_or(false);
            terminate_registered_child_async(app, &child).await?;
            return Err(if cancelled {
                "Operation cancelled.".to_string()
            } else {
                error
            });
        }
        if lock_process(state)?.cancelling {
            terminate_registered_child_async(app, &child).await?;
            return Err("Operation cancelled.".to_string());
        }
    }
    let collected = match tokio::time::timeout(timeout, async {
        match listing {
            Some(parser) => collect_listing_events(&mut rx, parser).await,
            None => collect_command_output(&mut rx, PREFLIGHT_LIST_OUTPUT_LIMIT, |_| {}).await,
        }
    })
    .await
    {
        Ok(collected) => collected,
        Err(_) => {
            terminate_registered_child_async(app, &child).await?;
            return Err(preflight_timeout_error(label, timeout));
        }
    };
    if collected.stream_error.is_some() || collected.exit.is_none() {
        terminate_registered_child_async(app, &child).await?;
    }
    {
        let mut process = lock_process(state)?;
        process.child = None;
        if process.cancelling {
            return Err("Operation cancelled.".to_string());
        }
    }
    Ok(collected)
}

pub(crate) async fn run_registered_preflight_7z(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: Vec<String>,
    timeout: std::time::Duration,
    label: &str,
    #[cfg_attr(not(feature = "e2e"), allow(unused_variables))] pause_point: &str,
) -> Result<PreflightOutput, String> {
    let collected =
        collect_registered_preflight(app, state, args, timeout, label, pause_point, None).await?;
    checked_preflight_output_with_limit(collected, label, None)
}

/// Sanitized 7-Zip failure detail (stderr first, then stdout).
pub(crate) fn preflight_failure_detail(output: &PreflightOutput) -> String {
    let detail = sanitize_output(output.stderr.trim());
    if detail.is_empty() {
        sanitize_output(output.stdout.trim())
    } else {
        detail
    }
}

pub(crate) async fn assert_extract_archive_members_safe_with_summary(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: &[String],
    max_declared_bytes: Option<u64>,
) -> Result<
    (
        std::path::PathBuf,
        ArchiveFileIdentity,
        ArchiveManifestSummary,
    ),
    String,
> {
    let list_args = extract_member_list_args(args)?;
    let archive = list_args
        .last()
        .cloned()
        .ok_or_else(|| "Extraction member list is missing an archive path.".to_string())?;
    let archive_path = std::path::PathBuf::from(&archive);
    let identity =
        crate::process::archive_snapshot::archive_identity_from_snapshot_handle(&archive_path)
            .or_else(|| archive_file_identity(&archive_path).ok())
            .ok_or_else(|| "Could not read archive identity for member preflight.".to_string())?;
    let label = "Archive member-safety preflight";
    let declared_limit =
        max_declared_bytes.map(|max_bytes| declared_size_limit(&archive_path, args, max_bytes));
    let mut listing = SltManifestParser::new(&archive, declared_limit);
    let collected = collect_registered_preflight(
        app,
        state,
        list_args,
        preflight_timeout_for_archive(&archive_path),
        label,
        "member-preflight-spawned",
        Some(&mut listing),
    )
    .await?;
    let output = checked_preflight_output_with_limit(collected, label, None)?;
    if let Some(error) = listing_exit_rejection(&output, listing.warnings()) {
        return Err(error);
    }
    let mut manifest = listing.finish()?;
    let lower = archive.to_ascii_lowercase();
    if [".gz", ".bz2", ".xz", ".tgz", ".tbz2", ".txz"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        manifest.declared_size_untrusted = true;
    }
    Ok((archive_path, identity, manifest))
}

pub(crate) const UPDATE_PASSWORD_REQUIRED: &str =
    "A password is required to add files to this encrypted archive. Files were not added.";
pub(crate) const UPDATE_WRONG_PASSWORD: &str =
    "Wrong password for this encrypted archive. Files were not added.";
pub(crate) const ZIPCRYPTO_UPDATE_REFUSED: &str =
    "This ZIP still has ZipCrypto members. Convert it to a new AES-256 ZIP instead of adding files in place.";

/// Encryption facts about the members of an existing archive.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct UpdateEncryptionFacts {
    pub(crate) has_encrypted_members: bool,
    pub(crate) has_zipcrypto_members: bool,
    /// Smallest encrypted regular file, used to verify a supplied password
    /// without decrypting the whole archive.
    pub(crate) smallest_encrypted_file: Option<String>,
    /// True when another member has the same displayed name, so this selector
    /// may resolve to a different record after 7-Zip normalizes the name.
    pub(crate) smallest_encrypted_file_ambiguous: bool,
}

/// Read per-member `Encrypted`, `Method`, `Folder`, and `Size` from
/// `7z l -slt -ba` output. 7-Zip reports ZIP encryption methods only on
/// member records, never on the archive record.
pub(crate) fn parse_update_encryption_facts(slt_output: &str) -> UpdateEncryptionFacts {
    #[derive(Default)]
    struct Member<'a> {
        path: Option<&'a str>,
        encrypted: bool,
        folder: bool,
        size: Option<u64>,
    }
    let mut facts = UpdateEncryptionFacts::default();
    let mut smallest: Option<(u64, String)> = None;
    let mut displayed_name_counts = std::collections::HashMap::<String, usize>::new();
    let mut flush = |member: &Member<'_>, facts: &mut UpdateEncryptionFacts| {
        if let Some(path) = member.path {
            *displayed_name_counts.entry(path.to_string()).or_default() += 1;
        }
        if !member.encrypted {
            return;
        }
        facts.has_encrypted_members = true;
        let (Some(path), false) = (member.path, member.folder) else {
            return;
        };
        let size = member.size.unwrap_or(u64::MAX);
        if smallest.as_ref().is_none_or(|(best, _)| size < *best) {
            smallest = Some((size, path.to_string()));
        }
    };
    let mut current = Member::default();
    for line in slt_output.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(path) = line.strip_prefix("Path = ") {
            flush(&current, &mut facts);
            current = Member {
                path: Some(path),
                ..Member::default()
            };
        } else if let Some(value) = line.strip_prefix("Encrypted = ") {
            current.encrypted |= value.trim() == "+";
        } else if let Some(value) = line.strip_prefix("Folder = ") {
            current.folder = value.trim() == "+";
        } else if let Some(value) = line.strip_prefix("Size = ") {
            current.size = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("Method = ") {
            let lower = value.to_ascii_lowercase();
            if lower.contains("zipcrypto") {
                facts.has_zipcrypto_members = true;
                current.encrypted = true;
            }
            if lower.contains("aes") {
                current.encrypted = true;
            }
        }
    }
    flush(&current, &mut facts);
    if let Some((_, path)) = smallest {
        facts.smallest_encrypted_file_ambiguous =
            displayed_name_counts.get(&path).copied().unwrap_or(0) > 1;
        facts.smallest_encrypted_file = Some(path);
    }
    facts
}

fn preflight_test_reports_no_files(output: &PreflightOutput) -> bool {
    output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .any(|line| line.trim().to_ascii_lowercase().starts_with("no files"))
}

fn preflight_test_reports_processed_file(output: &PreflightOutput) -> bool {
    let no_files_reported = preflight_test_reports_no_files(output);
    if no_files_reported {
        return false;
    }
    let files_count = output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .map(|line| line.trim().to_ascii_lowercase())
        .find_map(|line| {
            line.strip_prefix("files:")
                .and_then(|count| count.trim().parse::<u64>().ok())
        });
    if let Some(files_count) = files_count {
        return files_count > 0;
    }
    output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .map(|line| line.trim().to_ascii_lowercase())
        .any(|line| {
            line.strip_prefix("size:")
                .is_some_and(|size| size.trim().parse::<u64>().is_ok())
        })
}

pub(crate) fn member_password_test_needs_full_archive_check(
    facts: &UpdateEncryptionFacts,
    member_test: &PreflightOutput,
) -> bool {
    if facts.smallest_encrypted_file_ambiguous {
        return true;
    }
    if preflight_test_reports_no_files(member_test) {
        return true;
    }
    member_test.code == 0 && !preflight_test_reports_processed_file(member_test)
}

async fn run_update_password_check(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    archive: &str,
    password: &str,
    types: &[String],
    member: Option<&str>,
) -> Result<PreflightOutput, String> {
    let mut test_args = vec!["t".to_string(), password.to_string()];
    if member.is_some() {
        // 7-Zip's default case matching varies by platform. Keep a lossy
        // displayed name from selecting a differently cased plaintext alias.
        test_args.push("-ssc".to_string());
    }
    test_args.extend(types.iter().cloned());
    test_args.push("--".to_string());
    test_args.push(archive.to_string());
    if let Some(member) = member {
        test_args.push(member.to_string());
    }
    crate::process::commands::harden_7z_args(&mut test_args);
    run_registered_preflight_7z(
        app,
        state,
        test_args,
        preflight_timeout_for_archive(std::path::Path::new(archive)),
        "Archive password check",
        "update-password-check-spawned",
    )
    .await
}

fn password_and_type_switches(args: &[String]) -> (Option<String>, Vec<String>) {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let mut password = None;
    let mut types = Vec::new();
    for arg in &args[1..separator] {
        let lower = arg.to_ascii_lowercase();
        if lower.starts_with("-p") && arg.len() > 2 {
            password = Some(arg.clone());
        } else if lower.starts_with("-t") && lower != "-stl" && !lower.starts_with("-stx") {
            types.push(arg.clone());
        }
    }
    (password, types)
}

/// Refuse an update that would add unencrypted or differently encrypted files
/// to an encrypted archive, or mix AES with ZipCrypto members.
///
/// `7z u` copies existing members without decrypting them, so it succeeds with
/// no password (new files are stored in plaintext) and with a wrong password
/// (new files use a different key). Lists the archive 7-Zip will read, then
/// tests the smallest unambiguous encrypted file. If the listed selector is
/// ambiguous or the test proves it processed no data, tests the whole archive.
pub(crate) async fn assert_update_encryption_policy(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RunningProcess>,
    args: &[String],
    archive: &std::path::Path,
) -> Result<(), String> {
    let archive = archive
        .to_str()
        .ok_or_else(|| "Archive path is not valid UTF-8.".to_string())?
        .to_string();
    let (password, types) = password_and_type_switches(args);
    let mut list_args = vec!["l".to_string(), "-slt".to_string(), "-ba".to_string()];
    list_args.extend(password.iter().cloned());
    list_args.extend(types.iter().cloned());
    list_args.push("--".to_string());
    list_args.push(archive.clone());
    crate::process::commands::harden_7z_args(&mut list_args);
    let listing = run_registered_preflight_7z(
        app,
        state,
        list_args,
        preflight_timeout_for_archive(std::path::Path::new(&archive)),
        "Archive encryption preflight",
        "update-encryption-preflight-spawned",
    )
    .await?;
    if !listing_preflight_exit_is_acceptable(listing.code, &listing.stdout, &listing.stderr) {
        let detail = preflight_failure_detail(&listing);
        return Err(if detail.is_empty() {
            format!(
                "Could not inspect the archive before updating it (exit {}).",
                listing.code
            )
        } else {
            format!("Could not inspect the archive before updating it: {detail}")
        });
    }
    let facts = parse_update_encryption_facts(&listing.stdout);
    if facts.has_zipcrypto_members {
        return Err(ZIPCRYPTO_UPDATE_REFUSED.to_string());
    }
    if !facts.has_encrypted_members {
        return Ok(());
    }
    let Some(password) = password else {
        return Err(UPDATE_PASSWORD_REQUIRED.to_string());
    };
    let Some(member) = facts.smallest_encrypted_file.as_deref() else {
        return Err(
            "Could not verify the archive password because no encrypted file was available to test."
                .to_string(),
        );
    };
    let test = if facts.smallest_encrypted_file_ambiguous {
        run_update_password_check(app, state, &archive, &password, &types, None).await?
    } else {
        let member_test =
            run_update_password_check(app, state, &archive, &password, &types, Some(member))
                .await?;
        if member_password_test_needs_full_archive_check(&facts, &member_test) {
            run_update_password_check(app, state, &archive, &password, &types, None).await?
        } else {
            member_test
        }
    };
    if test.code == 0 && preflight_test_reports_processed_file(&test) {
        return Ok(());
    }
    if test.code == 0 {
        return Err(
            "Could not verify the archive password because 7-Zip did not test any files."
                .to_string(),
        );
    }
    let detail = preflight_failure_detail(&test);
    if detail.to_ascii_lowercase().contains("wrong password") {
        return Err(UPDATE_WRONG_PASSWORD.to_string());
    }
    Err(if detail.is_empty() {
        format!(
            "Could not verify the archive password before updating (exit {}).",
            test.code
        )
    } else {
        format!("Could not verify the archive password before updating: {detail}")
    })
}

#[cfg(test)]
mod preflight_budget_tests {
    use super::*;
    use std::time::Duration;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn timeout_is_120_seconds_plus_one_per_16_mib_rounded_up() {
        assert_eq!(
            preflight_timeout_for_archive_bytes(0),
            Duration::from_secs(120)
        );
        assert_eq!(
            preflight_timeout_for_archive_bytes(1),
            Duration::from_secs(121)
        );
        assert_eq!(
            preflight_timeout_for_archive_bytes(16 * MIB),
            Duration::from_secs(121)
        );
        assert_eq!(
            preflight_timeout_for_archive_bytes(16 * MIB + 1),
            Duration::from_secs(122)
        );
        assert_eq!(
            preflight_timeout_for_archive_bytes(1024 * MIB),
            Duration::from_secs(120 + 64)
        );
        assert_eq!(
            preflight_timeout_for_archive_bytes(50 * 1024 * MIB),
            Duration::from_secs(120 + 3200)
        );
    }

    #[test]
    fn timeout_saturates_for_extreme_archive_sizes() {
        assert!(preflight_timeout_for_archive_bytes(u64::MAX) >= Duration::from_secs(120));
    }

    #[test]
    fn timeout_message_states_the_seconds_and_suggests_a_faster_disk() {
        let message =
            preflight_timeout_error("Archive member-safety preflight", Duration::from_secs(184));
        assert!(message.contains("184 seconds"), "{message}");
        assert!(message.contains("faster disk"), "{message}");
    }

    #[test]
    fn listing_buffer_is_256_mib_and_covers_about_800k_zip_entries() {
        assert_eq!(PREFLIGHT_LIST_OUTPUT_LIMIT, 256 * 1024 * 1024);
        const { assert!(PREFLIGHT_LIST_OUTPUT_LIMIT / 325 >= 800_000) };
    }

    #[test]
    fn truncated_member_listing_reports_the_entry_limit_in_plain_words() {
        let collected = CollectedOutput {
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: true,
            stderr_truncated: false,
            exit: None,
            stream_error: None,
        };
        let error = checked_preflight_output_with_limit(
            collected,
            "Archive member-safety preflight",
            Some(MEMBER_LIST_LIMIT_MESSAGE),
        )
        .expect_err("truncated listing must fail");
        assert_eq!(error, MEMBER_LIST_LIMIT_MESSAGE);
        assert!(error.contains("1,000,000 entries"), "{error}");
        assert!(error.contains("Nothing was extracted."), "{error}");
        assert!(!error.contains("256 MiB"), "{error}");
    }
}

#[cfg(test)]
mod streaming_listing_tests {
    use super::*;
    use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};

    const ARCHIVE: &str = "/tmp/archive.7z";
    const MIB: u64 = 1024 * 1024;

    const PLAIN_ZIP: &str =
        "Path = a.txt\nSize = 3\nAttributes = A_ -rw-r--r--\n\nPath = dir/b.txt\nSize = 5\n\n";
    const SAFE_SYMLINK: &str = "Path = bin/tool\nSymbolic Link = ../lib/tool\nSize = 0\n\n";
    const UNIX_SYMLINK_MODE: &str =
        "Path = link\nSize = 3\nAttributes = A_ lrwxrwxrwx\n\nPath = target.txt\nSize = 2\n\n";
    const SAFE_HARD_LINK: &str = "Path = a\nHard Link = b\nSize = 1\n\n";
    const UNSAFE_SYMLINK: &str = "Path = bin/tool\nSymbolic Link = /etc/passwd\nSize = 0\n\n";
    const UNSAFE_PATH: &str = "Path = ../evil\nSize = 1\n\n";
    const PATHLESS_XZ: &str = "Size = 100000\nPacked Size = 100064\nMethod = LZMA2:17 CRC32\n\n";
    const PATHLESS_BAD: &str = "Size = lots\n\n";
    const ARCHIVE_RECORD_THEN_MEMBER: &str =
        "Path = archive.7z\nType = 7z\n\n----------\nPath = inner.txt\nSize = 4\n";
    const MULTIBYTE_CRLF: &str =
        "Path = café/naïve-日本.txt\r\nSize = 9\r\nAttributes = A\r\n\r\nPath = ü/ñ.txt\r\nSize = 2\r\n";
    const UNTERMINATED_UNSAFE: &str = "Path = ok.txt\nSize = 1\n\nPath = ../unterminated";
    const UNTERMINATED_SAFE: &str = "Path = ok.txt\nSize = 1\n\nPath = fine.txt";
    const WHITESPACE_ONLY: &str = "  \n\n\t\n";
    const EMPTY: &str = "";

    const FIXTURES: [&str; 14] = [
        PLAIN_ZIP,
        SAFE_SYMLINK,
        UNIX_SYMLINK_MODE,
        SAFE_HARD_LINK,
        UNSAFE_SYMLINK,
        UNSAFE_PATH,
        PATHLESS_XZ,
        PATHLESS_BAD,
        ARCHIVE_RECORD_THEN_MEMBER,
        MULTIBYTE_CRLF,
        UNTERMINATED_UNSAFE,
        UNTERMINATED_SAFE,
        WHITESPACE_ONLY,
        EMPTY,
    ];

    fn debug_result(result: &Result<ArchiveManifestSummary, String>) -> String {
        format!("{result:?}")
    }

    fn parse_in_two_chunks(
        text: &str,
        split: usize,
        archive: &str,
        limits: ListingLimits,
    ) -> Result<ArchiveManifestSummary, String> {
        let bytes = text.as_bytes();
        let mut parser = SltManifestParser::with_limits(archive, None, limits);
        parser.push(&bytes[..split]);
        parser.push(&bytes[split..]);
        parser.finish()
    }

    #[test]
    fn stream_split_at_every_byte_matches_whole_parse() {
        for fixture in FIXTURES {
            let whole = debug_result(&parse_slt_archive_manifest(fixture, ARCHIVE, None));
            for split in 0..=fixture.len() {
                let streamed = debug_result(&parse_in_two_chunks(
                    fixture,
                    split,
                    ARCHIVE,
                    ListingLimits::default(),
                ));
                assert_eq!(streamed, whole, "fixture {fixture:?} split at {split}");
            }
        }
    }

    #[test]
    fn stream_handles_crlf_and_multibyte_splits() {
        let whole = parse_slt_archive_manifest(MULTIBYTE_CRLF, ARCHIVE, None)
            .expect("multibyte CRLF listing is safe");
        assert_eq!(whole.entry_count, 2);
        assert_eq!(
            whole.path_bytes,
            "café/naïve-日本.txt".len() as u64 + "ü/ñ.txt".len() as u64
        );
        let cr = MULTIBYTE_CRLF.find('\r').expect("fixture has CR");
        assert_eq!(MULTIBYTE_CRLF.as_bytes()[cr + 1], b'\n');
        let split_between_cr_and_lf = debug_result(&parse_in_two_chunks(
            MULTIBYTE_CRLF,
            cr + 1,
            ARCHIVE,
            ListingLimits::default(),
        ));
        assert_eq!(split_between_cr_and_lf, debug_result(&Ok(whole.clone())));
        let split_inside_first_char = debug_result(&parse_in_two_chunks(
            MULTIBYTE_CRLF,
            "Path = caf".len() + 1,
            ARCHIVE,
            ListingLimits::default(),
        ));
        assert_eq!(split_inside_first_char, debug_result(&Ok(whole)));
    }

    #[test]
    fn stream_final_unterminated_line_is_checked() {
        for split in 0..=UNTERMINATED_UNSAFE.len() {
            let error = parse_in_two_chunks(
                UNTERMINATED_UNSAFE,
                split,
                ARCHIVE,
                ListingLimits::default(),
            )
            .expect_err("unsafe final member without a newline must fail");
            assert!(error.contains("../unterminated"), "{error}");
        }
        for split in 0..=UNTERMINATED_SAFE.len() {
            let summary =
                parse_in_two_chunks(UNTERMINATED_SAFE, split, ARCHIVE, ListingLimits::default())
                    .expect("safe final member");
            assert_eq!(summary.entry_count, 2);
        }
    }

    #[test]
    fn stream_rejects_line_over_bound_and_accepts_exact_bound() {
        let limits = ListingLimits {
            max_line_bytes: 64,
            ..ListingLimits::default()
        };
        let exact = format!("Path = {}\nSize = 1\n\n", "a".repeat(64 - "Path = ".len()));
        let over = format!(
            "Path = {}\nSize = 1\n\n",
            "a".repeat(64 - "Path = ".len() + 1)
        );
        let comment_over = format!("Comment = {}\n\n", "c".repeat(64));
        for split in 0..=exact.len() {
            let summary = parse_in_two_chunks(&exact, split, ARCHIVE, limits.clone())
                .expect("line exactly at the bound is accepted");
            assert_eq!(summary.entry_count, 1);
        }
        for split in 0..=over.len() {
            let error = parse_in_two_chunks(&over, split, ARCHIVE, limits.clone())
                .expect_err("line one byte over the bound is rejected");
            assert_eq!(error, LISTING_LINE_LIMIT_MESSAGE, "split {split}");
        }
        assert_eq!(
            parse_in_two_chunks(&comment_over, 3, ARCHIVE, limits).expect_err("non-path line"),
            LISTING_LINE_LIMIT_MESSAGE
        );
    }

    #[test]
    fn stream_keeps_retained_state_bounded_by_the_line_limit() {
        let limits = ListingLimits {
            max_line_bytes: 64,
            ..ListingLimits::default()
        };
        let mut parser = SltManifestParser::with_limits(ARCHIVE, None, limits);
        let hostile = vec![b'x'; 10 * 1024 * 1024];
        for chunk in hostile.chunks(4096) {
            parser.push(chunk);
        }
        assert!(
            parser.retained_bytes() <= 4 * 64,
            "{}",
            parser.retained_bytes()
        );
        assert_eq!(
            parser.finish().expect_err("hostile line"),
            LISTING_LINE_LIMIT_MESSAGE
        );
    }

    #[test]
    fn stream_entry_cap_is_enforced_across_chunks() {
        let limits = ListingLimits {
            max_entries: 2,
            ..ListingLimits::default()
        };
        let listing = "Path = a\n\nPath = b\n\nPath = c\n\n";
        for split in 0..=listing.len() {
            assert_eq!(
                parse_in_two_chunks(listing, split, ARCHIVE, limits.clone())
                    .expect_err("third entry exceeds the cap"),
                "Archive exceeds the safety limit of 2 entries.",
                "split {split}"
            );
        }
        let path_limits = ListingLimits {
            max_path_bytes: 3,
            ..ListingLimits::default()
        };
        let paths = "Path = ab\n\nPath = cd\n\n";
        for split in 0..=paths.len() {
            let error = parse_in_two_chunks(paths, split, ARCHIVE, path_limits.clone())
                .expect_err("aggregate path bytes exceed the cap");
            assert!(
                error.contains("aggregate path-name safety limit"),
                "{error}"
            );
        }
    }

    #[test]
    fn stream_total_bytes_bound_is_enforced_at_line_end() {
        let limits = ListingLimits {
            max_total_bytes: 19,
            ..ListingLimits::default()
        };
        let within = "Path = a\nSize = 1\n\n";
        parse_in_two_chunks(within, 4, ARCHIVE, limits.clone()).expect("exactly at the bound");
        let over = "Path = a\nSize = 1\n\nPath = b\n";
        for split in 0..=over.len() {
            assert_eq!(
                parse_in_two_chunks(over, split, ARCHIVE, limits.clone())
                    .expect_err("listing text over the bound"),
                MEMBER_LIST_LIMIT_MESSAGE,
                "split {split}"
            );
        }
    }

    #[test]
    fn stream_wrapper_matches_streaming_for_existing_fixture_shapes() {
        let zip = parse_slt_archive_manifest(PLAIN_ZIP, ARCHIVE, None).expect("plain zip");
        assert_eq!(zip.entry_count, 2);
        assert!(!zip.has_links());
        let link = parse_slt_archive_manifest(SAFE_SYMLINK, ARCHIVE, None).expect("safe link");
        assert!(link.has_symbolic_links);
        let mode_link =
            parse_slt_archive_manifest(UNIX_SYMLINK_MODE, ARCHIVE, None).expect("unix mode link");
        assert!(mode_link.has_symbolic_links);
        let hard = parse_slt_archive_manifest(SAFE_HARD_LINK, ARCHIVE, None).expect("hard link");
        assert!(hard.has_hard_links);
        assert!(parse_slt_archive_manifest(UNSAFE_SYMLINK, ARCHIVE, None)
            .expect_err("absolute link target")
            .contains("unsafe link target"));
        assert!(parse_slt_archive_manifest(UNSAFE_PATH, ARCHIVE, None)
            .expect_err("escaping member")
            .contains("unsafe member path"));
        let xz = parse_slt_archive_manifest(PATHLESS_XZ, "/tmp/payload.bin.xz", None)
            .expect("pathless single stream");
        assert_eq!(xz.declared_bytes, 100_000);
        assert!(xz.declared_size_untrusted);
        assert_eq!(
            parse_slt_archive_manifest(PATHLESS_BAD, "/tmp/payload.bin.xz", None)
                .expect_err("invalid pathless size"),
            "Archive listing contains an invalid declared member size."
        );
        let empty = parse_slt_archive_manifest(EMPTY, ARCHIVE, None).expect("empty listing");
        assert_eq!(empty.entry_count, 0);
        assert!(parse_slt_archive_manifest(PLAIN_ZIP, ARCHIVE, Some(7))
            .expect_err("declared bytes over the limit")
            .contains("Not enough free space"));
    }

    #[test]
    fn stream_first_error_wins_over_later_errors() {
        let listing = "Path = ../evil\nPath = a\nSize = 99999999999999999999999\n";
        for split in 0..=listing.len() {
            let error = parse_in_two_chunks(listing, split, ARCHIVE, ListingLimits::default())
                .expect_err("unsafe path");
            assert!(error.contains("../evil"), "split {split}: {error}");
        }
    }

    #[test]
    fn stream_warning_scan_matches_buffered_classifier_at_every_split() {
        let stdouts = [
            "Path = a.txt\nSize = 1\n\nArchives with Warnings: 1\n",
            "Path = a.txt\n\nWARNING: Cannot open 1 file\n",
            "Path = cannot open.txt\n\nThere are data after the end of archive\n",
            "Path = a\n\nWARNING: cannot set owner\r\nArchives with Warnings: 1\r\n",
            "Path = a\n\nERROR: Cannot open the file\n",
            "Path = a\n\nPath with no newline at the end",
        ];
        let stderrs = [
            "",
            "WARNING: cannot set file time\n",
            "ERROR: unknown\n",
            "data after the end of archive\n",
        ];
        for stdout in stdouts {
            for stderr in stderrs {
                for code in [0, 1, 2] {
                    let buffered = listing_preflight_exit_is_acceptable(code, stdout, stderr);
                    for split in 0..=stdout.len() {
                        let mut parser =
                            SltManifestParser::with_limits(ARCHIVE, None, ListingLimits::default());
                        parser.push(&stdout.as_bytes()[..split]);
                        parser.push(&stdout.as_bytes()[split..]);
                        parser.close();
                        assert_eq!(
                            listing_exit_is_acceptable_scanned(code, parser.warnings(), stderr),
                            buffered,
                            "stdout {stdout:?} stderr {stderr:?} code {code} split {split}"
                        );
                    }
                }
            }
        }
    }

    const SYNTHETIC_COMMENT: [u8; 200] = [b'c'; 200];

    fn push_zero_padded(out: &mut Vec<u8>, mut value: u64, width: usize) {
        let start = out.len();
        out.resize(start + width, b'0');
        for slot in out[start..].iter_mut().rev() {
            *slot = b'0' + (value % 10) as u8;
            value /= 10;
        }
    }

    fn write_record(out: &mut Vec<u8>, index: u64) {
        out.extend_from_slice(b"Path = d");
        push_zero_padded(out, index % 1000, 3);
        out.extend_from_slice(b"/f");
        push_zero_padded(out, index, 7);
        out.extend_from_slice(b".dat\nFolder = -\nSize = 0\nPacked Size = 0\n");
        out.extend_from_slice(b"Modified = 2026-11-12 22:56:10.0174470\nAttributes = A\n");
        out.extend_from_slice(b"Encrypted = -\nComment = ");
        out.extend_from_slice(&SYNTHETIC_COMMENT);
        out.extend_from_slice(b"\nCRC = 00000000\nMethod = Store\n");
        out.extend_from_slice(b"Host OS = FAT\nVersion = 10\nOffset = 0\n\n");
    }

    #[test]
    fn stream_listing_over_256_mib_succeeds_with_bounded_state() {
        const RECORDS: u64 = 700_000;
        let started = std::time::Instant::now();
        let declared_limit = DeclaredSizeLimit {
            max_bytes: u64::MAX,
            cause: DeclaredSizeCause::FreeSpace { free_bytes: None },
        };
        let mut parser =
            SltManifestParser::with_limits(ARCHIVE, Some(declared_limit), ListingLimits::default());
        let mut chunk = Vec::with_capacity(64 * 1024);
        let mut total_bytes: u64 = 0;
        let mut expected_path_bytes: u64 = 0;
        for index in 0..RECORDS {
            let before = chunk.len();
            write_record(&mut chunk, index);
            total_bytes += (chunk.len() - before) as u64;
            expected_path_bytes += "d000/f0000000.dat".len() as u64;
            if chunk.len() >= 64 * 1024 {
                parser.push(&chunk);
                chunk.clear();
            }
        }
        parser.push(&chunk);
        assert!(
            total_bytes > 256 * MIB,
            "synthetic listing is {total_bytes} bytes"
        );
        assert!(
            parser.retained_bytes() < 64 * 1024,
            "{}",
            parser.retained_bytes()
        );
        let summary = parser.finish().expect("large safe listing");
        assert_eq!(summary.entry_count, RECORDS);
        assert_eq!(summary.path_bytes, expected_path_bytes);
        assert_eq!(summary.declared_bytes, 0);
        assert!(!summary.has_links());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(120),
            "parse took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn collect_listing_reports_stream_error_as_incomplete() {
        tauri::async_runtime::block_on(async {
            let (tx, mut rx) = tauri::async_runtime::channel::<CommandEvent>(8);
            tx.send(CommandEvent::Error("broken pipe".to_string()))
                .await
                .expect("send error");
            drop(tx);
            let mut parser =
                SltManifestParser::with_limits(ARCHIVE, None, ListingLimits::default());
            let collected = collect_listing_events(&mut rx, &mut parser).await;
            assert!(collected.exit.is_none());
            let error = checked_preflight_output_with_limit(
                collected,
                "Archive member-safety preflight",
                None,
            )
            .expect_err("stream error is not a clean listing");
            assert!(
                error.contains("could not read the complete output stream: broken pipe"),
                "{error}"
            );
        });
    }

    #[test]
    fn collect_listing_keeps_only_a_bounded_stdout_head() {
        tauri::async_runtime::block_on(async {
            let (tx, mut rx) = tauri::async_runtime::channel::<CommandEvent>(8);
            tx.send(CommandEvent::Stdout(vec![
                b'x';
                crate::output::MAX_OUTPUT_BYTES
                    + 100
            ]))
            .await
            .expect("send stdout");
            tx.send(CommandEvent::Terminated(TerminatedPayload {
                code: Some(0),
                signal: None,
            }))
            .await
            .expect("send exit");
            drop(tx);
            let mut parser =
                SltManifestParser::with_limits(ARCHIVE, None, ListingLimits::default());
            let collected = collect_listing_events(&mut rx, &mut parser).await;
            assert_eq!(collected.stdout.len(), crate::output::MAX_OUTPUT_BYTES);
            assert!(!collected.stdout_truncated);
            let output = checked_preflight_output_with_limit(
                collected,
                "Archive member-safety preflight",
                None,
            )
            .expect("complete exit-0 output is not a preflight failure");
            assert_eq!(output.code, 0);
            assert_eq!(
                parser.finish().expect_err("over-long listing line"),
                LISTING_LINE_LIMIT_MESSAGE
            );
        });
    }

    #[test]
    fn listing_exit_error_is_reported_before_parse_errors() {
        let mut parser = SltManifestParser::with_limits(ARCHIVE, None, ListingLimits::default());
        parser.push(b"Path = ../evil\n");
        parser.close();
        let stderr_failure = PreflightOutput {
            code: 2,
            stdout: String::new(),
            stderr: "ERROR: Data Error\n".to_string(),
        };
        assert_eq!(
            listing_exit_rejection(&stderr_failure, parser.warnings()),
            Some("Could not list archive members for path safety: ERROR: Data Error".to_string())
        );
        let stdout_failure = PreflightOutput {
            code: 2,
            stdout: "  bad header \n".to_string(),
            stderr: String::new(),
        };
        assert_eq!(
            listing_exit_rejection(&stdout_failure, parser.warnings()),
            Some("Could not list archive members for path safety: bad header".to_string())
        );
        let silent_failure = PreflightOutput {
            code: -1,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(
            listing_exit_rejection(&silent_failure, parser.warnings()),
            Some("Could not list archive members for path safety (exit -1).".to_string())
        );
        let clean = PreflightOutput {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(listing_exit_rejection(&clean, parser.warnings()), None);
        assert!(parser
            .finish()
            .expect_err("unsafe member")
            .contains("../evil"));
    }

    #[test]
    fn streaming_limits_default_to_extract_constants() {
        let limits = ListingLimits::default();
        assert_eq!(
            limits.max_entries,
            crate::process::quota::MAX_EXTRACT_ENTRIES
        );
        assert_eq!(
            limits.max_path_bytes,
            crate::process::quota::MAX_EXTRACT_PATH_BYTES
        );
        assert_eq!(limits.max_line_bytes, 256 * 1024);
        assert_eq!(
            limits.max_total_bytes,
            crate::process::quota::MAX_EXTRACT_ENTRIES * 4096
                + crate::process::quota::MAX_EXTRACT_PATH_BYTES
        );
        assert!(limits.max_total_bytes >= 4_000_000_000);
        assert!(MEMBER_LIST_LIMIT_MESSAGE.contains("Nothing was extracted."));
        assert!(!MEMBER_LIST_LIMIT_MESSAGE.contains("256 MiB"));
    }
}
