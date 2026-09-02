#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
mod settings_store;
mod tempdir;
mod validation;
mod window_fx;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::Manager;

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

#[cfg(feature = "e2e")]
fn e2e_session_active() -> bool {
    std::env::var("ZINNIA_E2E").is_ok_and(|value| value == "1")
}

fn production_integrations_enabled() -> bool {
    #[cfg(feature = "e2e")]
    {
        !e2e_session_active()
    }
    #[cfg(not(feature = "e2e"))]
    {
        true
    }
}

fn defer_close_while_operation_finishes(
    app: &tauri::AppHandle,
    label: &str,
    api: &tauri::CloseRequestApi,
) -> bool {
    let state = app.state::<RunningProcess>();
    let owns_busy_operation = state.0.lock().map_or(true, |mut process| {
        process.expire_stale_update_reservation();
        process.owner_label.as_deref() == Some(label)
            && (process.child.is_some()
                || process.preparing
                || process.cancelling
                || process.blocks_quit_for_update_install())
    });
    if !owns_busy_operation {
        if launch::is_extract_window_label(label) {
            launch::clear_extract_window_bindings(app, label);
        }
        return false;
    }

    api.prevent_close();
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
                if let Err(error) = process::terminate_child(&child) {
                    eprintln!("Could not stop archive process during forced exit: {error}");
                    let mut process = match state.0.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    process.cancelling = true;
                    if process.child.is_none() {
                        process.child = Some(child);
                    }
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
        app.exit(0);
    });
}

fn defer_exit_while_operation_finishes(
    app: &tauri::AppHandle,
    api: &tauri::ExitRequestApi,
) -> bool {
    let state = app.state::<RunningProcess>();
    let owner = match state.0.lock() {
        Ok(mut process) => {
            // An update reservation has no child to cancel. Do not mistake a
            // user/system Quit during installation for the later updater
            // relaunch. The frontend releases this reservation immediately
            // before calling relaunch; until then, keep the process alive.
            process.expire_stale_update_reservation();
            if process.blocks_quit_for_update_install() {
                api.prevent_exit();
                return true;
            }
            if process.child.is_some() || process.preparing || process.cancelling {
                process.owner_label.clone()
            } else {
                return false;
            }
        }
        Err(poisoned) => {
            let mut process = poisoned.into_inner();
            process.expire_stale_update_reservation();
            if process.blocks_quit_for_update_install() {
                api.prevent_exit();
                return true;
            }
            if process.child.is_some() || process.preparing || process.cancelling {
                process.owner_label.clone()
            } else {
                return false;
            }
        }
    };
    api.prevent_exit();
    let Some(owner) = owner else {
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
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _| {
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
                if production_integrations_enabled() {
                    std::thread::spawn(platform::register_macos_finder_sync);
                }
            }

            // Recovery can traverse and sync directories. Keep it off the setup thread so the
            // first window appears immediately. `run_7z` takes the same recovery lock before any
            // new operation, so a fast user action cannot race an interrupted transaction.
            let maintenance_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = process::recover_interrupted_transaction(&maintenance_handle) {
                    eprintln!("Failed to recover an interrupted archive transaction: {e}");
                    process::set_startup_recovery_error(Some(e));
                } else {
                    process::set_startup_recovery_error(None);
                    if let Err(e) = process::cleanup_orphan_stages(&maintenance_handle) {
                        eprintln!("Failed to clean orphan staging directories: {e}");
                    }
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
            process::probe_compress_inputs,
            process::archive_output_selection_token,
            process::get_startup_recovery_status,
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
            launch::close_extract_window,
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
            tempdir::create_temp_extract_dir,
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
            if should_keep_extract_warm(app_handle) && enter_extract_warm_idle(app_handle) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Opened { urls } => {
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
                    let _ = extract_window.set_focus();
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
            if should_keep_extract_warm(app_handle) {
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
            if should_keep_extract_warm(app_handle) && enter_extract_warm_idle(app_handle) {
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
            if should_keep_extract_warm(app_handle) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                let _ = enter_extract_warm_idle(app_handle);
            }
        }
    });
}
