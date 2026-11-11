//! 7z switch allow-list helpers.

use super::members::archive_member_path_is_unsafe;

pub(super) fn has_embedded_listfile(arg: &str) -> bool {
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
pub(super) fn is_include_or_exclude(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    (lower.starts_with("-i") || lower.starts_with("-x"))
        && !has_embedded_listfile(arg)
        && arg.contains('!')
}

pub(super) fn is_include_switch(arg: &str) -> bool {
    arg.to_ascii_lowercase().starts_with("-i") && arg.contains('!')
}

pub(super) fn include_exclude_payload(arg: &str) -> Option<&str> {
    let index = arg.find('!')?;
    Some(&arg[index + 1..])
}

/// Compress `-i!` / `-x!` payloads that name absolute host paths bypass the
/// after-`--` real-path / reparse checks. Reject those shapes here.
pub(super) fn compress_include_exclude_payload_is_unsafe(payload: &str) -> bool {
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
}

fn method_switch_value_is_safe(value: &str) -> bool {
    !value.is_empty() && !value.contains('/') && !value.contains('\\') && !value.contains("..")
}

pub(super) fn is_allowed_method_switch(lower: &str) -> bool {
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

pub(super) fn is_allowed_switch(cmd: &str, arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    if is_common_diagnostic_switch(&lower) {
        return true;
    }

    match cmd {
        "a" | "u" => {
            (lower.starts_with("-t") && lower.len() > 2)
                || is_allowed_method_switch(&lower)
                || (lower.starts_with("-p") && lower.len() > 2)
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
                || (lower.starts_with("-t") && lower.len() > 2)
                || is_include_or_exclude(arg)
        }
        "l" | "t" => {
            (lower.starts_with("-p") && lower.len() > 2)
                || (lower.starts_with("-t") && lower.len() > 2)
                || lower == "-spd"
                || is_include_or_exclude(arg)
        }
        "b" => is_allowed_method_switch(&lower),
        _ => false,
    }
}
