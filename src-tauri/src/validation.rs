//! Allow-list validation for 7z args. Security boundary between frontend and process.

// Large drag-and-drop selections are valid. This is still bounded to protect
// the sidecar and IPC boundary without rejecting ordinary bulk operations.
// Archive validation accepts 4,096 user paths. Leave bounded room for the
// command, output, safety, compression, and user-approved option arguments.
const MAX_7Z_ARGS: usize = 8192;
const MAX_7Z_ARG_BYTES: usize = 8192;

const ALLOWED_7Z_COMMANDS: &[&str] = &["a", "u", "x", "l", "t", "b"];
// Store symbolic/hard links as links on create/update (-snl/-snh). Frontend
// also passes them; run_7z injects as defense in depth. Keep them out of
// BLOCKED so those switches validate; frontend extra-args does not expose them.
const BLOCKED_7Z_ARGS: &[&str] = &["-si", "-so", "-sdel", "-sfx", "-w", "-sns", "-sni", "-spf2"];

fn has_embedded_listfile(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    (lower.starts_with("-i") || lower.starts_with("-x")) && arg[2..].contains('@')
}

fn is_numbered_switch(arg: &str, prefix: &str, max: u8) -> bool {
    arg.strip_prefix(prefix)
        .and_then(|value| value.parse::<u8>().ok())
        .is_some_and(|value| value <= max)
}

fn is_stream_switch(arg: &str) -> bool {
    // -bsp2 would push progress into stderr and defeat the exit-1 classifier.
    arg.eq_ignore_ascii_case("-bsp1")
}

fn archive_type_switches(args: &[String]) -> Vec<String> {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    args.iter()
        .take(separator)
        .skip(1)
        .filter_map(|arg| {
            let lower = arg.to_ascii_lowercase();
            if lower == "-stl" || lower.starts_with("-stx") {
                return None;
            }
            lower
                .strip_prefix("-t")
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect()
}

fn create_output_looks_like_zip(args: &[String]) -> bool {
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    args[1..separator]
        .iter()
        .rev()
        .find(|arg| !arg.starts_with('-'))
        .is_some_and(|path| path.to_ascii_lowercase().ends_with(".zip"))
}

/// Password-protected ZIP create/update must use AES-256, never ZipCrypto.
pub(crate) fn is_password_protected_zip_create(args: &[String]) -> bool {
    let Some(cmd) = args.first() else {
        return false;
    };
    if !matches!(cmd.as_str(), "a" | "u") {
        return false;
    }
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let has_password = args[1..separator].iter().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        lower.starts_with("-p") && arg.len() > 2
    });
    if !has_password {
        return false;
    }
    match archive_type_switches(args).last().map(String::as_str) {
        Some("zip") => true,
        None => create_output_looks_like_zip(args),
        _ => false,
    }
}

fn is_include_or_exclude(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    (lower.starts_with("-i") || lower.starts_with("-x"))
        && !has_embedded_listfile(arg)
        && arg.contains('!')
}

fn is_include_switch(arg: &str) -> bool {
    arg.to_ascii_lowercase().starts_with("-i") && arg.contains('!')
}

fn include_exclude_payload(arg: &str) -> Option<&str> {
    let index = arg.find('!')?;
    Some(&arg[index + 1..])
}

/// Compress `-i!` / `-x!` payloads that name absolute host paths bypass the
/// after-`--` real-path / reparse checks. Reject those shapes here.
fn compress_include_exclude_payload_is_unsafe(payload: &str) -> bool {
    if payload.is_empty() {
        return false;
    }
    if archive_member_path_is_unsafe(payload) {
        return true;
    }
    let bytes = payload.as_bytes();
    bytes[0] == b'/' || bytes[0] == b'\\' || (bytes.len() >= 2 && bytes[1] == b':')
}

fn is_common_diagnostic_switch(lower: &str) -> bool {
    lower == "-ba"
        || lower == "-bt"
        || lower == "-slt"
        || is_numbered_switch(lower, "-bb", 3)
        || is_stream_switch(lower)
        || (lower.starts_with("-scs") && lower.len() > 4)
        || (lower.starts_with("-scc") && lower.len() > 4)
}

fn method_switch_value_is_safe(value: &str) -> bool {
    !value.is_empty() && !value.contains('/') && !value.contains('\\') && !value.contains("..")
}

