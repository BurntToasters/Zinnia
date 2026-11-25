#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![warn(clippy::undocumented_unsafe_blocks)]

mod app_menu;
mod archive_detect;
#[cfg(target_os = "macos")]
mod finder_sync_requests;
mod fs_secure;
mod launch;
mod logging;
#[cfg(target_os = "macos")]
mod macos_services;
mod output;
mod path_safety;
mod platform;
mod process;
mod progress;
mod quarantine;
mod settings_store;
mod tempdir;
mod validation;
mod window_fx;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

use launch::{
    collect_cli_context, emit_open_paths, enter_extract_warm_idle, has_extract_windows,
    should_keep_extract_warm, show_main_window, spawn_extract_window, ExtractBoundDestination,
    ExtractOpenAllowlist, ExtractQueue, InitialMode, InitialPaths, OpenPathAllowlist, PendingPaths,
    EXTRACT_ONLY_LAUNCH, FILE_OPEN_SIGNAL, MAC_FALLBACK_MAIN_PENDING,
};
#[cfg(any(target_os = "macos", target_os = "ios"))]
use launch::{emit_open_urls, first_extract_window, leave_extract_warm};
use logging::LogFileLock;
use process::RunningProcess;

fn production_integrations_enabled() -> bool {
    #[cfg(feature = "e2e")]
    {
        !launch::e2e_session_active()
    }
    #[cfg(not(feature = "e2e"))]
    {
        true
    }
}

/// Frontend event that asks the window owning a run to confirm before the run
/// is cancelled. Its payload is "close" or "quit".
const OPERATION_STOP_REQUEST_EVENT: &str = "operation-stop-request";

/// The archive slot as seen by a close or quit request.
struct SlotFacts {
    owner: Option<String>,
    /// An update install holds the slot. It is not a run the user started.
    update_reserved: bool,
    /// A 7-Zip child or its preparation that the user started is running.
    user_run: bool,
    /// Anything that closing or quitting must wait out.
    busy: bool,
}

static FORCE_EXIT: AtomicBool = AtomicBool::new(false);

fn exit_forced() -> bool {
    FORCE_EXIT.load(Ordering::SeqCst)
}

