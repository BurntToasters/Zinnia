//! OS-native window glass for Basic mode (macOS vibrancy / Windows Mica·Acrylic).
//! Linux is intentionally a no-op; Basic stays fully opaque there.

use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
fn apply_macos(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
    apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn clear_macos(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::clear_vibrancy;
    clear_vibrancy(window)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn acrylic_tint(dark: bool) -> (u8, u8, u8, u8) {
    if dark {
        (30, 30, 30, 180)
    } else {
        (245, 245, 245, 200)
    }
}

#[cfg(target_os = "windows")]
fn apply_windows(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    use window_vibrancy::{apply_acrylic, apply_mica};
    match apply_mica(window, Some(dark)) {
        Ok(()) => Ok(()),
        Err(mica_error) => {
            apply_acrylic(window, Some(acrylic_tint(dark))).map_err(|acrylic_error| {
                format!("Mica unavailable ({mica_error}); Acrylic failed: {acrylic_error}")
            })
        }
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

fn paint_opaque_background(window: &WebviewWindow, dark: bool) {
    let color = if dark {
        tauri::window::Color(0x1e, 0x1e, 0x1e, 0xff)
    } else {
        tauri::window::Color(0xf5, 0xf5, 0xf5, 0xff)
    };
    let _ = window.set_background_color(Some(color));
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn paint_transparent_background(window: &WebviewWindow) {
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
}

pub fn apply_basic_window_fx(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = dark;
        paint_transparent_background(window);
        apply_macos(window)
    }
    #[cfg(target_os = "windows")]
    {
        paint_transparent_background(window);
        apply_windows(window, dark)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = dark;
        paint_opaque_background(window, dark);
        Ok(())
    }
}

pub fn clear_basic_window_fx(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let result = clear_macos(window);
        paint_opaque_background(window, dark);
        result
    }
    #[cfg(target_os = "windows")]
    {
        let result = clear_windows(window);
        paint_opaque_background(window, dark);
        result
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        paint_opaque_background(window, dark);
        Ok(())
    }
}

/// Enable or disable Basic-mode native glass on the calling window.
/// Linux always paints opaque and skips vibrancy APIs.
#[tauri::command]
pub fn set_workspace_window_fx(
    window: WebviewWindow,
    enabled: bool,
    dark: bool,
) -> Result<(), String> {
    if !supports_basic_window_fx() {
        paint_opaque_background(&window, dark);
        let _ = enabled;
        return Ok(());
    }

    if enabled {
        apply_basic_window_fx(&window, dark)
    } else {
        clear_basic_window_fx(&window, dark)
    }
}

pub fn supports_basic_window_fx() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[tauri::command]
pub fn supports_workspace_window_fx() -> bool {
    supports_basic_window_fx()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_basic_window_fx_matches_platform() {
        let expected = cfg!(any(target_os = "macos", target_os = "windows"));
        assert_eq!(supports_basic_window_fx(), expected);
        assert_eq!(supports_workspace_window_fx(), expected);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn acrylic_tint_is_theme_aware() {
        let dark = acrylic_tint(true);
        let light = acrylic_tint(false);
        assert_eq!(dark, (30, 30, 30, 180));
        assert_eq!(light.0, 245);
        assert!(light.0 > dark.0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_does_not_claim_native_glass() {
        assert!(!supports_basic_window_fx());
    }
}
