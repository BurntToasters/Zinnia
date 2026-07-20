//! Platform/environment queries and OS integration helpers.

#[cfg(target_os = "linux")]
use std::process::Command;

const ZINNIA_BUNDLE_ID: &str = "run.rosie.zinnia";
const ZINNIA_DESKTOP_ID: &str = "run.rosie.zinnia.desktop";

#[derive(Clone, Copy, Debug)]
pub struct ArchiveDefaultTarget {
    key: &'static str,
    label: &'static str,
    extension: &'static str,
    mime_type: &'static str,
}

const ARCHIVE_DEFAULT_TARGETS: [ArchiveDefaultTarget; 10] = [
    ArchiveDefaultTarget {
        key: "zip",
        label: "ZIP",
        extension: "zip",
        mime_type: "application/zip",
    },
    ArchiveDefaultTarget {
        key: "7z",
        label: "7z",
        extension: "7z",
        mime_type: "application/x-7z-compressed",
    },
    ArchiveDefaultTarget {
        key: "tar",
        label: "TAR",
        extension: "tar",
        mime_type: "application/x-tar",
    },
    ArchiveDefaultTarget {
        key: "gzip",
        label: "Gzip",
        extension: "gz",
        mime_type: "application/gzip",
    },
    ArchiveDefaultTarget {
        key: "tgz",
        label: "TGZ",
        extension: "tgz",
        mime_type: "application/x-compressed-tar",
    },
    ArchiveDefaultTarget {
        key: "bzip2",
        label: "Bzip2",
        extension: "bz2",
        mime_type: "application/x-bzip2",
    },
    ArchiveDefaultTarget {
        key: "tbz2",
        label: "TBZ2",
        extension: "tbz2",
        mime_type: "application/x-bzip2-compressed-tar",
    },
    ArchiveDefaultTarget {
        key: "xz",
        label: "XZ",
        extension: "xz",
        mime_type: "application/x-xz",
    },
    ArchiveDefaultTarget {
        key: "txz",
        label: "TXZ",
        extension: "txz",
        mime_type: "application/x-xz-compressed-tar",
    },
    ArchiveDefaultTarget {
        key: "rar",
        label: "RAR",
        extension: "rar",
        mime_type: "application/vnd.rar",
    },
];

