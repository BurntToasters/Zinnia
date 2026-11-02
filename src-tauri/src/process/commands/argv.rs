//! 7-Zip argv hardening and managed list files.

use std::io::Write;

pub(crate) struct ManagedListFile(pub(crate) std::path::PathBuf);

impl Drop for ManagedListFile {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Could not remove the temporary 7-Zip list file: {error}");
            }
        }
        if let Some(parent) = self.0.parent() {
            // Only remove the private parent we created: exact prefix shape,
            // plain directory, not a link. Anything else is left alone.
            let name = parent.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("zinnia-7z-list-") {
                return;
            }
            if let Ok(meta) = std::fs::symlink_metadata(parent) {
                if meta.is_dir() && !crate::path_safety::is_link_or_reparse(&meta) {
                    let _ = std::fs::remove_dir(parent);
                }
            }
        }
    }
}

pub(crate) fn rewrite_args_for_managed_listfile(
    args: &mut Vec<String>,
    listfile_reference: String,
) -> Result<Vec<String>, String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "The 7-Zip command is missing its path separator.".to_string())?;
    let command = args.first().map(String::as_str);
    let (archive, selected_start) = match command {
        Some("a" | "u") => (None, separator + 1),
        Some("x") => (
            Some(
                args.get(separator + 1)
                    .cloned()
                    .ok_or_else(|| "Extraction command is missing its archive.".to_string())?,
            ),
            separator + 2,
        ),
        _ => {
            return Err("This 7-Zip command does not support managed path list files.".to_string())
        }
    };
    if selected_start >= args.len() {
        return Err("The 7-Zip command has no selected paths to place in a list file.".to_string());
    }
    let selected = args[selected_start..].to_vec();
    args.truncate(separator);
    // Managed listfiles are UTF-8. Drop any caller `-scs*` so a mismatched
    // charset cannot desync path decoding from the bytes we write.
    args.retain(|arg| !arg.to_ascii_lowercase().starts_with("-scs"));
    args.insert(1, "-scsUTF-8".to_string());
    if let Some(archive) = archive {
        // `@listfile` must occur before `--` to be expanded, but extraction's
        // archive must remain the first positional argument. Neutralize `@`/`-`
        // leading archive names so they are not re-parsed as switches/listfiles
        // once the original `--` separator is removed.
        let archive = if archive.starts_with('@') || archive.starts_with('-') {
            format!("./{archive}")
        } else {
            archive
        };
        args.push(archive);
    }
    args.push(listfile_reference);
    Ok(selected)
}

pub(super) fn prepare_managed_listfile(
    args: &mut Vec<String>,
) -> Result<Option<ManagedListFile>, String> {
    let Some(separator) = args.iter().position(|arg| arg == "--") else {
        return Ok(None);
    };
    let selected_start = match args.first().map(String::as_str) {
        Some("a" | "u") => separator + 1,
        Some("x") => separator + 2,
        _ => return Ok(None),
    };
    if selected_start >= args.len() {
        return Ok(None);
    }
    let token = super::super::staging::random_token()?;
    let private_dir = std::env::temp_dir().join(format!("zinnia-7z-list-{token}"));
    crate::fs_secure::create_private_dir(&private_dir)
        .map_err(|error| format!("Could not secure the 7-Zip list directory: {error}"))?;
    let listfile = ManagedListFile(private_dir.join("items.txt"));
    let listfile_str = listfile
        .0
        .to_str()
        .ok_or_else(|| "Temporary 7-Zip list path is not valid UTF-8.".to_string())?;
    let selected = rewrite_args_for_managed_listfile(args, format!("@{listfile_str}"))?;
    if selected.iter().any(|path| path.contains(['\r', '\n'])) {
        return Err(
            "A selected path contains a line break and cannot be placed in a managed 7-Zip list file."
                .to_string(),
        );
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&listfile.0)
        .map_err(|error| format!("Could not create a private 7-Zip list file: {error}"))?;
    for path in &selected {
        // A leading dash still has switch shape. A leading `@` inside a
        // listfile is a literal member name (only command-line `@file` opens a
        // second listfile), so preserve it.
        let line = if path.starts_with('-') {
            format!("./{path}")
        } else {
            path.clone()
        };
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\r\n"))
            .map_err(|error| format!("Could not write the 7-Zip list file: {error}"))?;
    }
    file.flush()
        .map_err(|error| format!("Could not finish the 7-Zip list file: {error}"))?;
    Ok(Some(listfile))
}
pub(crate) fn pin_existing_zip_output_type(args: &mut Vec<String>) {
    if !matches!(args.first().map(String::as_str), Some("a" | "u")) {
        return;
    }
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let has_password = args[1..separator].iter().any(|arg| {
        arg.len() > 2
            && arg
                .get(..2)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("-p"))
    });
    if !has_password || !crate::validation::archive_type_switches(args).is_empty() {
        return;
    }
    let Some(output) = args[1..separator]
        .iter()
        .rev()
        .find(|arg| !arg.starts_with('-'))
    else {
        return;
    };
    if output.to_ascii_lowercase().ends_with(".zip") {
        return;
    }
    let path = std::path::Path::new(output);
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if !meta.is_file() || crate::path_safety::is_link_or_reparse(&meta) {
        return;
    }
    let mut magic = [0u8; 4];
    let Ok(mut file) = crate::path_safety::open_regular_file_nofollow(path) else {
        return;
    };
    if std::io::Read::read_exact(&mut file, &mut magic).is_err() {
        return;
    }
    if matches!(&magic, b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08") {
        args.insert(separator, "-tzip".to_string());
    }
}

