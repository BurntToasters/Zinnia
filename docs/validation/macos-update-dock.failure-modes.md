# macOS updater Dock identity regression

Before implementation, failure inventory:

- Renaming/replacing the outer installed `.app` changes its filesystem identity;
  a Dock bookmark can follow the old app into the updater backup.
- Replacing Contents must preserve the app directory inode and native bookmark.
- Missing staged Contents must fail before touching the installed app.
- A failed move or partial cross-volume copy must restore the original Contents.
- A rollback failure must leave the backup available for recovery.
- An interrupted previous update must retain the existing sibling-backup recovery.
- A valid live app with stale backup must still update successfully.
- Admin installation must preserve the outer directory too, quote paths, and
  restore Contents without nesting it in a partial destination.
- Restart must continue using the installed bundle and existing archive-idle gate.
- Restart on macOS goes through `relaunch_app`, which opens the new instance only
  after the old PID exits (see "Relaunch overlap" below).

Evidence boundary: filesystem/native bookmark validation establishes the identity
mechanism. Final visual proof requires a signed packaged app updated with a pinned
Dock item, covering both writable and administrator-owned installations. The
0.6.3 to 0.6.4 tag diff does not change the updater/relaunch implementation.

Repeat the native check on macOS:

```sh
bash scripts/verify-macos-update-identity.sh
```

Artifacts: `coverage/macos-update-identity/result.json`, `rust-tests.txt`, and
`inputs.sha256`. The check invokes the production Rust contents transaction and
macOS bookmark APIs. It also executes the actual AppleScript shell transaction
without administrator elevation, including an injected install-move failure and
rollback. Standard AppleScript scripting additions must be available; the Codex
sandbox can hide them, requiring execution outside that sandbox.

Baseline probe: with the original whole-bundle rename, a native bookmark resolved
to `.zinnia-update-backup` while the old bundle was there. With contents replacement,
the outer inode remains equal and the bookmark is not stale after installation.
This demonstrates the identity mechanism, not a visual reproduction of the Dock.

## Relaunch overlap

Failure inventory for `relaunch_app` (macOS helper that waits for the old PID):

- Overlap: `open -n` ran while the old process was alive, so a pinned Dock tile
  stayed bound to the old instance and a second tile appeared. The helper must
  wait for the old PID to exit before `open` runs, and must not pass `-n`.
- Helper dies with the parent: the helper must be in its own process group
  (`process_group(0)`), with stdio null, so it survives the old process exit.
- PID reuse or a stuck old process: the poll may see an unrelated process with
  the same PID, or the old process may never exit. The wait is bounded to about
  60 seconds; on timeout the helper exits and launches nothing.
- Exit prevented: `app.exit(0)` goes through `ExitRequested`. If an archive
  operation or update reservation is busy, the exit is deferred, the old PID
  never ends, and the helper times out without relaunching. The frontend
  releases the update reservation before calling `relaunch_app`, so the normal
  path is not blocked; a deferred exit leaves the app running with no relaunch.
- Path with spaces, quotes, or shell metacharacters: pid and bundle path are
  passed as positional arguments to a fixed script, never interpolated.
- Non-bundle run (`cargo run`, `target/debug`): the executable is not under
  `<X>.app/Contents/MacOS/`, so the command falls back to `request_restart`.
- Bundle root detection: a path with `MacOS` but no `Contents`, or a directory
  that does not end in `.app`, must not be treated as a bundle.
- Spawn failure (missing `/bin/sh`, process limit): log the error and fall back to
  `request_restart`, so the app still restarts (possibly with overlap).
- Windows and Linux: always `request_restart`; no helper is spawned.
- Frontend: both call sites (update install and settings reset) must invoke
  `relaunch_app`. The update path keeps the order install, clear pending update,
  release reservation, relaunch, so a failed release still prevents relaunch.

## Updater hardening (0.7.0 audit)

Failure inventory, written before the matching tests and code.

- F1 payload downgrade: the signature covers only archive bytes, so a tampered
  manifest can label an old signed build as newer. The staged
  `Contents/Info.plist` must not declare a version that is not strictly greater
  than the installed version. A missing, binary, or unparsable plist value must
  not block the update, because the signature remains the primary gate.
- F1 false positives: a prerelease such as `0.7.0-beta.2` must compare by semver
  rules, and an installed version that does not parse must not block the update.
- F2 recovery stall: when restoring a sibling backup fails with PermissionDenied,
  the unprivileged install reports AlreadyExists and returns before the privileged
  script, which is the only code that can finish the recovery.
- F3 non-atomic replace: rename-to-backup followed by a move leaves a window with
  no live `Contents`. A crash in that window relies on backup recovery. An atomic
  exchange must be used when the volume supports it.
- F3 swap failures: EACCES/EPERM must go to the admin path unchanged. ENOTSUP,
  EXDEV, EINVAL, or a missing live `Contents` must fall back to the backup
  transaction. A stale backup slot must never be overwritten or bypassed by a swap.
- F3 swap leftovers: after a swap, the old `Contents` sits in the staging dir. The
  staging dir must be removed by its owner, and no backup dir may remain.
- F5 insecure redirect: a redirect from an https endpoint to http could leak or
  serve an unverified manifest. Release builds must refuse non-https requests,
  while debug builds and explicit dangerous opt-ins keep the current behavior.
- F6 truncated AppImage: writing the new bytes straight onto the live AppImage can
  leave a partial file after a write error or power loss. The bytes must be written
  to a temp file in the same directory and renamed into place.
- F6 cross-device: the temp file must live beside the AppImage so `persist` is a
  same-filesystem rename.
- F7 pkexec cancel: exit code 126 means the user dismissed the authorization dialog.
  Falling through would show zenity, kdialog, and sudo prompts for the same action.
  Other exit codes must keep the existing fall-through.
- F8 check ordering: calling `get_urls` before the version decision makes a
  manifest without this platform fail even when no update is needed.
- F13 stale Dock icon: a root-owned bundle replaced by the privileged script can
  leave LaunchServices with the old metadata. The script must touch the bundle
  before its success exit, and the swift fault-injection match must still apply.
