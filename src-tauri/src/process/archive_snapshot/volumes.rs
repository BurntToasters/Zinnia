//! Multi-volume archive input family resolution.

use super::identity::{archive_file_identity, ArchiveFileIdentity};

pub(crate) fn assert_archive_identity_unchanged(
    archive: &std::path::Path,
    expected: &ArchiveFileIdentity,
) -> Result<(), String> {
    let current = super::archive_identity_from_snapshot_handle(archive)
        .or_else(|| archive_file_identity(archive).ok())
        .ok_or_else(|| "Could not read archive identity after member preflight.".to_string())?;
    if &current != expected {
        return Err(
            "Archive changed after its member-safety preflight; extraction was cancelled."
                .to_string(),
        );
    }
    Ok(())
}
pub(crate) fn archive_input_family(
    path: &std::path::Path,
) -> Result<Vec<std::path::PathBuf>, String> {
    const MAX_ARCHIVE_VOLUMES: u32 = 10_000;
    type FoldedSiblingIndex = std::collections::HashMap<String, Vec<std::path::PathBuf>>;

    fn checked_volume(path: &std::path::Path) -> Result<bool, String> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata)
                if crate::path_safety::is_link_or_reparse(&metadata) || !metadata.is_file() =>
            {
                Err(format!(
                    "Archive volume is not a regular file: {}",
                    path.display()
                ))
            }
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Could not inspect archive volume {}: {error}",
                path.display()
            )),
        }
    }

    fn resolve_volume(
        expected: &std::path::Path,
        family_prefix: &str,
        folded_siblings: &mut Option<FoldedSiblingIndex>,
    ) -> Result<Option<std::path::PathBuf>, String> {
        if folded_siblings.is_none() {
            let parent = expected
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            let mut index = FoldedSiblingIndex::new();
            let mut indexed = 0usize;
            for entry in std::fs::read_dir(parent).map_err(|error| {
                format!(
                    "Could not inspect archive volume directory {}: {error}",
                    parent.display()
                )
            })? {
                let entry = entry.map_err(|error| {
                    format!(
                        "Could not inspect an archive volume sibling in {}: {error}",
                        parent.display()
                    )
                })?;
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let folded = name.to_ascii_lowercase();
                if !folded.starts_with(family_prefix) {
                    continue;
                }
                indexed += 1;
                if indexed > (MAX_ARCHIVE_VOLUMES as usize * 2 + 2) {
                    return Err(format!(
                        "Archive volume family has too many case-insensitive sibling candidates (limit {}).",
                        MAX_ARCHIVE_VOLUMES as usize * 2 + 2
                    ));
                }
                index.entry(folded).or_default().push(entry.path());
            }
            *folded_siblings = Some(index);
        }

        let expected_name = expected
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Archive volume has an invalid file name.".to_string())?
            .to_ascii_lowercase();
        let Some(matches) = folded_siblings
            .as_ref()
            .and_then(|index| index.get(&expected_name))
        else {
            return Ok(None);
        };
        if matches.len() != 1 {
            return Err(format!(
                "Archive volume name is ambiguous when matched case-insensitively: {}",
                expected.display()
            ));
        }
        let resolved = &matches[0];
        if checked_volume(resolved)? {
            Ok(Some(resolved.clone()))
        } else {
            Ok(None)
        }
    }

    fn collect_numbered(
        parent: &std::path::Path,
        family_prefix: &str,
        folded_siblings: &mut Option<FoldedSiblingIndex>,
        mut candidate_for: impl FnMut(u32) -> std::path::PathBuf,
    ) -> Result<Vec<std::path::PathBuf>, String> {
        let mut family = Vec::new();
        for index in 1..=MAX_ARCHIVE_VOLUMES {
            let candidate = parent.join(candidate_for(index));
            let Some(candidate) = resolve_volume(&candidate, family_prefix, folded_siblings)?
            else {
                for later in index.saturating_add(1)..=MAX_ARCHIVE_VOLUMES.saturating_add(1) {
                    let later_candidate = parent.join(candidate_for(later));
                    if resolve_volume(&later_candidate, family_prefix, folded_siblings)?.is_some() {
                        return Err(format!(
                            "Archive volume family has a numbering gap before {}.",
                            later_candidate.display()
                        ));
                    }
                }
                return Ok(family);
            };
            family.push(candidate);
        }
        let overflow = parent.join(candidate_for(MAX_ARCHIVE_VOLUMES + 1));
        if resolve_volume(&overflow, family_prefix, folded_siblings)?.is_some() {
            return Err(format!(
                "Archive has more than {MAX_ARCHIVE_VOLUMES} volumes."
            ));
        }
        Ok(family)
    }

    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Archive input has an invalid file name.".to_string())?;
    let lower = name.to_ascii_lowercase();
    let bytes = name.as_bytes();
    let numeric_suffix = bytes.len() > 4
        && bytes[bytes.len() - 4] == b'.'
        && bytes[bytes.len() - 3..].iter().all(u8::is_ascii_digit);
    // A bare `name.123`-shaped file is only a 7-Zip split-volume member when
    // its base ends in a recognized archive extension (`archive.7z.001`) or a
    // sibling `.002` volume actually exists next to it. Without one of those,
    // an ordinary numbered file like `photo.123` or `backup.100` was rejected
    // outright with "Select the first (.001) archive volume", even though it
    // is not part of any split archive at all.
    let split_base = numeric_suffix
        .then(|| &name[..name.len() - 4])
        .filter(|base| {
            const KNOWN_ARCHIVE_SUFFIXES: &[&str] = &[".7z", ".zip", ".tar", ".gz", ".bz2", ".xz"];
            let base_lower = base.to_ascii_lowercase();
            if KNOWN_ARCHIVE_SUFFIXES
                .iter()
                .any(|suffix| base_lower.ends_with(suffix))
            {
                return true;
            }
            parent.join(format!("{base}.002")).is_file()
        });
    if let Some(base) = split_base {
        if !lower.ends_with(".001") {
            return Err("Select the first (.001) archive volume for extraction.".to_string());
        }
        let family_prefix = format!("{}.", base.to_ascii_lowercase());
        let mut folded_siblings = None;
        return collect_numbered(parent, &family_prefix, &mut folded_siblings, |index| {
            std::path::PathBuf::from(format!("{base}.{index:03}"))
        });
    }

    if lower.ends_with(".rar") {
        let rar_start = name.len() - 4;
        if let Some(part_start) = lower[..rar_start].rfind(".part") {
            let digits_start = part_start + ".part".len();
            let digits = &lower[digits_start..rar_start];
            if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                if digits.parse::<u32>().ok() != Some(1) {
                    return Err(
                        "Select the first (.part1.rar) RAR volume for extraction.".to_string()
                    );
                }
                let prefix = &name[..digits_start];
                let suffix = &name[rar_start..];
                let width = digits.len();
                let family_prefix = prefix.to_ascii_lowercase();
                let mut folded_siblings = None;
                return collect_numbered(parent, &family_prefix, &mut folded_siblings, |index| {
                    std::path::PathBuf::from(format!("{prefix}{index:0width$}{suffix}"))
                });
            }
        }

        // Legacy multi-volume RAR uses archive.rar followed by archive.r00,
        // archive.r01, ...; a missing .r00 means this is a single-volume RAR.
        let base = &name[..rar_start];
        let first_legacy = parent.join(format!("{base}.r00"));
        let family_prefix = format!("{}.", base.to_ascii_lowercase());
        let mut folded_siblings = None;
        if resolve_volume(&first_legacy, &family_prefix, &mut folded_siblings)?.is_some() {
            let mut family = vec![path.to_path_buf()];
            // Old RAR naming advances from .r00 through .r99, then .s00,
            // continuing through .z99.
            for index in 0..900u32 {
                let letter = char::from(b'r' + (index / 100) as u8);
                let candidate = parent.join(format!("{base}.{letter}{:02}", index % 100));
                let Some(candidate) =
                    resolve_volume(&candidate, &family_prefix, &mut folded_siblings)?
                else {
                    for later in index.saturating_add(1)..900u32 {
                        let later_letter = char::from(b'r' + (later / 100) as u8);
                        let later_candidate =
                            parent.join(format!("{base}.{later_letter}{:02}", later % 100));
                        if resolve_volume(&later_candidate, &family_prefix, &mut folded_siblings)?
                            .is_some()
                        {
                            return Err(format!(
                                "Archive volume family has a numbering gap before {}.",
                                later_candidate.display()
                            ));
                        }
                    }
                    break;
                };
                family.push(candidate);
            }
            return Ok(family);
        }
    }

    // Reject selecting a non-first legacy RAR volume directly.
    if let Some(extension) = lower.rsplit_once('.').map(|(_, extension)| extension) {
        if extension.len() == 3
            && extension
                .as_bytes()
                .first()
                .is_some_and(|letter| (b'r'..=b'z').contains(letter))
            && extension[1..].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Select the first (.rar) legacy RAR volume for extraction.".to_string());
        }
    }

    if lower.ends_with(".zip") {
        let zip_start = name.len() - 4;
        let base = &name[..zip_start];
        let first_split = parent.join(format!("{base}.z01"));
        let family_prefix = format!("{}.", base.to_ascii_lowercase());
        let mut folded_siblings = None;
        if resolve_volume(&first_split, &family_prefix, &mut folded_siblings)?.is_some() {
            let mut family =
                collect_numbered(parent, &family_prefix, &mut folded_siblings, |index| {
                    std::path::PathBuf::from(format!("{base}.z{index:02}"))
                })?;
            family.push(path.to_path_buf());
            return Ok(family);
        }
    }

    if let Some(extension) = lower.rsplit_once('.').map(|(_, extension)| extension) {
        if extension.len() >= 3
            && extension.starts_with('z')
            && extension[1..].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Select the final (.zip) split ZIP volume for extraction.".to_string());
        }
    }

    Ok(vec![path.to_path_buf()])
}