pub(crate) fn harden_7z_args(args: &mut Vec<String>) {
    let command = args.first().cloned();
    let command = command.as_deref();
    if matches!(command, Some("a" | "u" | "x" | "l" | "t"))
        && !args.iter().any(|arg| arg.eq_ignore_ascii_case("-spd"))
    {
        args.insert(1, "-spd".to_string());
    }
    #[cfg(target_os = "windows")]
    if matches!(command, Some("a" | "u" | "x" | "l" | "t")) {
        args.retain(|arg| !arg.to_ascii_lowercase().starts_with("-scc"));
        let insert_at = args
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(args.len());
        args.insert(insert_at, "-sccUTF-8".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    if command == Some("x") && !args.iter().any(|arg| arg.eq_ignore_ascii_case("-spod")) {
        args.insert(1, "-spod".to_string());
    }
    if crate::validation::is_password_protected_zip_create(args) {
        args.retain(|arg| !arg.to_ascii_lowercase().starts_with("-mem="));
        let insert_at = args
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(args.len());
        args.insert(insert_at, "-mem=AES256".to_string());
    }
    if crate::validation::is_zip_create_or_update(args) {
        args.retain(|arg| {
            let lower = arg.to_ascii_lowercase();
            !lower.starts_with("-mcu") && !lower.starts_with("-mcl")
        });
        let insert_at = args
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(args.len());
        args.insert(insert_at, "-mcu=on".to_string());
    }
}

/// Inject backend-owned symlink / hard-link policy switches.
///
/// Call after `validate_run_7z_args` so the webview cannot omit or raise these
/// levels. Extract uses `-snld10`: 7-Zip 25.01+ defaults to level 5 and rejects
/// macOS `.framework` chains (`Libraries -> Versions/Current/Libraries`) as
/// "Dangerous link via another link". Level 10 also lets 7-Zip materialize some
/// escaping relative symlink targets that default level would ignore, so
/// Zinnia's staged-tree validation (absolute / escape / hardlink alias checks)
/// is the required containment gate before publish. Never raise to `-snld20`.
pub(crate) fn apply_backend_link_switches(args: &mut Vec<String>) {
    if matches!(args.first().map(String::as_str), Some("a" | "u")) {
        if !args.iter().any(|arg| arg.eq_ignore_ascii_case("-snl")) {
            args.insert(1, "-snl".to_string());
        }
        if !args.iter().any(|arg| arg.eq_ignore_ascii_case("-snh")) {
            args.insert(1, "-snh".to_string());
        }
    }
    // Windows: propagate Mark-of-the-Web (Zone.Identifier) from the archive onto
    // extracted files. macOS/Linux 7-Zip builds reject -snz.
    #[cfg(target_os = "windows")]
    if args.first().map(String::as_str) == Some("x")
        && !args.iter().any(|arg| arg.eq_ignore_ascii_case("-snz"))
    {
        args.insert(1, "-snz".to_string());
    }
    // Disable archive-supplied NTFS streams. 7-Zip 26.03 fixes CVE-2026-58052
    // (RAR5 STM name collisions that wiped MotW). Keep `-sns-` as defense in
    // depth so archive-supplied streams cannot replace the `-snz` marker.
    #[cfg(target_os = "windows")]
    if args.first().map(String::as_str) == Some("x") {
        args.retain(|arg| !arg.to_ascii_lowercase().starts_with("-sns"));
        args.insert(1, "-sns-".to_string());
    }
    if args.first().map(String::as_str) == Some("x") {
        args.retain(|arg| !arg.to_ascii_lowercase().starts_with("-snld"));
        args.insert(1, "-snld10".to_string());
    }
}
