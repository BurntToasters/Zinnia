//! Set/reset default archiver and open OS integration settings commands.

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::default_archiver_result;
#[cfg(target_os = "linux")]
use super::linux_defaults::{linux_set_archive_defaults, XdgMimeBackend};
#[cfg(target_os = "macos")]
use super::macos_defaults::macos_set_archive_defaults;
use super::{fallback_archive_defaults, is_packaged, DefaultArchiverResult};
#[cfg(target_os = "linux")]
use super::{is_flatpak, linux_desktop_session_available};

fn set_zinnia_default_archiver_blocking(
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
pub async fn set_zinnia_default_archiver(
    app: tauri::AppHandle,
) -> Result<DefaultArchiverResult, String> {
    tokio::task::spawn_blocking(move || set_zinnia_default_archiver_blocking(app))
        .await
        .map_err(|error| format!("Default-archiver worker failed: {error}"))?
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
        app.shell()
            .open("ms-settings:defaultapps", None)
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_shell::ShellExt;
        // Desktop & Dock → Default Apps (not Extensions).
        app.shell()
            .open(
                "x-apple.systempreferences:com.apple.Desktop-Settings.extension?com.apple.desktopsettings.apps",
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

/// Opens System Settings → Keyboard → Keyboard Shortcuts.
///
/// Zinnia also ships a **Finder Sync** appex for primary Finder context menus.
/// Services remain available under Keyboard Shortcuts → Services → Files and Folders.
#[tauri::command]
#[allow(deprecated)]
pub fn open_finder_services_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_shell::ShellExt;
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

/// Opens System Settings → General → Login Items & Extensions for Finder Sync.
#[tauri::command]
#[allow(deprecated)]
pub fn open_finder_sync_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(
                "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
                None,
            )
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Finder Sync settings are only available on macOS.".to_string())
    }
}

/// Elect the embedded Finder Sync extension via pluginkit (`-e use`).
/// Falls back to opening Login Items & Extensions when election fails.
#[tauri::command]
pub fn enable_finder_sync(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use super::integration_status::{
            register_macos_finder_sync, MACOS_FINDER_SYNC_BUNDLE_ID,
        };
        use super::os_command::command_output_with_timeout;
        use std::process::Command;

        register_macos_finder_sync();
        let elected = command_output_with_timeout(
            Command::new("/usr/bin/pluginkit").args([
                "-e",
                "use",
                "-i",
                MACOS_FINDER_SYNC_BUNDLE_ID,
            ]),
            std::time::Duration::from_secs(8),
        )
        .map(|output| output.status.success())
        .unwrap_or(false);

        if elected {
            return Ok(());
        }
        open_finder_sync_settings(app)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Finder Sync can only be enabled on macOS.".to_string())
    }
}

/// Enable Extract/Compress with Zinnia in Finder Services by writing `pbs`
/// `NSServicesStatus` overrides, then flushing the Services cache.
///
/// Keyboard Shortcuts checkboxes on current macOS often leave `NSServicesStatus`
/// empty, so status stays Not enabled until these prefs are written explicitly.
#[tauri::command]
pub fn enable_finder_services() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        enable_macos_finder_services()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Finder Services can only be enabled on macOS.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn enable_macos_finder_services() -> Result<(), String> {
    use std::path::PathBuf;
    use std::process::Command;

    use super::integration_status::MACOS_FINDER_SERVICE_KEYS;
    use super::os_command::command_output_with_timeout;

    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unset".to_string())?;
    let path = PathBuf::from(home).join("Library/Preferences/pbs.plist");

    let mut root = if path.exists() {
        let output = command_output_with_timeout(
            Command::new("plutil").args([
                "-convert",
                "json",
                "-o",
                "-",
                "--",
                &path.to_string_lossy(),
            ]),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to read pbs.plist: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Failed to read pbs.plist: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Failed to parse pbs.plist JSON: {e}"))?
    } else {
        serde_json::json!({})
    };

    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| "pbs.plist root must be a dictionary".to_string())?;
    let status_value = root_obj
        .entry("NSServicesStatus".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let status_map = status_value
        .as_object_mut()
        .ok_or_else(|| "NSServicesStatus must be a dictionary".to_string())?;

    let entry = serde_json::json!({
        "enabled_context_menu": true,
        "enabled_services_menu": true,
        "presentation_modes": { "ContextMenu": true }
    });
    for key in MACOS_FINDER_SERVICE_KEYS {
        status_map.insert((*key).to_string(), entry.clone());
    }

    let tmp = path.with_extension("zinnia.json");
    let json = serde_json::to_vec_pretty(&root)
        .map_err(|e| format!("Failed to serialize pbs prefs: {e}"))?;
    std::fs::write(&tmp, json).map_err(|e| format!("Failed to stage pbs prefs: {e}"))?;

    let convert = command_output_with_timeout(
        Command::new("plutil").args([
            "-convert",
            "binary1",
            "-o",
            &path.to_string_lossy(),
            "--",
            &tmp.to_string_lossy(),
        ]),
        std::time::Duration::from_secs(5),
    );
    let _ = std::fs::remove_file(&tmp);
    let convert = convert.map_err(|e| format!("Failed to write pbs.plist: {e}"))?;
    if !convert.status.success() {
        return Err(format!(
            "Failed to write pbs.plist: {}",
            String::from_utf8_lossy(&convert.stderr)
        ));
    }

    // Refresh CFPreferences + Services registration so Finder picks up the toggles.
    let _ = command_output_with_timeout(
        Command::new("defaults").args(["read", "pbs", "NSServicesStatus"]),
        std::time::Duration::from_secs(5),
    );
    let _ = command_output_with_timeout(
        Command::new("/System/Library/CoreServices/pbs").args(["-flush"]),
        std::time::Duration::from_secs(8),
    );

    Ok(())
}