#[tauri::command]
pub fn get_platform_info() -> String {
    std::env::consts::OS.to_string()
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDefaultStatus {
    key: String,
    label: String,
    extension: String,
    mime_type: String,
    current_handler: Option<String>,
    is_default: bool,
    can_change: bool,
    status: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsIntegrationStatus {
    platform: String,
    packaged: bool,
    file_associations_known: bool,
    context_actions_known: bool,
    default_app_help_available: bool,
    default_archiver_action_available: bool,
    default_archiver_action_label: String,
    default_archiver_help: String,
    /// macOS Finder Services (Extract/Compress). Other platforms: false.
    finder_services_available: bool,
    /// Whether we successfully determined enabled state (false → Unknown in UI).
    finder_services_known: bool,
    /// Whether Services appear enabled (meaningful when `finder_services_known`).
    finder_services_enabled: bool,
    finder_services_help: String,
    /// Windows: sparse identity package for Win11 modern context menu (not a full AppX app).
    win11_modern_menu_available: bool,
    win11_modern_menu_known: bool,
    win11_modern_menu_registered: bool,
    win11_modern_menu_help: String,
    archive_defaults: Vec<ArchiveDefaultStatus>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultArchiverResult {
    platform: String,
    changed: bool,
    message: String,
    results: Vec<ArchiveDefaultStatus>,
}

fn archive_status(
    target: ArchiveDefaultTarget,
    current_handler: Option<String>,
    can_change: bool,
    status: impl Into<String>,
) -> ArchiveDefaultStatus {
    let is_default = current_handler
        .as_deref()
        .is_some_and(|handler| handler == ZINNIA_BUNDLE_ID || handler == ZINNIA_DESKTOP_ID);

    ArchiveDefaultStatus {
        key: target.key.to_string(),
        label: target.label.to_string(),
        extension: target.extension.to_string(),
        mime_type: target.mime_type.to_string(),
        current_handler,
        is_default,
        can_change,
        status: status.into(),
    }
}

fn fallback_archive_defaults(
    platform: &str,
    packaged: bool,
    can_change: bool,
) -> Vec<ArchiveDefaultStatus> {
    let status = if !packaged {
        "Install a packaged build first."
    } else if platform == "windows" {
        "Choose in Windows Settings."
    } else {
        "Not verified yet."
    };

    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .filter(|target| !(platform == "windows" && target.key == "rar"))
        .map(|target| archive_status(*target, None, can_change, status))
        .collect()
}

struct FinderServicesInfo {
    available: bool,
    known: bool,
    enabled: bool,
    help: String,
}

/// Keys used by macOS `pbs` prefs for our NSServices entries.
#[cfg(any(target_os = "macos", test))]
const MACOS_FINDER_SERVICE_KEYS: &[&str] = &[
    "run.rosie.zinnia - Extract with Zinnia - extractWithZinnia",
    "run.rosie.zinnia - Compress with Zinnia - compressWithZinnia",
];

/// Parse `NSServicesStatus` from a pbs.plist JSON conversion.
/// Absent entries default to enabled (Apple’s default for contextual services).
#[cfg(any(target_os = "macos", test))]
pub(crate) fn finder_services_enabled_from_pbs(json: &serde_json::Value) -> bool {
    let Some(status_map) = json.get("NSServicesStatus") else {
        return true;
    };
    let Some(obj) = status_map.as_object() else {
        return true;
    };

    let mut saw_any = false;
    let mut all_enabled = true;
    for key in MACOS_FINDER_SERVICE_KEYS {
        let Some(entry) = obj.get(*key) else {
            continue;
        };
        saw_any = true;
        // Finder right-click / contextual Services use the context-menu flag.
        let context_on = entry
            .get("enabled_context_menu")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !context_on {
            all_enabled = false;
        }
    }

    if saw_any {
        all_enabled
    } else {
        true
    }
}

#[cfg(target_os = "macos")]
fn macos_read_finder_services_enabled() -> Option<bool> {
    use std::path::PathBuf;
    use std::process::Command;

    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join("Library/Preferences/pbs.plist");
    if !path.exists() {
        return Some(true);
    }

    let output = Command::new("plutil")
        .args([
            "-convert",
            "json",
            "-o",
            "-",
            &path.to_string_lossy(),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    Some(finder_services_enabled_from_pbs(&json))
}

struct Win11ModernMenuInfo {
    available: bool,
    known: bool,
    registered: bool,
    help: String,
}

#[cfg(target_os = "windows")]
fn windows_modern_menu_registered() -> Option<bool> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // Sparse identity package name (not the Zinnia app itself).
    // Use exit codes (not stdout) — PS 5.1 often emits UTF-16 on redirected pipes.
    const PACKAGE: &str = "run.rosie.zinnia.contextmenu";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = format!(
        "if (Get-AppxPackage -Name '{PACKAGE}' -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 2 }}"
    );
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .ok()?;
    match status.code() {
        Some(0) => Some(true),
        Some(2) => Some(false),
        _ => None,
    }
}

fn win11_modern_menu_status_for(platform: &str, packaged: bool) -> Win11ModernMenuInfo {
    if platform != "windows" {
        return Win11ModernMenuInfo {
            available: false,
            known: false,
            registered: false,
            help: String::new(),
        };
    }
    if !packaged {
        return Win11ModernMenuInfo {
            available: true,
            known: true,
            registered: false,
            help: "Install a signed NSIS build to register the Win11 modern context menu (sparse identity package + shell DLL). Classic Explorer verbs still work without it.".to_string(),
        };
    }

    #[cfg(target_os = "windows")]
    let probed = windows_modern_menu_registered();
    #[cfg(not(target_os = "windows"))]
    let probed: Option<bool> = None;

    match probed {
        Some(true) => Win11ModernMenuInfo {
            available: true,
            known: true,
            registered: true,
            help: "Win11 modern menu package is registered (sparse identity only — Zinnia remains a normal NSIS install). Confirm Extract/Compress actually launch from the primary menu; classic verbs remain under Show more options.".to_string(),
        },
        Some(false) => Win11ModernMenuInfo {
            available: true,
            known: true,
            registered: false,
            help: "Win11 modern menu package is not registered. Classic Explorer verbs still work. Check zinnia-context-menu-register.log in the install folder, or reinstall a signed build.".to_string(),
        },
        None => Win11ModernMenuInfo {
            available: true,
            known: false,
            registered: false,
            help: "Could not verify Win11 modern menu package registration. Classic Explorer verbs should still work if this is a packaged install.".to_string(),
        },
    }
}

fn finder_services_status_for(platform: &str, packaged: bool) -> FinderServicesInfo {
    if platform != "macos" {
        return FinderServicesInfo {
            available: false,
            known: false,
            enabled: false,
            help: String::new(),
        };
    }

    if !packaged {
        return FinderServicesInfo {
            available: true,
            known: true,
            enabled: false,
            help: "Install a packaged build to register Extract / Compress with Zinnia in Finder's Services menu.".to_string(),
        };
    }

    #[cfg(target_os = "macos")]
    let probed = macos_read_finder_services_enabled();
    #[cfg(not(target_os = "macos"))]
    let probed: Option<bool> = Some(true);

    match probed {
        Some(true) => FinderServicesInfo {
            available: true,
            known: true,
            enabled: true,
            help: "Extract with Zinnia and Compress with Zinnia are available in Finder's Services menu."
                .to_string(),
        },
        Some(false) => FinderServicesInfo {
            available: true,
            known: true,
            enabled: false,
            help: "Turn on Extract with Zinnia and Compress with Zinnia under Keyboard Shortcuts → Services."
                .to_string(),
        },
        None => FinderServicesInfo {
            available: true,
            known: false,
            enabled: false,
            help: "Could not verify Services status. Open Keyboard Shortcuts → Services if menus are missing."
                .to_string(),
        },
    }
}

pub fn os_integration_status_for(platform: &str, packaged: bool) -> OsIntegrationStatus {
    let action_available = packaged && matches!(platform, "macos" | "linux");
    let default_app_help_available = matches!(platform, "macos" | "windows") || action_available;
    let finder = finder_services_status_for(platform, packaged);
    let win11 = win11_modern_menu_status_for(platform, packaged);
    // macOS: "Open/extract actions" tracks Finder Services, not just packaging.
    // Windows: classic Explorer verbs are always registered by NSIS when packaged.
    let context_actions_known = if platform == "macos" {
        packaged && finder.known && finder.enabled
    } else {
        packaged && matches!(platform, "windows")
    };
    OsIntegrationStatus {
        platform: platform.to_string(),
        packaged,
        file_associations_known: packaged && matches!(platform, "macos" | "windows"),
        context_actions_known,
        default_app_help_available,
        default_archiver_action_available: action_available,
        default_archiver_action_label: default_action_label(platform).to_string(),
        default_archiver_help: default_action_help(platform, packaged, action_available)
            .to_string(),
        finder_services_available: finder.available,
        finder_services_known: finder.known,
        finder_services_enabled: finder.enabled,
        finder_services_help: finder.help,
        win11_modern_menu_available: win11.available,
        win11_modern_menu_known: win11.known,
        win11_modern_menu_registered: win11.registered,
        win11_modern_menu_help: win11.help,
        archive_defaults: fallback_archive_defaults(platform, packaged, action_available),
    }
}

#[tauri::command]
pub fn get_os_integration_status() -> OsIntegrationStatus {
    let platform = std::env::consts::OS;
    let packaged = is_packaged();
    let mut status = os_integration_status_for(platform, packaged);
    status.archive_defaults = query_archive_defaults(platform, packaged);
    if platform == "linux" {
        status.default_archiver_action_available =
            packaged && !is_flatpak() && linux_desktop_session_available();
        status.default_app_help_available = status.default_archiver_action_available;
        status.default_archiver_help =
            default_action_help(platform, packaged, status.default_archiver_action_available)
                .to_string();
    }
    if platform == "windows" {
        let win11 = win11_modern_menu_status_for(platform, packaged);
        status.win11_modern_menu_available = win11.available;
        status.win11_modern_menu_known = win11.known;
        status.win11_modern_menu_registered = win11.registered;
        status.win11_modern_menu_help = win11.help;
    }
    status
}

#[tauri::command]
pub fn set_zinnia_default_archiver(app: tauri::AppHandle) -> Result<DefaultArchiverResult, String> {
    let platform = std::env::consts::OS;
    let packaged = is_packaged();

    if platform == "windows" {
        open_os_integration_settings(app)?;
        let results = fallback_archive_defaults(platform, packaged, false);
        return Ok(DefaultArchiverResult {
            platform: platform.to_string(),
            changed: false,
            message: "Windows requires choosing Zinnia in Default Apps settings.".to_string(),
            results,
        });
    }

    if !packaged {
        return Err("Install a packaged build before changing archive defaults.".to_string());
    }

    #[cfg(target_os = "macos")]
    if platform == "macos" {
        let results = macos_set_archive_defaults();
        return Ok(default_archiver_result(platform, results));
    }

    #[cfg(target_os = "linux")]
    if platform == "linux" {
        if is_flatpak() {
            return Err(
                "Flatpak builds need desktop-specific default-app settings for archive types."
                    .to_string(),
            );
        }
        if !linux_desktop_session_available() {
            return Err("Default app changes require a running desktop session.".to_string());
        }
        let mut backend = XdgMimeBackend;
        let results = linux_set_archive_defaults(&mut backend);
        return Ok(default_archiver_result(platform, results));
    }

    let _ = app;
    Err("Default archiver changes are not available for this platform.".to_string())
}

#[tauri::command]
pub fn reset_preferred_archiver_to_system(
    app: tauri::AppHandle,
) -> Result<DefaultArchiverResult, String> {
    let platform = std::env::consts::OS;
    let packaged = is_packaged();

    if platform == "windows" {
        open_os_integration_settings(app)?;
        let results = fallback_archive_defaults(platform, packaged, false);
        return Ok(DefaultArchiverResult {
            platform: platform.to_string(),
            changed: false,
            message: "Windows requires choosing the system archive app in Default Apps settings."
                .to_string(),
            results,
        });
    }

    if !packaged {
        return Err("Install a packaged build before changing archive defaults.".to_string());
    }

    #[cfg(target_os = "macos")]
    if platform == "macos" {
        return Err("macOS does not expose a reliable universal 'system archiver' handler for every supported archive type. Use Finder's Get Info / Open With controls to choose a handler per extension.".to_string());
    }

    if platform == "linux" {
        return Err(
            "Linux does not expose one universal system archiver. Use your desktop's Default Applications settings to choose an archive app for each file type."
                .to_string(),
        );
    }

    let _ = app;
    Err("System archiver reset is not available for this platform.".to_string())
}

#[tauri::command]
#[allow(deprecated)]
pub fn open_os_integration_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_shell::ShellExt;
        return app
            .shell()
            .open("ms-settings:defaultapps", None)
            .map_err(|e| e.to_string());
    }

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(
                "x-apple.systempreferences:com.apple.ExtensionsPreferences",
                None,
            )
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "linux")]
    {
        let _ = app;
        Err("Open your desktop's Default Applications settings, or run xdg-mime default run.rosie.zinnia.desktop for archive MIME types.".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        Err("Default app settings are not available for this platform.".to_string())
    }
}

/// Opens System Settings → Keyboard Shortcuts → Services (where Finder Services are toggled).
#[tauri::command]
#[allow(deprecated)]
pub fn open_finder_services_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_shell::ShellExt;
        // Ventura+ System Settings deep link for Keyboard → Keyboard Shortcuts.
        app.shell()
            .open(
                "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Shortcuts",
                None,
            )
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Finder Services settings are only available on macOS.".to_string())
    }
}

