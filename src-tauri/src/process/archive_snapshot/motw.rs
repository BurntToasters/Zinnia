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

    let source_file = crate::path_safety::open_regular_file_nofollow(source)?;
    let opened_identity = crate::process::journal::file_identity(&source_file)?;
    if let Some(expected) = expected_source_identity {
        if !crate::process::journal::file_identities_match(&opened_identity, expected) {
            return Err(
                "The download-marker source changed before the archive could be marked."
                    .to_string(),
            );
        }
    }
    drop(source_file);

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
