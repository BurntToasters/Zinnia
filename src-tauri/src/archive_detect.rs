//! Archive detection by magic bytes / TAR header, and extension-vs-header validation.

use std::io::Read;

const ARCHIVE_SIGNATURE_SCAN_BYTES: usize = 512;
/// Keep aligned with `src/archive-rules.ts` MAX_ARCHIVE_PATHS and the 7-Zip
/// argument ceiling in `validation.rs`.
const MAX_ARCHIVE_PATHS: usize = 4096;
/// Keep aligned with `src/archive-rules.ts` MAX_ARCHIVE_PATHS_IPC_BYTES. The
/// command accepts one JSON string so this check occurs before allocating a
/// `Vec<String>` from an untrusted IPC request.
const MAX_ARCHIVE_PATHS_IPC_BYTES: usize = 4 * 1024 * 1024;

#[derive(serde::Serialize, Clone, Debug)]
pub struct ArchivePathValidation {
    pub path: String,
    pub valid: bool,
    pub reason: Option<String>,
}

fn expected_archive_family(lower_path: &str) -> Option<&'static str> {
    if lower_path.ends_with(".7z") {
        Some("7z")
    } else if lower_path.ends_with(".zip") {
        Some("zip")
    } else if lower_path.ends_with(".rar") {
        Some("rar")
    } else if lower_path.ends_with(".tar") {
        Some("tar")
    } else if lower_path.ends_with(".gz") || lower_path.ends_with(".tgz") {
        Some("gzip")
    } else if lower_path.ends_with(".bz2") || lower_path.ends_with(".tbz2") {
        Some("bzip2")
    } else if lower_path.ends_with(".xz") || lower_path.ends_with(".txz") {
        Some("xz")
    } else {
        None
    }
}

fn starts_with_bytes(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len() && &bytes[..prefix.len()] == prefix
}

pub fn detect_archive_signature(bytes: &[u8]) -> Option<&'static str> {
    if starts_with_bytes(bytes, &[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return Some("7z");
    }
    if starts_with_bytes(bytes, &[0x50, 0x4B, 0x03, 0x04])
        || starts_with_bytes(bytes, &[0x50, 0x4B, 0x05, 0x06])
        || starts_with_bytes(bytes, &[0x50, 0x4B, 0x07, 0x08])
    {
        return Some("zip");
    }
    if starts_with_bytes(bytes, &[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])
        || starts_with_bytes(bytes, &[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00])
    {
        return Some("rar");
    }
    if starts_with_bytes(bytes, &[0x1F, 0x8B]) {
        return Some("gzip");
    }
    if starts_with_bytes(bytes, b"BZh") {
        return Some("bzip2");
    }
    if starts_with_bytes(bytes, &[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
        return Some("xz");
    }
    None
}

fn parse_tar_octal_field(field: &[u8]) -> Option<u64> {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    let text = String::from_utf8_lossy(&field[..end]).trim().to_string();
    if text.is_empty() {
        return None;
    }
    u64::from_str_radix(text.trim(), 8).ok()
}

fn is_valid_tar_typeflag(flag: u8) -> bool {
    matches!(
        flag,
        0 | b'0'
            | b'1'
            | b'2'
            | b'3'
            | b'4'
            | b'5'
            | b'6'
            | b'7'
            | b'g'
            | b'x'
            | b'L'
            | b'K'
            | b'S'
            | b'V'
            | b'A'
            | b'D'
            | b'M'
            | b'N'
    )
}

fn is_ascii_printable_or_blank(field: &[u8]) -> bool {
    field
        .iter()
        .all(|byte| *byte == 0 || *byte == b' ' || (0x21..=0x7E).contains(byte))
}

fn has_tar_checksum(bytes: &[u8]) -> bool {
    if bytes.len() < 512 {
        return false;
    }

    if !is_valid_tar_typeflag(bytes[156]) {
        return false;
    }
    if !is_ascii_printable_or_blank(&bytes[0..100]) {
        return false;
    }
    if parse_tar_octal_field(&bytes[124..136]).is_none() {
        return false;
    }
    if parse_tar_octal_field(&bytes[136..148]).is_none() {
        return false;
    }

    let stored = match parse_tar_octal_field(&bytes[148..156]) {
        Some(value) => value,
        None => return false,
    };

    let mut computed: u64 = 0;
    for (index, byte) in bytes.iter().copied().take(512).enumerate() {
        if (148..156).contains(&index) {
            computed += 0x20;
        } else {
            computed += byte as u64;
        }
    }

    computed == stored
}

pub fn has_tar_signature(bytes: &[u8]) -> bool {
    if bytes.len() < 512 {
        return false;
    }
    bytes.get(257..262) == Some(b"ustar") || has_tar_checksum(bytes)
}

fn read_probe_bytes(path: &std::path::Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; max_bytes];
    let read = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(read);
    Ok(buf)
}

