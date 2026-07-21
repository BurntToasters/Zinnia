//! Finder Services provider (Extract / Compress with Zinnia).

#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, ClassType, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSPasteboard, NSUpdateDynamicServices};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString, NSURL};
use tauri::{AppHandle, Manager};

use crate::launch::{
    emit_open_paths, show_main_window, EXTRACT_ONLY_LAUNCH, FILE_OPEN_SIGNAL,
    MAC_FALLBACK_MAIN_PENDING,
};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

struct ServiceIvars;

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ZinniaServicesProvider"]
    #[ivars = ServiceIvars]
    struct ZinniaServicesProvider;

    impl ZinniaServicesProvider {
        #[unsafe(method(extractWithZinnia:userData:error:))]
        fn _extract(
            &self,
            pasteboard: Option<&NSPasteboard>,
            _user_data: Option<&NSString>,
            _error: *mut *mut AnyObject,
        ) {
            handle_service(pasteboard, "extract");
        }

        #[unsafe(method(compressWithZinnia:userData:error:))]
        fn _compress(
            &self,
            pasteboard: Option<&NSPasteboard>,
            _user_data: Option<&NSString>,
            _error: *mut *mut AnyObject,
        ) {
            handle_service(pasteboard, "compress");
        }
    }

    unsafe impl NSObjectProtocol for ZinniaServicesProvider {}
);

fn handle_service(pasteboard: Option<&NSPasteboard>, mode: &str) {
    let Some(app) = APP_HANDLE.get() else {
        eprintln!("Zinnia Services: app handle not ready");
        return;
    };
    let Some(pb) = pasteboard else {
        return;
    };

    let paths = match read_paths_from_pasteboard(pb) {
        Ok(paths) if !paths.is_empty() => paths,
        Ok(_) => return,
        Err(err) => {
            eprintln!("Zinnia Services: {err}");
            return;
        }
    };

    let mut argv = vec!["zinnia".to_string()];
    match mode {
        "extract" => argv.push("--extract".to_string()),
        "compress" => argv.push("--compress".to_string()),
        _ => {}
    }
    argv.extend(paths);

    // Compress needs the main workspace. Extract must NOT show main first —
    // that would defeat extract-only / quick-extract routing in launch.rs.
    if mode == "extract" {
        // Claim extract-only before any queued main-thread fallback runs, and
        // cancel the cold-start 150ms timer if it is still waiting.
        EXTRACT_ONLY_LAUNCH.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        // If the fallback already opened main, hide it immediately to avoid a flash.
        // Leave MAC_FALLBACK_MAIN_PENDING set so route_open_request still treats it
        // as a fallback window and destroys it (not as a user workspace).
        if MAC_FALLBACK_MAIN_PENDING.load(Ordering::SeqCst) {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
        }
    } else if mode == "compress" {
        // Cancel cold-start fallback so it cannot later mark this real main as
        // a disposable fallback window (and get destroyed by a later Extract).
        if let Ok(mut guard) = FILE_OPEN_SIGNAL.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        MAC_FALLBACK_MAIN_PENDING.store(false, Ordering::SeqCst);
        if let Err(err) = show_main_window(app) {
            eprintln!("Zinnia Services: failed to show main window: {err}");
        }
    }
    emit_open_paths(app, argv);
}

fn read_paths_from_pasteboard(pasteboard: &NSPasteboard) -> Result<Vec<String>, String> {
    unsafe {
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let objects = pasteboard
            .readObjectsForClasses_options(&classes, None)
            .ok_or_else(|| "no file URLs on pasteboard".to_string())?;

        let mut paths = Vec::new();
        for obj in objects.iter() {
            let url = obj
                .downcast_ref::<NSURL>()
                .ok_or_else(|| "pasteboard item was not NSURL".to_string())?;
            let Some(ns_path) = url.path() else {
                continue;
            };
            let utf8 = ns_path.UTF8String();
            if utf8.is_null() {
                return Err("path could not be represented as UTF-8".to_string());
            }
            let c_str = CStr::from_ptr(utf8);
            let path = c_str
                .to_str()
                .map_err(|_| "path was not valid UTF-8".to_string())?;
            if !path.is_empty() {
                paths.push(path.to_string());
            }
        }
        Ok(paths)
    }
}

/// Register the Finder Services provider for Extract / Compress.
pub fn install_macos_services(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());

    let Some(mtm) = objc2::MainThreadMarker::new() else {
        eprintln!("Zinnia Services: must install on the main thread");
        return;
    };

    let provider = ZinniaServicesProvider::alloc(mtm).set_ivars(ServiceIvars);
    let provider: Retained<ZinniaServicesProvider> = unsafe { msg_send![super(provider), init] };

    let ns_app = NSApplication::sharedApplication(mtm);
    unsafe {
        let as_any: &AnyObject =
            &*((&*provider) as *const ZinniaServicesProvider as *const AnyObject);
        ns_app.setServicesProvider(Some(as_any));
    }
    // Keep the provider alive for the process lifetime.
    std::mem::forget(provider);
    NSUpdateDynamicServices();
}
