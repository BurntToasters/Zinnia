# AppImage replacement failure modes

Each entry lists a way the replacement of the installed AppImage could fail, and the outcome the code must produce. The helper `replace_file_atomically` in `src/install_safety.rs` and `install_appimage` in `src/updater.rs` must meet all of them.

- Write error part way through a raw AppImage write: the closure returns an error, the original file keeps its exact original bytes, and the staged file is removed.
- Write error part way through a tar.gz entry copy (`std::io::copy` into the staged file): same outcome as a raw write error. The original bytes survive and the staged file is removed.
- Archive with no AppImage entry: `install_appimage` returns the existing `BinaryNotFoundInArchive` error. The helper is never invoked, so the original file is untouched and no staged file is created.
- Destination parent directory does not exist: the helper returns an error before creating anything. Nothing is created and the write closure is never called.
- Failure during the `sync_all` or the permission copy: the staged file is removed and the original is byte-identical.
- Failure at the final rename (persist), for example the destination is a directory: the staged file is removed and the destination is unchanged.
- No staged leftovers after a failure: the directory holds only the entries it held before the call.
- No staged leftovers after success: the staged file is renamed onto the destination, so only the new content remains.
- Success replaces content exactly: after success the destination bytes equal the bytes the closure wrote, with no trailing or partial data from the old file.
- Unix mode of the original is preserved: the staged file takes the destination's permissions before the rename, so an executable AppImage stays executable.
- Destination does not exist yet: the helper creates it with the staged content and copies no permissions.
- Process killed before the rename: the staged file is a hidden leftover, and the original path still holds the complete old AppImage, so it stays launchable. The rename is the only operation that mutates the live path, so an interruption at any earlier point leaves the live file untouched.
- Process killed after the rename: the live path holds the complete new file, because the rename is atomic on the same filesystem.

## macOS update version and backup failure modes

Each entry lists a way the macOS update could fail, and the outcome the code must produce. The build check uses `payload_build_is_newer` and `macos_plist_build_version` in `src/install_safety.rs`. The backup handling uses `recover_macos_app_backups` in the same file, and `install_inner` in `src/updater.rs` must call it.

- Older same-series beta is accepted: a payload with build `0.7.3002` over an installed `0.7.3003` has the same marketing version, so the build check must refuse it.
- Equal build is reinstalled: a payload with the same build as the installed copy is refused.
- Stable and beta ordering is wrong: `0.7.9999` (stable) must sort after `0.7.3003` (beta 3 of 0.7.0), and `0.7.13001` (0.7.1 beta 1) must sort after `0.7.9999`. Build components compare as integers, so `13001` is not read as less than `9999`.
- Unparsable or missing build blocks a valid update: when either build is missing, binary, or non-numeric, the decision is `None` and only the existing short-version check applies, so a valid signed update still installs.
- Installed bundle has no readable `CFBundleVersion`: same as above, the short-version check alone decides.
- Sibling backup deleted: updating `A.app` must never remove `B.app`'s scoped backup `.zinnia-update-backup-B.app`.
- Legacy backup of a healthy install deleted: when the live bundle is complete, the shared `.zinnia-update-backup` is left in place, and only the scoped backup of this bundle is removed.
- Restore from the wrong bundle's backup: an incomplete `A.app` restores only from `A`'s scoped backup, then from the legacy directory. It never restores from `B`'s backup.
- Restore when the live bundle is healthy: no restore happens, the live `Contents` is untouched, and only the bundle's own scoped backup is removed.
- Restore refused for permissions: the install routes to the privileged script with the backup that still holds the data. That is the legacy directory when the legacy directory was the restore source, and the scoped backup otherwise.
