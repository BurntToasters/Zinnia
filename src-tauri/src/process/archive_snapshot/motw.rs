//! Windows Mark-of-the-Web (Zone.Identifier) preservation.

#[cfg(windows)]
pub(crate) fn copy_windows_zone_identifier(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    copy_windows_zone_identifier_with_identity(source, destination, None)
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn copy_windows_zone_identifier_with_identity(
    source: &std::path::Path,
    destination: &std::path::Path,
    expected_source_identity: Option<&crate::process::journal::FileIdentity>,
) -> Result<(), String> {
    use std::io::{Read as _, Write as _};

    const SOURCE_CHANGED: &str =
        "The download-marker source changed before the archive could be marked.";
    // Held open until the stream is read, so the identity observed here stays
    // bound to the file whose stream is read below.
    let source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    let opened_identity = crate::process::journal::file_identity(&source_file)?;
    if let Some(expected) = expected_source_identity {
        if !crate::process::journal::file_identities_match(&opened_identity, expected) {
            return Err(SOURCE_CHANGED.to_string());
        }
    }

    const MAX_ZONE_BYTES: u64 = 64 * 1024;
    fn stream_path(path: &std::path::Path) -> std::path::PathBuf {
        let mut value = path.as_os_str().to_os_string();
        value.push(":Zone.Identifier");
        value.into()
    }

    fn zone_text_is_valid(text: &str) -> bool {
        let trimmed = text.trim_start_matches('\u{feff}').trim_start();
        trimmed.starts_with("[ZoneTransfer]")
    }

    fn decode_zone_identifier(contents: &[u8]) -> Option<Vec<u8>> {
        if !contents.contains(&0) && zone_text_is_valid(std::str::from_utf8(contents).ok()?) {
            return Some(contents.to_vec());
        }
        let utf16 = if contents.starts_with(&[0xFF, 0xFE]) {
            let mut units = Vec::with_capacity(contents.len() / 2);
            for chunk in contents[2..].as_chunks::<2>().0 {
                units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            String::from_utf16(&units).ok()?
        } else if contents.len() >= 2 && contents.len().is_multiple_of(2) && contents.contains(&0) {
            let mut units = Vec::with_capacity(contents.len() / 2);
            for chunk in contents.as_chunks::<2>().0 {
                units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            String::from_utf16(&units).ok()?
        } else {
            return None;
        };
        if !zone_text_is_valid(&utf16) {
            return None;
        }
        Some(utf16.into_bytes())
    }

    let mut source_stream = match std::fs::File::open(stream_path(source)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!("Could not read archive Mark-of-the-Web: {error}"));
        }
    };
    let length = source_stream
        .metadata()
        .map_err(|error| format!("Could not inspect archive Mark-of-the-Web: {error}"))?
        .len();
    if length > MAX_ZONE_BYTES {
        return Err("Archive Mark-of-the-Web is unexpectedly large.".to_string());
    }
    let mut contents = Vec::with_capacity(length as usize);
    source_stream
        .read_to_end(&mut contents)
        .map_err(|error| format!("Could not read archive Mark-of-the-Web: {error}"))?;
    // Re-open the source by path and confirm it still is the file observed at
    // the first open. The stream above was read by path, so a swap in between
    // would otherwise mark the archive with another file's stream.
    let reopened = crate::path_safety::open_regular_file_nofollow(source)
        .map_err(|_| SOURCE_CHANGED.to_string())?;
    let reopened_identity = crate::process::journal::file_identity(&reopened)?;
    let matches_expected = expected_source_identity.is_none_or(|expected| {
        crate::process::journal::file_identities_match(&reopened_identity, expected)
    });
    if !crate::process::journal::file_identities_match(&reopened_identity, &opened_identity)
        || !matches_expected
    {
        return Err(SOURCE_CHANGED.to_string());
    }
    drop(reopened);
    drop(source_file);
    if contents.is_empty() {
        return Ok(());
    }
    let Some(payload) = decode_zone_identifier(&contents) else {
        return Err("Archive Mark-of-the-Web has an invalid format.".to_string());
    };
    const ERROR_INVALID_FUNCTION: i32 = 1;
    const ERROR_NOT_SUPPORTED: i32 = 50;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    const ERROR_INVALID_NAME: i32 = 123;
    let mut destination_stream = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(stream_path(destination))
    {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(
                    ERROR_INVALID_FUNCTION
                        | ERROR_NOT_SUPPORTED
                        | ERROR_INVALID_PARAMETER
                        | ERROR_INVALID_NAME
                )
            ) =>
        {
            eprintln!(
                "Skipping Mark-of-the-Web for {}: the destination volume does not support alternate data streams ({error}).",
                destination.display()
            );
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "Could not preserve archive Mark-of-the-Web: {error}"
            ))
        }
    };
    destination_stream
        .write_all(&payload)
        .and_then(|()| destination_stream.sync_all())
        .map_err(|error| format!("Could not preserve archive Mark-of-the-Web: {error}"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::copy_windows_zone_identifier;

    struct ScratchDir {
        path: std::path::PathBuf,
    }

    impl ScratchDir {
        fn new(name: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};

            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            loop {
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir()
                    .join(format!("zinnia-motw-{name}-{}-{id}", std::process::id()));
                match std::fs::create_dir(&path) {
                    Ok(()) => return Self { path },
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("scratch directory should be created: {error}"),
                }
            }
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn zone_stream(path: &std::path::Path) -> std::path::PathBuf {
        let mut value = path.as_os_str().to_os_string();
        value.push(":Zone.Identifier");
        value.into()
    }

    fn copy_with_source_stream(
        scratch: &ScratchDir,
        stream: &[u8],
    ) -> (std::path::PathBuf, Result<(), String>) {
        let source = scratch.path.join("archive.7z");
        let destination = scratch.path.join("snapshot.7z");
        std::fs::write(&source, b"archive payload").expect("source archive");
        std::fs::write(&destination, b"snapshot payload").expect("destination archive");
        std::fs::write(zone_stream(&source), stream).expect("source Zone.Identifier stream");
        let result = copy_windows_zone_identifier(&source, &destination);
        (destination, result)
    }

    #[test]
    fn empty_zone_identifier_stream_is_treated_as_no_zone() {
        let scratch = ScratchDir::new("empty");
        let (destination, result) = copy_with_source_stream(&scratch, b"");
        result.expect("an empty Zone.Identifier stream should mean no zone");
        let missing = std::fs::metadata(zone_stream(&destination))
            .expect_err("no destination Zone.Identifier stream should be written");
        assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn zone_transfer_header_without_zone_id_is_copied_verbatim() {
        let scratch = ScratchDir::new("header-only");
        let stream = b"[ZoneTransfer]\r\n";
        let (destination, result) = copy_with_source_stream(&scratch, stream);
        result.expect("a Zone.Identifier with only the header should copy");
        assert_eq!(
            std::fs::read(zone_stream(&destination)).expect("destination Zone.Identifier"),
            stream
        );
    }

    #[test]
    fn zone_id_three_is_copied_verbatim() {
        let scratch = ScratchDir::new("zone-three");
        let stream = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        let (destination, result) = copy_with_source_stream(&scratch, stream);
        result.expect("a Zone.Identifier with ZoneId=3 should copy");
        assert_eq!(
            std::fs::read(zone_stream(&destination)).expect("destination Zone.Identifier"),
            stream
        );
    }
}
