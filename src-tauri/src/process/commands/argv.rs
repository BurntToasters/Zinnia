//! 7-Zip argv hardening and managed list files.

use std::io::Write;

pub(crate) struct ManagedListFile(pub(crate) std::path::PathBuf);

/// Index of the first `--`, or the argument count when there is none.
fn switch_region_end(args: &[String]) -> usize {
    args.iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len())
}

/// Switch-shaped arguments: everything before the first `--`. Arguments after
/// it are literal path or member names and are never inspected as switches.
fn switch_region(args: &[String]) -> &[String] {
    &args[..switch_region_end(args)]
}

/// Keep only the switch-region arguments that `keep` accepts. The tail after
/// `--` is preserved unchanged, so a member named like a switch survives.
fn retain_switch_region(args: &mut Vec<String>, mut keep: impl FnMut(&str) -> bool) {
    let end = switch_region_end(args);
    let tail = args.split_off(end);
    args.retain(|arg| keep(arg.as_str()));
    args.extend(tail);
}

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
    let neutralize_leading_dash = matches!(args.first().map(String::as_str), Some("a" | "u"));
    let selected = rewrite_args_for_managed_listfile(args, format!("@{listfile_str}"))?;
    if selected
        .iter()
        .any(|path| path.contains(['\r', '\n', '\0']))
    {
        return Err(
            "A selected path contains a line break or NUL character and cannot be placed in a managed 7-Zip list file."
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
        // Compress inputs are filesystem paths: a leading dash still has
        // switch shape there, so `./` keeps it a path. Extract selections are
        // archive member names matched literally, and `./-name` would never
        // match the member `-name`, so they are written as-is. A leading `@`
        // inside a listfile is a literal name (only command-line `@file`
        // opens a second listfile), so preserve it in both cases.
        let name = if neutralize_leading_dash && path.starts_with('-') {
            format!("./{path}")
        } else {
            path.clone()
        };
        // 7-Zip trims spaces around each list line and strips one pair of
        // surrounding quotes. Wrapping every line keeps leading and trailing
        // spaces and any quotes the name itself contains.
        let line = format!("\"{name}\"");
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
        && !switch_region(args)
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-spd"))
    {
        args.insert(1, "-spd".to_string());
    }
    #[cfg(target_os = "windows")]
    if matches!(command, Some("a" | "u" | "x" | "l" | "t")) {
        retain_switch_region(args, |arg| !arg.to_ascii_lowercase().starts_with("-scc"));
        let insert_at = switch_region_end(args);
        args.insert(insert_at, "-sccUTF-8".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    if command == Some("x")
        && !switch_region(args)
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-spod"))
    {
        args.insert(1, "-spod".to_string());
    }
    if crate::validation::is_password_protected_zip_create(args) {
        retain_switch_region(args, |arg| !arg.to_ascii_lowercase().starts_with("-mem="));
        let insert_at = switch_region_end(args);
        args.insert(insert_at, "-mem=AES256".to_string());
    }
    if crate::validation::is_zip_create_or_update(args) {
        retain_switch_region(args, |arg| {
            let lower = arg.to_ascii_lowercase();
            !lower.starts_with("-mcu") && !lower.starts_with("-mcl")
        });
        let insert_at = switch_region_end(args);
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
        if !switch_region(args)
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-snl"))
        {
            args.insert(1, "-snl".to_string());
        }
        if !switch_region(args)
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-snh"))
        {
            args.insert(1, "-snh".to_string());
        }
    }
    // Windows: propagate Mark-of-the-Web (Zone.Identifier) from the archive onto
    // extracted files. macOS/Linux 7-Zip builds reject -snz.
    #[cfg(target_os = "windows")]
    if args.first().map(String::as_str) == Some("x")
        && !switch_region(args)
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-snz"))
    {
        args.insert(1, "-snz".to_string());
    }
    // Disable archive-supplied NTFS streams. 7-Zip 26.03 fixes CVE-2026-58052
    // (RAR5 STM name collisions that wiped MotW). Keep `-sns-` as defense in
    // depth so archive-supplied streams cannot replace the `-snz` marker.
    #[cfg(target_os = "windows")]
    if args.first().map(String::as_str) == Some("x") {
        retain_switch_region(args, |arg| !arg.to_ascii_lowercase().starts_with("-sns"));
        args.insert(1, "-sns-".to_string());
    }
    if args.first().map(String::as_str) == Some("x") {
        retain_switch_region(args, |arg| !arg.to_ascii_lowercase().starts_with("-snld"));
        args.insert(1, "-snld10".to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    /// Lines of the managed list file that `prepare_managed_listfile` writes.
    fn written_listfile_lines(args: &mut Vec<String>) -> Result<Vec<String>, String> {
        let Some(listfile) = prepare_managed_listfile(args)? else {
            return Ok(Vec::new());
        };
        let body = std::fs::read_to_string(&listfile.0).map_err(|error| error.to_string())?;
        Ok(body
            .split("\r\n")
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }

    #[test]
    fn managed_listfile_wraps_every_extract_member_in_one_quote_pair() {
        let mut args = owned(&[
            "x",
            "-o/tmp/out",
            "-aou",
            "-spd",
            "--",
            "/tmp/archive.7z",
            "report ",
            " lead.txt",
            "\"quoted\"",
            "-web/app.js",
            "@at.txt",
        ]);
        let lines = written_listfile_lines(&mut args).expect("extract list file");
        assert_eq!(
            lines,
            [
                "\"report \"",
                "\" lead.txt\"",
                "\"\"quoted\"\"",
                "\"-web/app.js\"",
                "\"@at.txt\"",
            ]
        );
    }

    #[test]
    fn managed_listfile_wraps_compress_inputs_after_the_dash_prefix() {
        let mut args = owned(&[
            "a",
            "-t7z",
            "/tmp/out.7z",
            "--",
            "-dash.txt",
            "plain ",
            "\"q\"",
        ]);
        let lines = written_listfile_lines(&mut args).expect("compress list file");
        assert_eq!(lines, ["\"./-dash.txt\"", "\"plain \"", "\"\"q\"\""]);
    }

    #[test]
    fn managed_listfile_rejects_line_breaks_and_nul_in_names() {
        for bad in ["bad\nname", "bad\rname", "bad\0name"] {
            let mut args = owned(&["x", "-o/tmp/out", "-aou", "--", "/tmp/archive.7z"]);
            args.push(bad.to_string());
            assert!(
                prepare_managed_listfile(&mut args).is_err(),
                "name {bad:?} must not reach a list file"
            );
        }
    }

    #[test]
    fn backend_link_switches_leave_members_named_like_switches_alone() {
        let mut create = owned(&["a", "-t7z", "out.7z", "--", "-snl", "-snh"]);
        apply_backend_link_switches(&mut create);
        let separator = create.iter().position(|arg| arg == "--").unwrap();
        assert!(create[..separator].iter().any(|arg| arg == "-snl"));
        assert!(create[..separator].iter().any(|arg| arg == "-snh"));
        assert_eq!(&create[separator + 1..], ["-snl", "-snh"]);

        let mut extract = owned(&[
            "x",
            "-o/tmp/out",
            "-aou",
            "--",
            "/tmp/archive.7z",
            "-snldfoo",
            "-snsx",
        ]);
        apply_backend_link_switches(&mut extract);
        assert_eq!(extract[1], "-snld10");
        assert_eq!(&extract[extract.len() - 2..], ["-snldfoo", "-snsx"]);
    }

    #[test]
    fn harden_helpers_leave_members_named_like_switches_alone() {
        let mut extract = owned(&[
            "x",
            "-o/tmp/out",
            "-aou",
            "--",
            "/tmp/archive.7z",
            "-spd",
            "-mcu=on",
        ]);
        harden_7z_args(&mut extract);
        let separator = extract.iter().position(|arg| arg == "--").unwrap();
        assert!(extract[..separator].iter().any(|arg| arg == "-spd"));
        assert_eq!(
            &extract[separator + 1..],
            ["/tmp/archive.7z", "-spd", "-mcu=on"]
        );
    }

    #[test]
    fn zip_policy_ignores_a_member_named_like_the_zip_type_switch() {
        let args = owned(&["a", "-t7z", "out.7z", "--", "-tzip"]);
        assert!(!crate::validation::is_zip_create_or_update(&args));
    }

    #[test]
    fn listfile_rewrite_neutralizes_a_switch_shaped_archive_name() {
        let mut args = owned(&["x", "-o/tmp/out", "-aou", "--", "-archive.7z", "member"]);
        let selected = rewrite_args_for_managed_listfile(&mut args, "@/tmp/items.txt".to_string())
            .expect("rewrite");
        assert_eq!(selected, ["member"]);
        assert!(args.contains(&"./-archive.7z".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("@/tmp/items.txt"));
    }
}
