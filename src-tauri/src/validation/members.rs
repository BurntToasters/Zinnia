//! Archive member path safety rules.

// True if any path component is exactly "..". Substrings like "name..bak" are fine.
pub(crate) fn has_parent_dir_component(path: &str) -> bool {
    path.split(['/', '\\']).any(|component| component == "..")
}

/// True when an archive member path could escape an extract `-o` root.
///
/// Platform-neutral rules: any `..` component (either separator) and a leading
/// `/`. Windows-only rules (rooted and drive paths, trailing dot/space, NTFS
/// streams, reserved device names) apply only on Windows hosts. A Unix host
/// keeps those names literal, so a Linux archive containing `report:2026.txt`
/// still extracts there; the same archive is re-checked when opened on Windows.
pub(crate) fn archive_member_path_is_unsafe(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    // Normalize both separators on every platform so ZIP members that use
    // Windows-style `\` cannot smuggle `..` past a POSIX-only splitter.
    if path.split(['/', '\\']).any(|component| component == "..") {
        return true;
    }
    if path.as_bytes().first() == Some(&b'/') {
        return true;
    }
    windows_member_path_is_unsafe(path)
}

/// Win32 member-path rules: backslash-rooted and drive-absolute paths, plus
/// per-component naming rules. Enforced only where Windows interprets the path.
#[cfg(windows)]
fn windows_member_path_is_unsafe(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.first() == Some(&b'\\') {
        return true;
    }
    // Drive-absolute: `C:\...` or `C:/...`
    if bytes.len() >= 2 && bytes[1] == b':' {
        return true;
    }
    path.split(['/', '\\'])
        .any(windows_component_name_is_unsafe)
}

#[cfg(not(windows))]
fn windows_member_path_is_unsafe(_path: &str) -> bool {
    false
}

/// Win32 naming rules for one path component: Win32 strips trailing dots and
/// spaces (so `...` and `.. ` resolve to `..`, and `notes.txt.` collides with
/// `notes.txt`), any other colon opens an NTFS alternate data stream, and
/// reserved device names resolve to devices. Applied on every platform to
/// derived folder names, which may later be opened on Windows.
pub(crate) fn windows_component_name_is_unsafe(component: &str) -> bool {
    if component.is_empty() {
        return false;
    }
    if component.ends_with('.') || component.ends_with(' ') {
        return true;
    }
    if component.contains(':') {
        return true;
    }
    is_win32_reserved_device_name(component)
}

/// Win32 device-name check on the dot-stem, case-insensitive, any extension.
fn is_win32_reserved_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    let mut folded = String::with_capacity(stem.len());
    for ch in stem.chars() {
        match ch {
            '¹' => folded.push('1'),
            '²' => folded.push('2'),
            '³' => folded.push('3'),
            c if c.is_ascii() => folded.push(c.to_ascii_uppercase()),
            c => folded.extend(c.to_uppercase()),
        }
    }
    matches!(
        folded.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CONIN$"
            | "CONOUT$"
            | "CLOCK$"
            | "COM0"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT0"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub(super) fn switch_contains_parent_traversal(arg: &str) -> bool {
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
