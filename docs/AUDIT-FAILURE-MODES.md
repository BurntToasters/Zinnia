# 0.7.0-beta.1 audit fix failure inventory

Failure cases considered before the fixes for the 0.7.0-beta.1 audit items.

## Toast pause

- Hovering a success or info toast does not stop its dismiss timer, so the text disappears while the pointer is still on it.
- Keyboard focus on a timed toast does not stop the timer, so a keyboard user loses the message before reaching it.
- Resuming after a pause restarts the full duration instead of the remaining time, so a toast can stay visible far longer than configured.
- Leaving hover while focus remains inside the toast (or leaving focus while the pointer is still over it) resumes the timer early.
- Repeated enter, leave, focus, and blur events stack timers, so a toast dismisses early or its removal runs more than once.
- Click or Escape dismissal leaves the pending timer alive, which later runs against a detached toast.
- Sticky error toasts (duration 0) must stay persistent and must not gain a dismiss timer.

## OS integration logging

- A failed status refresh is written only with `console.warn`, so it never reaches the activity log or exported diagnostics.
- `devLog` writes only in DEV builds or when log verbosity is debug, so a release build at default verbosity drops these lines. The calls must use `log` at the error level instead.
- If the logging call throws, the catch block exits early and `renderOsIntegrationRefreshFailure` is skipped, leaving the panel showing stale status.
- If the Finder Sync enable log throws, the fallback that opens Finder Sync settings is skipped.

## Error hint matcher

- A bare `not found` substring matches unrelated 7-Zip output such as "method not found", so an unsupported method is reported as a missing file.
- Narrowing too far drops the Windows "The system cannot find the path specified" message, so a vanished folder gets no hint.
- Matching is lowercased, so the comparison phrases must be lowercase, and a localized 7-Zip message gets no hint and falls back to the generic text.
- Checks run in order, so an earlier broad branch such as "access is denied" can take precedence over a missing-file message in the same output.

## Reset script guard

- `npm run b` or `npm run r` runs `git reset --hard` with uncommitted tracked changes present, and the edits are discarded with no prompt.
- `git clean -fd` deletes untracked files, so the guard must count `??` entries from `git status --porcelain`, not only modified files.
- The current branch has commits that its upstream does not, and `git reset --hard` plus `git switch -C` leave them reachable only through the reflog.
- The branch has no upstream and its commits are on no remote-tracking ref. Treating "no upstream" as safe would pass this case.
- Detached HEAD has no branch name. The guard must still check HEAD against the remote-tracking refs rather than skip the commit check.
- An unborn branch in a fresh repository has no HEAD commit, so `rev-list HEAD` fails. That must not be read as a refusal with a bogus message or as a clean pass with unknown state.
- A repository with no remotes matches nothing for `--remotes`, so every commit counts as unpushed and the guard refuses. This is the intended conservative result.
- The upstream is configured but its remote-tracking ref was deleted, so `@{u}` does not resolve. The guard must fall back to the remotes check instead of passing.
- The guard runs before `git fetch`, so a tracking ref can be stale. Commits pushed since the last fetch make the guard refuse. That is a false refusal, and the operator clears it with `git fetch`. It is never a silent loss.
- `git` is missing from `PATH`, the directory is not a repository, or `git status` fails on a stale `index.lock`. A failed command must exit non-zero, not read as an empty status.
- The override is set to `true`, `yes`, or an empty string. Only the exact value `1` may bypass the guard.
- The override hint uses `VAR=1 cmd` syntax, which PowerShell and cmd do not accept. The hint must also show the PowerShell form, `$env:ZINNIA_FORCE_RESET = "1"`.
- A branch name, path, or ref containing spaces, quotes, or `$` must never reach a shell string. Git is invoked with `execFileSync` and an argument array only.
- The guard checks only the current branch. `git switch -C beta origin/beta` repoints a local `beta` or `main` that is not current, so unpushed commits on that other branch are still lost. The approved design does not cover that path, and the README must not claim it does.
- The new README text or guard message uses an em dash, which `npm run validate:no-em-dash` rejects.

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

The guard script was removed in 0.7.0; `npm run b` and `npm run r` no longer run it.

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

# 0.7.0 audit follow-up failure inventory

Failure cases considered before the follow-up fixes for the 0.7.0 audit. Each
section lists how the fix could still fail or hurt users.

## Cancel registration race

- `cancel_7z` runs between the cancelling check and the child registration, sees no child, arms `cancelling`, and the spawned 7-Zip process keeps running.
- The check and the registration take the lock twice, so a cancel that lands between them is never seen by the spawned child.
- The compound TAR path registers the child but not the cleanup plan, so a cancel leaves staged output that nothing cleans up.
- The probe path returns a different error string than before, so the UI shows a new message for a cancelled runtime probe.
- The fix holds the process lock across an `.await`, so the command future is no longer `Send` and Tauri refuses to compile it.
- The fix returns early without terminating the child it just spawned, so the child outlives the operation.

## E2E pause point

