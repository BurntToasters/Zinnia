//! Staged extract tree validation and planning.

use super::super::journal::{
    file_identities_match, file_identity, fingerprint_path_bytes, fingerprint_records,
    fingerprint_symlink, identity_with_object_fingerprint, path_entry_identity, path_identity,
    FileIdentity, MoveRecord, ObjectFingerprint,
};
use super::super::quota::{MAX_EXTRACT_ENTRIES, MAX_EXTRACT_PATH_BYTES};
use super::{auto_rename_path, sync_file_best_effort};

pub(crate) const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

pub(crate) fn assert_path_under_root(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("Staged path escaped the extract root: {}", path.display()))?;
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

pub(crate) fn validate_staged_tree(root: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    validate_staged_tree_impl(root, max_bytes, false, false).map(|_| ())
}

pub(super) fn validate_and_sync_staged_tree(
    root: &std::path::Path,
    max_bytes: u64,
) -> Result<FileIdentity, String> {
    validate_staged_tree_impl(root, max_bytes, true, true)?.map_or_else(
        || Err("Staged tree fingerprint was not produced during final validation.".to_string()),
        |fingerprint| {
            let identity = path_entry_identity(root)?;
            Ok(identity_with_object_fingerprint(identity, fingerprint))
        },
    )
}

pub(super) fn sync_staged_tree_without_fingerprint(
    root: &std::path::Path,
    max_bytes: u64,
) -> Result<(), String> {
    validate_staged_tree_impl(root, max_bytes, true, false).map(|_| ())
}

enum StagedFingerprintEntry {
    Regular(std::path::PathBuf),
    Directory,
    Symlink(ObjectFingerprint),
}

