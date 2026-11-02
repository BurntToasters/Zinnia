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

# 0.6.3-beta.5 audit fix failure inventory

Failure cases considered before the fixes for the beta.5 release audit.

## Conversion download marker

- A converted archive is published before it carries the source archive's download marker, so a crash or IPC failure between publish and marking leaves an unmarked archive on disk.
- The marker is copied from a path the webview chose freely, so a compromised window stamps or alters markers on unrelated files.
- The marker source is a symbolic link or reparse point and redirects the read.
- A split conversion marks only the base name and leaves `.001`, `.002`, ... volumes unmarked.
- Marking fails and the conversion still reports success, or the unmarked archive is left in place.
- An archive without a marker gains a fabricated one.
- A marker source is accepted for commands other than create, and changes extract or update behavior.

## Windows folder attributes

- An extracted folder keeps the read-only or system attribute, so Explorer honors an archive-supplied `desktop.ini` (icon path on a remote share, shell CLSID) when the folder is viewed or opened.
- Clearing attributes on folders also clears them on files, so read-only or hidden files lose their attributes.
- Hidden folders stop being hidden.

## Password ZIP update

- Updating an existing ZIP whose name does not end in `.zip` and has no `-tzip` skips the AES-256 enforcement, so 7-Zip falls back to ZipCrypto.
- The format probe follows a symbolic link or reads a different file than 7-Zip updates.
- A non-ZIP archive is treated as ZIP and receives ZIP-only switches that make 7-Zip fail.
- A missing archive (new output) is rejected instead of treated as a fresh create.

## Release dry run on Windows

- The `gh` and `cargo` stand-ins are POSIX scripts without an extension, so Windows resolves the real `gh.exe` and the dry run contacts the real GitHub repository.
- The child keeps the operator's GitHub CLI configuration and authenticates with real credentials.
- MSYS `gpg` from Git Bash receives a `C:\...` home directory and cannot create the throwaway key.
- The fix changes behavior on macOS or Linux, where the POSIX stand-ins already work.

## Branch reset guard

- `npm run b` or `npm run r` repoints a local `beta` or `main` that holds unpushed commits, so those commits disappear from the branch.
- The guard fails when the local branch does not exist yet or has no upstream.
- The override hint only works in POSIX shells.

# 0.7.0 audit fix failure inventory

Failure cases considered before the fixes for the 0.7.0 pre-1.0 audit. Legacy
compatibility removal is intentional in this release; the cases below cover how
that removal could hurt users who upgrade.

## Cancel and recovery threading

- `cancel_7z` waits for the child on the main thread, so the UI freezes for up to five seconds while 7-Zip shuts down.
- Moving the wait off the main thread lets a second cancel, or the next `run_7z`, start before the first child has exited.
- Cancel returns before the operation slot leaves the cancelling state, so a new operation sees a stale busy slot.
- A cancel from a window that does not own the operation succeeds after the command becomes async.
- The second recovery pass inside `run_7z` walks or rolls back a large tree on an async worker and stalls other IPC.
- Moving that pass into `spawn_blocking` drops its error, or runs it after the operation slot is already claimed.

## Password ZIP probe

- The probe checks `symlink_metadata`, then `File::open` follows a symlink swapped in between, and `-tzip` is added based on another file.
- A no-follow open refuses a regular archive that the old probe accepted, so password ZIP updates lose AES-256 enforcement.
- A missing output (new archive) is treated as an error instead of a fresh create.

## Download markers

- An unreadable, oversized, or malformed Zone.Identifier stream is reported as copied, and an archive from the internet publishes without Mark-of-the-Web.
- Returning an error for an absent stream, or for a volume without alternate data streams, makes every local or FAT32 extraction fail.
- The marker source is swapped for a symlink after validation, and the quarantine or zone data is read from a different file.
- The identity check at copy time compares against the wrong snapshot and rejects every legitimate marker source.

## Dead IPC and small command fixes

- `probe_compress_inputs` stays registered with no caller, so a future capability can grant it without review.
- Removing the command also removes the shared compress preflight that `run_7z` still needs.
- Removing the command leaves generated ACL schemas or permissions out of sync, and the schema drift check fails.
- Debug-console relay commands run on the main thread with an unbounded payload, so a large log line freezes the UI.
- `enable_finder_sync` reports success when `pluginkit` fails, so the UI shows Finder Sync as enabled when it is not.
- The 7-Zip `b` benchmark command is rejected and the Settings CPU benchmark stops working.

## Legacy journal removal

