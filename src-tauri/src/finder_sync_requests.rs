//! App Group handoff from the sandboxed Finder Sync extension to Zinnia.

#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use objc2_foundation::{NSFileManager, NSString};
use serde::Deserialize;
use tauri::AppHandle;

const REQUESTS_DIRECTORY: &str = "FinderSyncRequests";
const MAX_REQUESTS_PER_DRAIN: usize = 100;
const MAX_PATHS_PER_REQUEST: usize = 1_000;
const MAX_REQUEST_BYTES: u64 = 1_048_576;
const MAX_FUTURE_SKEW_MS: u64 = 5_000;
const MIN_POLL_MS: u64 = 250;
const MAX_POLL_MS: u64 = 2_000;
static DRAIN_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct FinderSyncRequest {
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    mode: String,
    paths: Vec<String>,
}

fn group_container() -> Option<PathBuf> {
    let group = NSString::from_str(env!("ZINNIA_APP_GROUP_ID"));
    let url = NSFileManager::defaultManager()
        .containerURLForSecurityApplicationGroupIdentifier(&group)?;
    let path = url.path()?;
    let utf8 = path.UTF8String();
    if utf8.is_null() {
        return None;
    }
    // Foundation returns a NUL-terminated UTF-8 buffer valid for the lifetime
    // of `path`, which is retained until this conversion completes.
    unsafe { CStr::from_ptr(utf8) }
        .to_str()
        .ok()
        .map(PathBuf::from)
}

fn requests_directory() -> Option<PathBuf> {
    Some(group_container()?.join(REQUESTS_DIRECTORY))
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn valid_request_at(request: &FinderSyncRequest, now_ms: u64) -> bool {
    matches!(request.mode.as_str(), "extract" | "compress")
        && request.created_at_ms <= now_ms.saturating_add(MAX_FUTURE_SKEW_MS)
        && !request.paths.is_empty()
        && request.paths.len() <= MAX_PATHS_PER_REQUEST
        && request
            .paths
            .iter()
            .all(|path| std::path::Path::new(path).is_absolute() && !path.contains('\0'))
}

fn has_pending_requests() -> bool {
    requests_directory()
        .and_then(|directory| std::fs::read_dir(directory).ok())
        .is_some_and(|mut entries| {
            entries.any(|entry| {
                entry.ok().is_some_and(|entry| {
                    let path = entry.path();
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                        && std::fs::symlink_metadata(path)
                            .is_ok_and(|metadata| metadata.file_type().is_file())
                })
            })
        })
}

/// Route queued requests, then acknowledge them by removing their files. A
/// full in-app queue leaves the durable request intact for a later drain.
pub(crate) fn route_pending_requests(app: &AppHandle) -> bool {
    let Some(directory) = requests_directory() else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return false;
    };

    let now_ms = unix_time_ms();
    let mut requests = Vec::new();
    for path in entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
    {
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        if metadata.len() > MAX_REQUEST_BYTES {
            if let Err(error) = std::fs::remove_file(&path) {
                eprintln!("Zinnia Finder Sync: could not discard oversized request: {error}");
            }
            continue;
        }
        let request = std::fs::read_to_string(&path)
            .ok()
            .and_then(|json| serde_json::from_str::<FinderSyncRequest>(&json).ok());
        let Some(request) = request.filter(|request| valid_request_at(request, now_ms)) else {
            let _ = std::fs::remove_file(&path);
            eprintln!("Zinnia Finder Sync: discarded invalid or expired queued request");
            continue;
        };
        requests.push((request.created_at_ms, path, request));
    }
    requests.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

    let mut routed = false;
    for (_, path, request) in requests.into_iter().take(MAX_REQUESTS_PER_DRAIN) {
        let mut argv = vec!["zinnia".to_string(), format!("--{}", request.mode)];
        argv.extend(request.paths);
        if !crate::launch::emit_open_paths(app, argv) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Zinnia Finder Sync: could not acknowledge queued request: {error}");
            }
            continue;
        }
        routed = true;
    }
    routed
}

/// `openApplication` activates an existing app but doesn't consistently emit a
/// reopen event. A short poll guarantees warm-host delivery without relying on
/// launch arguments or private plug-in behavior.
pub(crate) fn start_request_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut poll_ms = MIN_POLL_MS;
        loop {
            tokio::time::sleep(Duration::from_millis(poll_ms)).await;
            if !has_pending_requests() {
                poll_ms = (poll_ms * 2).min(MAX_POLL_MS);
                continue;
            }
            poll_ms = MIN_POLL_MS;
            if DRAIN_SCHEDULED
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                continue;
            }
            let handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                route_pending_requests(&handle);
                DRAIN_SCHEDULED.store(false, Ordering::SeqCst);
            }) {
                DRAIN_SCHEDULED.store(false, Ordering::SeqCst);
                eprintln!("Zinnia Finder Sync: could not schedule request drain: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{valid_request_at, FinderSyncRequest};

    #[test]
    fn accepts_absolute_extract_and_compress_requests() {
        for mode in ["extract", "compress"] {
            assert!(valid_request_at(
                &FinderSyncRequest {
                    created_at_ms: 10_000,
                    mode: mode.to_string(),
                    paths: vec!["/Users/example/Archive.zip".to_string()],
                },
                10_000
            ));
        }
    }

    #[test]
    fn rejects_untrusted_request_shapes() {
        assert!(!valid_request_at(
            &FinderSyncRequest {
                created_at_ms: 10_000,
                mode: "delete".to_string(),
                paths: vec!["/tmp/file".to_string()],
            },
            10_000
        ));
        assert!(!valid_request_at(
            &FinderSyncRequest {
                created_at_ms: 10_000,
                mode: "extract".to_string(),
                paths: vec!["relative.zip".to_string()],
            },
            10_000
        ));
        assert!(!valid_request_at(
            &FinderSyncRequest {
                created_at_ms: 10_000,
                mode: "compress".to_string(),
                paths: Vec::new(),
            },
            10_000
        ));
    }

    #[test]
    fn retains_old_requests_but_rejects_implausibly_future_requests() {
        let request = |created_at_ms| FinderSyncRequest {
            created_at_ms,
            mode: "extract".to_string(),
            paths: vec!["/tmp/archive.zip".to_string()],
        };
        assert!(valid_request_at(&request(10_000), 10_000));
        let now = 1_000_000;
        assert!(valid_request_at(&request(10_000), now));
        assert!(!valid_request_at(&request(now + 10_000), now));
    }
}