- The pause hook runs in a production build, so a stray environment variable can stall real extractions.
- `ZINNIA_E2E_PAUSE_MS` is unset or unparseable, so the pause is zero or unbounded instead of the 4000 ms default.
- A huge `ZINNIA_E2E_PAUSE_MS` value stalls a test run for hours. The clamp to 30000 ms must hold.
- The marker file is written non-atomically, so a test reads a half-written marker and opens the race window at the wrong time.
- The pause is placed before the child spawn instead of after it, so the child is never registered during the pause and the race window does not open.
- The hook blocks a thread with a sleep instead of yielding, so it stalls the runtime for every other task.

## Pending-stage registry corruption

- A whole-file parse failure drops every record and the next write overwrites the file, so stage directories leak forever.
- A single bad record is skipped silently, so the stage it pointed at is no longer tracked.
- The preserved copy is written non-atomically, so a crash leaves a partial corrupt copy and the original bytes are lost.
- The preserve step fails and the read still returns an empty list, so the registry is dropped without any record of it.
- A fully valid registry is also copied, which fills the cache dir with copies on every read.
- The 10,000 record limit now runs after preservation, so an oversized file is copied when it should only error.
- Repeated reads of a still-corrupt file create a new preserved copy each time, so the cache dir gains several copies before the next valid write.
- A corrupt registry that is read but not rewritten, such as when every record is skipped and the orphan cleanup returns early, adds a preserved copy on every launch and read, so copies pile up without limit.

## Mark-of-the-Web source binding

- The source file is replaced between the identity check and the stream read, so the stream of a different file is copied as the marker.
- The source handle is dropped before the stream read, so the observed file identity no longer protects the read.
- The re-check compares against the wrong identity, so a swapped source passes the check.
- The re-check fails when the source is missing, and the error reads as a generic open failure instead of the changed-source message.
- The re-check runs after the destination is written, so a swapped source has already been marked.

## Forced exit teardown

- The retry kill succeeds but the app still treats the child as failed, so it skips `cancel_owner_and_wait` and rolls nothing back.
- The first kill fails and the retry is skipped, so a live 7-Zip process is left behind.
- The retry fails and the function returns false, so the app exits without teardown and the staging locks stay held.
- A join error still reads as a failed teardown, so the fallback path keeps running after a panic.

## Updater touch path

- `touch` resolves through `PATH`, so a planted `touch` binary runs with the updater's privileges.
- `/usr/bin/touch` is missing on a minimal macOS image, so the touch call fails silently and the extract path keeps its old timestamp.
- The absolute path changes the error behavior for a missing binary, so the updater reports success either way.

## Branch reset guard doc

- The sentence says the guard is removed, but a reader still assumes `npm run b` or `npm run r` protects unpushed commits.
- The sentence is added under the wrong heading, so the removal note appears next to unrelated guard text.
- The sentence uses an em dash or other punctuation the no-em-dash validator rejects.


# 0.7.0 second audit fix failure inventory

Failure cases considered before the fixes for the 2026-11-03 audit
(`coverage/audit-2026-11-03/report.md`).

## Encrypted archive update

- Adding files to an encrypted 7z or ZIP with an empty password field stores the new files unencrypted, and 7-Zip exits 0 so no password prompt appears.
- Adding files with a wrong password succeeds, and the archive ends up with members under two different passwords.
- The check lives only in the frontend, so a direct `run_7z` IPC call still adds plaintext members.
- The check lists a different file than 7-Zip updates, so an archive swapped in between is never inspected.
- The check reads the whole archive to verify the password, so adding one file to a large encrypted archive takes as long as testing all of it.
- The refusal message does not match the password-retry hint, so the user sees a generic failure instead of a password prompt.
- A header-encrypted 7z without a password fails with a new message, and the existing password prompt stops appearing.
- A plaintext archive, a TAR, or a mixed archive whose encrypted members accept the given password is refused.
- A corrupt or unreadable archive passes the check because a failed listing is treated as "not encrypted".
- The extra listing child is not registered with the operation slot, so Cancel cannot stop it and the slot is released while it runs.
- The listing or test password leaks into argv, the log, or the error text.
- The check runs for create (`a`) commands and slows every new archive.

## ZipCrypto refusal

- The guard reads an archive-level `Method` field that 7-Zip never prints for ZIP, so ZipCrypto archives are updated anyway.
- The parser change marks AES ZIPs as ZipCrypto and blocks ordinary password updates.
- A ZIP with both AES and ZipCrypto members is accepted because only the first member is checked.
- The backend does not enforce the refusal, so a direct IPC call still mixes ZipCrypto and AES members.

## Release proof source binding

- Tracked source changes after `test:all` still validate against the old proof, so a native build ships code that never passed the gate.
- New untracked source files are not covered by the digest.
- Ignored build output (`node_modules`, `target`, `dist`, `coverage`) is hashed, so every build changes the digest and the proof never validates.
- The proof and session files themselves, or regenerated Tauri schemas, are included in the digest, so writing the proof invalidates it.
- A proof written by an older script without a digest is accepted.
- File order or path separators differ between platforms, so a proof recorded on one run does not validate on the same tree.

