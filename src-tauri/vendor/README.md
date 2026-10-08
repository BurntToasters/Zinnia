# Vendored tauri-plugin-updater

Path-patched from crates.io `tauri-plugin-updater` 2.10.1.

The fixes are also written up as upstream-ready patches in
[`docs/upstream/tauri-plugin-updater/`](../../docs/upstream/tauri-plugin-updater/),
with per-patch status against the latest 2.x release (2.13.2, checked
2026-10-07). Applying all patches in order to 2.10.1 reproduces this tree.

## Why

Keep `[patch.crates-io]` in `src-tauri/Cargo.toml` until upstream matches these
fixes:

- macOS privileged install must not interpolate bundle paths into a shell
  string. Paths are AppleScript handler arguments, quoted with
  `quoted form of` before `do shell script`.
- macOS must not `rm -rf` the live `.app` before the replacement is in place.
  The live bundle is renamed to a same-volume sibling backup
  (`.zinnia-update-backup`), the new bundle is moved in, then the backup is
  deleted. Failure restores the backup. Staging lives next to the `.app`, not
  under `/tmp`, so a dropped `TempDir` cannot erase the installed app. `EXDEV`
  copies onto the app's volume before the swap.
- Tar extraction must reject `Prefix` / `RootDir` / `ParentDir`, hard links,
  and symlinks that escape the extract root.
- Linux `pkexec` / `sudo` / `dpkg` / `rpm` must be absolute, root-owned
  helpers (`/usr/bin` or `/bin`), never resolved from `PATH`, with a minimal
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin` environment. Regular files must not be
  group/world writable. Root-owned helper symlinks are followed and the target
  must still be a trusted regular file (Linux symlink mode is always 0777 and
  unused). `sudo -S` must drain output and time out instead of piping both
  stdio and calling `wait()`.
- Windows must treat `ShellExecuteW <= 32` as failure and must not run
  `on_before_exit` / `exit` until the installer actually launches.
- Download timeout is a connect/read (stall) limit, not a total-transfer cap,
  so a slow but progressing download is not cut off. The update check keeps the
  total timeout. A server that keeps trickling bytes can hold a download open
  longer than the configured value.

Two more changes are in this tree, outside the list above:

- The `check` command ignores the frontend `allowDowngrades` flag. Pristine
  2.10.1 lets the webview switch to "any version other than the current one",
  which allows rollback to an older signed release.
- On Linux, `SSL_CERT_FILE` falls back to the Fedora/RHEL bundle path when the
  Debian path is absent.

Upstream status in 2.13.2: the macOS install path was rewritten (atomic swap,
restore on failure, quoted shell command), and the Windows result check was
added. Tar extraction, Linux helper resolution, the `sudo` drain and timeout,
and the total-transfer download timeout are unchanged upstream, so the patch
stays. The `SSL_CERT_FILE` code and the frontend downgrade flag were removed
upstream.

Do not drop the path patch without an equivalent upstream fix.

## Also vendored: tauri-plugin-wdio-webdriver 1.4.0

Used only for E2E runs. It is an optional dependency behind the `e2e` Cargo
feature (`src-tauri/Cargo.toml`), and `e2e` is not in `default`. The plugin is
registered only under `#[cfg(feature = "e2e")]` in `src-tauri/src/main.rs`, so
release builds do not compile or link it.

Compared with crates.io 1.4.0, the only build-affecting changes are in
`Cargo.toml` and `Cargo.toml.orig`: `webview2-com` 0.38 to 0.39, `windows` and
`windows-core` 0.61 to 0.62, and the extra `windows` feature
`Win32_System_Com_StructuredStorage`. Rust source differs only in comments and
dash punctuation. Reason: wry 0.57.0, used by tauri 2.12.0 (per
`src-tauri/Cargo.lock`), depends on `webview2-com` 0.39 and `windows` 0.62, so
the 1.4.0 pins would give the plugin different WebView2 types from the webview.

Drop this vendored copy once upstream publishes a release that builds against
wry 0.57. As of 2026-10-07, the newest crates.io release is 1.4.0, which still
pins `webview2-com` 0.38 and `windows` 0.61. When it is dropped, remove the
`[patch.crates-io]` entry for `tauri-plugin-wdio-webdriver` and delete this
directory.
