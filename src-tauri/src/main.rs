#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_menu;
mod archive_detect;
mod fs_secure;
mod launch;
#[cfg(target_os = "macos")]
mod macos_services;
mod logging;
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
    collect_cli_context, emit_open_paths, emit_open_urls, enter_extract_warm_idle,
    first_extract_window, has_extract_windows, leave_extract_warm, should_keep_extract_warm,
    show_main_window, spawn_extract_window, ExtractBoundDestination, ExtractOpenAllowlist,
    ExtractQueue, InitialMode, InitialPaths, OpenPathAllowlist, PendingPaths, EXTRACT_ONLY_LAUNCH,
    FILE_OPEN_SIGNAL, MAC_FALLBACK_MAIN_PENDING,
};
use logging::LogFileLock;
use process::RunningProcess;

fn defer_close_while_operation_finishes(
    app: &tauri::AppHandle,
    label: &str,
    api: &tauri::CloseRequestApi,
) -> bool {
    let state = app.state::<RunningProcess>();
    let owns_busy_operation = state.0.lock().map_or(true, |process| {
        process.owner_label.as_deref() == Some(label)
            && (process.child.is_some() || process.preparing || process.cancelling)
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
            let mut process = match state.0.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            if let Some(child) = process.child.take() {
                if let Err(error) = child.kill() {
                    eprintln!("Could not stop archive process during forced exit: {error}");
                }
            }
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
        Ok(process) if process.child.is_some() || process.preparing || process.cancelling => {
            process.owner_label.clone()
        }
        Ok(_) => return false,
        Err(poisoned) => {
            let process = poisoned.into_inner();
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

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
                // Window creation from the single-instance callback can deadlock
                // WebView2 on Windows. Dispatch after the callback returns.
                let dispatch_handle = app.clone();
                std::thread::spawn(move || {
                    let callback_handle = dispatch_handle.clone();
                    let _ = dispatch_handle.run_on_main_thread(move || {
                        emit_open_paths(&callback_handle, argv);
                    });
                });
            }))
            .plugin(tauri_plugin_updater::Builder::new().build());
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
            let launch_extract_window = initial_mode == "extract" && initial_paths.len() == 1;

            if launch_extract_window {
                spawn_extract_window(app.handle(), initial_paths.clone())
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
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
                            if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst)
                                && !has_extract_windows(&main_thread_handle)
                            {
                                MAC_FALLBACK_MAIN_PENDING.store(true, Ordering::SeqCst);
                                if let Err(e) = show_main_window(&main_thread_handle) {
                                    eprintln!("Failed to open main window: {e}");
                                }
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
            macos_services::install_macos_services(app.handle());

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
                }
                // Unblock run_7z before temp cleanup; recovery is what must be serialized.
                process::mark_startup_recovery_done();
                if let Err(e) = tempdir::cleanup_stale_temp_dirs(&maintenance_handle) {
                    eprintln!("Failed to clean stale conversion directories: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            process::run_7z,
            process::cancel_7z,
            process::is_7z_running,
            process::probe_7z,
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
            launch::drain_pending_paths,
            launch::get_extract_paths,
            launch::close_extract_window,
            launch::mark_main_window_ready,
            platform::get_platform_info,
            platform::get_os_integration_status,
            platform::open_os_integration_settings,
            platform::open_finder_services_settings,
            platform::reset_preferred_archiver_to_system,
            platform::set_zinnia_default_archiver,
            platform::get_cpu_count,
            platform::is_flatpak,
            platform::is_packaged,
            tempdir::create_temp_extract_dir,
            tempdir::remove_managed_temp_dir,
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
