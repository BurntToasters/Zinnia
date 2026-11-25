//! Native application menu (macOS menu bar).

use tauri::AppHandle;

static PENDING_MENU_ACTIONS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn flush_pending_menu_actions(app: &AppHandle) {
    use tauri::{Emitter as _, Manager as _};

    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let pending = PENDING_MENU_ACTIONS
        .lock()
        .map(|mut actions| std::mem::take(&mut *actions))
        .unwrap_or_default();
    let mut pending = pending.into_iter();
    while let Some(action) = pending.next() {
        if main.emit("app-menu", &action).is_err() {
            if let Ok(mut actions) = PENDING_MENU_ACTIONS.lock() {
                actions.push(action);
                actions.extend(pending);
            }
            break;
        }
    }
}

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
    const MENU_QUIT: &str = "menu-quit";

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

    // Custom instead of the predefined Quit: that one sends `terminate:`, which
    // skips ExitRequested and with it the busy-quit guard.
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Zinnia", true, Some("CmdOrCtrl+Q"))
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
        .item(&quit)
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
        .fullscreen()
        .separator()
        .close_window()
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
                // A menu action is an explicit request for the full workspace.
                // Leave extract-only mode so closing a quick-extract window
                // does not destroy the main window this action opens.
                crate::launch::open_main_from_extract_warm(app);
                let delivered = crate::launch::MAIN_WINDOW_READY
                    .load(std::sync::atomic::Ordering::SeqCst)
                    && app
                        .get_webview_window("main")
                        .is_some_and(|main| main.emit("app-menu", id).is_ok());
                if !delivered {
                    if let Ok(mut pending) = PENDING_MENU_ACTIONS.lock() {
                        pending.push(id.to_string());
                    }
                }
            }
            MENU_QUIT => {
                // Same route as the tray Quit: leave extract warm-idle first, or
                // ExitRequested would keep the process resident.
                if crate::launch::should_keep_extract_warm(app) {
                    crate::launch::leave_extract_warm(app);
                    crate::launch::EXTRACT_ONLY_LAUNCH
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                }
                app.exit(0);
            }
            _ => {}
        }
    });

    install_terminate_hook(app);

    Ok(())
}

/// Set once at startup so the NSApplication delegate hook can reach the app.
#[cfg(target_os = "macos")]
static TERMINATE_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// True between `NSTerminateLater` and `replyToApplicationShouldTerminate:`.
#[cfg(target_os = "macos")]
static TERMINATE_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// True while AppKit is waiting for an answer to `applicationShouldTerminate:`.
#[cfg(target_os = "macos")]
pub(crate) fn system_terminate_pending() -> bool {
    TERMINATE_PENDING.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn system_terminate_pending() -> bool {
    false
}

/// Answers a pending `NSTerminateLater`. Must run on the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn resolve_system_terminate(should_terminate: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("Could not answer applicationShouldTerminate: not on the main thread.");
        return;
    };
    if !TERMINATE_PENDING.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(should_terminate);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn resolve_system_terminate(_should_terminate: bool) {}

/// Bounds a logout/shutdown while the normal quit guard asks the user. AppKit
/// stays in `NSTerminateLater` until an answer arrives; a dismissed prompt has
/// no backend callback, so answer NO rather than leaving the system waiting.
#[cfg(target_os = "macos")]
pub(crate) fn bound_system_terminate_prompt(app: &AppHandle) {
    if !system_terminate_pending() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let _ = handle.run_on_main_thread(move || resolve_system_terminate(false));
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn bound_system_terminate_prompt(_app: &AppHandle) {}

/// `applicationShouldTerminate:` for Dock Quit, logout and shutdown. Those send
/// `terminate:` to NSApp and never reach `ExitRequested`. The same facts that
/// `ExitRequested` reads decide here. A busy slot defers the decision and hands
/// it to `app.exit(0)`, which runs the `ExitRequested` guard. `app.exit` does
/// not call `terminate:` again, so this cannot loop.
///
/// Returning `NSTerminateCancel` from here makes AppKit treat a pending logout
/// or shutdown as refused, which aborts the whole system action. `NSTerminateLater`
/// keeps it waiting while the guard runs; the guard then answers YES or NO.
#[cfg(target_os = "macos")]
extern "C-unwind" fn application_should_terminate(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _sender: *mut objc2::runtime::AnyObject,
) -> objc2_app_kit::NSApplicationTerminateReply {
    use objc2_app_kit::NSApplicationTerminateReply;

    let Some(app) = TERMINATE_APP.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    if !crate::should_prevent_exit(&crate::read_slot_facts(app), crate::exit_forced()) {
        return NSApplicationTerminateReply::TerminateNow;
    }
    TERMINATE_PENDING.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
    NSApplicationTerminateReply::TerminateLater
}

/// Adds `applicationShouldTerminate:` to the class of tao's NSApplication
/// delegate. tao implements only `applicationWillTerminate:`.
#[cfg(target_os = "macos")]
fn install_terminate_hook(app: &AppHandle) {
    use objc2::runtime::{AnyClass, AnyObject, Imp};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("Skipped applicationShouldTerminate: hook: not on the main thread.");
        return;
    };
    let _ = TERMINATE_APP.set(app.clone());
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns_app.delegate() else {
        eprintln!("Skipped applicationShouldTerminate: hook: NSApp has no delegate.");
        return;
    };
    let object: &AnyObject = delegate.as_ref();
    let class = object.class() as *const AnyClass as *mut AnyClass;
    let hook: extern "C-unwind" fn(
        *mut AnyObject,
        objc2::runtime::Sel,
        *mut AnyObject,
    ) -> NSApplicationTerminateReply = application_should_terminate;
    // SAFETY: `hook` has the signature the type encoding below describes. The
    // transmute only changes the fn-pointer type to the `Imp` that
    // `class_addMethod` takes, and both are the same thin function pointer.
    let imp: Imp = unsafe { std::mem::transmute::<_, Imp>(hook) };
    // SAFETY: `class` is the live class of NSApp's delegate. This runs on the
    // main thread during setup, before the run loop starts. The encoding
    // "Q24@0:8@16" is NSUInteger return, self, _cmd, and the sender argument.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class,
            objc2::sel!(applicationShouldTerminate:),
            imp,
            c"Q24@0:8@16".as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!("applicationShouldTerminate: already present on the app delegate; leaving it.");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install_macos_app_menu(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