fn default_action_label(platform: &str) -> &'static str {
    if platform == "windows" {
        "Open Default Apps"
    } else {
        "Make Zinnia Default"
    }
}

fn default_action_help(platform: &str, packaged: bool, action_available: bool) -> &'static str {
    if !packaged {
        return "Install a packaged build to register archive file types and menu actions.";
    }
    match platform {
        "macos" => "macOS may ask you to confirm each archive type.",
        "windows" => "Windows requires selecting defaults in Settings.",
        "linux" if action_available => {
            "Zinnia can ask xdg-mime to set archive defaults for this desktop session."
        }
        "linux" => "Use your desktop's Default Applications settings for archive file types.",
        _ => "Use your OS default-app settings to map archive files to Zinnia.",
    }
}

fn default_archiver_result(
    platform: &str,
    results: Vec<ArchiveDefaultStatus>,
) -> DefaultArchiverResult {
    let changed = results.iter().any(|result| result.is_default);
    let failures = results.iter().filter(|result| !result.is_default).count();
    let message = if failures == 0 {
        "Zinnia is now the default archive app for supported formats.".to_string()
    } else if changed {
        format!(
            "Zinnia was set for some archive formats. {failures} format(s) still need attention."
        )
    } else {
        "Zinnia could not be set as the default archive app.".to_string()
    };

    DefaultArchiverResult {
        platform: platform.to_string(),
        changed,
        message,
        results,
    }
}