#[cfg(target_os = "windows")]
pub fn is_rar_archive_file(path: &std::path::Path) -> Result<bool, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    crate::path_safety::reject_link_or_reparse(path, &meta)?;
    if !meta.is_file() {
        return Err("Path is not a file.".to_string());
    }
    let bytes = read_probe_bytes(path, 8)?;
    Ok(detect_archive_signature(&bytes) == Some("rar"))
}

fn extension_mismatch_reason(expected: &str, detected: Option<&str>, tar: bool) -> String {
    if expected == "tar" && tar {
        return String::new();
    }

    match detected {
        Some(kind) => format!("Extension indicates {expected} but header appears to be {kind}."),
        None => format!("Extension indicates {expected} but the archive header is unrecognized."),
    }
}

fn resolve_ascii_case_insensitive_sibling(
    expected: &std::path::Path,
) -> Result<Option<std::path::PathBuf>, String> {
    let parent = expected
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let expected_name = expected
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Archive volume has an invalid file name.".to_string())?;
    let mut matched = None;
    for entry in std::fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.eq_ignore_ascii_case(expected_name) {
            continue;
        }
        if matched.is_some() {
            return Err(format!(
                "Archive volume name is ambiguous when matched case-insensitively: {}",
                expected.display()
            ));
        }
        matched = Some(entry.path());
    }
    Ok(matched)
}