fn is_allowed_method_switch(lower: &str) -> bool {
    // Intentionally narrow: reject open-ended -m* (and -ssw is blocked separately).
    // Prefixes ending in '=' require a non-empty value. Others require end / '=' / digit
    // so `-mxyz` does not match `-mx`. Values must not smuggle path separators.
    const PREFIXES: &[&str] = &[
        "-m0=", "-mem=", "-mhe=", "-mtc=", "-mta=", "-mhc=", "-mcu=", "-mcl=", "-mx", "-md",
        "-mfb", "-ms", "-mmt",
    ];
    for prefix in PREFIXES {
        let Some(rest) = lower.strip_prefix(prefix) else {
            continue;
        };
        if prefix.ends_with('=') {
            return method_switch_value_is_safe(rest);
        }
        if rest.is_empty() {
            return true;
        }
        if let Some(value) = rest.strip_prefix('=') {
            return method_switch_value_is_safe(value);
        }
        if rest.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
            return method_switch_value_is_safe(rest);
        }
        return false;
    }
    false
}

fn is_allowed_switch(cmd: &str, arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    if is_common_diagnostic_switch(&lower) {
        return true;
    }

    match cmd {
        "a" | "u" => {
            (lower.starts_with("-t") && lower.len() > 2)
                || is_allowed_method_switch(&lower)
                || (lower.starts_with("-p") && lower.len() > 2)
                || lower == "-r"
                || lower == "-r-"
                || lower == "-r0"
                || lower == "-stl"
                || lower == "-slp"
                || lower == "-ssp"
                || lower == "-sse"
                || lower == "-snl"
                || lower == "-snh"
                || lower == "-spd"
                || is_include_or_exclude(arg)
                || (cmd == "a"
                    && lower.starts_with("-v")
                    && lower.len() > 2
                    && lower[2..]
                        .chars()
                        .all(|ch| ch.is_ascii_digit() || matches!(ch, 'b' | 'k' | 'm' | 'g')))
        }
        "x" => {
            (lower.starts_with("-o") && lower.len() > 2)
                || (lower.starts_with("-p") && lower.len() > 2)
                // Only auto-rename / skip existing; never overwrite-all (-aoa) or
                // rename-existing (-aot). Frontend default is -aou.
                || matches!(lower.as_str(), "-aos" | "-aou")
                || lower == "-y"
                || lower == "-spd"
                || lower == "-spod"
                || lower == "-r"
                || lower == "-r-"
                || lower == "-r0"
                || (lower.starts_with("-t") && lower.len() > 2)
                || is_include_or_exclude(arg)
        }
        "l" | "t" => {
            (lower.starts_with("-p") && lower.len() > 2)
                || (lower.starts_with("-t") && lower.len() > 2)
                || lower == "-r"
                || lower == "-r-"
                || lower == "-r0"
                || lower == "-spd"
                || is_include_or_exclude(arg)
        }
        "b" => is_allowed_method_switch(&lower),
        _ => false,
    }
}

// True if any path component is exactly "..". Substrings like "name..bak" are fine.
pub(crate) fn has_parent_dir_component(path: &str) -> bool {
    path.split(['/', '\\']).any(|component| component == "..")
}

/// True when a member path could escape an extract `-o` root. On Windows also
/// rejects trailing-dot/space parents, NTFS streams, and device names.
pub(crate) fn archive_member_path_is_unsafe(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    // Normalize both separators on every platform so ZIP members that use
    // Windows-style `\` cannot smuggle `..` past a POSIX-only splitter.
    let has_parent = path.split(['/', '\\']).any(|component| component == "..");
    if has_parent {
        return true;
    }
    let bytes = path.as_bytes();
    if bytes[0] == b'/' {
        return true;
    }
    #[cfg(target_os = "windows")]
    if bytes[0] == b'\\' {
        return true;
    }
    // Windows drive-absolute: `C:\...` or `C:/...`
    #[cfg(target_os = "windows")]
    if bytes.len() >= 2 && bytes[1] == b':' {
        return true;
    }
    #[cfg(target_os = "windows")]
    for component in path.split(['/', '\\']) {
        if component.is_empty() {
            continue;
        }
        // Win32 strips trailing dots/spaces, so `.. ` and `...` escape.
        let normalized = component.trim_end_matches(|c| c == '.' || c == ' ');
        if normalized == ".." || (normalized.is_empty() && !component.is_empty()) {
            return true;
        }
        // Any other colon opens an NTFS alternate data stream.
        if component.contains(':') {
            return true;
        }
        if is_win32_reserved_device_name(normalized) {
            return true;
        }
    }
    false
}

/// Win32 device-name check on the dot-stem, case-insensitive, any extension.
#[cfg(target_os = "windows")]
fn is_win32_reserved_device_name(normalized_component: &str) -> bool {
    let stem = normalized_component
        .split('.')
        .next()
        .unwrap_or(normalized_component)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "CLOCK$"
    )
}

