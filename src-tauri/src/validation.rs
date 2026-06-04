//! Allow-list validation for 7z args. Security boundary between frontend and process.

const MAX_7Z_ARGS: usize = 256;
const MAX_7Z_ARG_BYTES: usize = 8192;

const ALLOWED_7Z_COMMANDS: &[&str] = &["a", "u", "x", "l", "t"];
const BLOCKED_7Z_ARGS: &[&str] = &["-si", "-so"];
const ALLOWED_7Z_SWITCH_PREFIXES: &[&str] = &[
    "-t", "-m", "-o", "-p", "-spf", "-sdel", "-spd", "-sfx", "-v", "-y", "-r", "-w", "-x", "-i",
    "-ao", "-ba", "-bb", "-bs", "-bt", "-scs", "-slt", "-sns", "-snl", "-sni", "-stl", "-slp",
    "-ssp", "-ssw",
];

// True if any path component is exactly "..". Substrings like "name..bak" are fine.
fn has_parent_dir_component(path: &str) -> bool {
    path.split(['/', '\\']).any(|component| component == "..")
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

    for (idx, arg) in args.iter().enumerate().skip(1) {
        if arg == "--" {
            if separator_index.is_some() {
                return Err("7z argument separator '--' may appear only once.".to_string());
            }
            separator_index = Some(idx);
            continue;
        }

        let lower = arg.to_lowercase();
        if BLOCKED_7Z_ARGS.iter().any(|b| lower.starts_with(b)) {
            return Err(format!("7z argument '{arg}' is not permitted."));
        }
        if lower.starts_with("-sdel") && cmd != "a" && cmd != "u" {
            return Err(format!(
                "7z argument '{arg}' is only permitted for compression."
            ));
        }
        if lower.starts_with("-v") && cmd != "a" {
            return Err(format!(
                "7z argument '{arg}' is only permitted when creating an archive."
            ));
        }

        if separator_index.is_some() {
            positional_after_separator += 1;
            if has_parent_dir_component(arg) {
                return Err(format!(
                    "7z path '{arg}' must not contain a '..' parent-directory segment."
                ));
            }
        } else if arg.starts_with('-') {
            if !ALLOWED_7Z_SWITCH_PREFIXES
                .iter()
                .any(|p| lower.starts_with(p))
            {
                return Err(format!("7z argument '{arg}' is not permitted."));
            }
            // -o<dir> sets the extract/output directory; block traversal in it.
            if lower.starts_with("-o") && has_parent_dir_component(&arg[2..]) {
                return Err(format!(
                    "7z output path '{arg}' must not contain a '..' parent-directory segment."
                ));
            }
        } else {
            positional_before_separator += 1;
            if has_parent_dir_component(arg) {
                return Err(format!(
                    "7z path '{arg}' must not contain a '..' parent-directory segment."
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
        }
        "l" | "t" => {
            if let Some(separator) = separator_index {
                if separator + 1 >= args.len() {
                    return Err("Missing archive path after '--'.".to_string());
                }
            } else if positional_before_separator == 0 {
                return Err("Missing archive path.".to_string());
            }
        }
        _ => {}
    }

    if (cmd == "a" || cmd == "u" || cmd == "x") && positional_after_separator == 0 {
        return Err("Missing archive path(s) after '--'.".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_run_7z_args_allows_internal_delete_after_for_compress() {
        let args = vec![
            "a".to_string(),
            "-sdel".to_string(),
            "out.7z".to_string(),
            "--".to_string(),
            "input.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
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
            "-y".to_string(),
            "-spd".to_string(),
            "--".to_string(),
            "archive.7z".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
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
    fn validate_run_7z_args_rejects_unknown_switches() {
        for bad in ["-sao", "-foo", "-an", "-c"] {
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
    fn validate_run_7z_args_allows_delete_after_for_update() {
        let args = vec![
            "u".to_string(),
            "-sdel".to_string(),
            "existing.7z".to_string(),
            "--".to_string(),
            "newfile.txt".to_string(),
        ];
        assert!(validate_run_7z_args(&args).is_ok());
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
}
