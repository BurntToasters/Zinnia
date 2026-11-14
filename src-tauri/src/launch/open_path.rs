//! Allowlist and open-path commands.

use tauri::{Manager, Url};

use super::{
    is_extract_window_label, ExtractBoundDestination, ExtractOpenAllowlist, InitialMode,
    InitialPaths, OpenPathAllowlist, OpenPathsPayload, PendingPaths, MAX_OPENABLE_DIRECTORIES,
};

/// Remember a destination folder after a successful compress/extract so the main
/// window can open it later. Failures are ignored (open will simply refuse).
pub fn remember_openable_directory(app: &tauri::AppHandle, path: &std::path::Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if crate::path_safety::is_link_or_reparse(&meta) || !meta.is_dir() {
        return;
    }
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    let Some(state) = app.try_state::<OpenPathAllowlist>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    guard.retain(|existing| existing != &canonical);
    guard.push_back(canonical);
    while guard.len() > MAX_OPENABLE_DIRECTORIES {
        guard.pop_front();
    }
}
#[cfg(windows)]
pub(crate) fn normalize_shell_open_path(path: std::path::PathBuf) -> std::path::PathBuf {
    use std::path::PathBuf;

    let text = path.to_string_lossy();
    let Some(rest) = text.strip_prefix(r"\\?\") else {
        return path;
    };
    if rest
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC\\"))
    {
        return PathBuf::from(format!(r"\\{}", &rest[4..]));
    }
    let bytes = rest.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return PathBuf::from(rest);
    }
    // Keep volume-GUID and any other namespace path intact. Removing `\\?\`
    // from `\\?\Volume{GUID}\...` produces a relative, unusable path.
    path
}

#[cfg(not(windows))]
pub(crate) fn normalize_shell_open_path(path: std::path::PathBuf) -> std::path::PathBuf {
    path
}

pub(crate) fn normalize_destination_path(
    path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            crate::path_safety::reject_link_or_reparse(path, &meta)?;
            path.canonicalize().map_err(|e| e.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = match path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent,
                _ => std::path::Path::new("."),
            };
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| format!("Could not resolve destination parent: {e}"))?;
            let name = path
                .file_name()
                .ok_or_else(|| "Destination path must have a directory name.".to_string())?;
            Ok(canonical_parent.join(name))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Keep aligned with `src/extract-path.ts` deriveExtractDestinationPath + parent fallback.
pub fn derive_extract_destination_path(archive_path: &str) -> Option<std::path::PathBuf> {
    if archive_path.is_empty() {
        return None;
    }
    if let Some(derived) = derive_extract_folder_destination(archive_path) {
        return Some(derived);
    }
    parent_dir_path(archive_path)
}

pub(crate) fn parent_dir_path(path: &str) -> Option<std::path::PathBuf> {
    let parts = split_path_parts(path);
    if parts.name.is_empty() {
        return None;
    }
    if parts.parent.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(parts.parent))
}

pub(crate) fn derive_extract_folder_destination(archive_path: &str) -> Option<std::path::PathBuf> {
    let parts = split_path_parts(archive_path);
    if parts.name.is_empty() {
        return None;
    }
    let folder = derive_extract_folder_name(&parts.name)?;
    Some(std::path::PathBuf::from(join_path(
        &parts.parent,
        &folder,
        parts.separator,
    )))
}

pub(crate) struct PathParts {
    parent: String,
    name: String,
    separator: char,
}

pub(crate) fn looks_like_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || path.starts_with("\\\\")
}

pub(crate) fn split_path_parts(raw_path: &str) -> PathParts {
    let archive_path = raw_path;
    if archive_path.is_empty() {
        return PathParts {
            parent: String::new(),
            name: String::new(),
            separator: '/',
        };
    }
    let windows_like = looks_like_windows_path(archive_path);
    let slash = archive_path.rfind('/');
    let backslash = if windows_like {
        archive_path.rfind('\\')
    } else {
        None
    };
    let split_index = match (slash, backslash) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    let separator = match split_index {
        None if windows_like => '\\',
        None => '/',
        Some(idx) if backslash == Some(idx) => '\\',
        Some(_) => '/',
    };
    let Some(idx) = split_index else {
        return PathParts {
            parent: String::new(),
            name: archive_path.to_string(),
            separator,
        };
    };
    let mut parent = archive_path[..idx].to_string();
    let name = archive_path[idx + 1..].to_string();
    if parent.is_empty() && separator == '/' {
        parent = "/".to_string();
    } else if parent.len() == 2
        && parent.as_bytes()[0].is_ascii_alphabetic()
        && parent.as_bytes()[1] == b':'
    {
        parent = format!("{parent}{separator}");
    }
    PathParts {
        parent,
        name,
        separator,
    }
}

