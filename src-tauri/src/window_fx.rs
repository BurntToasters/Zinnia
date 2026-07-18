//! OS-native window glass for Basic mode (macOS vibrancy / Windows Mica·Acrylic).
//! Linux is intentionally a no-op; Basic stays fully opaque there.

use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(target_os = "macos")]
fn apply_macos(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
    apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None)
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn clear_macos(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::clear_vibrancy;
    clear_vibrancy(window)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn apply_windows(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{apply_acrylic, apply_mica};
    match apply_mica(window, None) {
        Ok(()) => Ok(()),
        Err(mica_error) => apply_acrylic(window, Some((30, 30, 30, 180))).map_err(|acrylic_error| {
            format!("Mica unavailable ({mica_error}); Acrylic failed: {acrylic_error}")
        }),
    }
}

#[cfg(target_os = "windows")]
fn clear_windows(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{clear_acrylic, clear_mica};
    let mica = clear_mica(window);
    let acrylic = clear_acrylic(window);
    if mica.is_ok() || acrylic.is_ok() {
        Ok(())
    } else {
        Err(format!(
            "Could not clear window effects: mica={mica:?}, acrylic={acrylic:?}"
        ))
    }
}

pub fn apply_basic_window_fx(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return apply_macos(window);
    }
    #[cfg(target_os = "windows")]
    {
        return apply_windows(window);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        Ok(())
    }
}

pub fn clear_basic_window_fx(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return clear_macos(window);
    }
    #[cfg(target_os = "windows")]
    {
        return clear_windows(window);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        Ok(())
    }
}

/// Enable or disable Basic-mode native glass on the main window.
/// Linux always no-ops so the UI stays opaque.
#[tauri::command]
pub fn set_workspace_window_fx(app: AppHandle, enabled: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    if !supports_basic_window_fx() {
        let _ = enabled;
        return Ok(());
    }

    if enabled {
        apply_basic_window_fx(&window)
    } else {
        clear_basic_window_fx(&window)
    }
}

pub fn supports_basic_window_fx() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[tauri::command]
pub fn supports_workspace_window_fx() -> bool {
    supports_basic_window_fx()
}
