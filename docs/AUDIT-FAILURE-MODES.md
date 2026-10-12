# 0.6.3 audit fix failure inventory

Failure cases considered before the fixes for the 0.6.3 codebase audit.

## macOS quarantine propagation

- A quarantined archive extracts files and folders without `com.apple.quarantine`, so Gatekeeper never assesses an extracted app.
- Quarantine is copied onto a symbolic link and, through it, onto a file outside the stage.
- A file inside a read-only staged directory cannot receive the attribute, and extraction still reports success.
- An archive without quarantine gains a fabricated quarantine value.
- The attribute is applied after publication, leaving a window where the published app is unquarantined.
- Applying the attribute changes staged identities and makes publication fail its own identity checks.
- A large tree makes the quarantine pass block the async runtime.

## Opening destinations

- "Open destination" on a folder named like an app bundle launches the bundle instead of showing it.
- The reveal path follows a symbolic link or opens a replaced file.
- Ordinary folders stop opening as folders.

## Log export dialog

- A synchronous command waits on the main thread for a dialog that needs the main run loop, and the app hangs.
- The export lock is held while the user keeps the dialog open.

## Listing output

- Password redaction rewrites archive member names that contain `-p…` tokens or `token=`/`password=` text, so browse shows wrong names and selective extraction misses them.
- Removing redaction from listings lets a password reach the activity log.

## Progress events

- Progress for one window's operation reaches another window's listeners.
- A window that cannot resolve its own label subscribes globally. In
- production the label always resolves, so the fallback only executes
- outside Tauri (vitest), where no cross-window leak is possible.

## Main-thread commands

- File I/O commands with fsync run on the main thread and freeze the UI on slow or network disks.

## Unused command

- `create_temp_extract_dir` stays registered and can be granted by a future capability without review.

## Updater environment

- The vendored updater calls `std::env::set_var` while other threads read the environment.
- Removing the fallback leaves Linux without root certificates.

## Single-stream quota

- A gzip trailer understates the decompressed size, or bzip2/xz report none, so live quota scans are skipped and only the free-space reserve stops the write.

## Windows shell integration

- `.rar`, `.tgz`, `.tbz2`, and `.txz` ProgIds lack the "Open with Zinnia" label and multi-select model.
- A C++ exception from allocation or `std::filesystem` escapes a COM method into Explorer.

## Dependency audit

- A dev-only advisory is not reviewed and silently passes the gate.
- A fixable build-chain advisory stays installed.

## Progress parsing

- A percent sign inside a file name is read as progress.
- A leading `U` is removed from a file name when no action marker is present.

## Developer hooks

- Staged Rust changes skip formatting checks before commit.

## Third audit (H1-H3, M1-M10, L1-L12) failure inventory

- A new moderate+ npm advisory appears that is not in the reviewed list, and the gate still passes because unreviewed advisories only warn.
- The reviewed-advisory re-review date passes and the gate still passes.
- 7-Zip exits 0 but writes no files (skip-all, killed writer, full disk with buffered exit), and extraction still reports success with an empty destination.
- An archive containing `CON`, `NUL.txt`, `foo:bar`, or `name. ` is created on Linux, then breaks or collides with a device/ADS when opened on Windows.
- The webview gains `shell:execute` because `shell:default` was granted instead of least-privilege `shell:allow-open`.
- A batch-extract password survives in the JS heap after the DOM fields are cleared, until GC.
- A compromised updater manifest with a version at or below the installed version still downloads and prompts for install.
- A build with unproven process cleanup still stamps the E2E binary as fresh and the next run reuses it.
- Committed ACL/capability schemas drift from generated output, but snapshot/restore hides the diff.
- A staged `.mjs`/rename/Cargo.toml/capability change skips pre-commit checks.
- An out-of-memory error in a shell-extension COM entry point escapes into Explorer and crashes it.
- An updater manifest with a bad signature or a downgrade version passes shape-only CI.
- A published folder is briefly world-readable, or a quarantined file is briefly owner-writable, before final permissions are applied.
- A compress input is swapped for a symlink between validation and 7-Zip spawn, or two distinct non-UTF8 paths collapse to the same lossy string.
- `open_path` opens a folder that was swapped for a symlink between canonicalization and open.
- A log export destination is swapped between the symlink check and `rename`.
- A stale `zinnia-7z-list-*` sweep deletes a squatted same-user directory.
- `probe_7z` masks a real exit-1 diagnostic because the version banner still parsed.
- A `%` inside a file name is read as progress, or a summary line `Everything is Ok 100%` is treated as completion.
- A URL with embedded bidi/zero-width characters passes `safeHref`.
- A window that cannot resolve its label subscribes globally and receives other windows' file names.
- An `extras` key of `__proto__` round-trips through settings save/load.
- `.rar`/`.tgz` lack the ProgId open verb while classic verbs exist.
- A Job Object without UI/die-on-exception limits lets a confined child show UI or swallow crashes.
- A poisoned compress-preflight mutex panics a worker thread and, under `panic=abort`, kills the process.
