//! Platform/environment queries and OS integration helpers.

mod defaults_cmds;
mod integration_status;
mod linux_defaults;
mod os_command;

#[cfg(target_os = "macos")]
mod macos_defaults;

#[cfg(target_os = "linux")]
use linux_defaults::linux_query_archive_defaults_parallel;
#[cfg(target_os = "macos")]
use macos_defaults::macos_query_archive_defaults;

pub(crate) const ZINNIA_BUNDLE_ID: &str = "run.rosie.zinnia";
pub(crate) const ZINNIA_DESKTOP_ID: &str = "run.rosie.zinnia.desktop";

#[derive(Clone, Copy, Debug)]
pub struct ArchiveDefaultTarget {
    key: &'static str,
    label: &'static str,
    extension: &'static str,
    mime_type: &'static str,
}

pub(crate) const ARCHIVE_DEFAULT_TARGETS: [ArchiveDefaultTarget; 10] = [
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

#[tauri::command]
pub fn get_beta_updater_target() -> String {
    use tauri::utils::config::BundleType;

    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "i686",
        "arm64" => "aarch64",
        other => other,
    };
    let installer = match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) => Some("deb"),
        Some(BundleType::Rpm) => Some("rpm"),
        Some(BundleType::AppImage) => Some("appimage"),
        Some(BundleType::Msi) => Some("msi"),
        Some(BundleType::Nsis) => Some("nsis"),
        Some(BundleType::App | BundleType::Dmg) => Some("app"),
        None => None,
    };
    match installer {
        Some(installer) => format!("{os}-beta-{arch}-{installer}"),
        None => format!("{os}-beta-{arch}"),
    }
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
    /// macOS Finder Sync appex (primary Finder context menu). Other platforms: false.
    finder_sync_available: bool,
    finder_sync_known: bool,
    finder_sync_enabled: bool,
    finder_sync_help: String,
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

pub(crate) fn archive_status(
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

pub(crate) fn fallback_archive_defaults(
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
pub(crate) fn default_action_label(platform: &str) -> &'static str {
    if platform == "windows" {
        "Open Default Apps"
    } else {
        "Make Zinnia Default"
    }
}

pub(crate) fn default_action_help(
    platform: &str,
    packaged: bool,
    action_available: bool,
) -> &'static str {
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn default_archiver_result(
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

pub(crate) fn query_archive_defaults(platform: &str, packaged: bool) -> Vec<ArchiveDefaultStatus> {
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

pub(crate) fn linux_desktop_session_available() -> bool {
    std::env::var_os("DISPLAY").is_some()
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var_os("XDG_CURRENT_DESKTOP").is_some()
        || std::env::var_os("DESKTOP_SESSION").is_some()
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

// Public API + tauri command companions (needed by generate_handler!).
#[allow(unused_imports)]
pub use defaults_cmds::{
    enable_finder_sync, open_finder_services_settings, open_finder_sync_settings,
    open_os_integration_settings, reset_preferred_archiver_to_system, set_zinnia_default_archiver,
};
#[allow(unused_imports)]
pub use integration_status::{get_os_integration_status, os_integration_status_for};

#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub use integration_status::register_macos_finder_sync;

#[doc(hidden)]
pub use defaults_cmds::{
    __cmd__enable_finder_sync, __cmd__open_finder_services_settings,
    __cmd__open_finder_sync_settings, __cmd__open_os_integration_settings,
    __cmd__reset_preferred_archiver_to_system, __cmd__set_zinnia_default_archiver,
    __tauri_command_name_enable_finder_sync, __tauri_command_name_open_finder_services_settings,
    __tauri_command_name_open_finder_sync_settings,
    __tauri_command_name_open_os_integration_settings,
    __tauri_command_name_reset_preferred_archiver_to_system,
    __tauri_command_name_set_zinnia_default_archiver,
};
#[doc(hidden)]
pub use integration_status::{
    __cmd__get_os_integration_status, __tauri_command_name_get_os_integration_status,
};

#[cfg(all(test, target_os = "macos"))]
mod macos_uti_tests {
    use super::macos_defaults;

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
