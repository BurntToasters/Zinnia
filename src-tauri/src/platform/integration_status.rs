//! Finder PBS / Win11 modern menu / classic verbs / OS integration status.

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyClass;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Command;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use super::os_command::command_output_with_timeout;
use super::{
    default_action_help, default_action_label, fallback_archive_defaults, is_flatpak, is_packaged,
    linux_desktop_session_available, query_archive_defaults, OsIntegrationStatus,
};

struct FinderServicesInfo {
    available: bool,
    known: bool,
    enabled: bool,
    help: String,
}

/// Keys used by macOS `pbs` prefs for our NSServices entries.
#[cfg(any(target_os = "macos", test))]
pub(crate) const MACOS_FINDER_SERVICE_KEYS: &[&str] = &[
    "run.rosie.zinnia - Extract with Zinnia - extractWithZinnia",
    "run.rosie.zinnia - Compress with Zinnia - compressWithZinnia",
];

/// User override for Finder Services context-menu toggles in `pbs` prefs.
///
/// Empty `NSServicesStatus` is common. The UI treats that as **Not enabled**
/// until both services have an explicit enable override (safer than Unknown).
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FinderServicesOverride {
    /// Every Zinnia override entry has context menu enabled.
    Enabled,
    /// At least one Zinnia service has context menu disabled.
    Disabled,
    /// No Zinnia keys present (empty map or unrelated apps only).
    Absent,
    /// Present but unreadable (malformed bool / unexpected shape).
    Indeterminate,
}

#[cfg(any(target_os = "macos", test))]
fn finder_service_context_menu_enabled(entry: &serde_json::Value) -> Option<bool> {
    if let Some(flag) = entry
        .get("enabled_context_menu")
        .and_then(serde_json::Value::as_bool)
    {
        return Some(flag);
    }
    // Sequoia+ may store presentation_modes instead of the legacy bool.
    entry
        .get("presentation_modes")
        .and_then(|modes| modes.get("ContextMenu"))
        .and_then(serde_json::Value::as_bool)
}

/// Parse `NSServicesStatus` from a pbs.plist JSON conversion.
///
/// Enabled requires **both** Zinnia services to have an explicit context-menu
/// enable override. Empty/missing keys mean Not enabled (not Unknown).
#[cfg(any(target_os = "macos", test))]
pub(crate) fn finder_services_override_from_pbs(
    json: &serde_json::Value,
) -> FinderServicesOverride {
    let Some(status_map) = json.get("NSServicesStatus").and_then(|v| v.as_object()) else {
        return FinderServicesOverride::Absent;
    };

    let mut enabled_count = 0usize;
    let mut disabled_count = 0usize;
    for key in MACOS_FINDER_SERVICE_KEYS {
        let Some(entry) = status_map.get(*key) else {
            continue;
        };
        match finder_service_context_menu_enabled(entry) {
            Some(true) => enabled_count += 1,
            Some(false) => disabled_count += 1,
            None => return FinderServicesOverride::Indeterminate,
        }
    }

    if disabled_count > 0 {
        return FinderServicesOverride::Disabled;
    }
    if enabled_count == MACOS_FINDER_SERVICE_KEYS.len() {
        return FinderServicesOverride::Enabled;
    }
    // Empty map, unrelated apps only, or only one service toggled on.
    FinderServicesOverride::Absent
}

/// Test helper: `Some(true)` only when both services are explicitly enabled.
#[cfg(test)]
pub(crate) fn finder_services_enabled_from_pbs(json: &serde_json::Value) -> Option<bool> {
    match finder_services_override_from_pbs(json) {
        FinderServicesOverride::Enabled => Some(true),
        FinderServicesOverride::Disabled => Some(false),
        FinderServicesOverride::Absent | FinderServicesOverride::Indeterminate => None,
    }
}