## Vendored updater `zip` dependency

- The `zip` 4.x advisories stay in `Cargo.lock` and `cargo audit` keeps failing in CI.
- Upgrading `zip` changes the extraction API, and the Windows-only updater path no longer compiles, which macOS CI never sees.
- Removing ZIP support breaks Windows updates if any published updater artifact is ZIP-wrapped.

## Dev-toolchain advisories

- A patched dev dependency is available but not installed, so the reviewed-advisory gate fails or a fixable advisory stays.
- An advisory is added to the reviewed list without showing that it never reaches a shipped package.
- Updating dev dependencies changes production dependencies or the lockfile's production tree.

# 0.7.0 third audit fix failure inventory

Failure cases considered before the fixes for the second 2026-11-03 audit
(`coverage/audit-2026-11-03-b/report.md`).

## Selective extract of members that start with a dash

- A selected member named `-dash.txt` is written to the list file as `./-dash.txt`, 7-Zip finds no match, exits 0, and the run reports success with the file missing.
- Removing the `./` prefix for every command also removes it for compress inputs, where a leading dash is parsed as a switch.
- A member whose name starts with `@` is mishandled because the fix changes how `@` lines are written.
- A folder named `-dir` is skipped along with every file under it.
- A mixed selection publishes only the normal members and the UI still reports success.
- A member name that contains a line break is written unescaped and splits into two list entries.
- The archive path itself (first positional argument) loses its `./` neutralizing and is parsed as a switch or list file.

## Basic destination fields

- The typed destination is copied into Power on every keystroke, and an incomplete path is passed to a later run.
- Copying runs while a run is active and changes the destination mid-operation.
- The Basic field is overwritten by Power's stale value on the next switch, so the sync fix only moves the problem.
- Syncing the output path also overwrites Power's auto-filled name after the user cleared it.
- A programmatic Basic value (autofill) now counts as user-typed and stops later autofill.

## macOS Services pasteboard

- Restricting to file URLs rejects valid selections whose items are `NSURL` file references instead of plain file URLs.
- A mixed pasteboard with one non-file URL rejects the whole request instead of skipping the item.
- The cap is applied after conversion, so a huge selection is still fully allocated.
- The cap counts skipped items and rejects a valid small selection.

## Finder Sync timestamp

- A negative or non-finite clock value still traps.
- Clamping to 0 produces a request that the consumer accepts as expired but never removes, so it stays in the request directory.
- The request is dropped silently and the user sees no result.

## Recovery journal confinement

- A valid journal written by the app is refused because a volume name pattern is too strict (`.7z.001`, `.zip.001`, `.part1.rar` style names).
- A destination that is a symlink or has different case on a case-insensitive volume fails the equality check and strands a real rollback.
- A refused journal blocks every later operation with no visible explanation.
- The check runs after some deletions have already happened.
- Backup paths for the previous family are still restored to unconfined targets.

## Updater download limit

- A legitimate large installer is rejected because the cap is too low.
- A server that omits `Content-Length` bypasses a check that only reads the header.
- The cap is enforced after the buffer is already full.
- Rejection leaves a partial file or a stale download resource in the webview.

## Windows read-only clearing

- Clearing through a handle misses read-only directories, so removal fails on a tree that previously worked.
- Read-only files inside read-only directories are cleared in the wrong order.
- A handle held without `FILE_SHARE_DELETE` blocks the removal that follows.
- The Windows-only change cannot be run on this macOS host, so a compile error or behavior change ships unseen.

## Windows read-only clearing: deliberately not changed

- Replacing the path-based pre-pass with `open_directory_for_quarantine` plus `remove_directory_contents_relative` opens each directory with `DELETE` access. Windows can refuse that open on an entry that carries the read-only attribute (`STATUS_CANNOT_DELETE`), which is exactly the case the pre-pass exists for, so cleanup would start failing for every Windows user.
- The change cannot be compiled or run on the macOS development host (the `ring` build needs MSVC headers), so a mistake would ship unseen.
- The remaining race needs a same-user process inside the app's private conversion temp directory, and the current behavior is covered by the Windows run of `process/tests.rs`.
- Revisit only together with a Windows CI run that exercises read-only directories and files.

## Seeded settings file overwritten by a queued write

Failure cases considered before fixing the intermittent `settings-flows` failure.

- A workspace switch in test cleanup queues a debounced (140 ms) write of the app's in-memory settings. The next test seeds `settings.json`, the stale write lands on top, and the reload loads the app's own state instead of the seed.
- The flush runs after the baseline file is written, so the stale write still lands after it.
- The flush is exposed outside E2E builds and lets a page drop settings writes in production.
- The flush bumps the persist generation, so a legitimate write queued afterwards is rejected as superseded.
- A cleanup that throws before the flush leaves the stale write in place for the next test.
- Cleanup runs with no WebDriver session (settings reset relaunch), so the flush call itself throws and skips the baseline seed.
- Timing diagnostics inside the page change the schedule and hide the race; watch the file from the test process instead.
