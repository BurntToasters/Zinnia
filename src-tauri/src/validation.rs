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
// BLOCKED so those switches validate; users cannot pass them via extra-args
// (not in ALLOWED_EXTRA_PREFIXES).
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
    let bytes = arg.as_bytes();
    bytes.len() == 5
        && bytes[0..3].eq_ignore_ascii_case(b"-bs")
        && matches!(bytes[3].to_ascii_lowercase(), b'o' | b'e' | b'p')
        && matches!(bytes[4], b'0' | b'1' | b'2')
}

fn is_include_or_exclude(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    (lower.starts_with("-i") || lower.starts_with("-x"))
        && !has_embedded_listfile(arg)
        && arg.contains('!')
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

fn is_allowed_method_switch(lower: &str) -> bool {
    // Intentionally narrow: reject open-ended -m* (and -ssw is blocked separately).
    // Prefixes ending in '=' require a non-empty value. Others require end / '=' / digit
    // so `-mxyz` does not match `-mx`.
    const PREFIXES: &[&str] = &[
        "-m0=", "-mem=", "-mhe=", "-mtc=", "-mta=", "-mhc=", "-mcu=", "-mcl=", "-mx", "-md",
        "-mfb", "-ms", "-mmt",
    ];
    for prefix in PREFIXES {
        let Some(rest) = lower.strip_prefix(prefix) else {
            continue;
        };
        if prefix.ends_with('=') {
            return !rest.is_empty()
                && !rest.contains('/')
                && !rest.contains('\\')
                && !rest.contains("..");
        }
        return rest.is_empty()
            || rest.starts_with('=')
            || rest.chars().next().is_some_and(|ch| ch.is_ascii_digit());
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

/// True when an archive member path could escape an extract `-o` root
/// (`..`, absolute POSIX, drive-letter, or UNC).
pub(crate) fn archive_member_path_is_unsafe(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    #[cfg(target_os = "windows")]
    let has_parent = path.split(['/', '\\']).any(|component| component == "..");
    #[cfg(not(target_os = "windows"))]
    let has_parent = path.split('/').any(|component| component == "..");
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
    false
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
            if arg.len() > 2 && arg[2..].contains(['\r', '\n']) {
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
        let formats: Vec<String> = args
            .iter()
            .take(separator_index.unwrap_or(args.len()))
            .skip(1)
            .filter_map(|arg| {
                // ASCII-only: compared prefixes/values are ASCII archive-type
                // tokens (7z/zip/tar/gzip/...); no need for Unicode casing.
                let lower = arg.to_ascii_lowercase();
                // `-stl` / `-stx…` are not archive-type switches; only `-tTYPE`.
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
        let method = args[1..separator].iter().find_map(|arg| {
            arg.to_ascii_lowercase()
                .strip_prefix("-m0=")
                .map(str::to_string)
        });
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
                return Err(
                    "Compound TAR stream output is not supported in this release.".to_string(),
                );
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
        #[cfg(not(target_os = "windows"))]
        {
            assert!(!archive_member_path_is_unsafe(r"a:b"));
            assert!(!archive_member_path_is_unsafe(r"\literal-name"));
            assert!(!archive_member_path_is_unsafe(r"folder\..\literal"));
        }
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
}
