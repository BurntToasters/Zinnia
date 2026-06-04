//! Platform/environment queries and OS integration helpers.

#[tauri::command]
pub fn get_platform_info() -> String {
    std::env::consts::OS.to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsIntegrationStatus {
    platform: String,
    packaged: bool,
    file_associations_known: bool,
    context_actions_known: bool,
    default_app_help_available: bool,
}

pub fn os_integration_status_for(platform: &str, packaged: bool) -> OsIntegrationStatus {
    let supported_platform = matches!(platform, "macos" | "windows" | "linux");
    OsIntegrationStatus {
        platform: platform.to_string(),
        packaged,
        file_associations_known: packaged && supported_platform,
        context_actions_known: packaged && supported_platform,
        default_app_help_available: matches!(platform, "macos" | "windows"),
    }
}

#[tauri::command]
pub fn get_os_integration_status() -> OsIntegrationStatus {
    os_integration_status_for(std::env::consts::OS, is_packaged())
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

    #[test]
    fn os_integration_status_reflects_packaged_support() {
        let packaged = os_integration_status_for("windows", true);
        assert!(packaged.file_associations_known);
        assert!(packaged.context_actions_known);
        assert!(packaged.default_app_help_available);

        let dev = os_integration_status_for("linux", false);
        assert!(!dev.file_associations_known);
        assert!(!dev.context_actions_known);
        assert!(!dev.default_app_help_available);
    }
}
