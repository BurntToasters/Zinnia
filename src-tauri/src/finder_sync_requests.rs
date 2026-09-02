//! App Group handoff from the sandboxed Finder Sync extension to Zinnia.

#![cfg(target_os = "macos")]

use std::ffi::{CStr, CString};
use std::io::{Read, Seek, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
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
// Darwin's renameatx_np(2) exclusive flag. It provides an atomic no-replace
// claim/restore primitive; plain renameat(2) would overwrite a collision.
const RENAME_EXCL: u32 = 0x0000_0004;
static DRAIN_SCHEDULED: AtomicBool = AtomicBool::new(false);

unsafe extern "C" {
    fn renameatx_np(
        fromfd: libc::c_int,
        from: *const libc::c_char,
        tofd: libc::c_int,
        to: *const libc::c_char,
        flags: libc::c_uint,
    ) -> libc::c_int;
    fn __error() -> *mut libc::c_int;
}

#[derive(Deserialize)]
struct FinderSyncRequest {
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    mode: String,
    paths: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct EntryIdentity {
    device: u64,
    inode: u64,
}

struct RequestDirectory {
    file: std::fs::File,
}

impl RequestDirectory {
    fn open(path: &std::path::Path) -> Result<Self, String> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "Finder request directory contains a NUL byte.".to_string())?;
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err("Finder request path is not a real directory.".to_string());
        }
        Ok(Self { file })
    }

    fn fd(&self) -> libc::c_int {
        self.file.as_raw_fd()
    }

    fn list_names(&self) -> Result<Vec<String>, String> {
        // `dup` would share the directory stream offset with the held handle,
        // making a second scan appear empty. Reopen `.` relative to the held
        // descriptor to get an independent stream without resolving a path.
        let dot = c".";
        let scan_fd = unsafe {
            libc::openat(
                self.fd(),
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if scan_fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let directory = unsafe { libc::fdopendir(scan_fd) };
        if directory.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe { libc::close(scan_fd) };
            return Err(error.to_string());
        }

        let result = (|| {
            let mut names = Vec::new();
            loop {
                unsafe { *__error() = 0 };
                let entry = unsafe { libc::readdir(directory) };
                if entry.is_null() {
                    let errno = unsafe { *__error() };
                    return if errno == 0 {
                        Ok(names)
                    } else {
                        Err(std::io::Error::from_raw_os_error(errno).to_string())
                    };
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                let Ok(name) = name.to_str() else {
                    continue;
                };
                if name != "." && name != ".." {
                    names.push(name.to_string());
                }
            }
        })();
        unsafe { libc::closedir(directory) };
        result
    }

    fn open_regular_rw(&self, name: &str) -> Result<(std::fs::File, EntryIdentity), String> {
        let name = request_component(name)?;
        let fd = unsafe {
            libc::openat(
                self.fd(),
                name.as_ptr(),
                libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Finder request entry is not a regular file.".to_string());
        }
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) }
                < 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let identity = EntryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        Ok((file, identity))
    }

    fn named_identity(&self, name: &str) -> Result<EntryIdentity, String> {
        let name = request_component(name)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                self.fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err("Finder request entry is not a regular file.".to_string());
        }
        Ok(EntryIdentity {
            device: stat.st_dev as u64,
            inode: stat.st_ino,
        })
    }

    fn name_matches(&self, name: &str, identity: EntryIdentity) -> bool {
        self.named_identity(name)
            .is_ok_and(|actual| actual == identity)
    }

    fn rename_exclusive(&self, from: &str, to: &str) -> Result<(), String> {
        let from = request_component(from)?;
        let to = request_component(to)?;
        let result = unsafe {
            renameatx_np(
                self.fd(),
                from.as_ptr(),
                self.fd(),
                to.as_ptr(),
                RENAME_EXCL,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }

    fn unlink(&self, name: &str) -> Result<(), String> {
        let name = request_component(name)?;
        if unsafe { libc::unlinkat(self.fd(), name.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }

    fn quarantine_and_unlink(&self, name: &str, expected: EntryIdentity) -> Result<(), String> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|error| error.to_string())?;
        let quarantine = format!(
            ".zinnia-request-quarantine-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        self.rename_exclusive(name, &quarantine)?;
        if !self.name_matches(&quarantine, expected) {
            return match self.rename_exclusive(&quarantine, name) {
                Ok(()) => Err(
                    "Finder request changed before quarantine and was preserved.".to_string(),
                ),
                Err(restore_error) => Err(format!(
                    "Finder request changed before quarantine and was preserved as {quarantine}; its original name could not be restored: {restore_error}"
                )),
            };
        }
        self.unlink(&quarantine)?;
        self.file.sync_all().map_err(|error| error.to_string())
    }
}

fn request_component(name: &str) -> Result<CString, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err("Finder request entry has an unsafe name.".to_string());
    }
    CString::new(name).map_err(|_| "Finder request entry contains a NUL byte.".to_string())
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

fn request_directory() -> Result<RequestDirectory, String> {
    let path = group_container()
        .ok_or_else(|| "Finder App Group container is unavailable.".to_string())?
        .join(REQUESTS_DIRECTORY);
    RequestDirectory::open(&path)
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

fn read_valid_request(file: &mut std::fs::File, now_ms: u64) -> Result<FinderSyncRequest, String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.len() > MAX_REQUEST_BYTES {
        return Err("Finder request exceeds its byte limit.".to_string());
    }
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut json = String::new();
    file.take(MAX_REQUEST_BYTES.saturating_add(1))
        .read_to_string(&mut json)
        .map_err(|error| error.to_string())?;
    if json.len() as u64 > MAX_REQUEST_BYTES {
        return Err("Finder request exceeds its byte limit.".to_string());
    }
    let request: FinderSyncRequest =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if !valid_request_at(&request, now_ms) {
        return Err("Finder request is invalid or expired.".to_string());
    }
    Ok(request)
}

fn invalidate_held_request(file: &mut std::fs::File) -> Result<(), String> {
    file.set_len(0).map_err(|error| error.to_string())?;
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    file.write_all(b"{}").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn invalidate_and_unlink(
    directory: &RequestDirectory,
    name: &str,
    file: &mut std::fs::File,
    identity: EntryIdentity,
) -> Result<(), String> {
    invalidate_held_request(file)?;
    directory.quarantine_and_unlink(name, identity)
}

/// Orphaned `*.claimed` files (crash between claim and ack) would otherwise
/// never re-enter the drain queue because only `*.json` is scanned.
fn sweep_orphaned_claimed_requests(directory: &RequestDirectory, now_ms: u64) {
    let Ok(names) = directory.list_names() else {
        return;
    };
    for claimed in names.into_iter().filter(|name| name.ends_with(".claimed")) {
        let Some(stem) = claimed.strip_suffix(".claimed") else {
            continue;
        };
        let restore = format!("{stem}.json");
        let Ok((mut file, identity)) = directory.open_regular_rw(&claimed) else {
            continue;
        };
        if !directory.name_matches(&claimed, identity) {
            continue;
        }
        if read_valid_request(&mut file, now_ms).is_ok() {
            if let Err(error) = directory.rename_exclusive(&claimed, &restore) {
                eprintln!(
                    "Zinnia Finder Sync: could not exclusively restore orphaned request: {error}"
                );
            }
        } else if let Err(error) = invalidate_and_unlink(directory, &claimed, &mut file, identity) {
            eprintln!("Zinnia Finder Sync: could not discard stale claimed request: {error}");
        }
    }
}

fn has_pending_requests() -> bool {
    let Ok(directory) = request_directory() else {
        return false;
    };
    directory.list_names().is_ok_and(|names| {
        names.into_iter().any(|name| {
            (name.ends_with(".json") || name.ends_with(".claimed"))
                && directory.named_identity(&name).is_ok()
        })
    })
}

fn drain_directory<F>(directory: &RequestDirectory, now_ms: u64, mut emit: F) -> bool
where
    F: FnMut(Vec<String>) -> bool,
{
    sweep_orphaned_claimed_requests(directory, now_ms);

    let Ok(mut names) = directory.list_names() else {
        return false;
    };
    // Producer names begin with a fixed-width timestamp, so lexical ordering
    // preserves the prior created-at ordering without parsing before claim.
    names.retain(|name| name.ends_with(".json"));
    names.sort();

    let mut routed = false;
    for original in names.into_iter().take(MAX_REQUESTS_PER_DRAIN) {
        let Some(stem) = original.strip_suffix(".json") else {
            continue;
        };
        let claimed = format!("{stem}.claimed");
        // Open the source first to bind its identity, but claim it exclusively
        // before reading/parsing any attacker-controlled bytes.
        let Ok((mut file, identity)) = directory.open_regular_rw(&original) else {
            continue;
        };
        if let Err(error) = directory.rename_exclusive(&original, &claimed) {
            eprintln!("Zinnia Finder Sync: could not exclusively claim request: {error}");
            continue;
        }
        if !directory.name_matches(&claimed, identity) {
            eprintln!("Zinnia Finder Sync: claimed request identity changed; refusing delivery");
            continue;
        }

        let request = match read_valid_request(&mut file, now_ms) {
            Ok(request) => request,
            Err(error) => {
                if let Err(cleanup_error) =
                    invalidate_and_unlink(directory, &claimed, &mut file, identity)
                {
                    eprintln!(
                        "Zinnia Finder Sync: invalid request was preserved after cleanup failure: {error}; {cleanup_error}"
                    );
                }
                continue;
            }
        };
        let mut argv = vec!["zinnia".to_string(), format!("--{}", request.mode)];
        argv.extend(request.paths);
        if !emit(argv) {
            // Restore only the same claimed inode and never overwrite a newly
            // queued request that collided with its original name.
            if directory.name_matches(&claimed, identity) {
                if let Err(error) = directory.rename_exclusive(&claimed, &original) {
                    eprintln!(
                        "Zinnia Finder Sync: could not exclusively restore failed request: {error}"
                    );
                }
            }
            continue;
        }

        // Acknowledge through the already-open claimed handle. Never reopen the
        // pathname for write: a swapped symlink/name must not redirect truncation.
        if let Err(error) = invalidate_and_unlink(directory, &claimed, &mut file, identity) {
            eprintln!("Zinnia Finder Sync: request delivered but acknowledgement failed: {error}");
        }
        routed = true;
    }
    routed
}

/// Route queued requests, then acknowledge them by removing their files. A
/// full in-app queue leaves the durable request intact for a later drain.
pub(crate) fn route_pending_requests(app: &AppHandle) -> bool {
    let Ok(directory) = request_directory() else {
        return false;
    };
    drain_directory(&directory, unix_time_ms(), |argv| {
        crate::launch::emit_open_paths(app, argv)
    })
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
    use super::{drain_directory, valid_request_at, FinderSyncRequest, RequestDirectory};

    fn temp_root(label: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    fn write_request(path: &std::path::Path, created_at_ms: u64) {
        std::fs::write(
            path,
            format!(
                r#"{{"createdAtMs":{created_at_ms},"mode":"extract","paths":["/tmp/archive.7z"]}}"#
            ),
        )
        .expect("request");
    }

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

    #[test]
    fn request_directory_open_rejects_symlink() {
        use std::os::unix::fs::symlink;

        let root = temp_root("zinnia-finder-dir-symlink");
        let real = root.join("real");
        let link = root.join("link");
        std::fs::create_dir_all(&real).expect("real dir");
        symlink(&real, &link).expect("dir symlink");
        assert!(RequestDirectory::open(&link).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn exclusive_claim_collision_never_overwrites_existing_claim() {
        let root = temp_root("zinnia-finder-claim-collision");
        std::fs::create_dir_all(&root).expect("request dir");
        let original = root.join("0000000010000-token.json");
        let claimed = root.join("0000000010000-token.claimed");
        write_request(&original, 10_000);
        write_request(&claimed, 10_000);
        let collision = std::fs::read(&claimed).expect("collision bytes");
        let directory = RequestDirectory::open(&root).expect("open directory");

        assert!(!drain_directory(&directory, 10_000, |_| true));
        assert!(original.is_file());
        assert_eq!(std::fs::read(&claimed).unwrap(), collision);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn held_directory_is_authoritative_after_path_replacement() {
        let root = temp_root("zinnia-finder-held-dir");
        let queue = root.join("queue");
        let moved = root.join("moved");
        let replacement = root.join("replacement");
        std::fs::create_dir_all(&queue).expect("queue");
        let directory = RequestDirectory::open(&queue).expect("held queue");
        std::fs::rename(&queue, &moved).expect("move held queue");
        std::fs::create_dir(&queue).expect("replacement queue");
        write_request(&moved.join("0000000010000-token.json"), 10_000);
        std::fs::create_dir(&replacement).expect("unrelated");

        assert!(drain_directory(&directory, 10_000, |_| true));
        assert!(std::fs::read_dir(&moved).unwrap().next().is_none());
        assert!(std::fs::read_dir(&queue).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn replaced_claim_is_not_parsed_or_acknowledged() {
        let root = temp_root("zinnia-finder-replaced-claim");
        std::fs::create_dir_all(&root).expect("request dir");
        let original_name = "0000000010000-token.json";
        let claimed_name = "0000000010000-token.claimed";
        write_request(&root.join(original_name), 10_000);
        let outside = root.join("outside.txt");
        std::fs::write(&outside, b"outside").expect("outside");
        let directory = RequestDirectory::open(&root).expect("open directory");
        let (mut held, identity) = directory
            .open_regular_rw(original_name)
            .expect("open source");
        directory
            .rename_exclusive(original_name, claimed_name)
            .expect("claim");
        std::fs::remove_file(root.join(claimed_name)).expect("unlink claim name");
        std::os::unix::fs::symlink(&outside, root.join(claimed_name)).expect("replacement link");

        assert!(!directory.name_matches(claimed_name, identity));
        assert!(super::invalidate_held_request(&mut held).is_ok());
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn quarantine_ack_preserves_a_replacement_inserted_after_open() {
        let root = temp_root("zinnia-finder-quarantine-replacement");
        std::fs::create_dir_all(&root).expect("request dir");
        let claimed_name = "0000000010000-token.claimed";
        let claimed = root.join(claimed_name);
        write_request(&claimed, 10_000);
        let directory = RequestDirectory::open(&root).expect("open directory");
        let (mut held, identity) = directory
            .open_regular_rw(claimed_name)
            .expect("open claimed request");
        std::fs::remove_file(&claimed).expect("unlink opened request name");
        std::fs::write(&claimed, b"replacement").expect("replacement request");

        let error = super::invalidate_and_unlink(&directory, claimed_name, &mut held, identity)
            .expect_err("replacement must fail closed");
        assert!(error.contains("preserved"));
        assert_eq!(std::fs::read(&claimed).unwrap(), b"replacement");
        assert!(std::fs::read_dir(&root)
            .expect("request directory")
            .all(|entry| !entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".zinnia-request-quarantine-")));
        let _ = std::fs::remove_dir_all(root);
    }
}