fn exit_forced_app(app: &tauri::AppHandle) {
    FORCE_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn should_prevent_exit(facts: &SlotFacts, forced: bool) -> bool {
    !forced && facts.busy
}

fn should_defer_close(facts: &SlotFacts, label: &str, forced: bool) -> bool {
    !forced && facts.owner.as_deref() == Some(label) && facts.busy
}

fn read_slot_facts(app: &tauri::AppHandle) -> SlotFacts {
    let state = app.state::<RunningProcess>();
    let mut process = match state.0.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    process.reap_orphaned_child();
    process.expire_stale_update_reservation();
    let update_reserved = process.blocks_quit_for_update_install();
    let user_run = !update_reserved && (process.child.is_some() || process.preparing);
    SlotFacts {
        owner: process.owner_label.clone(),
        update_reserved,
        user_run,
        busy: update_reserved || user_run || process.cancelling,
    }
}

/// Asks the owning window to confirm. Returns false when that window is gone,
/// so the caller falls back to cancelling without a prompt.
fn ask_owner_to_confirm(app: &tauri::AppHandle, owner: &str, request: &str) -> bool {
    if app.get_webview_window(owner).is_none() {
        return false;
    }
    app.emit_to(
        tauri::EventTarget::WebviewWindow {
            label: owner.to_string(),
        },
        OPERATION_STOP_REQUEST_EVENT,
        request,
    )
    .is_ok()
}

fn defer_close_while_operation_finishes(
    app: &tauri::AppHandle,
    label: &str,
    api: &tauri::CloseRequestApi,
) -> bool {
    let facts = read_slot_facts(app);
    if !should_defer_close(&facts, label, exit_forced()) {
        if launch::is_extract_window_label(label) {
            launch::clear_extract_window_bindings(app, label);
        }
        return false;
    }

    api.prevent_close();
    // A user run waits for the window's answer. The frontend's accept path
    // closes the window after the run is stopped, so the next request passes.
    if facts.user_run && ask_owner_to_confirm(app, label, "close") {
        return true;
    }
    let handle = app.clone();
    let window_label = label.to_string();
    tauri::async_runtime::spawn(async move {
        match launch::cancel_owner_and_wait(&handle, &window_label).await {
            Ok(()) => {
                let close_handle = handle.clone();
                let close_label = window_label.clone();
                let _ = handle.run_on_main_thread(move || {
                    launch::clear_extract_window_bindings(&close_handle, &close_label);
                    if let Some(window) = close_handle.get_webview_window(&close_label) {
                        let _ = window.destroy();
                    }
                });
            }
            Err(error) => eprintln!("Could not safely close {window_label}: {error}"),
        }
    });
    true
}

fn force_exit_after_busy_teardown(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<RunningProcess>();
        let owner = {
            let child = {
                let process = match state.0.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                process.child.clone()
            };
            if let Some(child) = child {
                let child_for_term = child.clone();
                let terminate_failed = tokio::task::spawn_blocking(move || {
                    if let Err(error) = process::terminate_child(&child_for_term) {
                        eprintln!(
                            "Could not stop archive process during forced exit: {error}"
                        );
                        if let Err(retry_error) = process::terminate_child_with_timeout(
                            &child_for_term,
                            std::time::Duration::from_secs(5),
                        ) {
                            eprintln!(
                                "Retry stop during forced exit also failed: {retry_error}. A leftover 7-Zip process may hold staging locks until the next recovery pass."
                            );
                            return true;
                        }
                        return false;
                    }
                    false
                })
                .await
                .unwrap_or(true);
                if terminate_failed {
                    {
                        let mut process = match state.0.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        process.cancelling = true;
                        if process.child.is_none() {
                            process.child = Some(child);
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    exit_forced_app(&app);
                    return;
                }
            }
            let mut process = match state.0.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            process.child = None;
            process.cancelling = true;
            process.owner_label.clone()
        };
        if let Some(owner) = owner {
            if let Err(error) = launch::cancel_owner_and_wait(&app, &owner).await {
                eprintln!("Could not finish archive teardown during forced exit: {error}");
            }
        } else {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        exit_forced_app(&app);
    });
}

fn defer_exit_while_operation_finishes(
    app: &tauri::AppHandle,
    api: &tauri::ExitRequestApi,
) -> bool {
    let facts = read_slot_facts(app);
    if !should_prevent_exit(&facts, exit_forced()) {
        if app_menu::system_terminate_pending() {
            // AppKit is waiting in NSTerminateLater. Hand termination back to
            // the system instead of racing it with a Tauri exit.
            api.prevent_exit();
            app_menu::resolve_system_terminate(true);
            return true;
        }
        return false;
    }
    api.prevent_exit();
    app_menu::bound_system_terminate_prompt(app);
    // An update reservation has no child to cancel. Do not mistake a
    // user/system Quit during installation for the later updater relaunch.
    // The frontend releases this reservation immediately before calling
    // relaunch; until then, keep the process alive.
    if facts.update_reserved {
        return true;
    }
    if facts.user_run {
        if let Some(owner) = facts.owner.as_deref() {
            if ask_owner_to_confirm(app, owner, "quit") {
                return true;
            }
        }
    }
    let Some(owner) = facts.owner else {
        eprintln!("Busy archive slot has no owner; forcing teardown before exit.");
        force_exit_after_busy_teardown(app.clone());
        return true;
    };

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match launch::cancel_owner_and_wait(&handle, &owner).await {
            Ok(()) => handle.exit(0),
            Err(error) => {
                eprintln!("Could not safely exit Zinnia: {error}");
                force_exit_after_busy_teardown(handle);
            }
        }
    });
    true
}