pub(crate) fn join_path(parent: &str, name: &str, separator: char) -> String {
    if parent.is_empty() {
        return name.to_string();
    }
    if parent.ends_with('/') || parent.ends_with('\\') {
        return format!("{parent}{name}");
    }
    format!("{parent}{separator}{name}")
}

fn sanitize_extract_folder_name(folder: &str) -> String {
    if folder == "." || folder == ".." {
        return "_extracted".to_string();
    }
    if !folder.is_empty() && folder.chars().all(|ch| ch == '.') {
        return "_extracted".to_string();
    }
    if folder.ends_with('.') || folder.ends_with(' ') {
        return "_extracted".to_string();
    }
    if folder.contains(':') {
        return "_extracted".to_string();
    }
    // Never derive a Windows device name (CON, NUL, COM1, ...) or an NTFS
    // stream name even on Unix: the folder may later be opened on Windows.
    // A braced CLSID (`name.{GUID}`) is the same kind of hazard: Windows shell
    // parsing resolves it to a namespace extension instead of the folder.
    for component in folder.split(['/', '\\']) {
        if component == ".."
            || crate::validation::windows_component_name_is_unsafe(component)
            || contains_braced_clsid(component)
        {
            return "_extracted".to_string();
        }
    }
    folder.to_string()
}

/// True when `text` contains a braced GUID such as `{20D04FE0-3AEA-1069-A2D8-08002B30309D}`.
fn contains_braced_clsid(text: &str) -> bool {
    text.as_bytes().windows(38).any(is_braced_guid)
}

fn is_braced_guid(window: &[u8]) -> bool {
    if window.len() != 38 || window[0] != b'{' || window[37] != b'}' {
        return false;
    }
    window[1..37]
        .iter()
        .enumerate()
        .all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// True when any component of `path` carries a braced CLSID. Windows resolves
/// such a folder to a shell namespace extension, so opening it does not show
/// the folder's contents. Both separators split components.
pub(crate) fn path_has_shell_namespace_component(path: &str) -> bool {
    path.split(['/', '\\']).any(contains_braced_clsid)
}

/// Windows-only policy, with `windows` as a parameter so the decision is testable
/// on every OS. Windows would open such a folder as a shell view, not its contents.
fn shell_namespace_refusal(path: &str, windows: bool) -> Option<&'static str> {
    (windows && path_has_shell_namespace_component(path)).then_some(
        "This folder's name contains a Windows shell class ID ({GUID}), so Windows would open a shell view instead of the folder. Open it from File Explorer instead.",
    )
}

pub(crate) fn derive_extract_folder_name(archive_name: &str) -> Option<String> {
    const SUFFIXES: &[&str] = &[
        ".tar.gz", ".tar.bz2", ".tar.xz", ".tbz2", ".tgz", ".txz", ".7z", ".zip", ".rar", ".tar",
        ".gz", ".bz2", ".xz",
    ];
    let cleaned = archive_name;
    if cleaned.is_empty() {
        return None;
    }
    let lower = cleaned.to_ascii_lowercase();
    for suffix in SUFFIXES {
        if lower.ends_with(suffix) && cleaned.len() > suffix.len() {
            return Some(sanitize_extract_folder_name(
                &cleaned[..cleaned.len() - suffix.len()],
            ));
        }
    }
    Some(sanitize_extract_folder_name(&format!(
        "{cleaned}_extracted"
    )))
}

