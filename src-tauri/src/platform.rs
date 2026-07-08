//! Platform/environment queries and OS integration helpers.

#[cfg(target_os = "linux")]
use std::process::Command;

const ZINNIA_BUNDLE_ID: &str = "run.rosie.zinnia";
const ZINNIA_DESKTOP_ID: &str = "run.rosie.zinnia.desktop";
const SYSTEM_ARCHIVER_BUNDLE_ID: &str = "com.apple.archiveutility";

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
        .map(|target| archive_status(*target, None, can_change, status))
        .collect()
}

pub fn os_integration_status_for(platform: &str, packaged: bool) -> OsIntegrationStatus {
    let action_available = packaged && matches!(platform, "macos" | "linux");
    let default_app_help_available = matches!(platform, "macos" | "windows") || action_available;
    OsIntegrationStatus {
        platform: platform.to_string(),
        packaged,
        file_associations_known: packaged && matches!(platform, "macos" | "windows"),
        context_actions_known: packaged && matches!(platform, "macos" | "windows"),
        default_app_help_available,
        default_archiver_action_available: action_available,
        default_archiver_action_label: default_action_label(platform).to_string(),
        default_archiver_help: default_action_help(platform, packaged, action_available)
            .to_string(),
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
    status
}

#[tauri::command]
pub fn set_zinnia_default_archiver(
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
        let results = macos_reset_archive_defaults_to_system();
        return Ok(system_archiver_result(platform, results));
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

#[cfg(any(target_os = "macos", test))]
fn system_archiver_result(
    platform: &str,
    results: Vec<ArchiveDefaultStatus>,
) -> DefaultArchiverResult {
    let changed = results
        .iter()
        .any(|result| result.current_handler.as_deref() == Some(SYSTEM_ARCHIVER_BUNDLE_ID));
    let failures = results
        .iter()
        .filter(|result| result.current_handler.as_deref() != Some(SYSTEM_ARCHIVER_BUNDLE_ID))
        .count();
    let message = if failures == 0 {
        "The system archive app is now preferred for supported formats.".to_string()
    } else if changed {
        format!(
            "The system archive app was restored for some formats. {failures} format(s) still need attention."
        )
    } else {
        "The system archive app could not be restored automatically.".to_string()
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
        let backend = XdgMimeBackend;
        return linux_query_archive_defaults(
            &backend,
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

#[cfg(any(target_os = "linux", test))]
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
        SYSTEM_ARCHIVER_BUNDLE_ID, ZINNIA_BUNDLE_ID,
    };
    use core_foundation::base::{kCFAllocatorDefault, TCFType};
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
            allocator: *const std::ffi::c_void,
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
                kCFAllocatorDefault,
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

    pub fn reset_archive_defaults_to_system() -> Vec<ArchiveDefaultStatus> {
        ARCHIVE_DEFAULT_TARGETS
            .iter()
            .map(|target| set_target(*target, SYSTEM_ARCHIVER_BUNDLE_ID, "System"))
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

#[cfg(target_os = "macos")]
fn macos_reset_archive_defaults_to_system() -> Vec<ArchiveDefaultStatus> {
    macos_defaults::reset_archive_defaults_to_system()
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
        assert_eq!(packaged.archive_defaults.len(), ARCHIVE_DEFAULT_TARGETS.len());

        let dev = os_integration_status_for("linux", false);
        assert!(!dev.file_associations_known);
        assert!(!dev.context_actions_known);
        assert!(!dev.default_app_help_available);
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

    #[test]
    fn system_archiver_result_reports_partial_restores() {
        let mut results = fallback_archive_defaults("macos", true, true);
        results[0].current_handler = Some(SYSTEM_ARCHIVER_BUNDLE_ID.to_string());
        results[0].status = "System".to_string();

        let result = system_archiver_result("macos", results);

        assert!(result.changed);
        assert!(result.message.contains("some formats"));
    }
}
