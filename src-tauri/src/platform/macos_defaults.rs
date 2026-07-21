//! macOS default-handler query/set via NSWorkspace / UTType.

use super::{
    archive_status, ArchiveDefaultStatus, ArchiveDefaultTarget, ARCHIVE_DEFAULT_TARGETS,
    ZINNIA_BUNDLE_ID,
};
use block2::RcBlock;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_uniform_type_identifiers::UTType;

fn uti_for_extension(extension: &str) -> Option<objc2::rc::Retained<UTType>> {
    UTType::typeWithFilenameExtension(&NSString::from_str(extension))
}

#[cfg(test)]
pub fn uti_identifier_for_extension(extension: &str) -> Option<String> {
    uti_for_extension(extension).map(|uti| uti.identifier().to_string())
}

fn current_handler_for_uti(workspace: &NSWorkspace, uti: &UTType) -> Option<String> {
    let application_url = workspace.URLForApplicationToOpenContentType(uti)?;
    let bundle = NSBundle::bundleWithURL(&application_url)?;
    bundle
        .bundleIdentifier()
        .map(|identifier| identifier.to_string())
}

fn query_target(target: ArchiveDefaultTarget, can_change: bool) -> ArchiveDefaultStatus {
    let Some(uti) = uti_for_extension(target.extension) else {
        return archive_status(target, None, can_change, "Unknown file type");
    };
    let workspace = NSWorkspace::sharedWorkspace();
    let current_handler = current_handler_for_uti(&workspace, &uti);
    let status = if current_handler.as_deref() == Some(ZINNIA_BUNDLE_ID) {
        "Default"
    } else {
        "Not default"
    };
    archive_status(target, current_handler, can_change, status)
}

fn set_target(
    target: ArchiveDefaultTarget,
    bundle_id_value: &str,
    changed_status: &str,
    deadline: std::time::Instant,
) -> ArchiveDefaultStatus {
    if std::time::Instant::now() >= deadline {
        return archive_status(
            target,
            None,
            true,
            "Default-app operation reached its overall timeout",
        );
    }
    let Some(uti) = uti_for_extension(target.extension) else {
        return archive_status(target, None, true, "Unknown file type");
    };
    let workspace = NSWorkspace::sharedWorkspace();
    let bundle_id = NSString::from_str(bundle_id_value);
    let Some(application_url) = workspace.URLForApplicationWithBundleIdentifier(&bundle_id)
    else {
        return archive_status(target, None, true, "Installed app bundle not found");
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let completion = RcBlock::new(move |error: *mut NSError| {
        let message = if error.is_null() {
            None
        } else {
            // SAFETY: AppKit guarantees a valid NSError for the duration of
            // the completion callback when the operation fails.
            Some(unsafe { &*error }.localizedDescription().to_string())
        };
        let _ = sender.send(message);
    });
    workspace.setDefaultApplicationAtURL_toOpenContentType_completionHandler(
        &application_url,
        &uti,
        Some(&completion),
    );
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    let completion_error = match receiver.recv_timeout(remaining) {
        Ok(error) => error,
        Err(_) => Some("macOS did not finish the default-app request".to_string()),
    };
    let current_handler = current_handler_for_uti(&workspace, &uti);
    if completion_error.is_none() && current_handler.as_deref() == Some(bundle_id_value) {
        archive_status(target, current_handler, true, changed_status)
    } else {
        archive_status(
            target,
            current_handler,
            true,
            completion_error.unwrap_or_else(|| "Not changed".to_string()),
        )
    }
}

pub(crate) fn query_archive_defaults(can_change: bool) -> Vec<ArchiveDefaultStatus> {
    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .map(|target| query_target(*target, can_change))
        .collect()
}

pub(crate) fn set_archive_defaults() -> Vec<ArchiveDefaultStatus> {
    // Bound the whole operation, rather than allowing every content type
    // to consume a separate timeout interval.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .map(|target| set_target(*target, ZINNIA_BUNDLE_ID, "Default", deadline))
        .collect()
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_query_archive_defaults(can_change: bool) -> Vec<ArchiveDefaultStatus> {
    query_archive_defaults(can_change)
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_set_archive_defaults() -> Vec<ArchiveDefaultStatus> {
    set_archive_defaults()
}