/// Ensure an extract window's `-o` / open path matches the destination bound at spawn.
pub fn assert_extract_bound_destination(
    app: &tauri::AppHandle,
    label: &str,
    requested: &std::path::Path,
) -> Result<(), String> {
    let state = app
        .try_state::<ExtractBoundDestination>()
        .ok_or_else(|| "Extract destination binding is unavailable.".to_string())?;
    let guard = state
        .0
        .lock()
        .map_err(|_| "Extract destination lock poisoned.".to_string())?;
    let Some(bound) = guard.get(label) else {
        return Err("Extract window has no bound destination.".to_string());
    };
    let bound_norm = normalize_destination_path(&bound.destination)?;
    let requested_norm = normalize_destination_path(requested)?;
    if bound_norm != requested_norm {
        return Err(
            "Quick-extract windows may only write to their bound destination folder.".to_string(),
        );
    }
    Ok(())
}

/// Ensure an extract window's `--` archive matches the archive bound at spawn.
pub fn assert_extract_bound_archive(
    app: &tauri::AppHandle,
    label: &str,
    requested: &std::path::Path,
) -> Result<(), String> {
    let state = app
        .try_state::<ExtractBoundDestination>()
        .ok_or_else(|| "Extract archive binding is unavailable.".to_string())?;
    let guard = state
        .0
        .lock()
        .map_err(|_| "Extract destination lock poisoned.".to_string())?;
    let Some(bound) = guard.get(label) else {
        return Err("Extract window has no bound archive.".to_string());
    };
    let bound_norm = normalize_destination_path(&bound.archive)?;
    let requested_norm = normalize_destination_path(requested)?;
    if bound_norm != requested_norm {
        return Err("Quick-extract windows may only extract their bound archive.".to_string());
    }
    Ok(())
}
pub(crate) fn destination_in_chosen_folder(
    chosen: &std::path::Path,
    archive: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let meta = std::fs::symlink_metadata(chosen)
        .map_err(|_| "The chosen folder does not exist or cannot be read.".to_string())?;
    crate::path_safety::reject_link_or_reparse(chosen, &meta).map_err(|_| {
        "A symbolic link or reparse point cannot be used as the destination folder.".to_string()
    })?;
    if !meta.is_dir() {
        return Err("Choose a folder, not a file.".to_string());
    }
    let name = archive
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The archive name is not valid text.".to_string())?;
    let folder = derive_extract_folder_name(name)
        .ok_or_else(|| "Could not derive a folder name for this archive.".to_string())?;
    let destination = chosen.join(folder);
    match crate::path_safety::classify_extract_destination(&destination)? {
        crate::path_safety::ExtractDestinationStatus::Invalid => {
            Err("A file or link already uses that name in the chosen folder.".to_string())
        }
        crate::path_safety::ExtractDestinationStatus::Missing
        | crate::path_safety::ExtractDestinationStatus::Directory => Ok(destination),
    }
}

pub(crate) fn apply_picked_folder(
    bindings: &mut std::collections::HashMap<String, super::ExtractBoundPaths>,
    label: &str,
    picked: Option<std::path::PathBuf>,
) -> Result<Option<std::path::PathBuf>, String> {
    let bound = bindings
        .get_mut(label)
        .ok_or_else(|| "Extract window has no bound destination.".to_string())?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let destination = destination_in_chosen_folder(&folder, &bound.archive)?;
    bound.destination = destination.clone();
    Ok(Some(destination))
}

#[tauri::command(async)]
pub fn register_extract_open_path(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
    state: tauri::State<'_, ExtractOpenAllowlist>,
) -> Result<(), String> {
    if !is_extract_window_label(window.label()) {
        return Err("Only extract windows can register an open destination.".to_string());
    }
    let Some(raw_path) = normalize_open_path_arg(&path) else {
        return Err("Path is required.".to_string());
    };
    if raw_path.contains('\0') {
        return Err("Path contains invalid characters.".to_string());
    }
    let resolved = std::path::PathBuf::from(&raw_path);
    assert_extract_bound_destination(&app, window.label(), &resolved)?;
    let meta =
        std::fs::symlink_metadata(&resolved).map_err(|_| "Path does not exist.".to_string())?;
    crate::path_safety::reject_link_or_reparse(&resolved, &meta)
        .map_err(|_| "Symbolic links and reparse points cannot be opened directly.".to_string())?;
    if !meta.is_dir() {
        return Err("Only directories can be opened.".to_string());
    }
    let canonical = resolved
        .canonicalize()
        .map_err(|_| "Path does not exist.".to_string())?;
    let mut allowlist = state
        .0
        .lock()
        .map_err(|_| "Extract open allowlist lock poisoned.".to_string())?;
    allowlist.insert(window.label().to_string(), canonical);
    Ok(())
}