fn query_archive_defaults(platform: &str, packaged: bool) -> Vec<ArchiveDefaultStatus> {
    if !packaged {
        return fallback_archive_defaults(platform, packaged, false);
    }

    #[cfg(target_os = "macos")]
    if platform == "macos" {
        return macos_query_archive_defaults(true);
    }

    #[cfg(target_os = "linux")]
    if platform == "linux" {
        return linux_query_archive_defaults_parallel(
            !is_flatpak() && linux_desktop_session_available(),
        );
    }

    fallback_archive_defaults(platform, packaged, false)
}

fn linux_desktop_session_available() -> bool {
    std::env::var_os("DISPLAY").is_some()
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var_os("XDG_CURRENT_DESKTOP").is_some()
        || std::env::var_os("DESKTOP_SESSION").is_some()
}

#[cfg(any(target_os = "linux", test))]
trait LinuxMimeBackend {
    fn query_default(&self, mime_type: &str) -> Result<Option<String>, String>;
    fn set_default(&mut self, desktop_id: &str, mime_type: &str) -> Result<(), String>;
}

#[cfg(target_os = "linux")]
struct XdgMimeBackend;

#[cfg(target_os = "linux")]
impl LinuxMimeBackend for XdgMimeBackend {
    fn query_default(&self, mime_type: &str) -> Result<Option<String>, String> {
        let output = Command::new("xdg-mime")
            .args(["query", "default", mime_type])
            .output()
            .map_err(|e| format!("Unable to run xdg-mime: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value))
        }
    }

    fn set_default(&mut self, desktop_id: &str, mime_type: &str) -> Result<(), String> {
        let output = Command::new("xdg-mime")
            .args(["default", desktop_id, mime_type])
            .output()
            .map_err(|e| format!("Unable to run xdg-mime: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "xdg-mime failed without details.".to_string()
            } else {
                stderr
            })
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_query_archive_defaults_parallel(can_change: bool) -> Vec<ArchiveDefaultStatus> {
    let handles: Vec<_> = ARCHIVE_DEFAULT_TARGETS
        .iter()
        .copied()
        .map(|target| {
            std::thread::spawn(move || {
                let backend = XdgMimeBackend;
                match backend.query_default(target.mime_type) {
                    Ok(current_handler) => {
                        let status = if current_handler.as_deref() == Some(ZINNIA_DESKTOP_ID) {
                            "Default"
                        } else {
                            "Not default"
                        };
                        archive_status(target, current_handler, can_change, status)
                    }
                    Err(err) => archive_status(target, None, can_change, err),
                }
            })
        })
        .collect();
    handles
        .into_iter()
        .enumerate()
        .map(|(index, handle)| {
            handle.join().unwrap_or_else(|_| {
                archive_status(
                    ARCHIVE_DEFAULT_TARGETS[index],
                    None,
                    can_change,
                    "xdg-mime query worker failed",
                )
            })
        })
        .collect()
}

#[cfg(test)]
fn linux_query_archive_defaults<B: LinuxMimeBackend>(
    backend: &B,
    can_change: bool,
) -> Vec<ArchiveDefaultStatus> {
    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .map(|target| match backend.query_default(target.mime_type) {
            Ok(current_handler) => {
                let status = if current_handler.as_deref() == Some(ZINNIA_DESKTOP_ID) {
                    "Default"
                } else {
                    "Not default"
                };
                archive_status(*target, current_handler, can_change, status)
            }
            Err(err) => archive_status(*target, None, can_change, err),
        })
        .collect()
}

#[cfg(any(target_os = "linux", test))]
fn linux_set_archive_defaults<B: LinuxMimeBackend>(backend: &mut B) -> Vec<ArchiveDefaultStatus> {
    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .map(
            |target| match backend.set_default(ZINNIA_DESKTOP_ID, target.mime_type) {
                Ok(()) => match backend.query_default(target.mime_type) {
                    Ok(current_handler) => {
                        let status = if current_handler.as_deref() == Some(ZINNIA_DESKTOP_ID) {
                            "Default"
                        } else {
                            "Not changed"
                        };
                        archive_status(*target, current_handler, true, status)
                    }
                    Err(err) => archive_status(*target, None, true, err),
                },
                Err(err) => archive_status(*target, None, true, err),
            },
        )
        .collect()
}

#[cfg(target_os = "macos")]
mod macos_defaults {
    use super::{
        archive_status, ArchiveDefaultStatus, ArchiveDefaultTarget, ARCHIVE_DEFAULT_TARGETS,
        ZINNIA_BUNDLE_ID,
    };
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    type OSStatus = i32;

    const LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
            in_handler_bundle_id: CFStringRef,
        ) -> OSStatus;
        fn LSCopyDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
        ) -> CFStringRef;
        fn UTTypeCreatePreferredIdentifierForTag(
            tag_class: CFStringRef,
            tag: CFStringRef,
            conforming_to_uti: CFStringRef,
        ) -> CFStringRef;
    }