fn main() {
    let (initial_paths, initial_mode) = collect_cli_context();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(feature = "e2e")]
    {
        builder = builder
            .plugin(tauri_plugin_wdio::init())
            .plugin(tauri_plugin_wdio_webdriver::init());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if production_integrations_enabled() {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
                // Relative paths belong to the sender's working directory.
                let argv = launch::resolve_open_args_against_cwd(argv, &cwd);
                // Invalidate extract warm-idle before the deferred main-thread
                // dispatch so an in-flight idle-exit cannot destroy the window
                // that this second-instance open is about to reuse.
                launch::bump_extract_warm_idle_generation();
                // Window creation from the single-instance callback can deadlock
                // WebView2 on Windows. Dispatch after the callback returns.
                let dispatch_handle = app.clone();
                std::thread::spawn(move || {
                    let callback_handle = dispatch_handle.clone();
                    let _ = dispatch_handle.run_on_main_thread(move || {
                        emit_open_paths(&callback_handle, argv);
                    });
                });
            }));
        }
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    // Launch activation runs before setup, so the background flag must reach the builder.
    #[cfg(all(feature = "e2e", target_os = "macos"))]
    if launch::e2e_background() {
        builder = builder.activate_ignoring_other_apps(false);
    }

    let app = builder
        .manage(InitialPaths(Mutex::new(initial_paths.clone())))
        .manage(InitialMode(Mutex::new(initial_mode.clone())))
        .manage(ExtractQueue(Mutex::new(HashMap::new())))
        .manage(ExtractOpenAllowlist(Mutex::new(HashMap::new())))
        .manage(ExtractBoundDestination(Mutex::new(HashMap::new())))
        .manage(OpenPathAllowlist::default())
        .manage(PendingPaths(Mutex::new(Vec::new())))
        .manage(LogFileLock(Mutex::new(())))
        .manage(RunningProcess::new())
        .setup(move |app| {
            #[cfg(all(feature = "e2e", target_os = "macos"))]
            if launch::e2e_background() {
                // No Dock icon and no activation, so E2E launches never steal focus.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            // Primary instance only reaches setup. Resolve shell handoffs here
            // (and in emit_open_paths); collect_cli_context must not consume them
            // or warm-start Explorer selections are deleted by the secondary.
            let (initial_paths, initial_mode) = {
                let resolved = launch::resolve_cli_context_with_handoffs();
                if let Ok(mut paths) = app.state::<InitialPaths>().0.lock() {
                    *paths = resolved.0.clone();
                }
                if let Ok(mut mode) = app.state::<InitialMode>().0.lock() {
                    *mode = resolved.1.clone();
                }
                resolved
            };

            #[cfg(target_os = "macos")]
            let finder_sync_routed = finder_sync_requests::route_pending_requests(app.handle());
            #[cfg(not(target_os = "macos"))]
            let finder_sync_routed = false;

            let launch_extract_window = initial_mode == "extract" && initial_paths.len() == 1;

            if finder_sync_routed {
                // The queued request already created the appropriate Extract or
                // Compress UI. Do not race it with the empty-launch fallback.
            } else if launch_extract_window {
                spawn_extract_window(app.handle(), initial_paths.clone())
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
                // Extract-only never mounts main, so get_initial_paths would not
                // consume these. Clear them now or a later warm main reopen would
                // re-apply the same archive into the workspace.
                if let Ok(mut paths) = app.state::<InitialPaths>().0.lock() {
                    paths.clear();
                }
                if let Ok(mut mode) = app.state::<InitialMode>().0.lock() {
                    *mode = String::new();
                }
            } else if cfg!(target_os = "macos") && initial_paths.is_empty() {
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
                    *guard = Some(tx);
                }
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                        rx.recv_timeout(std::time::Duration::from_millis(150))
                    {
                        if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
                            guard.take();
                        }
                        let main_thread_handle = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            // Re-check on the main thread: Services may have claimed
                            // extract-only or already opened a real main (Compress)
                            // after the timeout fired.
                            if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst)
                                || has_extract_windows(&main_thread_handle)
                                || main_thread_handle.get_webview_window("main").is_some()
                            {
                                return;
                            }
                            MAC_FALLBACK_MAIN_PENDING.store(true, Ordering::SeqCst);
                            if let Err(e) = show_main_window(&main_thread_handle) {
                                // Do not leave PENDING stuck: a later Extract would
                                // treat any surviving main as disposable fallback.
                                MAC_FALLBACK_MAIN_PENDING.store(false, Ordering::SeqCst);
                                eprintln!("Failed to open main window: {e}");
                            }
                        });
                    }
                });
            } else {
                show_main_window(app.handle())
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            }

            if let Err(e) = app_menu::install_macos_app_menu(app.handle()) {
                eprintln!("Failed to install macOS app menu: {e}");
            }

            #[cfg(target_os = "macos")]
            {
                macos_services::install_macos_services(app.handle());
                finder_sync_requests::start_request_monitor(app.handle().clone());
                // pluginkit can take several seconds when Launch Services is
                // unhealthy. Registration is best-effort, so keep it off the
                // setup/main thread and show the first window without waiting.
                if production_integrations_enabled() && !platform::running_from_app_translocation()
                {
                    std::thread::spawn(platform::register_macos_finder_sync);
                }
            }

            // Recovery can traverse and sync directories. Keep it off the setup thread so the
            // first window appears immediately. `run_7z` takes the same recovery lock before any
            // new operation, so a fast user action cannot race an interrupted transaction.
            let maintenance_handle = app.handle().clone();
            std::thread::spawn(move || {
                let recovered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if let Err(failure) =
                        process::recover_interrupted_transaction(&maintenance_handle)
                    {
                        eprintln!(
                            "Failed to recover an interrupted archive transaction: {failure}"
                        );
                        process::set_startup_recovery_error(Some(failure));
                    } else {
                        process::set_startup_recovery_error(None);
                        if let Err(e) = process::cleanup_orphan_stages(&maintenance_handle) {
                            eprintln!("Failed to clean orphan staging directories: {e}");
                        }
                    }
                }));
                if recovered.is_err() {
                    eprintln!("Startup recovery panicked; unblocking archive operations.");
                    process::set_startup_recovery_error(Some(process::RecoveryFailure::error(
                        "Startup recovery failed unexpectedly.",
                    )));
                }
                // Unblock run_7z before temp cleanup; recovery is what must be serialized.
                process::mark_startup_recovery_done();
                if let Err(e) = tempdir::cleanup_stale_temp_dirs(&maintenance_handle) {
                    eprintln!("Failed to clean stale conversion directories: {e}");
                }
                tempdir::sweep_stale_launch_temp_files();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            process::run_7z,
            process::cancel_7z,
            process::is_7z_running,
            process::probe_7z,
            process::archive_output_selection_token,
            process::get_startup_recovery_status,
            process::acknowledge_preserved_transaction,
            archive_detect::validate_archive_paths,
            settings_store::load_settings,
            settings_store::save_settings,
            settings_store::reset_settings,
            logging::append_local_log,
            logging::get_log_dir,
            logging::export_logs,
            logging::clear_logs,
            logging::open_log_dir,
            launch::open_path,
            launch::register_extract_open_path,
            launch::get_initial_paths,
            launch::get_initial_mode,
            launch::get_shell_handoff_error,
            launch::drain_pending_paths,
            launch::get_extract_paths,
            launch::inspect_extract_destination,
            launch::close_extract_window,
            launch::choose_extract_destination,
            launch::open_debug_console_window,
            launch::close_debug_console_window,
            launch::relay_debug_console_line,
            launch::relay_debug_console_seed,
            launch::relay_debug_console_clear,
            launch::relay_debug_console_signal,
            launch::debug_console_window_open,
            launch::mark_main_window_ready,
            platform::get_platform_info,
            platform::get_beta_updater_target,
            platform::relaunch_app,
            platform::get_os_integration_status,
            platform::open_os_integration_settings,
            platform::open_finder_services_settings,
            platform::open_finder_sync_settings,
            platform::enable_finder_sync,
            platform::reset_preferred_archiver_to_system,
            platform::set_zinnia_default_archiver,
            platform::get_cpu_count,
            platform::is_flatpak,
            platform::is_packaged,
            tempdir::reserve_temp_extract_path,
            tempdir::remove_managed_temp_dir,
            tempdir::list_managed_temp_children,
            window_fx::set_workspace_window_fx,
            window_fx::supports_workspace_window_fx
        ])
        .build(tauri::generate_context!())
        .expect("failed to initialize Tauri application");

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if defer_exit_while_operation_finishes(app_handle, &api) {
                return;
            }
            // Stay resident after quick-extract so the next file association is warm.
            if !exit_forced()
                && should_keep_extract_warm(app_handle)
                && enter_extract_warm_idle(app_handle)
            {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Opened { urls } => {
            // Finder may hand the file to us just as the warm-idle timer is
            // exiting. Invalidate any armed timer before routing the open.
            launch::bump_extract_warm_idle_generation();
            emit_open_urls(app_handle, urls);
        }
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            #[cfg(target_os = "macos")]
            if finder_sync_requests::route_pending_requests(app_handle) {
                return;
            }
            if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                if let Some(extract_window) = first_extract_window(app_handle) {
                    launch::restore_foreground_activation(app_handle);
                    let _ = extract_window.show();
                    if launch::window_may_take_focus() {
                        let _ = extract_window.set_focus();
                    }
                } else {
                    // Dock/Spotlight activate while warm-idle: open the full app.
                    EXTRACT_ONLY_LAUNCH.store(false, Ordering::SeqCst);
                    leave_extract_warm(app_handle);
                    if let Err(e) = show_main_window(app_handle) {
                        eprintln!("Failed to reopen main window: {e}");
                    }
                }
            } else if !has_visible_windows {
                if let Err(e) = show_main_window(app_handle) {
                    eprintln!("Failed to reopen main window: {e}");
                }
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            defer_close_while_operation_finishes(app_handle, &label, &api);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            if label == "main" {
                MAC_FALLBACK_MAIN_PENDING.store(false, Ordering::SeqCst);
                launch::MAIN_WINDOW_READY.store(false, Ordering::SeqCst);
            }
            if launch::is_extract_window_label(&label) {
                launch::clear_extract_window_bindings(app_handle, &label);
            }
            if !exit_forced() && should_keep_extract_warm(app_handle) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                let _ = enter_extract_warm_idle(app_handle);
            }
        }
        _ => {}
    });

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if defer_exit_while_operation_finishes(app_handle, api) {
                return;
            }
            if !exit_forced()
                && should_keep_extract_warm(app_handle)
                && enter_extract_warm_idle(app_handle)
            {
                api.prevent_exit();
                return;
            }
        }
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = &event
        {
            if defer_close_while_operation_finishes(app_handle, label, api) {
                return;
            }
        }
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            if label == "main" {
                MAC_FALLBACK_MAIN_PENDING.store(false, Ordering::SeqCst);
                launch::MAIN_WINDOW_READY.store(false, Ordering::SeqCst);
            }
            if launch::is_extract_window_label(label) {
                launch::clear_extract_window_bindings(app_handle, label);
            }
            if !exit_forced() && should_keep_extract_warm(app_handle) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                let _ = enter_extract_warm_idle(app_handle);
            }
        }
    });
}

