//! ZIP create/update policy helpers.

pub(crate) fn archive_type_switches(args: &[String]) -> Vec<String> {
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

pub(crate) fn is_zip_create_or_update(args: &[String]) -> bool {
    let Some(cmd) = args.first() else {
        return false;
    };
    if !matches!(cmd.as_str(), "a" | "u") {
        return false;
    }
    if args.iter().any(|arg| arg.eq_ignore_ascii_case("-tzip")) {
        return true;
    }
    create_output_looks_like_zip(args)
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
