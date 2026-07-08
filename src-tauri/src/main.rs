#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive_detect;
mod launch;
mod logging;
mod output;
mod platform;
mod process;
mod progress;
mod settings_store;
mod tempdir;
mod validation;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::Manager;

use launch::{
    collect_cli_context, emit_open_paths, emit_open_urls, first_extract_window,
    has_extract_windows, spawn_extract_window, ExtractQueue, InitialMode, InitialPaths,
    PendingPaths, EXTRACT_ONLY_LAUNCH, FILE_OPEN_SIGNAL,
};
use logging::LogFileLock;
use process::RunningProcess;

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
                emit_open_paths(app, argv);
            }))
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .manage(InitialPaths(Mutex::new(initial_paths.clone())))
        .manage(InitialMode(Mutex::new(initial_mode.clone())))
        .manage(ExtractQueue(Mutex::new(HashMap::new())))
        .manage(PendingPaths(Mutex::new(Vec::new())))
        .manage(LogFileLock(Mutex::new(())))
        .manage(RunningProcess::new())
        .setup(move |app| {
            let launch_extract_window = initial_mode == "extract" && !initial_paths.is_empty();

            if launch_extract_window {
                spawn_extract_window(app.handle(), initial_paths.clone())
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
            } else if cfg!(target_os = "macos") && initial_paths.is_empty() {
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
                    *guard = Some(tx);
                }
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                        rx.recv_timeout(std::time::Duration::from_millis(750))
                    {
                        if !EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst)
                            && !has_extract_windows(&handle)
                        {
                            if let Some(main_window) = handle.get_webview_window("main") {
                                let _ = main_window.show();
                                let _ = main_window.set_focus();
                            }
                        }
                    }
                });
            } else if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            process::run_7z,
            process::cancel_7z,
            process::probe_7z,
            archive_detect::validate_archive_paths,
            settings_store::load_settings,
            settings_store::save_settings,
            logging::append_local_log,
            logging::get_log_dir,
            logging::export_logs,
            logging::clear_logs,
            logging::open_log_dir,
            launch::open_path,
            launch::get_initial_paths,
            launch::get_initial_mode,
            launch::drain_pending_paths,
            launch::get_extract_paths,
            launch::close_extract_window,
            platform::get_platform_info,
            platform::get_os_integration_status,
            platform::open_os_integration_settings,
            platform::reset_preferred_archiver_to_system,
            platform::set_zinnia_default_archiver,
            platform::get_cpu_count,
            platform::is_flatpak,
            platform::is_packaged,
            tempdir::create_temp_extract_dir,
            tempdir::remove_managed_temp_dir
        ])
        .build(tauri::generate_context!())
        .expect("failed to initialize Tauri application");

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Opened { urls } => {
            emit_open_urls(app_handle, urls);
        }
        tauri::RunEvent::Reopen { .. } => {
            if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                if let Some(extract_window) = first_extract_window(app_handle) {
                    let _ = extract_window.show();
                    let _ = extract_window.set_focus();
                } else {
                    app_handle.exit(0);
                }
            }
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) && !has_extract_windows(app_handle) => {
            if let Some(main_window) = app_handle.get_webview_window("main") {
                let _ = main_window.destroy();
            }
            app_handle.exit(0);
        }
        _ => {}
    });

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    app.run(|app_handle, event| {
        if let tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } = event
        {
            if EXTRACT_ONLY_LAUNCH.load(Ordering::SeqCst) && !has_extract_windows(app_handle) {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.destroy();
                }
                app_handle.exit(0);
            }
        }
    });
}