#[cfg(test)]
mod exit_gate_tests {
    use super::{should_defer_close, should_prevent_exit, SlotFacts};

    fn facts(owner: Option<&str>, update_reserved: bool, user_run: bool, busy: bool) -> SlotFacts {
        SlotFacts {
            owner: owner.map(str::to_string),
            update_reserved,
            user_run,
            busy,
        }
    }

    fn idle() -> SlotFacts {
        facts(None, false, false, false)
    }

    fn running_child() -> SlotFacts {
        facts(Some("main"), false, true, true)
    }

    fn update_held() -> SlotFacts {
        facts(None, true, false, true)
    }

    fn cancelling_without_owner() -> SlotFacts {
        facts(None, false, false, true)
    }

    #[test]
    fn idle_slot_lets_exit_proceed() {
        assert!(!should_prevent_exit(&idle(), false));
    }

    #[test]
    fn running_child_defers_exit_until_forced() {
        assert!(should_prevent_exit(&running_child(), false));
    }

    #[test]
    fn update_reservation_defers_exit_when_not_forced() {
        assert!(should_prevent_exit(&update_held(), false));
    }

    #[test]
    fn busy_without_owner_defers_exit_when_not_forced() {
        assert!(should_prevent_exit(&cancelling_without_owner(), false));
    }

    #[test]
    fn forced_exit_proceeds_with_running_child() {
        assert!(!should_prevent_exit(&running_child(), true));
    }

    #[test]
    fn forced_exit_proceeds_with_cancelling_slot_and_no_owner() {
        assert!(!should_prevent_exit(&cancelling_without_owner(), true));
    }

    #[test]
    fn forced_exit_proceeds_with_update_reservation() {
        assert!(!should_prevent_exit(&update_held(), true));
    }

    #[test]
    fn owner_busy_close_defers_when_not_forced() {
        assert!(should_defer_close(&running_child(), "main", false));
    }

    #[test]
    fn forced_close_of_busy_owner_is_not_deferred() {
        assert!(!should_defer_close(&running_child(), "main", true));
    }

    #[test]
    fn close_of_a_window_that_owns_nothing_is_never_deferred() {
        assert!(!should_defer_close(&running_child(), "extract-0", false));
        assert!(!should_defer_close(&idle(), "main", false));
    }
}