fn validate_staged_tree_impl(
    root: &std::path::Path,
    max_bytes: u64,
    sync_contents: bool,
    fingerprint_contents: bool,
) -> Result<Option<ObjectFingerprint>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut directories = Vec::new();
    let mut entries = 0u64;
    let mut bytes = 0u64;
    let mut path_bytes = 0u64;
    let mut regular_files = Vec::new();
    let mut fingerprint_entries = Vec::<(Vec<u8>, StagedFingerprintEntry)>::new();
    let mut observed_entries = Vec::<(
        std::path::PathBuf,
        FileIdentity,
        u64,
        Option<std::time::SystemTime>,
    )>::new();
    // Defense in depth for hard links: 7-Zip may create them by default. If any
    // staged file's link count exceeds the number of names we observed for that
    // inode under the stage root, it aliases a path outside the extract tree.
    #[cfg(unix)]
    let mut hardlink_files: Vec<(std::path::PathBuf, u64, u64, u64)> = Vec::new();
    #[cfg(windows)]
    let mut hardlink_files: Vec<(std::path::PathBuf, u64, u64)> = Vec::new();
    while let Some(directory) = pending.pop() {
        assert_path_under_root(root, &directory)?;
        let meta = std::fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
            return Err(format!("Unsafe staged directory: {}", directory.display()));
        }
        directories.push(directory.clone());
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            entries = entries.saturating_add(1);
            if entries > MAX_EXTRACT_ENTRIES {
                return Err(format!(
                    "Archive exceeds the {MAX_EXTRACT_ENTRIES}-entry safety limit."
                ));
            }
            let path = entry.path();
            path_bytes = path_bytes.saturating_add(
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .as_os_str()
                    .as_encoded_bytes()
                    .len() as u64,
            );
            if path_bytes > MAX_EXTRACT_PATH_BYTES {
                return Err(format!(
                    "Archive exceeds the {} MiB aggregate path-name safety limit.",
                    MAX_EXTRACT_PATH_BYTES / (1024 * 1024)
                ));
            }
            assert_path_under_root(root, &path)?;
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                crate::path_safety::assert_relative_symlink_within_root(root, &path)?;
                if fingerprint_contents {
                    let identity = path_entry_identity(&path)?;
                    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
                    fingerprint_entries.push((
                        fingerprint_path_bytes(relative.as_os_str()),
                        StagedFingerprintEntry::Symlink(fingerprint_symlink(&path)?),
                    ));
                    observed_entries.push((
                        path.clone(),
                        identity,
                        meta.len(),
                        meta.modified().ok(),
                    ));
                }
                continue;
            }
            if crate::path_safety::is_link_or_reparse(&meta) {
                return Err(format!(
                    "Archive contains a symbolic link or reparse point: {}",
                    path.display()
                ));
            }
            let sync_identity = fingerprint_contents
                .then(|| path_entry_identity(&path))
                .transpose()?;
            let sync_relative = fingerprint_contents
                .then(|| {
                    path.strip_prefix(root)
                        .map(|relative| fingerprint_path_bytes(relative.as_os_str()))
                        .map_err(|error| error.to_string())
                })
                .transpose()?;
            if meta.is_dir() {
                if let (Some(identity), Some(relative)) = (sync_identity, sync_relative) {
                    observed_entries.push((
                        path.clone(),
                        identity,
                        meta.len(),
                        meta.modified().ok(),
                    ));
                    fingerprint_entries.push((relative, StagedFingerprintEntry::Directory));
                }
                pending.push(path);
            } else if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
                if bytes > max_bytes {
                    return Err(format!(
                        "Archive exceeds its {:.1} GiB expanded-size safety limit.",
                        max_bytes as f64 / 1_073_741_824.0
                    ));
                }
                if sync_contents {
                    regular_files.push(path.clone());
                }
                if let (Some(identity), Some(relative)) = (sync_identity, sync_relative) {
                    observed_entries.push((
                        path.clone(),
                        identity,
                        meta.len(),
                        meta.modified().ok(),
                    ));
                    fingerprint_entries
                        .push((relative, StagedFingerprintEntry::Regular(path.clone())));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt as _;
                    hardlink_files.push((path.clone(), meta.dev(), meta.ino(), meta.nlink()));
                }
                #[cfg(windows)]
                {
                    // `MetadataExt::{file_index,number_of_links}` need the
                    // unstable `windows_by_handle` feature. Use the same stable
                    // GetFileInformationByHandle path as journal identities.
                    use std::os::windows::io::AsRawHandle as _;
                    use windows_sys::Win32::Foundation::HANDLE;
                    use windows_sys::Win32::Storage::FileSystem::{
                        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
                    };
                    let file = crate::path_safety::open_regular_file_nofollow(&path).map_err(
                        |_| {
                            format!(
                                "Archive contains a hard link whose identity could not be verified: {}",
                                path.display()
                            )
                        },
                    )?;
                    let handle = file.as_raw_handle() as HANDLE;
                    // SAFETY: BY_HANDLE_FILE_INFORMATION holds only integers, so all-zero is valid;
                    // GetFileInformationByHandle overwrites it on success.
                    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
                    // SAFETY: `handle` comes from `file`, which is live for this call, and `info`
                    // is a live writable struct of the type the API fills.
                    let success = unsafe { GetFileInformationByHandle(handle, &mut info) };
                    if success == 0 {
                        return Err(format!(
                            "Archive contains a hard link whose identity could not be verified: {}",
                            path.display()
                        ));
                    }
                    let file_index =
                        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
                    let nlink = u64::from(info.nNumberOfLinks);
                    hardlink_files.push((path.clone(), file_index, nlink));
                }
            } else {
                return Err(format!(
                    "Archive contains an unsupported entry: {}",
                    path.display()
                ));
            }
        }
    }
    #[cfg(unix)]
    assert_staged_hardlinks_self_contained(&hardlink_files)?;
    #[cfg(windows)]
    assert_staged_hardlinks_self_contained(&hardlink_files)?;
    if sync_contents {
        let fingerprints = sync_staged_regular_files(&regular_files, fingerprint_contents)?;
        if !fingerprint_contents {
            directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
            for directory in directories {
                crate::fs_secure::sync_directory_nofollow(&directory)?;
            }
            return Ok(None);
        }
        let fingerprints = fingerprints
            .ok_or_else(|| "Final staged-file fingerprints were not produced.".to_string())?;
        let records = fingerprint_entries
            .into_iter()
            .map(|(relative, entry)| {
                let fingerprint = match entry {
                    StagedFingerprintEntry::Regular(path) => {
                        fingerprints.get(&path).cloned().ok_or_else(|| {
                            format!(
                                "Final staged-file fingerprint was not produced: {}",
                                path.display()
                            )
                        })
                    }
                    StagedFingerprintEntry::Directory => {
                        Ok(ObjectFingerprint::Directory { sha256: [0; 32] })
                    }
                    StagedFingerprintEntry::Symlink(fingerprint) => Ok(fingerprint),
                }?;
                Ok::<_, String>((relative, fingerprint))
            })
            .collect::<Result<Vec<_>, _>>()?;
        for (path, expected, len, modified) in observed_entries {
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            let actual = path_entry_identity(&path)?;
            if !file_identities_match(&actual, &expected)
                || metadata.len() != len
                || metadata.modified().ok() != modified
            {
                return Err(format!(
                    "Staged path changed while being prepared for durable publication: {}",
                    path.display()
                ));
            }
        }
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            crate::fs_secure::sync_directory_nofollow(&directory)?;
        }
        return Ok(Some(fingerprint_records(records)));
    }
    Ok(None)
}

