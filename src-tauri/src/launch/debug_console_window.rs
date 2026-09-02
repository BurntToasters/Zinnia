//! Detached Debug Console window lifecycle.

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DEBUG_CONSOLE_LABEL: &str = "debug-console";

pub fn debug_console_is_open(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(DEBUG_CONSOLE_LABEL).is_some()
}

fn attach_destroy_notifier(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = app_handle.emit("zinnia-debug-console-closed", ());
        }
    });
}

#[tauri::command]
pub fn open_debug_console_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(DEBUG_CONSOLE_LABEL) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    crate::launch::restore_foreground_activation(&app);

    let mut builder = WebviewWindowBuilder::new(
        &app,
        DEBUG_CONSOLE_LABEL,
        WebviewUrl::App("debug-console.html".into()),
    )
    .title("Zinnia: Debug Console")
    .inner_size(640.0, 420.0)
    .min_inner_size(420.0, 240.0)
    .resizable(true)
    .minimizable(true)
    .maximizable(true)
    .initialization_script(super::webview_context_menu::NATIVE_CONTEXT_MENU_GUARD_SCRIPT);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title("")
            .title_bar_style(tauri::TitleBarStyle::Overlay);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    attach_destroy_notifier(&app, &window);
    Ok(())
}

#[tauri::command]
pub fn close_debug_console_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DEBUG_CONSOLE_LABEL) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Forward a single debug line to the popped-out console when it exists.
#[tauri::command]
pub fn relay_debug_console_line(app: tauri::AppHandle, line: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DEBUG_CONSOLE_LABEL) {
        window
            .emit("zinnia-debug-log", line)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Seed the popped-out console with the current buffer in one IPC round-trip.
#[tauri::command]
pub fn relay_debug_console_seed(app: tauri::AppHandle, lines: Vec<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DEBUG_CONSOLE_LABEL) {
        window
            .emit("zinnia-debug-seed", lines)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn relay_debug_console_clear(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DEBUG_CONSOLE_LABEL) {
        window
            .emit("zinnia-debug-clear", ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn debug_console_window_open(app: tauri::AppHandle) -> bool {
    debug_console_is_open(&app)
}

/// Forward a pop-out console lifecycle signal to main. Only the debug-console
/// window may invoke this; the event name is allowlisted.
#[tauri::command]
pub fn relay_debug_console_signal(
    window: tauri::Window,
    app: tauri::AppHandle,
    signal: String,
) -> Result<(), String> {
    if window.label() != DEBUG_CONSOLE_LABEL {
        return Err(
            "Debug console signals can only be sent from the debug console window.".to_string(),
        );
    }
    let event = match signal.as_str() {
        "ready" => "zinnia-debug-console-ready",
        "closed" => "zinnia-debug-console-closed",
        "dock" => "zinnia-debug-console-dock-request",
        "clear" => "zinnia-debug-console-clear-request",
        _ => return Err(format!("Unknown debug console signal '{signal}'.")),
    };
    app.emit(event, ()).map_err(|error| error.to_string())
}
