//! Native application menu (macOS menu bar).

use tauri::AppHandle;

/// Install the macOS application menu and route custom items to the frontend.
#[cfg(target_os = "macos")]
pub fn install_macos_app_menu(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, SubmenuBuilder};
    use tauri::{Emitter, Manager};

    const MENU_CHECK_UPDATES: &str = "menu-check-updates";
    const MENU_SETTINGS: &str = "menu-settings";
    const MENU_SHORTCUTS: &str = "menu-shortcuts";
    const MENU_SUPPORT: &str = "menu-support";
    const MENU_LICENSES: &str = "menu-licenses";

    let check_updates = MenuItem::with_id(
        app,
        MENU_CHECK_UPDATES,
        "Check for Updates…",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;

    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))
        .map_err(|e| e.to_string())?;

    let shortcuts = MenuItem::with_id(
        app,
        MENU_SHORTCUTS,
        "Keyboard Shortcuts",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;

    let support = MenuItem::with_id(app, MENU_SUPPORT, "Support Zinnia", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let licenses = MenuItem::with_id(app, MENU_LICENSES, "Licenses", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let about = AboutMetadata {
        name: Some("Zinnia".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("© BurntToasters".into()),
        ..Default::default()
    };

    let app_submenu = SubmenuBuilder::new(app, "Zinnia")
        .about(Some(about))
        .separator()
        .item(&check_updates)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()
        .map_err(|e| e.to_string())?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
        .map_err(|e| e.to_string())?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()
        .map_err(|e| e.to_string())?;

    let help_submenu = SubmenuBuilder::new(app, "Help")
        .item(&shortcuts)
        .item(&support)
        .separator()
        .item(&licenses)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = help_submenu.set_as_help_menu_for_nsapp();
    let _ = window_submenu.set_as_windows_menu_for_nsapp();

    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&window_submenu)
        .item(&help_submenu)
        .build()
        .map_err(|e| e.to_string())?;

    app.set_menu(menu).map_err(|e| e.to_string())?;

    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        match id {
            MENU_CHECK_UPDATES | MENU_SETTINGS | MENU_SHORTCUTS | MENU_SUPPORT | MENU_LICENSES => {
                if let Err(error) = crate::launch::show_main_window(app) {
                    eprintln!("Failed to show main window for menu action: {error}");
                }
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("app-menu", id);
                } else {
                    let _ = app.emit("app-menu", id);
                }
            }
            _ => {}
        }
    });

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install_macos_app_menu(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