pub fn validate_archive_path(path: &str) -> ArchivePathValidation {
    let candidate = path;

    let invalid = |reason: &str| ArchivePathValidation {
        path: candidate.to_string(),
        valid: false,
        reason: Some(reason.to_string()),
    };

    if candidate.is_empty() {
        return invalid("Path is empty.");
    }
    if candidate.contains('\0') {
        return invalid("Path contains invalid characters.");
    }
    if candidate.len() > 4096 {
        return invalid("Path exceeds maximum length.");
    }

    let lower = candidate.to_lowercase();
    let fs_path = std::path::Path::new(candidate);

    let meta = match std::fs::symlink_metadata(fs_path) {
        Ok(meta) => meta,
        Err(err) => {
            let reason = if err.kind() == std::io::ErrorKind::NotFound {
                "File does not exist.".to_string()
            } else {
                format!("Unable to read file metadata: {}", err)
            };
            return ArchivePathValidation {
                path: candidate.to_string(),
                valid: false,
                reason: Some(reason),
            };
        }
    };
    if crate::path_safety::is_link_or_reparse(&meta) {
        return invalid(
            "Choose the real file, not a symbolic link or reparse point. Zinnia does not follow links as archive inputs.",
        );
    }
    if !meta.is_file() {
        return invalid("Path is not a file.");
    }

    let bytes = match read_probe_bytes(fs_path, ARCHIVE_SIGNATURE_SCAN_BYTES) {
        Ok(bytes) => bytes,
        Err(err) => {
            return ArchivePathValidation {
                path: candidate.to_string(),
                valid: false,
                reason: Some(format!("Unable to read file contents: {}", err)),
            };
        }
    };

    let signature = detect_archive_signature(&bytes);
    let tar = has_tar_signature(&bytes);

    // Windows RAR extract is blocked at run_7z (command `x`) for CVE-2026-58052.
    // Browse/test remain allowed so users can inspect archives without extracting.
    let split_zip_header_valid = || {
        let base = fs_path.with_extension("");
        let first = std::path::PathBuf::from(format!("{}.z01", base.to_string_lossy()));
        let Ok(Some(first)) = resolve_ascii_case_insensitive_sibling(&first) else {
            return false;
        };
        let Ok(metadata) = std::fs::symlink_metadata(&first) else {
            return false;
        };
        if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() {
            return false;
        }
        read_probe_bytes(&first, ARCHIVE_SIGNATURE_SCAN_BYTES)
            .ok()
            .is_some_and(|probe| detect_archive_signature(&probe) == Some("zip"))
    };

    let valid = match expected_archive_family(&lower) {
        Some("7z") => signature == Some("7z"),
        Some("zip") => signature == Some("zip") || split_zip_header_valid(),
        Some("rar") => signature == Some("rar"),
        Some("gzip") => signature == Some("gzip"),
        Some("bzip2") => signature == Some("bzip2"),
        Some("xz") => signature == Some("xz"),
        Some("tar") => tar,
        _ => signature.is_some() || tar,
    };

    if valid {
        return ArchivePathValidation {
            path: candidate.to_string(),
            valid: true,
            reason: None,
        };
    }

    let expected = expected_archive_family(&lower);
    let reason = match expected {
        Some(kind) => {
            let mismatch = extension_mismatch_reason(kind, signature, tar);
            if mismatch.is_empty() {
                "Archive header could not be validated.".to_string()
            } else {
                mismatch
            }
        }
        None => "File does not look like a supported archive.".to_string(),
    };

    ArchivePathValidation {
        path: candidate.to_string(),
        valid: false,
        reason: Some(reason),
    }
}

fn validate_archive_paths_blocking(
    paths_json: String,
) -> Result<Vec<ArchivePathValidation>, String> {
    if paths_json.len() > MAX_ARCHIVE_PATHS_IPC_BYTES {
        return Err(format!(
            "Archive-path validation request exceeds the {} MiB safety limit.",
            MAX_ARCHIVE_PATHS_IPC_BYTES / (1024 * 1024)
        ));
    }
    let paths: Vec<String> = serde_json::from_str(&paths_json).map_err(|_| {
        "Archive-path validation request must be a JSON array of paths.".to_string()
    })?;
    if paths.len() > MAX_ARCHIVE_PATHS {
        return Err(format!(
            "At most {MAX_ARCHIVE_PATHS} paths can be validated at once."
        ));
    }
    Ok(paths
        .into_iter()
        .map(|path| validate_archive_path(&path))
        .collect())
}