    fn uti_for_extension(extension: &str) -> Option<CFString> {
        let tag_class = CFString::new("public.filename-extension");
        let tag = CFString::new(extension);
        let uti = unsafe {
            UTTypeCreatePreferredIdentifierForTag(
                tag_class.as_concrete_TypeRef(),
                tag.as_concrete_TypeRef(),
                std::ptr::null(),
            )
        };
        if uti.is_null() {
            None
        } else {
            Some(unsafe { CFString::wrap_under_create_rule(uti) })
        }
    }

    #[cfg(test)]
    pub fn uti_identifier_for_extension(extension: &str) -> Option<String> {
        uti_for_extension(extension).map(|uti| uti.to_string())
    }

    fn current_handler_for_uti(uti: &CFString) -> Option<String> {
        let handler = unsafe {
            LSCopyDefaultRoleHandlerForContentType(uti.as_concrete_TypeRef(), LS_ROLES_ALL)
        };
        if handler.is_null() {
            None
        } else {
            Some(unsafe { CFString::wrap_under_create_rule(handler) }.to_string())
        }
    }

    fn query_target(target: ArchiveDefaultTarget, can_change: bool) -> ArchiveDefaultStatus {
        let Some(uti) = uti_for_extension(target.extension) else {
            return archive_status(target, None, can_change, "Unknown file type");
        };
        let current_handler = current_handler_for_uti(&uti);
        let status = if current_handler.as_deref() == Some(ZINNIA_BUNDLE_ID) {
            "Default"
        } else {
            "Not default"
        };
        archive_status(target, current_handler, can_change, status)
    }