- A version 0 journal from 0.6.2 or earlier is parsed as a current journal, and missing fields drive destructive recovery.
- Refusing a version 0 journal deletes its stage or destination instead of preserving them.
- A refused journal blocks every later operation with no visible explanation.
- An extract journal without `move_plan_sidecar` reads an in-payload `move-plan.json` that the archive itself supplied.
- A bare-string `pending-stages.json` entry makes the whole registry unreadable, orphan cleanup fails, and a directory is deleted without an identity record.
- Removing the settings `.bak` restore loses settings for a user whose last save crashed between the two old rename steps.
- The live Unix publish path without `publish_temp` is removed along with the legacy comment.

## Error surfacing

- The Basic failure panel and the quick extract window show raw 7-Zip stderr, including paths and internal switches, instead of a recovery hint.
- Hiding stderr removes the only detail a user can report, because it is no longer in the log or the debug dump either.
- A wrong password and a corrupt archive show the same hint.
- Browse and test status in Basic is written to the hidden compress panel, so the user sees no progress or error.
- Malformed settings in the extract window disable auto-close entirely instead of using the default.

## Settings, presets, and legacy keys

- A second Save click supersedes the first write, the first handler reports success, and the modal closes over unsaved settings.
- Save stays disabled forever after a failed write.
- Delete preset removes a custom preset with no confirmation.
- Settings or custom presets that still contain `sfx`, `deleteAfter`, or `pathMode` fail validation and reset everything to defaults.
- Removing those keys lets `-sfx` reach 7-Zip.
- Dropping `_setupComplete` shows the setup wizard again to users who finished it.

## Accessibility

- The Power password toggle keeps one accessible name while its state changes.
- The auto-close countdown is visible but not announced.
- Indeterminate progress announces 0 percent.
- Tree expand buttons all have the same name.
- Basic icon buttons are hard to hit on touch screens, and a larger hit area shifts the layout.

## Installer and tooling cleanup

- Removing the v0.5.x verb cleanup leaves duplicate Open/Extract entries for users who skip from 0.5.3 directly to 0.7.0.
- Removing the 0.6.0 beta root DLL cleanup leaves a mapped `zinnia_shell.dll` in the install root of those beta users.
- The removal also deletes the classic-verb fallback that Windows 10 and failed Win11 registrations still need.
- A removed npm script is still named in README or another script.

## Module splits

- A moved function changes visibility or module path, and a `#[tauri::command]` path or `__cmd__` re-export no longer resolves.
- Windows-only or Unix-only code moves without its imports and only fails on that platform.
- A split reorders rollback steps, lock scope, or cancellation checks.
- A CSS split changes cascade order and visibly changes the UI.
- A TS split changes listener registration order or registers a listener twice.
- Moved files fall outside coverage gates that name file paths.

## E2E runner filter

- A filtered run writes `status: "passed"` and is accepted as release or CI proof.
- `npm run test:all` forwards the filter and silently runs fewer suites.
- An unknown spec name runs nothing and still passes.
- The filter skips the main suite that the selected spec depends on for its build or profile.

## Pass 2 hardening failure inventory

- Closing a window or quitting while 7-Zip is active calls `terminate_registered_child` or `terminate_child` synchronously on a Tokio runtime thread, blocking async progress/UI work for up to 5 seconds.
- A journal with `format_version == 1` but missing `archive_phase`, `extract_phase`, or `extract_stage_placement` falls back to legacy heuristics instead of failing closed.
- Accepting a preserved older-format journal in the startup banner shows the "Accept kept extraction result" prompt instead of explaining that the journal came from an older Zinnia version.
- `openFinderSyncSettings` aborts on a non-zero `pluginkit -e use` exit and never opens System Settings -> Login Items & Extensions for manual approval.
- Basic extraction on a corrupt or non-archive file treats a failed `7z l -slt` probe as an encrypted archive and prompts for a password instead of surfacing the archive validation/corruption error.
- Seeding a popped-out Debug Console with a full 1,000-line buffer exceeds the 256 KiB IPC cap and silently leaves the popped-out console blank.
- Clearing or resetting a Power password field resets the button text to "Show" while leaving `aria-label="Hide password"`.
- `e2e-archive-benchmark.ts` or `basic/sync.ts` accesses removed `#delete-after` or `#path-mode` DOM nodes and throws at runtime once `setup-dom.ts` stops faking them.
- `export_logs` in E2E cannot be exercised end-to-end because the save dialog blocks headless automation unless E2E mode can supply a queued destination path.