#[tauri::command(async)]
#[allow(deprecated)]
pub fn open_path(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
    extract_allowlist: tauri::State<'_, ExtractOpenAllowlist>,
    main_allowlist: tauri::State<'_, OpenPathAllowlist>,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let Some(raw_path) = normalize_open_path_arg(&path) else {
        return Err("Path is required.".to_string());
    };

    if raw_path.contains('\0') {
        return Err("Path contains invalid characters.".to_string());
    }

    let resolved = std::path::PathBuf::from(&raw_path);

    let meta =
        std::fs::symlink_metadata(&resolved).map_err(|_| "Path does not exist.".to_string())?;
    crate::path_safety::reject_link_or_reparse(&resolved, &meta)
        .map_err(|_| "Symbolic links and reparse points cannot be opened directly.".to_string())?;
    if !meta.is_dir() {
        return Err("Only directories can be opened.".to_string());
    }

    let canonical = resolved
        .canonicalize()
        .map_err(|_| "Path does not exist.".to_string())?;

    if is_extract_window_label(window.label()) {
        let allowed = extract_allowlist
            .0
            .lock()
            .map_err(|_| "Extract open allowlist lock poisoned.".to_string())?;
        let Some(expected) = allowed.get(window.label()) else {
            return Err(
                "Extract window must register its destination before opening it.".to_string(),
            );
        };
        if expected != &canonical {
            return Err("Extract windows may only open their registered destination.".to_string());
        }
    } else {
        let allowed = main_allowlist
            .0
            .lock()
            .map_err(|_| "Open-path allowlist lock poisoned.".to_string())?;
        if !allowed.iter().any(|entry| entry == &canonical) {
            return Err(
                "Only folders from a recent successful Zinnia compress/extract can be opened."
                    .to_string(),
            );
        }
    }

    #[cfg(target_os = "macos")]
    if macos_bundle_should_reveal(&canonical) {
        return reveal_in_finder(&canonical);
    }

    // Re-validate immediately before open: the path may have been swapped
    // for a symlink between canonicalization and the allowlist check.
    let re_meta =
        std::fs::symlink_metadata(&canonical).map_err(|_| "Path does not exist.".to_string())?;
    crate::path_safety::reject_link_or_reparse(&canonical, &re_meta)
        .map_err(|_| "Symbolic links and reparse points cannot be opened directly.".to_string())?;
    if !re_meta.is_dir() {
        return Err("Only directories can be opened.".to_string());
    }
    if let Some(message) = shell_namespace_refusal(&canonical.to_string_lossy(), cfg!(windows)) {
        return Err(message.to_string());
    }
    let normalized = normalize_shell_open_path(canonical);
    let path_str = normalized.to_string_lossy().to_string();
    app.shell().open(&path_str, None).map_err(|e| e.to_string())
}

/// Directory extensions that LaunchServices treats as launchable bundles or
/// installable packages when handed to `open`. Those reveal in Finder instead
/// of opening. Any other dotted folder name (`report.2026`) is an ordinary
/// directory and opens normally.
#[cfg(target_os = "macos")]
const MACOS_BUNDLE_EXTENSIONS: &[&str] = &[
    "app",
    "bundle",
    "framework",
    "plugin",
    "kext",
    "appex",
    "prefpane",
    "saver",
    "service",
    "workflow",
    "component",
    "pkg",
    "mpkg",
    "xpc",
    "rtfd",
    "key",
    "numbers",
    "pages",
    "photoslibrary",
];

#[cfg(target_os = "macos")]
fn macos_bundle_should_reveal(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MACOS_BUNDLE_EXTENSIONS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
}