    fn set_target(
        target: ArchiveDefaultTarget,
        bundle_id_value: &str,
        changed_status: &str,
    ) -> ArchiveDefaultStatus {
        let Some(uti) = uti_for_extension(target.extension) else {
            return archive_status(target, None, true, "Unknown file type");
        };
        let bundle_id = CFString::new(bundle_id_value);
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(
                uti.as_concrete_TypeRef(),
                LS_ROLES_ALL,
                bundle_id.as_concrete_TypeRef(),
            )
        };
        let current_handler = current_handler_for_uti(&uti);
        if status == 0 && current_handler.as_deref() == Some(bundle_id_value) {
            archive_status(target, current_handler, true, changed_status)
        } else if status == 0 {
            archive_status(target, current_handler, true, "Not changed")
        } else {
            archive_status(
                target,
                current_handler,
                true,
                format!("Not changed ({status})"),
            )
        }
    }

    pub fn query_archive_defaults(can_change: bool) -> Vec<ArchiveDefaultStatus> {
        ARCHIVE_DEFAULT_TARGETS
            .iter()
            .map(|target| query_target(*target, can_change))
            .collect()
    }

    pub fn set_archive_defaults() -> Vec<ArchiveDefaultStatus> {
        ARCHIVE_DEFAULT_TARGETS
            .iter()
            .map(|target| set_target(*target, ZINNIA_BUNDLE_ID, "Default"))
            .collect()
    }
}