#[cfg(target_os = "macos")]
fn macos_read_pbs_plist_json() -> Option<serde_json::Value> {
    use std::path::PathBuf;

    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join("Library/Preferences/pbs.plist");
    if !path.exists() {
        return Some(serde_json::json!({}));
    }

    let output = command_output_with_timeout(
        Command::new("plutil").args(["-convert", "json", "-o", "-", &path.to_string_lossy()]),
        std::time::Duration::from_secs(5),
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// True when `pbs -dump_cache` lists both Zinnia Services (registration proof).
#[cfg(target_os = "macos")]
fn macos_finder_services_registered() -> Option<bool> {
    let output = command_output_with_timeout(
        Command::new("/System/Library/CoreServices/pbs").args(["-dump_cache"]),
        std::time::Duration::from_secs(8),
    )
    .ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let registered = text.contains("run.rosie.zinnia")
        && text.contains("extractWithZinnia")
        && text.contains("compressWithZinnia");
    Some(registered)
}

/// Packaged Finder Services status. Prefer **Not enabled** over Unknown:
/// Enabled only with an explicit pbs enable override for both services.
#[cfg(target_os = "macos")]
fn macos_finder_services_info() -> FinderServicesInfo {
    let override_state =
        macos_read_pbs_plist_json().map(|json| finder_services_override_from_pbs(&json));
    let registered = macos_finder_services_registered();

    if matches!(override_state, Some(FinderServicesOverride::Enabled)) {
        return FinderServicesInfo {
            available: true,
            known: true,
            enabled: true,
            help: "Extract with Zinnia and Compress with Zinnia are enabled in Finder's Services menu."
                .to_string(),
        };
    }

    let help = match (&override_state, registered) {
        (Some(FinderServicesOverride::Disabled), _) => {
            "Extract / Compress with Zinnia are turned off. In Keyboard Shortcuts, click Services (not Login Items & Extensions) and enable both."
                .to_string()
        }
        (_, Some(true)) => {
            "Services are registered but not enabled yet. Click Enable…  -  Keyboard Shortcuts checkboxes alone may not update this status on current macOS."
                .to_string()
        }
        (_, Some(false)) => {
            "Services are not enabled. Launch Zinnia once if menus are missing, then enable them under Keyboard Shortcuts → Services (not File Providers)."
                .to_string()
        }
        _ => {
            "Services are not enabled. Open Keyboard Shortcuts → Services and turn on Extract with Zinnia and Compress with Zinnia."
                .to_string()
        }
    };

    FinderServicesInfo {
        available: true,
        known: true,
        enabled: false,
        help,
    }
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

    // Sparse identity package name (not the Zinnia app itself).
    // Use exit codes (not stdout): PS 5.1 often emits UTF-16 on redirected pipes.
    const ROOT_PACKAGE: &str = "run.rosie.zinnia.contextmenu";
    const EXTRACT_PACKAGE: &str = "run.rosie.zinnia.extractmenu";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = format!(
        "if ((Get-AppxPackage -Name '{ROOT_PACKAGE}' -ErrorAction SilentlyContinue) -and (Get-AppxPackage -Name '{EXTRACT_PACKAGE}' -ErrorAction SilentlyContinue)) {{ exit 0 }} else {{ exit 2 }}"
    );
    // Resolve the absolute System32 path rather than a bare "powershell.exe"
    // name: NSIS installs under installMode "currentUser", so Zinnia's own
    // install directory is user-writable and would otherwise be searched
    // before System32 for program-name resolution.
    let powershell =
        crate::fs_secure::system32_binary_path("WindowsPowerShell\\v1.0\\powershell.exe").ok()?;
    let output = command_output_with_timeout(
        Command::new(powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .creation_flags(CREATE_NO_WINDOW),
        std::time::Duration::from_secs(10),
    )
    .ok()?;
    match output.status.code() {
        Some(0) => Some(true),
        Some(2) => Some(false),
        _ => None,
    }
}

/// Probe Explorer shell integration written by NSIS / Win11 sparse packages.
///
/// After beta.21, classic Extract/Compress registry verbs are removed when the
/// Win11 packages register successfully (they also appear under Show more
/// options). Treat ProgId open + (classic compress OR modern menu) as Ready.
#[cfg(target_os = "windows")]
fn windows_classic_verbs_registered(modern_registered: Option<bool>) -> Option<bool> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const PROGID_OPEN: &str = r"HKCU\Software\Classes\run.rosie.zinnia.7z\shell\open";
    const CLASSIC_COMPRESS: &str = r"HKCU\Software\Classes\*\shell\ZinniaCompress";

    // Resolve the absolute System32 path rather than a bare "reg" name: NSIS
    // installs under installMode "currentUser", so Zinnia's own install
    // directory is user-writable and would otherwise be searched before
    // System32 for program-name resolution.
    let reg = crate::fs_secure::system32_binary_path("reg.exe").ok()?;
    let progid_open = {
        let output = command_output_with_timeout(
            Command::new(&reg)
                .args(["query", PROGID_OPEN])
                .creation_flags(CREATE_NO_WINDOW),
            std::time::Duration::from_secs(5),
        )
        .ok()?;
        output.status.success()
    };
    if !progid_open {
        return Some(false);
    }

    let classic_compress = {
        let output = command_output_with_timeout(
            Command::new(&reg)
                .args(["query", CLASSIC_COMPRESS])
                .creation_flags(CREATE_NO_WINDOW),
            std::time::Duration::from_secs(5),
        )
        .ok()?;
        output.status.success()
    };
    if classic_compress {
        return Some(true);
    }

    modern_registered
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
            help: "Win11 modern menu package is registered (sparse identity only; Zinnia remains a normal NSIS install). Confirm Extract/Compress launch from the primary menu. Classic HKCU Extract/Compress verbs are removed on success so they do not stack under Show more options; they return only if package registration fails.".to_string(),
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

struct FinderSyncInfo {
    available: bool,
    known: bool,
    enabled: bool,
    help: String,
}

#[cfg(target_os = "macos")]
pub(crate) const MACOS_FINDER_SYNC_BUNDLE_ID: &str = "run.rosie.zinnia.findersync";

// Load FinderSync in the containing app so its public management/status APIs
// are usable even before pluginkit discovers the embedded extension.
#[cfg(target_os = "macos")]
#[link(name = "FinderSync", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
fn finder_sync_controller_class() -> Option<&'static AnyClass> {
    AnyClass::get(c"FIFinderSyncController")
}

#[cfg(target_os = "macos")]
pub(crate) fn show_finder_sync_management_interface(app: &tauri::AppHandle) -> bool {
    if finder_sync_controller_class().is_none() {
        return false;
    }
    app.run_on_main_thread(|| {
        if let Some(controller) = finder_sync_controller_class() {
            // `showExtensionManagementInterface` is FinderSync's documented
            // route to the system-managed enablement interface.
            unsafe { msg_send![controller, showExtensionManagementInterface] }
        }
    })
    .is_ok()
}

#[cfg(target_os = "macos")]
fn macos_finder_sync_appex_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    let appex = contents.join("PlugIns").join("ZinniaFinderSync.appex");
    appex.exists().then_some(appex)
}

/// Register the embedded Finder Sync appex with pluginkit (best-effort).
#[cfg(target_os = "macos")]
pub fn register_macos_finder_sync() {
    let Some(appex) = macos_finder_sync_appex_path() else {
        return;
    };
    let _ = command_output_with_timeout(
        Command::new("/usr/bin/pluginkit").args(["-a", &appex.to_string_lossy()]),
        std::time::Duration::from_secs(8),
    );
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_finder_sync_enabled() -> Option<bool> {
    if let Some(controller) = finder_sync_controller_class() {
        // `isExtensionEnabled` is the public FinderSync status API. Retain the
        // pluginkit query below only for compatibility if the framework loads.
        return Some(unsafe { msg_send![controller, isExtensionEnabled] });
    }
    // `+` election means the user (or pluginkit -e use) enabled the extension.
    let output = command_output_with_timeout(
        Command::new("/usr/bin/pluginkit").args(["-m", "-v", "-i", MACOS_FINDER_SYNC_BUNDLE_ID]),
        std::time::Duration::from_secs(8),
    )
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    if text.trim().is_empty() && !output.status.success() {
        return None;
    }
    if !text.contains(MACOS_FINDER_SYNC_BUNDLE_ID) {
        // Not discovered yet  -  still treat as known+disabled when the appex exists.
        return Some(false);
    }
    Some(text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with('+') && trimmed.contains(MACOS_FINDER_SYNC_BUNDLE_ID)
    }))
}

