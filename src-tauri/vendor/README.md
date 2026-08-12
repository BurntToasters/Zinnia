# Vendored tauri-plugin-updater

Path-patched from crates.io `tauri-plugin-updater` 2.10.1.

## Why

macOS privileged install must not interpolate bundle paths into a shell string.
This tree passes source/destination paths as AppleScript handler arguments and
quotes them with `quoted form of` before `do shell script`.

Do not drop `[patch.crates-io]` in `src-tauri/Cargo.toml` without an equivalent
upstream fix.