#[cfg(target_os = "macos")]
fn macos_query_archive_defaults(can_change: bool) -> Vec<ArchiveDefaultStatus> {
    macos_defaults::query_archive_defaults(can_change)
}

#[cfg(target_os = "macos")]
fn macos_set_archive_defaults() -> Vec<ArchiveDefaultStatus> {
    macos_defaults::set_archive_defaults()
}

#[tauri::command]
pub fn is_flatpak() -> bool {
    std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists()
}

#[tauri::command]
pub fn is_packaged() -> bool {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return false,
    };

    #[cfg(windows)]
    {
        let lower = exe.to_lowercase();
        if lower.contains("\\target\\debug\\") || lower.contains("\\target\\release\\") {
            return false;
        }
        true
    }

    #[cfg(target_os = "macos")]
    {
        exe.contains(".app/Contents/MacOS/")
    }

    #[cfg(target_os = "linux")]
    {
        if exe.contains("/target/debug/") || exe.contains("/target/release/") {
            return false;
        }
        true
    }
}

#[tauri::command]
pub fn get_cpu_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    struct FakeLinuxMimeBackend {
        defaults: RefCell<HashMap<String, String>>,
        set_failures: HashMap<String, String>,
        query_failures: HashMap<String, String>,
        set_calls: RefCell<Vec<(String, String)>>,
    }

    impl FakeLinuxMimeBackend {
        fn new() -> Self {
            Self {
                defaults: RefCell::new(HashMap::new()),
                set_failures: HashMap::new(),
                query_failures: HashMap::new(),
                set_calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl LinuxMimeBackend for FakeLinuxMimeBackend {
        fn query_default(&self, mime_type: &str) -> Result<Option<String>, String> {
            if let Some(err) = self.query_failures.get(mime_type) {
                return Err(err.clone());
            }
            Ok(self.defaults.borrow().get(mime_type).cloned())
        }

        fn set_default(&mut self, desktop_id: &str, mime_type: &str) -> Result<(), String> {
            self.set_calls
                .borrow_mut()
                .push((desktop_id.to_string(), mime_type.to_string()));
            if let Some(err) = self.set_failures.get(mime_type) {
                return Err(err.clone());
            }
            self.defaults
                .borrow_mut()
                .insert(mime_type.to_string(), desktop_id.to_string());
            Ok(())
        }
    }

    #[test]
    fn os_integration_status_reflects_packaged_support() {
        let packaged = os_integration_status_for("windows", true);
        assert!(packaged.file_associations_known);
        assert!(packaged.context_actions_known);
        assert!(packaged.default_app_help_available);
        assert!(!packaged.finder_services_available);
        assert!(packaged.win11_modern_menu_available);
        assert_eq!(
            packaged.archive_defaults.len(),
            ARCHIVE_DEFAULT_TARGETS.len() - 1
        );
        assert!(!packaged
            .archive_defaults
            .iter()
            .any(|entry| entry.key == "rar"));

        let dev = os_integration_status_for("linux", false);
        assert!(!dev.file_associations_known);
        assert!(!dev.context_actions_known);
        assert!(!dev.default_app_help_available);
        assert!(!dev.finder_services_available);

        let macos_dev = os_integration_status_for("macos", false);
        assert!(macos_dev.finder_services_available);
        assert!(macos_dev.finder_services_known);
        assert!(!macos_dev.finder_services_enabled);
        assert!(!macos_dev.context_actions_known);
        assert!(macos_dev.finder_services_help.contains("packaged"));

        // Packaged macOS: Open/extract actions track Finder Services state.
        let macos_pkg = os_integration_status_for("macos", true);
        assert!(macos_pkg.finder_services_available);
        assert_eq!(
            macos_pkg.context_actions_known,
            macos_pkg.finder_services_known && macos_pkg.finder_services_enabled
        );
    }

    #[test]
    fn finder_services_pbs_defaults_enabled_when_absent() {
        let empty = serde_json::json!({});
        assert!(finder_services_enabled_from_pbs(&empty));

        let other = serde_json::json!({
            "NSServicesStatus": {
                "com.example.app - Other - other": {
                    "enabled_context_menu": false,
                    "enabled_services_menu": false
                }
            }
        });
        assert!(finder_services_enabled_from_pbs(&other));
    }

    #[test]
    fn finder_services_pbs_detects_disabled_context_menu() {
        let disabled = serde_json::json!({
            "NSServicesStatus": {
                "run.rosie.zinnia - Extract with Zinnia - extractWithZinnia": {
                    "enabled_context_menu": false,
                    "enabled_services_menu": true
                },
                "run.rosie.zinnia - Compress with Zinnia - compressWithZinnia": {
                    "enabled_context_menu": true,
                    "enabled_services_menu": true
                }
            }
        });
        assert!(!finder_services_enabled_from_pbs(&disabled));

        let enabled = serde_json::json!({
            "NSServicesStatus": {
                "run.rosie.zinnia - Extract with Zinnia - extractWithZinnia": {
                    "enabled_context_menu": true,
                    "enabled_services_menu": true
                },
                "run.rosie.zinnia - Compress with Zinnia - compressWithZinnia": {
                    "enabled_context_menu": true,
                    "enabled_services_menu": true
                }
            }
        });
        assert!(finder_services_enabled_from_pbs(&enabled));
    }

    #[test]
    fn linux_default_query_marks_zinnia_defaults() {
        let backend = FakeLinuxMimeBackend::new();
        backend
            .defaults
            .borrow_mut()
            .insert("application/zip".to_string(), ZINNIA_DESKTOP_ID.to_string());

        let defaults = linux_query_archive_defaults(&backend, true);
        let zip = defaults.iter().find(|entry| entry.key == "zip").unwrap();
        let txz = defaults.iter().find(|entry| entry.key == "txz").unwrap();
        let rar = defaults.iter().find(|entry| entry.key == "rar").unwrap();

        assert!(zip.is_default);
        assert_eq!(zip.current_handler.as_deref(), Some(ZINNIA_DESKTOP_ID));
        assert_eq!(txz.mime_type, "application/x-xz-compressed-tar");
        assert!(!rar.is_default);
        assert!(rar.can_change);
    }

    #[test]
    fn linux_set_defaults_records_partial_failures() {
        let mut backend = FakeLinuxMimeBackend::new();
        backend.set_failures.insert(
            "application/vnd.rar".to_string(),
            "policy rejected".to_string(),
        );

        let results = linux_set_archive_defaults(&mut backend);
        let zip = results.iter().find(|entry| entry.key == "zip").unwrap();
        let rar = results.iter().find(|entry| entry.key == "rar").unwrap();

        assert!(zip.is_default);
        assert_eq!(rar.status, "policy rejected");
        assert!(!rar.is_default);
        assert_eq!(
            backend.set_calls.borrow().len(),
            ARCHIVE_DEFAULT_TARGETS.len()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_archive_extensions_resolve_to_utis() {
        let zip = macos_defaults::uti_identifier_for_extension("zip");
        let seven_zip = macos_defaults::uti_identifier_for_extension("7z");

        // Apple does not guarantee which identifier is returned when multiple
        // declarations match an extension; unknown mappings may be dynamic
        // (`dyn.*`). Verify a usable identifier, not an implementation-specific
        // spelling that changes across macOS releases.
        assert!(zip.as_deref().is_some_and(|uti| !uti.trim().is_empty()));
        assert!(seven_zip
            .as_deref()
            .is_some_and(|uti| !uti.trim().is_empty()));
    }
}
