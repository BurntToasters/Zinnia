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
