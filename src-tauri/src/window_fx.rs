//! OS-native window glass for Basic mode (macOS vibrancy / Windows Mica·Acrylic).
//! Linux is intentionally a no-op; Basic stays fully opaque there.

use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
fn apply_macos(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
    apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None).map_err(|e| e.to_string())
}

/// Upper bound on clear passes so a misbehaving view tree cannot spin forever.
#[cfg(target_os = "macos")]
const MAX_VIBRANCY_CLEAR_PASSES: usize = 16;

/// `apply_vibrancy` adds a new NSVisualEffectView on every call, while
/// `clear_vibrancy` removes one. Drain the stack until nothing is left.
#[cfg(target_os = "macos")]
fn clear_macos(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::clear_vibrancy;
    for _ in 0..MAX_VIBRANCY_CLEAR_PASSES {
        match clear_vibrancy(window) {
            Ok(true) => continue,
            Ok(false) => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Sets the app-wide NSApp appearance. Pinning it to Dark/Light stops WKWebView
/// from following OS appearance changes (prefers-color-scheme), so when the
/// user's theme is "system" the override is cleared with `set_theme(None)`
/// instead. tauri applies this with `[NSApp setAppearance:]`, not per window.
#[cfg(target_os = "macos")]
fn apply_macos_appearance(window: &WebviewWindow, dark: bool, follow_system: bool) {
    let theme = if follow_system {
        None
    } else if dark {
        Some(tauri::Theme::Dark)
    } else {
        Some(tauri::Theme::Light)
    };
    let _ = window.set_theme(theme);
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

pub fn apply_basic_window_fx(
    window: &WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        apply_macos_appearance(window, dark, follow_system);
        // Remove any previously stacked effect views before adding a new one.
        let _ = clear_macos(window);
        paint_transparent_background(window);
        let result = apply_macos(window);
        if result.is_err() {
            paint_opaque_background(window, dark);
        }
        result
    }
    #[cfg(target_os = "windows")]
    {
        let _ = follow_system;
        paint_transparent_background(window);
        let result = apply_windows(window, dark);
        if result.is_err() {
            paint_opaque_background(window, dark);
        }
        result
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (dark, follow_system);
        paint_opaque_background(window, dark);
        Ok(())
    }
}

pub fn clear_basic_window_fx(
    window: &WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        apply_macos_appearance(window, dark, follow_system);
        let result = clear_macos(window);
        paint_opaque_background(window, dark);
        result
    }
    #[cfg(target_os = "windows")]
    {
        let _ = follow_system;
        let result = clear_windows(window);
        paint_opaque_background(window, dark);
        result
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = follow_system;
        paint_opaque_background(window, dark);
        Ok(())
    }
}

/// Enable or disable Basic-mode native glass on the calling window.
/// Linux always paints opaque and skips vibrancy APIs.
/// `follow_system` defaults to true when omitted, so a caller that does not
/// send it never pins the native appearance.
#[tauri::command]
pub fn set_workspace_window_fx(
    window: WebviewWindow,
    enabled: bool,
    dark: bool,
    follow_system: Option<bool>,
) -> Result<(), String> {
    let follow_system = follow_system.unwrap_or(true);
    if !supports_basic_window_fx() {
        paint_opaque_background(&window, dark);
        let _ = enabled;
        return Ok(());
    }

    if enabled {
        apply_basic_window_fx(&window, dark, follow_system)
    } else {
        clear_basic_window_fx(&window, dark, follow_system)
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