#[tauri::command]
pub async fn validate_archive_paths(
    paths_json: String,
) -> Result<Vec<ArchivePathValidation>, String> {
    tokio::task::spawn_blocking(move || validate_archive_paths_blocking(paths_json))
        .await
        .map_err(|error| format!("Archive-path validation worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_archive_signature_recognizes_known_headers() {
        assert_eq!(
            detect_archive_signature(&[0x50, 0x4B, 0x03, 0x04]),
            Some("zip")
        );
        assert_eq!(
            detect_archive_signature(&[0x50, 0x4B, 0x07, 0x08]),
            Some("zip")
        );
        assert_eq!(detect_archive_signature(&[0x1F, 0x8B, 0x08]), Some("gzip"));
        assert_eq!(
            detect_archive_signature(&[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]),
            Some("rar")
        );
        assert_eq!(detect_archive_signature(b"plain-text"), None);
    }

    #[test]
    fn validate_archive_paths_rejects_oversized_batches() {
        let paths_json = serde_json::to_string(&vec![String::new(); MAX_ARCHIVE_PATHS + 1])
            .expect("test paths should serialize");
        let result = validate_archive_paths_blocking(paths_json);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("At most 4096 paths"));
    }

    #[test]
    fn validation_rejects_oversized_ipc_payload_before_json_deserialization() {
        let result = validate_archive_paths_blocking("x".repeat(MAX_ARCHIVE_PATHS_IPC_BYTES + 1));
        assert!(result.is_err_and(|error| error.contains("safety limit")));
    }

    #[test]
    fn has_tar_signature_accepts_checksum_valid_block() {
        let mut block = [0u8; 512];
        block[0..8].copy_from_slice(b"file.txt");
        block[124..136].copy_from_slice(b"00000000000\0");
        block[136..148].copy_from_slice(b"00000000000\0");
        block[156] = b'0';
        for byte in &mut block[148..156] {
            *byte = b' ';
        }
        let checksum: u64 = block.iter().map(|b| *b as u64).sum();
        let checksum_field = format!("{:06o}\0 ", checksum);
        block[148..156].copy_from_slice(checksum_field.as_bytes());

        assert!(has_tar_signature(&block));
    }

    #[test]
    fn has_tar_signature_rejects_invalid_typeflag() {
        let mut block = [0u8; 512];
        block[0..8].copy_from_slice(b"file.txt");
        block[124..136].copy_from_slice(b"00000000000\0");
        block[136..148].copy_from_slice(b"00000000000\0");
        block[156] = 0xFF;
        for byte in &mut block[148..156] {
            *byte = b' ';
        }
        let checksum: u64 = block.iter().map(|b| *b as u64).sum();
        let checksum_field = format!("{:06o}\0 ", checksum);
        block[148..156].copy_from_slice(checksum_field.as_bytes());

        assert!(!has_tar_signature(&block));
    }

    #[test]
    fn validate_archive_path_accepts_extensionless_zip_signature() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-archive-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("archive-without-extension");
        std::fs::write(&file_path, [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
            .expect("probe file should be written");

        let path = file_path.to_string_lossy().to_string();
        assert!(validate_archive_path(&path).valid);

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn validate_archive_path_rejects_mislabeled_zip_file() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-archive-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let file_path = base.join("not-an-archive.zip");
        std::fs::write(&file_path, b"this is plain text").expect("probe file should be written");

        let path = file_path.to_string_lossy().to_string();
        let result = validate_archive_path(&path);
        assert!(!result.valid);
        assert!(result
            .reason
            .unwrap_or_default()
            .contains("Extension indicates zip"));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn validate_archive_path_accepts_split_zip_from_first_volume_header() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-split-zip-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let first = base.join("archive.z01");
        let final_volume = base.join("archive.zip");
        std::fs::write(&first, [0x50, 0x4B, 0x07, 0x08, 0x14, 0x00])
            .expect("first volume should be written");
        std::fs::write(&final_volume, b"continuation bytes")
            .expect("final volume should be written");

        assert!(validate_archive_path(&final_volume.to_string_lossy()).valid);

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn validate_archive_path_accepts_uppercase_split_zip_volume() {
        let base = std::env::temp_dir().join(format!(
            "zinnia-uppercase-split-zip-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp directory should be created");
        let first = base.join("archive.Z01");
        let final_volume = base.join("archive.ZIP");
        std::fs::write(&first, [0x50, 0x4B, 0x07, 0x08, 0x14, 0x00])
            .expect("first volume should be written");
        std::fs::write(&final_volume, b"continuation bytes")
            .expect("final volume should be written");

        assert!(validate_archive_path(&final_volume.to_string_lossy()).valid);

        let _ = std::fs::remove_dir_all(base);
    }
}
