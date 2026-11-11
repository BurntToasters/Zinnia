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
const MAX_PATHS_PER_REQUEST: usize = 1_000;

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

    // SAFETY: the class inherits from NSObject, which already implements NSObjectProtocol, so the
    // impl adds no methods.
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

    // Compress needs the main workspace. Extract must NOT show main first;
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
    // SAFETY: AppKit calls this on the main thread with a valid NSPasteboard. `classes` is an
    // NSArray holding only the NSURL class. Each `obj` returned by readObjectsForClasses is
    // retained for its loop iteration. `ns_path` owns the UTF8String buffer, which is read only
    // while `ns_path` is alive, and it is copied into an owned String.
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
            // A web or custom-scheme URL has a `path()` too (`http://h/etc/x`
            // gives `/etc/x`), which must never be routed as a local path.
            if !url.isFileURL() {
                continue;
            }
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
                // Reject as soon as the cap is passed instead of converting
                // the rest of an arbitrarily large selection first.
                if paths.len() > MAX_PATHS_PER_REQUEST {
                    return Err(format!(
                        "Finder Services selection exceeds {MAX_PATHS_PER_REQUEST} paths."
                    ));
                }
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
    // SAFETY: `provider` is a freshly allocated instance with its ivars set. `init` is an
    // init-family method that returns an owned (+1) object, which Retained takes ownership of.
    // `super(provider)` sends init to NSObject's implementation.
    let provider: Retained<ZinniaServicesProvider> = unsafe { msg_send![super(provider), init] };

    let ns_app = NSApplication::sharedApplication(mtm);
    // SAFETY: `provider` is a live retained ZinniaServicesProvider. Every Objective-C object is a
    // valid AnyObject, so the reference cast is valid. The provider is leaked below, so the pointer
    // stays valid for the process lifetime.
    unsafe {
        let as_any: &AnyObject =
            &*((&*provider) as *const ZinniaServicesProvider as *const AnyObject);
        ns_app.setServicesProvider(Some(as_any));
    }
    // Keep the provider alive for the process lifetime.
    std::mem::forget(provider);
    NSUpdateDynamicServices();
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardType, NSPasteboardWriting};

    fn item(url: &str) -> Retained<NSPasteboardItem> {
        let item = NSPasteboardItem::new();
        let kind: &NSPasteboardType = if url.starts_with("file:") {
            // public.file-url
            // SAFETY: reads an immutable AppKit string constant that is valid for the process.
            unsafe { objc2_app_kit::NSPasteboardTypeFileURL }
        } else {
            // public.url
            // SAFETY: reads an immutable AppKit string constant that is valid for the process.
            unsafe { objc2_app_kit::NSPasteboardTypeURL }
        };
        assert!(item.setString_forType(&NSString::from_str(url), kind));
        item
    }

    fn pasteboard_with(urls: &[&str]) -> Retained<NSPasteboard> {
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        pasteboard.clearContents();
        let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = urls
            .iter()
            .map(|url| ProtocolObject::from_retained(item(url)))
            .collect();
        let array = NSArray::from_retained_slice(&items);
        assert!(pasteboard.writeObjects(&array), "pasteboard rejected items");
        pasteboard
    }

    #[test]
    fn pasteboard_reader_keeps_file_urls_and_skips_other_schemes() {
        let pasteboard = pasteboard_with(&[
            "file:///tmp/zinnia-services-a.zip",
            "http://example.invalid/etc/passwd",
            "file:///tmp/zinnia-services-b.7z",
        ]);
        let paths = read_paths_from_pasteboard(&pasteboard).expect("file URLs are accepted");
        assert_eq!(
            paths,
            vec![
                "/tmp/zinnia-services-a.zip".to_string(),
                "/tmp/zinnia-services-b.7z".to_string()
            ],
            "a non-file URL must be skipped, not turned into a local path"
        );
    }

    #[test]
    fn pasteboard_reader_rejects_a_selection_over_the_cap() {
        let urls: Vec<String> = (0..=MAX_PATHS_PER_REQUEST)
            .map(|index| format!("file:///tmp/zinnia-services-{index}.zip"))
            .collect();
        let refs: Vec<&str> = urls.iter().map(String::as_str).collect();
        let pasteboard = pasteboard_with(&refs);
        let error = read_paths_from_pasteboard(&pasteboard).expect_err("cap exceeded");
        assert!(error.contains("exceeds"), "unexpected error: {error}");
    }
}
