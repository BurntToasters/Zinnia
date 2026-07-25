//! App Group handoff from the sandboxed Finder Sync extension to Zinnia.

#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::io::Read;
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
const MAX_REQUEST_AGE_MS: u64 = 120_000;
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
    let oldest_accepted = now_ms.saturating_sub(MAX_REQUEST_AGE_MS);
    matches!(request.mode.as_str(), "extract" | "compress")
        && request.created_at_ms >= oldest_accepted
        && request.created_at_ms <= now_ms.saturating_add(MAX_FUTURE_SKEW_MS)
        && !request.paths.is_empty()
        && request.paths.len() <= MAX_PATHS_PER_REQUEST
        && request
            .paths
            .iter()
            .all(|path| std::path::Path::new(path).is_absolute() && !path.contains('\0'))
}

fn read_valid_claimed_request(path: &std::path::Path, now_ms: u64) -> Option<FinderSyncRequest> {
    let Ok(file) = crate::path_safety::open_regular_file_nofollow(path) else {
        return None;
    };
    let Ok(metadata) = file.metadata() else {
        return None;
    };
    if metadata.len() > MAX_REQUEST_BYTES {
        return None;
    }
    let mut json = String::new();
    let read_ok = file
        .take(MAX_REQUEST_BYTES.saturating_add(1))
        .read_to_string(&mut json)
        .is_ok()
        && (json.len() as u64) <= MAX_REQUEST_BYTES;
    read_ok
        .then(|| serde_json::from_str::<FinderSyncRequest>(&json).ok())
        .flatten()
        .filter(|request| valid_request_at(request, now_ms))
}

/// Orphaned `*.claimed` files (crash between claim and ack) would otherwise
/// never re-enter the drain queue because only `*.json` is scanned.
fn sweep_orphaned_claimed_requests(directory: &std::path::Path, now_ms: u64) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path
            .extension()
            .is_none_or(|extension| extension != "claimed")
        {
            continue;
        }
        let restore = path.with_extension("json");
        match read_valid_claimed_request(&path, now_ms) {
            Some(_) => {
                if let Err(error) = std::fs::rename(&path, &restore) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "Zinnia Finder Sync: could not restore orphaned claimed request: {error}"
                        );
                    }
                }
            }
            None => {
                if let Err(error) = std::fs::remove_file(&path) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "Zinnia Finder Sync: could not discard stale claimed request: {error}"
                        );
                    }
                }
            }
        }
    }
}

fn has_pending_requests() -> bool {
    requests_directory()
        .and_then(|directory| std::fs::read_dir(directory).ok())
        .is_some_and(|mut entries| {
            entries.any(|entry| {
                entry.ok().is_some_and(|entry| {
                    let path = entry.path();
                    let extension = path.extension();
                    (extension.is_some_and(|extension| extension == "json")
                        || extension.is_some_and(|extension| extension == "claimed"))
                        && std::fs::symlink_metadata(&path)
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

    let now_ms = unix_time_ms();
    // Restore/discard orphans before scanning so cold-start only-claimed queues
    // are visible in this drain instead of waiting for the next poll.
    sweep_orphaned_claimed_requests(&directory, now_ms);

    let Ok(entries) = std::fs::read_dir(&directory) else {
        return false;
    };

    let mut requests = Vec::new();
    for path in entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
    {
        // Open without following symlinks, then read from the handle so a
        // TOCTOU swap after symlink_metadata cannot redirect the payload.
        let Ok(file) = crate::path_safety::open_regular_file_nofollow(&path) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        if metadata.len() > MAX_REQUEST_BYTES {
            drop(file);
            if let Err(error) = std::fs::remove_file(&path) {
                eprintln!("Zinnia Finder Sync: could not discard oversized request: {error}");
            }
            continue;
        }
        let mut json = String::new();
        let read_ok = file
            .take(MAX_REQUEST_BYTES.saturating_add(1))
            .read_to_string(&mut json)
            .is_ok()
            && (json.len() as u64) <= MAX_REQUEST_BYTES;
        let request = read_ok
            .then(|| serde_json::from_str::<FinderSyncRequest>(&json).ok())
            .flatten();
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
        // Claim before emit so a failed ack cannot re-deliver on the next drain.
        let claimed = path.with_extension("claimed");
        if let Err(error) = std::fs::rename(&path, &claimed) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Zinnia Finder Sync: could not claim queued request: {error}");
            }
            continue;
        }
        let mut argv = vec!["zinnia".to_string(), format!("--{}", request.mode)];
        argv.extend(request.paths);
        if !crate::launch::emit_open_paths(app, argv) {
            // Restore so a later drain can retry.
            if let Err(restore_error) = std::fs::rename(&claimed, &path) {
                eprintln!(
                    "Zinnia Finder Sync: could not restore failed request after emit: {restore_error}"
                );
            }
            continue;
        }
        // Mark non-restorable immediately after a successful emit so a crash
        // before rename cannot leave a valid *.claimed for sweep to restore.
        if let Err(write_error) = std::fs::write(&claimed, b"{}") {
            if let Err(remove_error) = std::fs::remove_file(&claimed) {
                if remove_error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "Zinnia Finder Sync: could not invalidate claimed request after emit: {write_error}; remove also failed: {remove_error}"
                    );
                }
            }
        } else {
            let acked = claimed.with_extension("acked");
            if let Err(ack_error) = std::fs::rename(&claimed, &acked) {
                if let Err(remove_error) = std::fs::remove_file(&claimed) {
                    if remove_error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "Zinnia Finder Sync: could not ack claimed request after emit: {ack_error}; remove also failed: {remove_error}"
                        );
                    }
                }
            } else if let Err(error) = std::fs::remove_file(&acked) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Zinnia Finder Sync: could not discard acked request: {error}");
                }
            }
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
    fn rejects_stale_and_implausibly_future_requests() {
        let request = |created_at_ms| FinderSyncRequest {
            created_at_ms,
            mode: "extract".to_string(),
            paths: vec!["/tmp/archive.zip".to_string()],
        };
        assert!(valid_request_at(&request(10_000), 10_000));
        let now = 1_000_000;
        assert!(valid_request_at(&request(now), now));
        assert!(valid_request_at(&request(now - 120_000), now));
        assert!(!valid_request_at(&request(now - 120_001), now));
        assert!(!valid_request_at(&request(10_000), now));
        assert!(!valid_request_at(&request(now + 10_000), now));
    }
}