#[cfg(target_os = "macos")]
fn reveal_in_finder(path: &std::path::Path) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg("--")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| format!("Could not reveal the folder in Finder: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Finder could not reveal the folder ({status})."))
    }
}

#[tauri::command]
pub fn get_initial_paths(state: tauri::State<'_, InitialPaths>) -> Result<Vec<String>, String> {
    let mut paths = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(std::mem::take(&mut *paths))
}

#[tauri::command]
pub fn get_initial_mode(state: tauri::State<'_, InitialMode>) -> Result<String, String> {
    let mode = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(mode.clone())
}

#[tauri::command]
pub fn drain_pending_paths(
    state: tauri::State<'_, PendingPaths>,
) -> Result<Vec<OpenPathsPayload>, String> {
    let mut q = state.0.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(std::mem::take(&mut *q))
}

pub(crate) fn normalize_open_path_arg(arg: &str) -> Option<String> {
    if arg.is_empty() || arg == "--" {
        return None;
    }
    if arg.contains('\0') {
        return None;
    }

    if arg.to_ascii_lowercase().starts_with("file://") {
        if let Ok(url) = Url::parse(arg) {
            if let Ok(path) = url.to_file_path() {
                return Some(path.to_string_lossy().to_string());
            }
            return None;
        }
    }

    Some(arg.to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::macos_bundle_should_reveal;
    use std::path::Path;

    #[test]
    fn dotted_folder_names_open_instead_of_revealing() {
        assert!(!macos_bundle_should_reveal(Path::new(
            "/Users/dev/Downloads/report.2026"
        )));
        assert!(!macos_bundle_should_reveal(Path::new(
            "/Users/dev/Downloads/archive.v2"
        )));
        assert!(!macos_bundle_should_reveal(Path::new(
            "/Users/dev/Downloads/Downloads"
        )));
        assert!(!macos_bundle_should_reveal(Path::new(
            "/Users/dev/Downloads/notes."
        )));
    }

    #[test]
    fn launchable_bundles_and_packages_reveal_instead_of_opening() {
        for name in [
            "Tool.app",
            "Tool.APP",
            "Plugin.bundle",
            "Lib.framework",
            "Installer.pkg",
            "Installer.MPKG",
            "Doc.rtfd",
            "Sheet.numbers",
            "Library.photoslibrary",
        ] {
            let path = format!("/Users/dev/Downloads/{name}");
            assert!(macos_bundle_should_reveal(Path::new(&path)), "{name}");
        }
    }
}

#[cfg(test)]
mod derived_folder_name_tests {
    use super::derive_extract_folder_name;

    #[test]
    fn derived_folder_names_avoid_windows_devices_and_streams_on_every_platform() {
        assert_eq!(
            derive_extract_folder_name("CON.zip").as_deref(),
            Some("_extracted")
        );
        assert_eq!(
            derive_extract_folder_name("aux.tar.gz").as_deref(),
            Some("_extracted")
        );
        assert_eq!(
            derive_extract_folder_name("notes:ads.zip").as_deref(),
            Some("_extracted")
        );
        assert_eq!(
            derive_extract_folder_name("notes..zip").as_deref(),
            Some("_extracted")
        );
        assert_eq!(
            derive_extract_folder_name("console.zip").as_deref(),
            Some("console")
        );
        assert_eq!(
            derive_extract_folder_name("report.2026.zip").as_deref(),
            Some("report.2026")
        );
    }
}

// Failure modes, written before the implementation:
// 1. A `name.{CLSID}` folder opened on Windows resolves to a shell namespace
//    extension (ILCreateFromPathW / explorer.exe parse display names), not the
//    folder's contents. Such a path must be refused before the shell is called.
// 2. A derived extract folder name carrying a braced CLSID must not be created,
//    because Zinnia would later open it as the namespace above.
// 3. Near-miss braces (wrong length, non-hex, missing braces) are ordinary names.
// 4. Both separators split components.
// 5. The check is pure, so it is testable on every OS; enforcement is Windows-only.
#[cfg(test)]
mod shell_namespace_tests {
    use super::{derive_extract_folder_name, path_has_shell_namespace_component};

    const GUID: &str = "{20D04FE0-3AEA-1069-A2D8-08002B30309D}";

    #[test]
    fn braced_clsid_components_are_shell_namespace_paths() {
        assert!(path_has_shell_namespace_component(&format!(
            r"C:\Users\dev\Downloads\Invoice.{GUID}"
        )));
        assert!(path_has_shell_namespace_component(&format!(
            "/Users/dev/Downloads/Invoice.{GUID}/sub"
        )));
        assert!(path_has_shell_namespace_component(&format!(
            r"C:\Users\dev\{GUID}\file"
        )));
        assert!(path_has_shell_namespace_component(&format!(
            r"C:\Users\dev\{}\plain",
            GUID.to_ascii_lowercase()
        )));
    }

    #[test]
    fn near_miss_braces_are_ordinary_names() {
        assert!(!path_has_shell_namespace_component(
            r"C:\Users\dev\draft{1}"
        ));
        assert!(!path_has_shell_namespace_component(
            r"C:\Users\dev\{20D04FE0-3AEA-1069-A2D8-0800}"
        ));
        assert!(!path_has_shell_namespace_component(
            r"C:\Users\dev\{ZZD04FE0-3AEA-1069-A2D8-08002B30309D}"
        ));
        assert!(!path_has_shell_namespace_component(
            r"C:\Users\dev\20D04FE0-3AEA-1069-A2D8-08002B30309D"
        ));
        assert!(!path_has_shell_namespace_component(r"C:\Users\dev\plain"));
    }

    #[test]
    fn windows_refuses_clsid_folders_and_other_platforms_keep_opening_them() {
        let path = format!(r"C:\Users\dev\Downloads\Invoice.{GUID}");
        assert!(super::shell_namespace_refusal(&path, true).is_some());
        assert!(super::shell_namespace_refusal(&path, false).is_none());
        let plain = r"C:\Users\dev\Downloads\Invoice";
        assert!(super::shell_namespace_refusal(plain, true).is_none());
        assert!(super::shell_namespace_refusal(plain, false).is_none());
    }

    #[test]
    fn derived_extract_names_never_carry_a_braced_clsid() {
        assert_eq!(
            derive_extract_folder_name(&format!("Invoice.{GUID}.zip")).as_deref(),
            Some("_extracted")
        );
        assert_eq!(
            derive_extract_folder_name(&format!("{GUID}.zip")).as_deref(),
            Some("_extracted")
        );
        assert_eq!(
            derive_extract_folder_name("draft{1}.zip").as_deref(),
            Some("draft{1}")
        );
    }
}

#[cfg(test)]
mod relative_destination_tests {
    use super::{derive_extract_destination_path, normalize_destination_path};
    use std::path::{Path, PathBuf};

    fn canonical_cwd() -> PathBuf {
        std::env::current_dir()
            .expect("cwd")
            .canonicalize()
            .expect("canonical cwd")
    }

    fn missing_leaf(stem: &str) -> String {
        format!("zinnia-beta2-{stem}-{}", std::process::id())
    }

    #[test]
    fn relative_leaf_without_parent_resolves_under_current_dir() {
        let leaf = missing_leaf("bare-leaf");
        let normalized = normalize_destination_path(Path::new(&leaf)).expect("normalize");
        assert_eq!(normalized, canonical_cwd().join(&leaf));
    }

    #[test]
    fn relative_archive_destination_resolves_under_current_dir() {
        let leaf = missing_leaf("archive");
        let destination =
            derive_extract_destination_path(&format!("{leaf}.zip")).expect("destination");
        assert_eq!(destination, PathBuf::from(&leaf));
        let normalized = normalize_destination_path(&destination).expect("normalize");
        assert_eq!(normalized, canonical_cwd().join(&leaf));
    }

    #[test]
    fn dot_slash_archive_destination_resolves_under_current_dir() {
        let leaf = missing_leaf("dot-slash");
        let destination =
            derive_extract_destination_path(&format!("./{leaf}.zip")).expect("destination");
        let normalized = normalize_destination_path(&destination).expect("normalize");
        assert_eq!(normalized, canonical_cwd().join(&leaf));
    }

    #[test]
    fn relative_subdirectory_destination_resolves_under_current_dir() {
        assert!(
            Path::new("src").is_dir(),
            "cargo runs unit tests from the package root, which holds src/"
        );
        let leaf = missing_leaf("subdir");
        let normalized =
            normalize_destination_path(&PathBuf::from("src").join(&leaf)).expect("normalize");
        assert_eq!(
            normalized,
            canonical_cwd()
                .join("src")
                .canonicalize()
                .expect("canonical src")
                .join(&leaf)
        );
    }

    #[test]
    fn absolute_destination_is_unchanged_by_relative_resolution() {
        let base = std::env::temp_dir().canonicalize().expect("temp dir");
        let leaf = missing_leaf("absolute");
        let normalized = normalize_destination_path(&base.join(&leaf)).expect("normalize");
        assert_eq!(normalized, base.join(&leaf));
    }
}

#[cfg(test)]
mod chosen_destination_tests {
    use super::{
        apply_picked_folder, derive_extract_destination_path, destination_in_chosen_folder,
    };
    use crate::launch::ExtractBoundPaths;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(stem: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("zinnia-beta2-chosen-{stem}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn chosen_folder(&self, name: &str) -> PathBuf {
            let folder = self.0.join(name);
            std::fs::create_dir_all(&folder).expect("chosen folder");
            folder
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn make_directory_link(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    #[cfg(windows)]
    fn make_directory_link(link: &Path, target: &Path) {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("cmd")
            .raw_arg(format!(
                "/C mklink /J \"{}\" \"{}\"",
                link.display(),
                target.display()
            ))
            .stdout(std::process::Stdio::null())
            .status()
            .expect("cmd");
        assert!(status.success(), "mklink /J failed for {}", link.display());
    }

    fn binding(archive: &str, destination: &str) -> ExtractBoundPaths {
        ExtractBoundPaths {
            destination: PathBuf::from(destination),
            archive: PathBuf::from(archive),
        }
    }

    fn snapshot(bindings: &HashMap<String, ExtractBoundPaths>) -> Vec<(String, PathBuf, PathBuf)> {
        let mut rows: Vec<_> = bindings
            .iter()
            .map(|(label, bound)| {
                (
                    label.clone(),
                    bound.destination.clone(),
                    bound.archive.clone(),
                )
            })
            .collect();
        rows.sort();
        rows
    }

    #[test]
    fn chosen_folder_derives_the_leaf_the_first_destination_used() {
        let scratch = Scratch::new("leaf-match");
        let chosen = scratch.chosen_folder("pick");
        for archive in ["/data/hello.7z", "/data/report.tar.gz", "/data/Invoice.zip"] {
            let first = derive_extract_destination_path(archive).expect("first destination");
            let derived =
                destination_in_chosen_folder(&chosen, Path::new(archive)).expect("derived");
            assert_eq!(derived.file_name(), first.file_name(), "{archive}");
            assert_eq!(derived.parent(), Some(chosen.as_path()), "{archive}");
        }
    }

    #[test]
    fn archive_without_a_known_suffix_keeps_the_extracted_suffix_rule() {
        let scratch = Scratch::new("no-suffix");
        let chosen = scratch.chosen_folder("pick");
        let derived =
            destination_in_chosen_folder(&chosen, Path::new("/data/notes.txt")).expect("derived");
        assert_eq!(derived, chosen.join("notes.txt_extracted"));
    }

    #[test]
    fn missing_chosen_folder_is_rejected() {
        let scratch = Scratch::new("missing");
        let chosen = scratch.path().join("absent");
        let error = destination_in_chosen_folder(&chosen, Path::new("/data/hello.7z"))
            .expect_err("missing folder");
        assert!(error.contains("folder"), "{error}");
    }

    #[test]
    fn chosen_path_that_is_a_file_is_rejected() {
        let scratch = Scratch::new("file-pick");
        let file = scratch.path().join("plain.txt");
        std::fs::write(&file, b"plain").expect("file");
        assert!(destination_in_chosen_folder(&file, Path::new("/data/hello.7z")).is_err());
    }

    #[test]
    fn symlink_or_junction_chosen_folder_is_rejected() {
        let scratch = Scratch::new("link-pick");
        let target = scratch.chosen_folder("target");
        let link = scratch.path().join("link");
        make_directory_link(&link, &target);
        let error = destination_in_chosen_folder(&link, Path::new("/data/hello.7z"))
            .expect_err("link folder");
        assert!(error.contains("link"), "{error}");
    }

    #[test]
    fn existing_file_at_the_derived_name_is_rejected() {
        let scratch = Scratch::new("collision-file");
        let chosen = scratch.chosen_folder("pick");
        std::fs::write(chosen.join("hello"), b"occupied").expect("collision");
        assert!(destination_in_chosen_folder(&chosen, Path::new("/data/hello.7z")).is_err());
    }

    #[test]
    fn existing_link_at_the_derived_name_is_rejected() {
        let scratch = Scratch::new("collision-link");
        let chosen = scratch.chosen_folder("pick");
        let target = scratch.chosen_folder("elsewhere");
        make_directory_link(&chosen.join("hello"), &target);
        let error = destination_in_chosen_folder(&chosen, Path::new("/data/hello.7z"))
            .expect_err("link at derived name");
        assert!(error.contains("link"), "{error}");
    }

    #[test]
    fn existing_directory_at_the_derived_name_is_allowed_like_the_first_destination() {
        let scratch = Scratch::new("collision-dir");
        let chosen = scratch.chosen_folder("pick");
        std::fs::create_dir_all(chosen.join("hello")).expect("existing destination");
        let derived =
            destination_in_chosen_folder(&chosen, Path::new("/data/hello.7z")).expect("merge");
        assert_eq!(derived, chosen.join("hello"));
    }

    #[test]
    fn cancelled_pick_returns_none_and_keeps_the_binding() {
        let mut bindings = HashMap::from([(
            "extract-0".to_string(),
            binding("/data/hello.7z", "/data/readonly/hello"),
        )]);
        let before = snapshot(&bindings);
        let outcome =
            apply_picked_folder(&mut bindings, "extract-0", None).expect("cancel is not an error");
        assert_eq!(outcome, None);
        assert_eq!(snapshot(&bindings), before);
    }

    #[test]
    fn picked_folder_replaces_only_the_target_labels_destination() {
        let scratch = Scratch::new("rebind");
        let chosen = scratch.chosen_folder("writable");
        let mut bindings = HashMap::from([
            (
                "extract-0".to_string(),
                binding("/data/hello.7z", "/data/readonly/hello"),
            ),
            (
                "extract-1".to_string(),
                binding("/other/notes.zip", "/other/notes"),
            ),
        ]);
        let outcome =
            apply_picked_folder(&mut bindings, "extract-0", Some(chosen.clone())).expect("rebind");
        let expected = chosen.join("hello");
        assert_eq!(outcome, Some(expected.clone()));
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings["extract-0"].destination, expected);
        assert_eq!(
            bindings["extract-0"].archive,
            PathBuf::from("/data/hello.7z")
        );
        assert_eq!(
            bindings["extract-1"].destination,
            PathBuf::from("/other/notes")
        );
        assert_eq!(
            bindings["extract-1"].archive,
            PathBuf::from("/other/notes.zip")
        );
    }

    #[test]
    fn rejected_pick_leaves_the_binding_unchanged() {
        let scratch = Scratch::new("rejected-pick");
        let file = scratch.path().join("plain.txt");
        std::fs::write(&file, b"plain").expect("file");
        let mut bindings = HashMap::from([(
            "extract-0".to_string(),
            binding("/data/hello.7z", "/data/readonly/hello"),
        )]);
        let before = snapshot(&bindings);
        assert!(apply_picked_folder(&mut bindings, "extract-0", Some(file)).is_err());
        assert_eq!(snapshot(&bindings), before);
    }

    #[test]
    fn rebinding_a_label_without_a_binding_is_rejected() {
        let scratch = Scratch::new("no-binding");
        let chosen = scratch.chosen_folder("pick");
        let mut bindings: HashMap<String, ExtractBoundPaths> = HashMap::new();
        assert!(apply_picked_folder(&mut bindings, "extract-9", Some(chosen)).is_err());
        assert!(bindings.is_empty());
    }
}