fn finder_sync_status_for(platform: &str, packaged: bool) -> FinderSyncInfo {
    if platform != "macos" {
        return FinderSyncInfo {
            available: false,
            known: false,
            enabled: false,
            help: String::new(),
        };
    }
    if !packaged {
        return FinderSyncInfo {
            available: true,
            known: true,
            enabled: false,
            help: "Install a packaged build to embed the Finder Sync extension for primary Finder context menus.".to_string(),
        };
    }

    #[cfg(target_os = "macos")]
    {
        if macos_finder_sync_appex_path().is_none() {
            return FinderSyncInfo {
                available: true,
                known: true,
                enabled: false,
                help: "Finder Sync extension is missing from this install. Reinstall a current packaged build.".to_string(),
            };
        }
        match macos_finder_sync_enabled() {
            Some(true) => FinderSyncInfo {
                available: true,
                known: true,
                enabled: true,
                help: "Finder Sync is enabled. Extract / Compress with Zinnia appear in Finder's primary right-click menu on Desktop, Documents, Downloads, Movies, Music, Pictures, and mounted volumes. Use Finder Services elsewhere.".to_string(),
            },
            Some(false) => FinderSyncInfo {
                available: true,
                known: true,
                enabled: false,
                help: "Finder Sync is installed but not enabled. Click Enable… or turn on Zinnia under System Settings → General → Login Items & Extensions → File Providers / Finder extensions.".to_string(),
            },
            None => FinderSyncInfo {
                available: true,
                known: false,
                enabled: false,
                help: "Could not query Finder Sync status via pluginkit. Open Login Items & Extensions and enable Zinnia Finder.".to_string(),
            },
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        FinderSyncInfo {
            available: true,
            known: true,
            enabled: true,
            help: "Finder Sync is enabled. Extract / Compress with Zinnia appear in Finder's primary right-click menu.".to_string(),
        }
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
    {
        macos_finder_services_info()
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Cross-compiled / non-mac unit tests: packaged build is assumed enabled.
        FinderServicesInfo {
            available: true,
            known: true,
            enabled: true,
            help: "Extract with Zinnia and Compress with Zinnia are enabled in Finder's Services menu."
                .to_string(),
        }
    }
}

pub fn os_integration_status_for(platform: &str, packaged: bool) -> OsIntegrationStatus {
    let action_available = packaged && matches!(platform, "macos" | "linux");
    let default_app_help_available = matches!(platform, "macos" | "windows") || action_available;
    let finder = finder_services_status_for(platform, packaged);
    let finder_sync = finder_sync_status_for(platform, packaged);
    let win11 = win11_modern_menu_status_for(platform, packaged);
    // macOS: primary context menu tracks Finder Sync; Services remain a fallback.
    // Windows: Explorer actions come from Win11 sparse packages and/or classic
    // NSIS verbs (classic Extract/Compress only when packages fail to register).
    let context_actions_known = if platform == "macos" {
        packaged && ((finder_sync.known && finder_sync.enabled) || (finder.known && finder.enabled))
    } else {
        false
    };
    OsIntegrationStatus {
        platform: platform.to_string(),
        packaged,
        file_associations_known: packaged && matches!(platform, "macos"),
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
        finder_sync_available: finder_sync.available,
        finder_sync_known: finder_sync.known,
        finder_sync_enabled: finder_sync.enabled,
        finder_sync_help: finder_sync.help,
        win11_modern_menu_available: win11.available,
        win11_modern_menu_known: win11.known,
        win11_modern_menu_registered: win11.registered,
        win11_modern_menu_help: win11.help,
        archive_defaults: fallback_archive_defaults(platform, packaged, action_available),
    }
}

fn get_os_integration_status_blocking() -> OsIntegrationStatus {
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
        // xdg-mime query succeeded for at least one format → associations are known.
        if packaged
            && status
                .archive_defaults
                .iter()
                .any(|entry| entry.current_handler.is_some())
        {
            status.file_associations_known = true;
        }
    }
    if platform == "windows" {
        // Live ProgId query succeeded for at least one format.
        if packaged
            && status
                .archive_defaults
                .iter()
                .any(|entry| entry.current_handler.is_some() || entry.is_default)
        {
            status.file_associations_known = true;
        }

        #[cfg(target_os = "windows")]
        {
            let modern_registered = status
                .win11_modern_menu_known
                .then_some(status.win11_modern_menu_registered);
            match windows_classic_verbs_registered(modern_registered) {
                Some(true) => {
                    status.context_actions_known = true;
                }
                Some(false) => {
                    status.context_actions_known = false;
                }
                None => {
                    status.context_actions_known = false;
                }
            }
        }
    }
    if platform == "macos" {
        // Use live default-handler query for the Ready badge when possible.
        if packaged
            && status
                .archive_defaults
                .iter()
                .any(|entry| entry.current_handler.is_some() || entry.is_default)
        {
            status.file_associations_known = true;
        }
    }
    status
}

#[tauri::command]
pub async fn get_os_integration_status() -> Result<OsIntegrationStatus, String> {
    tokio::task::spawn_blocking(get_os_integration_status_blocking)
        .await
        .map_err(|error| format!("OS integration status worker failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::super::ARCHIVE_DEFAULT_TARGETS;
    use super::*;
    use super::{
        finder_services_enabled_from_pbs, finder_services_override_from_pbs, FinderServicesOverride,
    };

    #[test]
    fn os_integration_status_reflects_packaged_support() {
        let packaged = os_integration_status_for("windows", true);
        assert!(!packaged.file_associations_known);
        assert!(!packaged.context_actions_known);
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
        assert!(macos_dev.finder_sync_available);
        assert!(!macos_dev.finder_sync_enabled);
        assert!(!macos_dev.context_actions_known);
        assert!(macos_dev.finder_services_help.contains("packaged"));

        // Packaged macOS: Open/extract actions track Finder Sync and/or Services.
        let macos_pkg = os_integration_status_for("macos", true);
        assert!(macos_pkg.finder_services_available);
        assert!(macos_pkg.finder_sync_available);
        let sync_ok = macos_pkg.finder_sync_known && macos_pkg.finder_sync_enabled;
        let services_ok = macos_pkg.finder_services_known && macos_pkg.finder_services_enabled;
        assert_eq!(macos_pkg.context_actions_known, sync_ok || services_ok);
    }

    #[test]
    fn finder_services_override_absent_when_empty_or_unrelated() {
        let empty = serde_json::json!({});
        assert_eq!(
            finder_services_override_from_pbs(&empty),
            FinderServicesOverride::Absent
        );
        assert_eq!(finder_services_enabled_from_pbs(&empty), None);

        let other = serde_json::json!({
            "NSServicesStatus": {
                "com.example.app - Other - other": {
                    "enabled_context_menu": false,
                    "enabled_services_menu": false
                }
            }
        });
        assert_eq!(
            finder_services_override_from_pbs(&other),
            FinderServicesOverride::Absent
        );
        assert_eq!(finder_services_enabled_from_pbs(&other), None);

        let empty_map = serde_json::json!({ "NSServicesStatus": {} });
        assert_eq!(
            finder_services_override_from_pbs(&empty_map),
            FinderServicesOverride::Absent
        );
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
        assert_eq!(finder_services_enabled_from_pbs(&disabled), Some(false));
        assert_eq!(
            finder_services_override_from_pbs(&disabled),
            FinderServicesOverride::Disabled
        );

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
        assert_eq!(finder_services_enabled_from_pbs(&enabled), Some(true));
        assert_eq!(
            finder_services_override_from_pbs(&enabled),
            FinderServicesOverride::Enabled
        );
    }

    #[test]
    fn finder_services_partial_override_is_not_fully_enabled() {
        let partial_on = serde_json::json!({
            "NSServicesStatus": {
                "run.rosie.zinnia - Extract with Zinnia - extractWithZinnia": {
                    "enabled_context_menu": true,
                    "enabled_services_menu": true
                }
            }
        });
        assert_eq!(
            finder_services_override_from_pbs(&partial_on),
            FinderServicesOverride::Absent
        );

        let partial_off = serde_json::json!({
            "NSServicesStatus": {
                "run.rosie.zinnia - Compress with Zinnia - compressWithZinnia": {
                    "enabled_context_menu": false
                }
            }
        });
        assert_eq!(
            finder_services_override_from_pbs(&partial_off),
            FinderServicesOverride::Disabled
        );
    }

    #[test]
    fn finder_services_reads_presentation_modes_context_menu() {
        let modes = serde_json::json!({
            "NSServicesStatus": {
                "run.rosie.zinnia - Extract with Zinnia - extractWithZinnia": {
                    "presentation_modes": { "ContextMenu": false }
                },
                "run.rosie.zinnia - Compress with Zinnia - compressWithZinnia": {
                    "presentation_modes": { "ContextMenu": true }
                }
            }
        });
        assert_eq!(
            finder_services_override_from_pbs(&modes),
            FinderServicesOverride::Disabled
        );
    }

    #[test]
    fn finder_services_pbs_is_indeterminate_when_context_menu_flag_is_malformed() {
        let malformed = serde_json::json!({
            "NSServicesStatus": {
                "run.rosie.zinnia - Extract with Zinnia - extractWithZinnia": {
                    "enabled_context_menu": "true"
                },
                "run.rosie.zinnia - Compress with Zinnia - compressWithZinnia": {}
            }
        });
        assert_eq!(
            finder_services_override_from_pbs(&malformed),
            FinderServicesOverride::Indeterminate
        );
        assert_eq!(finder_services_enabled_from_pbs(&malformed), None);
    }
}