fn sync_staged_regular_files(
    paths: &[std::path::PathBuf],
    fingerprint_contents: bool,
) -> Result<Option<std::collections::HashMap<std::path::PathBuf, ObjectFingerprint>>, String> {
    if paths.is_empty() {
        return Ok(fingerprint_contents.then(std::collections::HashMap::new));
    }
    let worker_count = std::thread::available_parallelism()
        .map(|count| count.get().min(8))
        .unwrap_or(1)
        .min(paths.len())
        .max(1);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let first_error = std::sync::Mutex::new(None::<String>);
    let fingerprints = std::sync::Mutex::new(std::collections::HashMap::new());
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| loop {
                if first_error
                    .lock()
                    .map(|error| error.is_some())
                    .unwrap_or(true)
                {
                    break;
                }
                let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(path) = paths.get(index) else {
                    break;
                };
                let result = (|| {
                    use sha2::Digest as _;
                    use std::io::{Read as _, Seek as _};

                    let mut file = crate::path_safety::open_regular_file_nofollow(path)?;
                    let opened_identity = file_identity(&file)?;
                    let before = file.metadata().map_err(|error| error.to_string())?;
                    let current_identity = path_identity(path)?;
                    if !file_identities_match(&opened_identity, &current_identity) {
                        return Err(format!(
                            "Staged file changed while being prepared for durable publication: {}",
                            path.display()
                        ));
                    }
                    sync_file_best_effort(&file)?;
                    if !fingerprint_contents {
                        let after_identity = path_identity(path)?;
                        if !file_identities_match(&opened_identity, &after_identity) {
                            return Err(format!(
                                "Staged file changed while being prepared for durable publication: {}",
                                path.display()
                            ));
                        }
                        return Ok::<_, String>(None);
                    }
                    file.seek(std::io::SeekFrom::Start(0))
                        .map_err(|error| error.to_string())?;
                    let mut hasher = sha2::Sha256::new();
                    let mut buffer = [0u8; 128 * 1024];
                    loop {
                        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
                        if read == 0 {
                            break;
                        }
                        hasher.update(&buffer[..read]);
                    }
                    let after_identity = file_identity(&file)?;
                    let after = file.metadata().map_err(|error| error.to_string())?;
                    if !file_identities_match(&opened_identity, &after_identity)
                        || before.len() != after.len()
                        || before.modified().ok() != after.modified().ok()
                    {
                        return Err(format!(
                            "Staged file changed while being prepared for durable publication: {}",
                            path.display()
                        ));
                    }
                    Ok::<_, String>(Some(ObjectFingerprint::File {
                        len: before.len(),
                        sha256: hasher.finalize().into(),
                    }))
                })();
                match result {
                    Ok(Some(fingerprint)) => {
                        if let Ok(mut fingerprints) = fingerprints.lock() {
                            fingerprints.insert(path.clone(), fingerprint);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        if let Ok(mut first) = first_error.lock() {
                            if first.is_none() {
                                *first = Some(error);
                            }
                        }
                        break;
                    }
                }
            });
        }
    });
    first_error
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .map_or_else(
            || {
                Ok(fingerprint_contents.then(|| {
                    fingerprints
                        .into_inner()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                }))
            },
            Err,
        )
}

#[cfg(unix)]
fn assert_staged_hardlinks_self_contained(
    files: &[(std::path::PathBuf, u64, u64, u64)],
) -> Result<(), String> {
    use std::collections::HashMap;

    let mut staged_names: HashMap<(u64, u64), u64> = HashMap::new();
    for (_, dev, ino, _) in files {
        *staged_names.entry((*dev, *ino)).or_insert(0) += 1;
    }
    for (path, dev, ino, nlink) in files {
        let staged = staged_names.get(&(*dev, *ino)).copied().unwrap_or(0);
        if *nlink > staged {
            return Err(format!(
                "Archive contains a hard link that aliases a file outside the extract root: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn assert_staged_hardlinks_self_contained(
    files: &[(std::path::PathBuf, u64, u64)],
) -> Result<(), String> {
    use std::collections::HashMap;

    let mut staged_names: HashMap<u64, u64> = HashMap::new();
    for (_, file_index, _) in files {
        *staged_names.entry(*file_index).or_insert(0) += 1;
    }
    for (path, file_index, nlink) in files {
        let staged = staged_names.get(file_index).copied().unwrap_or(0);
        if *nlink > staged {
            return Err(format!(
                "Archive contains a hard link that aliases a file outside the extract root: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

pub(crate) fn plan_staged_contents(
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
        plan.push(MoveRecord {
            source,
            target,
            publish_temp: None,
            publish_identity: None,
        });
    }
    Ok(())
}

pub(super) fn is_publish_temp_name(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(token) = name.strip_prefix(".zinnia-publish-") else {
        return false;
    };
    token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// True when `root` contains any symbolic-link entry. Non-symlink reparse points
/// are rejected: staged trees should already have failed closed on those.
#[cfg(test)]
pub(crate) fn staged_tree_contains_symlink(root: &std::path::Path) -> Result<bool, String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Ok(true);
            }
            if crate::path_safety::is_link_or_reparse(&metadata) {
                return Err(format!(
                    "Archive contains a symbolic link or reparse point: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(false)
}