fn switch_contains_parent_traversal(arg: &str) -> bool {
    // ASCII-only lowercasing: `arg[2..]` below byte-slices the *original*
    // string, and every allow-listed prefix compared against is ASCII, so
    // Unicode-aware `to_lowercase()` (which can change a string's byte
    // length, e.g. "İ" -> "i̇") buys nothing here and only risks a future
    // allowlist edit reasoning about byte offsets against the wrong string.
    let lower = arg.to_ascii_lowercase();
    if !(lower.starts_with("-i")
        || lower.starts_with("-x")
        || lower.starts_with("-w")
        || lower.starts_with("-o"))
    {
        return false;
    }

    arg[2..]
        .split(['!', ':', '@'])
        .any(has_parent_dir_component)
}

pub fn validate_run_7z_args(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        return Err("Missing 7z arguments".to_string());
    }
    if args.len() > MAX_7Z_ARGS {
        return Err("Too many 7z arguments.".to_string());
    }
    if args.iter().any(|arg| arg.len() > MAX_7Z_ARG_BYTES) {
        return Err("A 7z argument exceeds maximum length.".to_string());
    }
    if args.iter().any(|arg| arg.contains('\0')) {
        return Err("7z arguments contain invalid characters.".to_string());
    }

    let cmd = args[0].as_str();
    if !ALLOWED_7Z_COMMANDS.contains(&cmd) {
        return Err(format!("7z command '{cmd}' is not permitted."));
    }

    let mut separator_index = None;
    let mut positional_before_separator = 0usize;
    let mut positional_after_separator = 0usize;
    let mut output_switches = 0usize;
    let mut password_switches = 0usize;
    let mut overwrite_switches = 0usize;
    let mut archive_output: Option<&str> = None;

    for (idx, arg) in args.iter().enumerate().skip(1) {
        if arg == "--" {
            if separator_index.is_some() {
                return Err("7z argument separator '--' may appear only once.".to_string());
            }
            separator_index = Some(idx);
            continue;
        }

        // ASCII-only: every allow/block-listed prefix compared against `lower`
        // here is ASCII, and `arg[2..]` a few lines below byte-slices the
        // original string using an offset derived from an ASCII prefix match.
        let lower = arg.to_ascii_lowercase();
        if BLOCKED_7Z_ARGS.iter().any(|b| lower.starts_with(b)) {
            return Err(format!("7z argument '{arg}' is not permitted."));
        }
        // Reject @listfile references before -- (7z reads them as file lists with
        // unvalidated contents). After --, the leading @ is literal.
        if separator_index.is_none() && arg.starts_with('@') {
            return Err(format!(
                "7z argument '{arg}' is not permitted (response files are not allowed)."
            ));
        }
        if has_embedded_listfile(arg) {
            return Err(format!(
                "7z argument '{arg}' is not permitted (list files are backend-managed only)."
            ));
        }
        if separator_index.is_none() && lower.starts_with("-o") {
            output_switches += 1;
        }
        if separator_index.is_none() && lower.starts_with("-p") {
            password_switches += 1;
            if arg.len() > 2 && arg[2..].contains(['\r', '\n', '\0', '\u{2028}', '\u{2029}']) {
                return Err("Archive passwords cannot contain line breaks.".to_string());
            }
        }
        if separator_index.is_none() && lower.starts_with("-ao") {
            overwrite_switches += 1;
        }

        if separator_index.is_some() {
            positional_after_separator += 1;
            if has_parent_dir_component(arg) {
                return Err(format!(
                    "7z path '{arg}' must not contain a '..' parent-directory segment."
                ));
            }
        } else if arg.starts_with('-') {
            if !is_allowed_switch(cmd, arg) {
                return Err(format!("7z argument '{arg}' is not permitted."));
            }
            // -o<dir> sets the extract/output directory; block traversal in it.
            if lower.starts_with("-o") && has_parent_dir_component(&arg[2..]) {
                return Err(format!(
                    "7z output path '{arg}' must not contain a '..' parent-directory segment."
                ));
            }
            if switch_contains_parent_traversal(arg) {
                return Err(format!(
                    "7z switch '{arg}' must not contain a '..' parent-directory segment."
                ));
            }
            if matches!(cmd, "a" | "u") && is_include_or_exclude(arg) {
                // Compression inputs must come only from the validated paths
                // after `--`. Even a relative `-i!name` makes 7-Zip read an
                // additional file from its working directory.
                if is_include_switch(arg) {
                    return Err(format!(
                        "7z include switch '{arg}' is not permitted for compression. Select inputs in the UI instead."
                    ));
                }
                if include_exclude_payload(arg)
                    .is_some_and(compress_include_exclude_payload_is_unsafe)
                {
                    return Err(format!(
                        "7z switch '{arg}' must not name an absolute or escaping host path. Select inputs in the UI instead."
                    ));
                }
            }
        } else {
            positional_before_separator += 1;
            if matches!(cmd, "a" | "u") {
                archive_output = Some(arg);
            }
            if has_parent_dir_component(arg) {
                return Err(format!(
                    "7z path '{arg}' must not contain a '..' parent-directory segment."
                ));
            }
        }
    }

    if password_switches > 1 {
        return Err("Password switch may appear only once.".to_string());
    }
    if output_switches > 1 {
        return Err("Extraction output switch may appear only once.".to_string());
    }
    if overwrite_switches > 1 {
        return Err("Extraction overwrite policy may appear only once.".to_string());
    }
    // Rust is the security boundary: reject password create/update for formats
    // Zinnia does not actually encrypt (frontend already hides the control).
    // 7-Zip honors the last -t when several are present, so evaluate the last
    // type and reject more than one -t with a password (fail closed).
    if password_switches > 0 && matches!(cmd, "a" | "u") {
        let formats = archive_type_switches(args);
        if formats.len() > 1 {
            return Err(
                "Password-protected create/update allows at most one archive type (-t)."
                    .to_string(),
            );
        }
        match formats.last().map(String::as_str) {
            // 7-Zip defaults to 7z when -t is omitted.
            None | Some("7z") | Some("zip") => {}
            Some(other) => {
                return Err(format!(
                    "Password encryption is not supported for archive format '{other}'."
                ));
            }
        }
        if is_password_protected_zip_create(args) {
            let separator = separator_index.unwrap_or(args.len());
            for arg in &args[1..separator] {
                let lower = arg.to_ascii_lowercase();
                if lower.starts_with("-mem=") && lower != "-mem=aes256" {
                    return Err(
                        "Password-protected ZIP archives must use AES-256 (-mem=AES256)."
                            .to_string(),
                    );
                }
            }
        }
    }

    match cmd {
        "a" | "u" => {
            let separator = separator_index
                .ok_or_else(|| "Compression arguments must include '--'.".to_string())?;
            if separator + 1 >= args.len() {
                return Err("Missing compression input path(s) after '--'.".to_string());
            }
            if positional_before_separator != 1 {
                return Err(
                    "Compression command must include exactly one output archive path before '--'."
                        .to_string(),
                );
            }
        }
        "x" => {
            let separator = separator_index
                .ok_or_else(|| "Extraction arguments must include '--'.".to_string())?;
            if separator + 1 >= args.len() {
                return Err("Missing extraction archive path after '--'.".to_string());
            }
            if positional_before_separator > 0 {
                return Err(
                    "Extraction command cannot include positional arguments before '--'."
                        .to_string(),
                );
            }
            // Require -o for extract to prevent extraction into an unpredictable CWD.
            if output_switches != 1 {
                return Err(
                    "Extraction command must include exactly one output directory (-o<path>)."
                        .to_string(),
                );
            }
            // Require a safe overwrite policy; never rely on interactive defaults.
            if overwrite_switches != 1 {
                return Err(
                    "Extraction command must include exactly one overwrite policy (-aou or -aos)."
                        .to_string(),
                );
            }
        }
        "l" | "t" => {
            let separator = separator_index
                .ok_or_else(|| "List/test arguments must include '--'.".to_string())?;
            if separator + 1 >= args.len() || positional_after_separator != 1 {
                return Err(
                    "List/test command requires exactly one archive path after '--'.".to_string(),
                );
            }
            if positional_before_separator != 0 {
                return Err("List/test command cannot include paths before '--'.".to_string());
            }
        }
        "b" if separator_index.is_some()
            || positional_before_separator > 0
            || positional_after_separator > 0 =>
        {
            return Err("Benchmark command does not take any paths.".to_string());
        }
        _ => {}
    }

    if (cmd == "a" || cmd == "u" || cmd == "x") && positional_after_separator == 0 {
        return Err("Missing archive path(s) after '--'.".to_string());
    }

    if matches!(cmd, "a" | "u") {
        let separator = separator_index.unwrap_or(args.len());
        let formats: Vec<String> = args[1..separator]
            .iter()
            .filter_map(|arg| {
                let lower = arg.to_ascii_lowercase();
                if lower == "-stl" || lower.starts_with("-stx") {
                    return None;
                }
                lower
                    .strip_prefix("-t")
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .collect();
        if formats.len() > 1 {
            return Err("Compression allows at most one archive type (-t).".to_string());
        }
        let format = formats.last().map(String::as_str).unwrap_or("7z");
        let methods: Vec<String> = args[1..separator]
            .iter()
            .filter_map(|arg| {
                arg.to_ascii_lowercase()
                    .strip_prefix("-m0=")
                    .map(str::to_string)
            })
            .collect();
        if methods.len() > 1 {
            return Err("Compression allows at most one method switch (-m0=).".to_string());
        }
        let method = methods.into_iter().next();
        let has_dict = args[1..separator]
            .iter()
            .any(|arg| arg.to_ascii_lowercase().starts_with("-md"));
        let has_word = args[1..separator]
            .iter()
            .any(|arg| arg.to_ascii_lowercase().starts_with("-mfb"));
        let supports_dict = matches!(
            (format, method.as_deref()),
            ("7z", None | Some("lzma2") | Some("lzma")) | ("xz", _) | ("zip", Some("lzma"))
        );
        let supports_word = matches!(
            (format, method.as_deref()),
            ("7z", None | Some("lzma2") | Some("lzma"))
                | ("xz", _)
                | ("gzip", _)
                | ("zip", Some("deflate") | Some("lzma") | None)
        );
        if has_dict && !supports_dict {
            return Err(format!(
                "Dictionary-size switch is not supported for {format}{}.",
                method
                    .as_deref()
                    .map(|value| format!("/{value}"))
                    .unwrap_or_default()
            ));
        }
        if has_word && !supports_word {
            return Err(format!(
                "Word-size switch is not supported for {format}{}.",
                method
                    .as_deref()
                    .map(|value| format!("/{value}"))
                    .unwrap_or_default()
            ));
        }
        if cmd == "u" && matches!(format, "gzip" | "bzip2" | "xz") {
            return Err(format!(
                "Archive format '{format}' is single-stream and cannot be updated."
            ));
        }
        if let Some(output) = archive_output {
            let lower = output.to_ascii_lowercase();
            if [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
            {
                return Err("Creating compound TAR output is not supported yet.".to_string());
            }
            if cmd == "u" && lower.ends_with(".001") {
                return Err("Split-volume archives cannot be updated.".to_string());
            }
        }
        for arg in &args[1..separator] {
            let lower = arg.to_ascii_lowercase();
            let Some(value) = lower.strip_prefix("-v") else {
                continue;
            };
            let (digits, factor) = match value.chars().last() {
                Some('k') => (&value[..value.len() - 1], 1024u64),
                Some('m') => (&value[..value.len() - 1], 1024u64.pow(2)),
                Some('g') => (&value[..value.len() - 1], 1024u64.pow(3)),
                Some('b') => (&value[..value.len() - 1], 1u64),
                _ => (value, 1u64),
            };
            let bytes = digits
                .parse::<u64>()
                .ok()
                .and_then(|amount| amount.checked_mul(factor))
                .ok_or_else(|| "Split size is invalid or too large.".to_string())?;
            if bytes < 1024 * 1024 {
                return Err("Split size must be at least 1 MiB.".to_string());
            }
        }
    }

    if cmd == "a" && positional_after_separator != 1 {
        let single_stream = args.iter().any(|arg| {
            matches!(
                arg.to_ascii_lowercase().as_str(),
                "-tgzip" | "-tbzip2" | "-txz"
            )
        });
        if single_stream {
            return Err("GZIP, BZIP2, and XZ compression accept exactly one input. Use a TAR-based format for multiple files.".to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_run_7z_args_rejects_delete_after_for_compress() {
        let args = vec![
            "a".to_string(),
            "-sdel".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_accepts_public_maximum_path_batch() {
        let mut args = vec![
            "a".to_string(),
            "-t7z".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
        ];
        args.extend((0..4_096).map(|index| format!("input-{index}.txt")));
        validate_run_7z_args(&args).expect("4,096 input paths plus bounded options should fit");
    }

    #[test]
    fn validate_run_7z_args_rejects_delete_after_outside_compress() {
        let args = vec![
            "x".to_string(),
            "-sdel".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_allows_typical_compress_switches() {
        let args = vec![
            "a".to_string(),
            "-t7z".to_string(),
            "-mx=9".to_string(),
            "-md=64m".to_string(),
            "-ms=on".to_string(),
            "-mmt=4".to_string(),
            "-mhe=on".to_string(),
            "-snl".to_string(),
            "-snh".to_string(),
            "-p secret".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_allows_typical_extract_switches() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "-aou".to_string(),
            "-y".to_string(),
            "-spd".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_requires_extract_overwrite_policy() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "-y".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        let err = validate_run_7z_args(&args).expect_err("missing -ao*");
        assert!(
            err.contains("overwrite"),
            "expected overwrite policy error, got: {err}"
        );
    }

    #[test]
    fn validate_run_7z_args_rejects_stdin_stdout_switches() {
        for bad in ["-si", "-so", "-si{name}", "-so2"] {
            let args = vec![
                "a".to_string(),
                bad.to_string(),
                "out.7z".to_string(),
                "--".to_string(),
                "input.txt".to_string(),
            ];
            assert!(
                validate_run_7z_args(&args).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[test]
    fn validate_run_7z_args_rejects_ssw_and_open_ended_method_switches() {
        for bad in ["-ssw", "-mfoo=1", "-m", "-mxyz"] {
            let err = validate_run_7z_args(&[
                "a".to_string(),
                bad.to_string(),
                "out.7z".to_string(),
                "--".to_string(),
                "in.txt".to_string(),
            ])
            .expect_err("unsafe method/ssw switch");
            assert!(
                err.contains("not permitted"),
                "expected '{bad}' to be rejected, got {err}"
            );
        }
        validate_run_7z_args(&[
            "a".to_string(),
            "-mx=9".to_string(),
            "-mhe=on".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect("known method switches should pass");
    }

    #[test]
    fn validate_run_7z_args_rejects_unknown_switches() {
        for bad in ["-sao", "-foo", "-an", "-c", "-ssw"] {
            let args = vec![
                "a".to_string(),
                bad.to_string(),
                "out.7z".to_string(),
                "--".to_string(),
                "input.txt".to_string(),
            ];
            assert!(
                validate_run_7z_args(&args).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[test]
    fn validate_run_7z_args_rejects_dash_leading_output_path() {
        let args = vec![
            "a".to_string(),
            "-evil.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_allows_benchmark_command() {
        assert!(validate_run_7z_args(&["b".to_string()]).is_ok());
        assert!(validate_run_7z_args(&["b".to_string(), "-mmt=4".to_string()]).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_benchmark_with_paths() {
        let args = vec!["b".to_string(), "--".to_string(), "file.txt".to_string()];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_allows_update_command() {
        let args = vec![
            "u".to_string(),
            "-t7z".to_string(),
            "existing.7z".to_string(),
            "--".to_string(),
            "newfile.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_delete_after_for_update() {
        let args = vec![
            "u".to_string(),
            "-sdel".to_string(),
            "existing.7z".to_string(),
            "--".to_string(),
            "newfile.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_rejects_volume_switch_for_update() {
        let args = vec![
            "u".to_string(),
            "-v100m".to_string(),
            "existing.7z".to_string(),
            "--".to_string(),
            "newfile.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_allows_volume_switch_for_compress() {
        let args = vec![
            "a".to_string(),
            "-v100m".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_invalid_format_method_controls() {
        for (format, method_switch) in [
            ("tar", "-md=64m"),
            ("tar", "-mfb=64"),
            ("gzip", "-md=64m"),
            ("bzip2", "-mfb=64"),
            ("zip", "-md=64m"),
        ] {
            let args = vec![
                "a".to_string(),
                format!("-t{format}"),
                method_switch.to_string(),
                format!("out.{format}"),
                "--".to_string(),
                "input.txt".to_string(),
            ];
            assert!(
                validate_run_7z_args(&args).is_err(),
                "{format} unexpectedly accepted {method_switch}"
            );
        }
    }

    #[test]
    fn validate_run_7z_args_rejects_unsafe_update_and_split_shapes() {
        for args in [
            vec!["u", "-tgzip", "out.gz", "--", "input.txt"],
            vec!["u", "-t7z", "out.7z.001", "--", "input.txt"],
            vec!["a", "-t7z", "-v1b", "out.7z", "--", "input.txt"],
            vec!["a", "-tgzip", "out.tgz", "--", "input.txt"],
        ] {
            let owned = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert!(
                validate_run_7z_args(&owned).is_err(),
                "unsafe command unexpectedly passed: {owned:?}"
            );
        }
    }

    #[test]
    fn validate_run_7z_args_rejects_volume_switch_outside_compress() {
        let args = vec![
            "x".to_string(),
            "-v100m".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_rejects_parent_dir_in_positional_path() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "-aou".to_string(),
            "--".to_string(),
            "../../etc/passwd".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_rejects_parent_dir_in_output_switch() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/../etc".to_string(),
            "-aou".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_rejects_parent_dir_in_include_switch() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "-aou".to_string(),
            "-ir!../../secret".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_rejects_parent_dir_in_workdir_switch() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "-aou".to_string(),
            "-w../../tmp".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_allows_dotdot_inside_filename() {
        let args = vec![
            "a".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "name..bak.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_allows_dash_leading_paths_after_separator() {
        let args = vec![
            "a".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "-dash-leading-file.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_extract_without_output_dir() {
        let args = vec![
            "x".to_string(),
            "-aou".to_string(),
            "-y".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        let err = validate_run_7z_args(&args).unwrap_err();
        assert!(err.contains("-o"), "expected error about -o, got: {err}");
    }

    #[test]
    fn validate_run_7z_args_rejects_listfile_reference_before_separator() {
        let args = vec![
            "a".to_string(),
            "@listfile.txt".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        let err = validate_run_7z_args(&args).unwrap_err();
        assert!(
            err.contains("response files"),
            "expected response file error, got: {err}"
        );
    }

    #[test]
    fn validate_run_7z_args_allows_at_sign_after_separator() {
        // After --, leading @ is treated as a literal filename by 7z.
        let args = vec![
            "a".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "@literal-at-file.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_unsafe_extract_path_mode() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "-aou".to_string(),
            "-spf".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_rejects_absolute_path_storage_for_create_and_update() {
        for command in ["a", "u"] {
            let args = vec![
                command.to_string(),
                "-spf".to_string(),
                "out.7z".to_string(),
                "--".to_string(),
                "input.txt".to_string(),
            ];
            assert!(
                validate_run_7z_args(&args).is_err(),
                "expected -spf to be rejected for {command}"
            );
        }
    }

    #[test]
    fn validate_run_7z_args_rejects_all_compress_includes() {
        for bad in [
            "-i!unselected.txt",
            "-ir!*.rs",
            "-i!/etc/passwd",
            r"-i!C:\Windows\secret",
            r"-ir!\abs\*",
        ] {
            let args = vec![
                "a".to_string(),
                "-t7z".to_string(),
                bad.to_string(),
                "out.7z".to_string(),
                "--".to_string(),
                "input.txt".to_string(),
            ];
            assert!(
                validate_run_7z_args(&args).is_err(),
                "expected {bad} to be rejected"
            );
        }
        let ok = vec![
            "a".to_string(),
            "-t7z".to_string(),
            "-x!*.tmp".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&ok).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_overwrite_all_extract_modes() {
        for bad in ["-aoa", "-aot"] {
            let args = vec![
                "x".to_string(),
                "-o/tmp/out".to_string(),
                bad.to_string(),
                "--".to_string(),
                "archive.7z".to_string(),
            ];
            assert!(
                validate_run_7z_args(&args).is_err(),
                "expected {bad} to be rejected"
            );
        }
        let ok = vec![
            "x".to_string(),
            "-o/tmp/out".to_string(),
            "-aou".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&ok).is_ok());
    }

    #[test]
    fn validate_run_7z_args_rejects_duplicate_extract_output() {
        let args = vec![
            "x".to_string(),
            "-o/tmp/one".to_string(),
            "-o/tmp/two".to_string(),
            "-aou".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_err());
    }

    #[test]
    fn validate_run_7z_args_rejects_embedded_listfiles_and_sfx_modules() {
        for switch in ["-ir@files.txt", "-xr@files.txt", "-sfx7z.sfx"] {
            let args = vec![
                "a".to_string(),
                switch.to_string(),
                "out.7z".to_string(),
                "--".to_string(),
                "input.txt".to_string(),
            ];
            assert!(validate_run_7z_args(&args).is_err(), "accepted {switch}");
        }
    }

    #[test]
    fn archive_member_path_is_unsafe_detects_traversal_and_absolutes() {
        assert!(!archive_member_path_is_unsafe("folder/file.txt"));
        assert!(!archive_member_path_is_unsafe("name..bak.txt"));
        assert!(archive_member_path_is_unsafe("../sibling/file.txt"));
        assert!(archive_member_path_is_unsafe("a/../../b"));
        assert!(archive_member_path_is_unsafe("/etc/passwd"));
        #[cfg(target_os = "windows")]
        assert!(archive_member_path_is_unsafe(r"C:\Windows\evil.dll"));
        #[cfg(target_os = "windows")]
        assert!(archive_member_path_is_unsafe(r"\\server\share\file"));
        #[cfg(target_os = "windows")]
        {
            assert!(archive_member_path_is_unsafe("sub/.. "));
            assert!(archive_member_path_is_unsafe("sub/.. ."));
            assert!(archive_member_path_is_unsafe("..."));
            assert!(archive_member_path_is_unsafe("notes.txt:evil"));
            assert!(archive_member_path_is_unsafe("folder/CON"));
            assert!(archive_member_path_is_unsafe("folder/aux.c"));
            assert!(archive_member_path_is_unsafe("COM1.txt"));
            assert!(!archive_member_path_is_unsafe("folder/normal.txt"));
            assert!(!archive_member_path_is_unsafe("name..bak.txt"));
            assert!(!archive_member_path_is_unsafe("dots...and..spaces.txt"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(!archive_member_path_is_unsafe(r"a:b"));
            assert!(!archive_member_path_is_unsafe(r"\literal-name"));
            // Backslash separators still carry `..` components on every OS.
            assert!(archive_member_path_is_unsafe(r"folder\..\literal"));
        }
        assert!(!is_allowed_method_switch("-mx=../evil"));
        assert!(!is_allowed_method_switch("-md=/tmp"));
        assert!(!is_allowed_method_switch(r"-mmt=4\x"));
        assert!(is_allowed_method_switch("-mx=9"));
        assert!(is_allowed_method_switch("-mmt=4"));
    }

    #[test]
    fn validate_run_7z_args_rejects_password_line_breaks() {
        let err = validate_run_7z_args(&[
            "a".to_string(),
            "-t7z".to_string(),
            "-psecret\nmore".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect_err("line-break password");
        assert!(err.contains("line breaks"), "{err}");
    }

    #[test]
    fn validate_run_7z_args_rejects_password_for_non_encrypting_formats() {
        for format in ["-tgzip", "-tbzip2", "-txz", "-ttar"] {
            let err = validate_run_7z_args(&[
                "a".to_string(),
                format.to_string(),
                "-psecret".to_string(),
                "out.bin".to_string(),
                "--".to_string(),
                "in.txt".to_string(),
            ])
            .expect_err("password on non-encrypting format");
            assert!(
                err.contains("Password encryption is not supported"),
                "format {format}: {err}"
            );
        }
        validate_run_7z_args(&[
            "a".to_string(),
            "-t7z".to_string(),
            "-psecret".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect("7z password create");
        validate_run_7z_args(&[
            "a".to_string(),
            "-tzip".to_string(),
            "-psecret".to_string(),
            "out.zip".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect("zip password create");
        validate_run_7z_args(&[
            "a".to_string(),
            "-t7z".to_string(),
            "-stl".to_string(),
            "-psecret".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect("-stl is not an archive type");
    }

    #[test]
    fn validate_run_7z_args_rejects_password_with_conflicting_types() {
        let err = validate_run_7z_args(&[
            "a".to_string(),
            "-t7z".to_string(),
            "-tgzip".to_string(),
            "-psecret".to_string(),
            "out.gz".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect_err("multi -t with password");
        assert!(err.contains("at most one archive type"), "{err}");
    }

    #[test]
    fn validate_run_7z_args_rejects_zipcrypto_for_password_zip() {
        let err = validate_run_7z_args(&[
            "u".to_string(),
            "-tzip".to_string(),
            "-psecret".to_string(),
            "-mem=ZipCrypto".to_string(),
            "out.zip".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect_err("ZipCrypto on password ZIP");
        assert!(err.contains("AES-256"), "{err}");
        validate_run_7z_args(&[
            "u".to_string(),
            "-tzip".to_string(),
            "-psecret".to_string(),
            "-mem=AES256".to_string(),
            "out.zip".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect("AES-256 password ZIP");
        validate_run_7z_args(&[
            "u".to_string(),
            "-psecret".to_string(),
            "out.zip".to_string(),
            "--".to_string(),
            "in.txt".to_string(),
        ])
        .expect("password ZIP without explicit -mem (backend injects AES-256)");
    }

    #[test]
    fn validate_run_7z_args_rejects_stderr_silence_stream_switches() {
        for switch in ["-bse0", "-bso0", "-bsp0", "-bse1", "-bso1"] {
            let err = validate_run_7z_args(&[
                "x".to_string(),
                switch.to_string(),
                "-aou".to_string(),
                "-o/tmp/out".to_string(),
                "--".to_string(),
                "in.zip".to_string(),
            ])
            .expect_err(switch);
            assert!(err.contains("not permitted"), "{switch}: {err}");
        }
        validate_run_7z_args(&[
            "x".to_string(),
            "-bsp1".to_string(),
            "-aou".to_string(),
            "-o/tmp/out".to_string(),
            "--".to_string(),
            "in.zip".to_string(),
        ])
        .expect("-bsp1 progress stream");
        validate_run_7z_args(&[
            "x".to_string(),
            "-bsp2".to_string(),
            "-aou".to_string(),
            "-o/tmp/out".to_string(),
            "--".to_string(),
            "in.zip".to_string(),
        ])
        .expect_err("-bsp2 relocates progress to stderr and must be rejected");
    }
}
