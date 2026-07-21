//! Set/reset default archiver and open OS integration settings commands.

#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "macos")]
use super::os_command::command_output_with_timeout;
#[cfg(target_os = "linux")]
use super::linux_defaults::{linux_set_archive_defaults, XdgMimeBackend};
#[cfg(target_os = "macos")]
use super::macos_defaults::macos_set_archive_defaults;
use super::{
    default_archiver_result, fallback_archive_defaults, is_packaged, DefaultArchiverResult,
};
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
        return app
            .shell()
            .open("ms-settings:defaultapps", None)
            .map_err(|e| e.to_string());
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

/// Opens System Settings → Keyboard → Keyboard Shortcuts → **Services**.
///
/// Zinnia registers **Finder Services** (`NSServices`), not a Finder Sync /
/// File Provider appex. Those show under Login Items & Extensions (Keka-style);
/// ours are toggled under Keyboard Shortcuts → Services.
#[tauri::command]
#[allow(deprecated)]
pub fn open_finder_services_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // URL alone often leaves Modifier Keys selected. Reveal Shortcuts, then
        // select the Services row by name (fragile UI scripting, with URL fallback).
        const SCRIPT: &str = r#"
tell application "System Settings"
  activate
  reveal anchor "Shortcuts" of pane id "com.apple.Keyboard-Settings.extension"
end tell
delay 0.9
tell application "System Events"
  tell process "System Settings"
    set frontmost to true
    if not (exists sheet 1 of window 1) then error "shortcuts sheet missing"
    tell sheet 1 of window 1
      set theOutline to outline 1 of scroll area 1 of group 1 of splitter group 1 of group 1
      repeat with r in rows of theOutline
        try
          set rowLabel to name of UI element 1 of r
          if rowLabel is "Services" then
            set selected of r to true
            return "ok"
          end if
        end try
      end repeat
    end tell
  end tell
end tell
error "Services row not found"
"#;
        let script_ok = command_output_with_timeout(
            Command::new("osascript").arg("-e").arg(SCRIPT),
            std::time::Duration::from_secs(8),
        )
        .map(|output| output.status.success())
        .unwrap_or(false);
        if script_ok {
            return Ok(());
        }
        // Accessibility may be denied or the sheet layout changed; still
        // open Keyboard Shortcuts so the user can click Services manually.
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
