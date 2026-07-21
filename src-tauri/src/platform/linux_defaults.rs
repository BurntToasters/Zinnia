//! Linux xdg-mime archive default query/set helpers.

#[cfg(target_os = "linux")]
use std::process::Command;

#[cfg(target_os = "linux")]
use super::os_command::command_output_with_timeout;
#[cfg(any(target_os = "linux", test))]
use super::{
    archive_status, ArchiveDefaultStatus, ARCHIVE_DEFAULT_TARGETS, ZINNIA_DESKTOP_ID,
};

#[cfg(any(target_os = "linux", test))]
pub(crate) trait LinuxMimeBackend {
    fn query_default(&self, mime_type: &str) -> Result<Option<String>, String>;
    fn set_default(&mut self, desktop_id: &str, mime_type: &str) -> Result<(), String>;
}

#[cfg(target_os = "linux")]
pub(crate) struct XdgMimeBackend;

#[cfg(target_os = "linux")]
impl LinuxMimeBackend for XdgMimeBackend {
    fn query_default(&self, mime_type: &str) -> Result<Option<String>, String> {
        let output = command_output_with_timeout(
            Command::new("xdg-mime").args(["query", "default", mime_type]),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Unable to run xdg-mime: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value))
        }
    }

    fn set_default(&mut self, desktop_id: &str, mime_type: &str) -> Result<(), String> {
        let output = command_output_with_timeout(
            Command::new("xdg-mime").args(["default", desktop_id, mime_type]),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Unable to run xdg-mime: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "xdg-mime failed without details.".to_string()
            } else {
                stderr
            })
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn linux_query_archive_defaults_parallel(can_change: bool) -> Vec<ArchiveDefaultStatus> {
    let handles: Vec<_> = ARCHIVE_DEFAULT_TARGETS
        .iter()
        .copied()
        .map(|target| {
            std::thread::spawn(move || {
                let backend = XdgMimeBackend;
                match backend.query_default(target.mime_type) {
                    Ok(current_handler) => {
                        let status = if current_handler.as_deref() == Some(ZINNIA_DESKTOP_ID) {
                            "Default"
                        } else {
                            "Not default"
                        };
                        archive_status(target, current_handler, can_change, status)
                    }
                    Err(err) => archive_status(target, None, can_change, err),
                }
            })
        })
        .collect();
    handles
        .into_iter()
        .enumerate()
        .map(|(index, handle)| {
            handle.join().unwrap_or_else(|_| {
                archive_status(
                    ARCHIVE_DEFAULT_TARGETS[index],
                    None,
                    can_change,
                    "xdg-mime query worker failed",
                )
            })
        })
        .collect()
}

#[cfg(test)]
fn linux_query_archive_defaults<B: LinuxMimeBackend>(
    backend: &B,
    can_change: bool,
) -> Vec<ArchiveDefaultStatus> {
    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .map(|target| match backend.query_default(target.mime_type) {
            Ok(current_handler) => {
                let status = if current_handler.as_deref() == Some(ZINNIA_DESKTOP_ID) {
                    "Default"
                } else {
                    "Not default"
                };
                archive_status(*target, current_handler, can_change, status)
            }
            Err(err) => archive_status(*target, None, can_change, err),
        })
        .collect()
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_set_archive_defaults<B: LinuxMimeBackend>(backend: &mut B) -> Vec<ArchiveDefaultStatus> {
    ARCHIVE_DEFAULT_TARGETS
        .iter()
        .map(
            |target| match backend.set_default(ZINNIA_DESKTOP_ID, target.mime_type) {
                Ok(()) => match backend.query_default(target.mime_type) {
                    Ok(current_handler) => {
                        let status = if current_handler.as_deref() == Some(ZINNIA_DESKTOP_ID) {
                            "Default"
                        } else {
                            "Not changed"
                        };
                        archive_status(*target, current_handler, true, status)
                    }
                    Err(err) => archive_status(*target, None, true, err),
                },
                Err(err) => archive_status(*target, None, true, err),
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    struct FakeLinuxMimeBackend {
        defaults: RefCell<HashMap<String, String>>,
        set_failures: HashMap<String, String>,
        query_failures: HashMap<String, String>,
        set_calls: RefCell<Vec<(String, String)>>,
    }

    impl FakeLinuxMimeBackend {
        fn new() -> Self {
            Self {
                defaults: RefCell::new(HashMap::new()),
                set_failures: HashMap::new(),
                query_failures: HashMap::new(),
                set_calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl LinuxMimeBackend for FakeLinuxMimeBackend {
        fn query_default(&self, mime_type: &str) -> Result<Option<String>, String> {
            if let Some(err) = self.query_failures.get(mime_type) {
                return Err(err.clone());
            }
            Ok(self.defaults.borrow().get(mime_type).cloned())
        }

        fn set_default(&mut self, desktop_id: &str, mime_type: &str) -> Result<(), String> {
            self.set_calls
                .borrow_mut()
                .push((desktop_id.to_string(), mime_type.to_string()));
            if let Some(err) = self.set_failures.get(mime_type) {
                return Err(err.clone());
            }
            self.defaults
                .borrow_mut()
                .insert(mime_type.to_string(), desktop_id.to_string());
            Ok(())
        }
    }

    #[test]
    fn linux_default_query_marks_zinnia_defaults() {
        let backend = FakeLinuxMimeBackend::new();
        backend
            .defaults
            .borrow_mut()
            .insert("application/zip".to_string(), ZINNIA_DESKTOP_ID.to_string());

        let defaults = linux_query_archive_defaults(&backend, true);
        let zip = defaults.iter().find(|entry| entry.key == "zip").unwrap();
        let txz = defaults.iter().find(|entry| entry.key == "txz").unwrap();
        let rar = defaults.iter().find(|entry| entry.key == "rar").unwrap();

        assert!(zip.is_default);
        assert_eq!(zip.current_handler.as_deref(), Some(ZINNIA_DESKTOP_ID));
        assert_eq!(txz.mime_type, "application/x-xz-compressed-tar");
        assert!(!rar.is_default);
        assert!(rar.can_change);
    }

    #[test]
    fn linux_set_defaults_records_partial_failures() {
        let mut backend = FakeLinuxMimeBackend::new();
        backend.set_failures.insert(
            "application/vnd.rar".to_string(),
            "policy rejected".to_string(),
        );

        let results = linux_set_archive_defaults(&mut backend);
        let zip = results.iter().find(|entry| entry.key == "zip").unwrap();
        let rar = results.iter().find(|entry| entry.key == "rar").unwrap();

        assert!(zip.is_default);
        assert_eq!(rar.status, "policy rejected");
        assert!(!rar.is_default);
        assert_eq!(
            backend.set_calls.borrow().len(),
            ARCHIVE_DEFAULT_TARGETS.len()
        );
    }
}
