> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                          | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux        |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-macOS.dmg)**   | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-Linux-x64.AppImage) |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>-->                     | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-macOS.zip)**   | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-Linux-x64.deb)           |
| <!--*See MSI note below*-->                                                                                                                                                                                                |                                                                                                                 | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-Linux-x64.rpm)           |
|                                                                                                                                                                                                                            |                                                                                                                 | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.1-beta.2/Zinnia-Linux-x64.flatpak)   |

> macOS downloads require macOS 26 or later.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
> ⚠️ Arm64 Linux Binaries are _NOT_ available at the moment. Its something I may get around to in the future but its not a priority. However, I do have the logic setup in the repo in-case people would like to build their own :)

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2!

## Changes in `v0.6.1-beta.2:`

- **Fix:** Extract-only windows grant `allow-probe-7z` in Tauri capabilities so shell/quick extract can run the pre-extract 7-Zip probe (B1 failed with “Command probe_7z not allowed by ACL”).
- **Fix:** `release:mirror` copies each release artifact into `AFTER_PACK_LOC`, overwriting same-named files only, instead of replacing the whole share directory (so a later finalize on another OS no longer deletes other VMs' checksums and installers).
- **UI:** Windows NSIS installer notes that Win11 context menu package registration “may take a moment” (can be slow while integration is already active).
- **Tooling:** `tauri-capabilities` tests assert every `invoke` in `extract-window.ts` is allowed by `capabilities/extract.json`.

## Changes in `v0.6.1-beta.1:`

- **Fix:** Windows Explorer shell handoffs that fail during cold start (oversized selection, wrong owner, malformed list) now surface a toast via `get_shell_handoff_error` instead of silently opening with no paths.
- **Fix:** Warm-idle / extract-only Explorer handoff failures keep the error until a main window can toast it (do not emit+clear into a non-listening extract webview).
- **Fix:** Cancel during an idle password-prompt or between-batch gap keeps abort intent so retry/batch loops stop (`cancel_7z` still reports whether a child was armed).
- **Fix:** macOS empty-launch fallback clears `MAC_FALLBACK_MAIN_PENDING` if main fails to open or is destroyed, so a later Extract cannot treat a real workspace as disposable.
- **Fix:** Archive-probe IPC failures fail closed (toast) instead of auto-routing drops into Compress.
- **Fix:** Basic extract password prompts distinguish wrong passwords from backend/IPC failures so unrelated errors no longer loop as “Incorrect password”.
- **Fix:** Basic encryption probing treats probe failures as “assume encrypted” so password-protected archives are never skipped silently.
- **Fix:** Windows settings saves use atomic `rename` replace-existing promotion (with stale `.bak` cleanup) instead of a rename-to-backup window that could briefly leave settings missing.
- **Fix:** Main/batch/selective extract pass `-bsp1` so live percent progress matches the extract-only window; progress IPC keeps CR so 7-Zip line rewrites stay parseable.
- **Fix:** OS Integration help no longer claims classic Explorer verbs remain under Show more options after a successful Win11 package registration.
- **Fix:** Extract-only window probes bundled 7-Zip before extract; auto-close
  delay uses the same supported archive allowlist as Settings.
- **Fix:** macOS archive CoW snapshot cleanup removes partial clones when chmod/fsync fails (matches Linux).
- **Performance:** Archive-input snapshots use APFS `fclonefileat` and Linux `FICLONE` when available before falling back to a byte copy (CoW clones share blocks on APFS/Btrfs; free-space preflight still reserves for full byte-copy worst case).
- **Performance:** Large merge-into-existing extractions journal publish identities append-only instead of rewriting the full move-plan JSON after every file (avoids O(n²) I/O).
- **Fix:** Startup sweeps orphaned `%TEMP%` shell-handoff files (owner-checked) and stale `zinnia-7z-list-*` directories (nofollow + age gate) after crashes; stale Zinnia temp dirs use hardened cleanup.
- **Fix:** File/folder pickers and incoming-path apply respect Basic preparation locks without self-deadlock; dialog failures log clearly instead of failing silently.
- **Tooling:** Node.js engine requirement is `>=22.12` (Node 25+ no longer capped out).
- **Tooling:** Live updater smoke fails closed on same-channel stale `/latest` feeds while still soft-passing when nothing is published yet.
- **Security:** Extracted symbolic links now use OS-resolved containment checks, blocking ancestor-symlink plus `..` escape shapes and dangling links before publish.
- **Fix:** Live extraction quota scans tolerate a safe relative symlink appearing before its target while final publish validation remains strict.
- **Fix:** Select-all in the selective extraction tree now includes rendered folders synthesized from archives that omit explicit directory entries.
- **Fix:** Selective extraction tree counts, row-limit messaging, and accessibility labels now match the controls and rows actually rendered.
- **Tooling:** Version synchronization now keeps the tracked Finder Sync extension metadata aligned with the containing macOS app.
- **Fix:** Keyboard dismissal now closes the Licenses sheet above Basic Settings first, and Settings shortcuts no longer act on the obscured lower layer.
- **Fix:** Closing an extract window treats an already-exited 7-Zip kill as success and restores the child handle on real kill failure so close/cancel can retry instead of soft-locking.
- **Fix:** Extract-window Cancel re-enables after a failed `cancel_7z` so the user can retry the kill.
- **Security:** Archive create/update crash-recovery backups now journal content fingerprints (sha256) with the inode/file-id identity, so same-inode rewrites cannot be restored as the user’s archive.
- **Fix:** Failed update installs always attempt `release_update` through a dedicated path that does not treat IPC errors as “still busy”, avoiding a stuck archive prepare slot until restart.
- **Security:** Extraction crash-recovery move plans reject `..` / non-normal path components so a tampered journal cannot roll back or publish outside the destination root.
- **Fix:** Update install waits are bounded (3 minutes) and still release the archive prepare slot on timeout, matching download-timeout behavior.
- **Fix:** Settings saves keep backend-owned `_`-prefixed keys (except setup-wizard fields) from being overwritten by incoming JSON.
- **Docs:** README OS-integration wording matches Win11 modern-primary vs classic-fallback behavior.
- **Tooling:** Windows Artifact Signing client-tool discovery matches 0.6.0 again (use first found dlib/signtool under Program Files or AppData; no Authenticode gate on the client tools themselves). Signed app output is still verified.
- **Fix:** Beta→`/latest` manifest sync again receives the GitHub upload response `id` (`uploadAssetOnce` was awaiting without `return`) and uses non-dot staging names because GitHub strips leading periods from release assets.
- **Tooling:** Tracked files must not contain Unicode em dashes (U+2014); `npm run validate:no-em-dash` runs in `test:all`.

## Changes in `v0.6.0:`

### v0.6.0 is a large feature-packed update :) a lot of painstaking work went into integrating Zinnia with the Windows 11 Context-menu :P

- **NEW - Basic mode:** Drop-first home, warmer floral accent, friendlier copy, and Basic/Power, Support, and Settings in the custom titlebar; Power keeps a separate header row and free resizing.
- **NEW - Basic window effects:** Translucent Basic window with macOS vibrancy and Windows Mica/Acrylic (Linux Basic stays opaque); toggle in Settings with live apply and opaque fallback when FX are off or unsupported.
- **NEW - macOS Finder Sync:** **Extract with Zinnia** / **Compress with Zinnia** on Finder’s primary right-click menu (Keka-style), with Zinnia logo as an adaptive template image.
- **NEW - macOS Finder Services:** Extract/Compress services with OS Integration status (Enabled/Off/Unknown) and **Enable…** that writes `pbs` prefs directly when System Settings checkboxes stall.
- **NEW - Windows 11 context menu:** Signed sparse-package **Zinnia** submenu (Extract/Compress) plus top-level **Extract with Zinnia** on archives; classic Explorer verbs remain for Show more options and as fallback when package registration fails.
- **NEW - Auto-close extract window:** Setting to close the extract window immediately or after a countdown on success (default 1.5 seconds).
- **NEW - Recents:** Compact titlebar dropdown in Basic mode; missing paths drop automatically.
- **UI:** Basic locks main window size when active (non-resizable/non-maximizable); titlebar Maximize is disabled in Basic; roomier Settings sheet; `Ctrl`/`⌘` + `,` opens Settings; stacked modal focus traps; Basic progress clears `aria-busy` when finished.
- **UI:** Selective extract picker uses archive-native path separators; folder toggles and Select all respect rendered rows, search visibility, and the 1,000-row budget; browse tree construction is iterative with depth/member limits.
- **UI:** Clearer errors for symlink/reparse inputs.
- **UI:** Timestamp option label matches behavior (created + accessed; modification always stored); Basic glass no longer paints a solid dock behind Compress; extract-only window matches Basic glass/opaque theming.
- **Windows:** NSIS migrates legacy `v0.5.3` context-menu registration to the `v0.6.0` shell layout; versioned side-by-side shell DLL/MSIX payloads prevent loaded DLLs from blocking updates; uninstall retries sparse AppX removal.
- **Windows:** OS Integration reads live default-app ProgId per format; Ready detection accepts Win11 sparse packages when classic verbs were removed; legacy duplicate Open/Extract/Compress stacking under Show more options is removed on upgrade.
- **Windows:** Large Explorer selections use a private UTF-8 list file; handoffs use a private SDDL temp file with nofollow/owner-checked consume; selection batches cap at 1,000 paths with a 4,096-path hard ceiling.
- **Windows:** Extract propagates Mark-of-the-Web via 7-Zip `-snz`; compress fails closed on nested junction/cloud reparse points; staging ACL uses token SID/SDDL verification instead of locale-specific account names.
- **macOS:** Requires macOS 26+ for the bundled 7-Zip 26.02 binary; default-archiver integration uses `NSWorkspace`/`UTType`; signed artifacts enforce an entitlement allowlist.
- **Linux:** Flatpak resolves before the setup wizard, skips the Updates step, and grants `xdg-download`, `/run/media`, `/mnt`, and `/media` per `SECURITY.md`; WebKitGTK-blocked flows use in-app dialogs.
- **Linux:** RPM/DEB/AppImage/Flatpak x64 release set with updater manifests validated before upload.
- **Security:** Password-protected create/update keeps 7-Zip’s bare `-p` switch and pipes secrets on stdin after stdout/stderr drain; rejects multiple `-t` types, non-encrypting formats, line-break secrets, and `-stl` mistaken as a type.
- **Security:** 7-Zip password spawn uses a buffered channel and registers the child before stdin so Cancel works during password setup; validation and backend output redact secrets.
- **Security:** Extract staging uses private snapshots, reparse/symlink gates, member preflight (`7z l -slt`), relative in-tree symlinks allowed where safe, and publish paths that never overwrite existing destinations without recorded identity.
- **Security:** Unix publish stages are `0o700` while in progress; merged directories restore destination parent mode; hard-link/copy rollback retracts targets only with matching publish identity.
- **Security:** Updater publication verifies every artifact/Minisign pair with the embedded public key; 7-Zip provenance is pinned in `7z-checksums.json`.
- **Security:** Archive create/update stores symlinks and hard links (`-snl`/`-snh`) for `.app`/`.framework` round-trips; ZIP compress warns on symlinks and bundles.
- **Fix:** Basic prep locks OS handoffs and file-remove controls until a job runs; Power/Basic drops serialize on incoming-path apply locks; Add Files/Folder/Remove/Clear honor busy state; selective extract never passes bare folder paths to 7z.
- **Fix:** Cancel/prepare/quota-stop keep the global 7z soft-lock until staging rollback and journal clear finish; failed commits fail-closed on journal parse errors and retract partial publishes before clearing journals.
- **Fix:** Split-archive recovery, in-process promote recovery, and durable commit phases prevent mixed volumes after interruption; cancel during prepare kills spawned 7z before rollback.
- **Fix:** Protected compress sources (shortcuts, Start Menu paths) default to Desktop; relative compress outputs are rejected; Basic no longer double-shows native error dialogs on failure.
- **Fix:** Quick-extract warm idle, tray, and extract-window teardown avoid Dock zombies and racey idle quit; explicit Extract/Compress handoffs clear mismatched sessions instead of appending.
- **Fix:** Settings/modals no longer mark the titlebar `inert`; Support/About/license links open once in the system browser; macOS Services Extract avoids flashing the main window on cold start.
- **Fix:** Setup wizard Skip no longer fails on AppData directory fsync; Basic titlebar brand layout on Windows; modals respect overlay `[hidden]` for keyboard shortcuts.
- **Updater:** Stable releases also publish beta-channel updater manifests so final-beta installs can move to stable; beta manifest sync to `/releases/latest` runs automatically during release signing.
- **Accessibility:** Contrast tokens, focus rings, danger buttons, path ellipsis RTL, and Basic touch targets updated for WCAG-friendly controls; Flatpak hides the Updates section when updates are unavailable.
- **Codebase:** Modular frontend (`archive/`, `basic/`, `ui/`) and Rust (`process/`, `platform/`, `launch/`) splits; archive commit finalization on `spawn_blocking`; OS integration commands kill process trees on timeout.
- **Testing:** Changelog/updater validation in `npm run test:all`; expanded Rust Clippy/format gates; Windows/macOS CI smoke compiles the shell DLL and universal macOS builds.
- **Docs:** Windows context-menu QA checklist; `SECURITY.md` Flatpak and hard-link TOCTOU notes.
- **Known:** Windows RAR browse, test, conversion, and extraction stay disabled
  because packaged `7za.exe` has no RAR handler. macOS/Linux RAR support remains
  available.
- **PKG:** Updated packages.

### FULL CHANGELOG:

<details>
  <summary>ℹ️ Click here to see previous major releases!</summary>

## Changes in `v0.5.0:`

- **Misc:** This stable release includes all improvements from `v0.5.0-beta.2` through `v0.5.0-beta.9 (RC)`, plus final stabilization and polish.
- **Codebase:** Updated bundled 7z to `26.02`.
- **NEW - Split Archives:** Added multi-volume archive creation with presets and custom sizes.
- **NEW - Custom Presets:** Added save/apply/delete compression presets that persist across sessions.
- **NEW - Archive Update:** Added "Update existing archive" mode to refresh or add files without full recreation.
- **NEW - Add Files From Browse:** Added adding files while browsing an archive.
- **NEW - Convert Archive:** Added convert in browse view with full compression settings support.
- **NEW - CPU Benchmark:** Added a benchmark in Settings to help tune thread count.
- **NEW - Selective Extract Tree:** Added selective extract as a collapsible tri-state tree.
- **NEW - Keyboard Shortcuts Help:** Added shortcut help via `?`.
- **Codebase:** Added ability to set Zinnia as the default archiver, plus reset supported formats back to system defaults where supported.
- **Codebase:** Fixed right-click "Compress with Zinnia" flows, improved Windows/Linux menu registration, and cleaned up stale entries.
- **Linux:** Replaced blocked browser dialogs (WebKitGTK) with in-app dialogs for password prompts and preset saves.
- **UI:** Updated visual direction inspired by IYERIS and improved titlebar behavior on Windows and macOS.
- **UI:** Added real-time progress (percent, current file, ETA) across compress, extract, batch extract, and basic/extract-window flows.
- **UI:** Added non-blocking success toasts, inline validation badges, better error hints, and improved Basic mode drag-and-drop behavior.
- **UI:** Improved legibility, touch target sizing (WCAG 2.2 24x24), warning badge contrast, screen reader semantics, keyboard support, modal focus restoration, and empty-selection confirmation in selective extract.
- **Security:** Strengthened Rust-side 7-Zip argument validation with strict allowlists and rejected dangerous patterns including `@listfile` and `..` segments.
- **Security:** Required explicit `-o<dir>` output directory for extraction validation.
- **Security:** Added watchdog timeout for 7z subprocesses to prevent indefinite hangs on interactive prompts.
- **Security:** Enforced bundled 7-Zip checksum verification against `7z-checksums.json`, with build failure on mismatch or missing entries.
- **Security:** Made `prepare-7z.js` fail hard when checksum manifest data is missing or invalid.
- **Security:** Defaulted ZIP encryption to AES-256 for password-protected archives.
- **Security:** Narrowed webview CSP `connect-src` to `'self'` and ensured passwords are cleared from DOM fields and excluded from logs/command previews.
- **Codebase:** Fixed cancel/completion race that could delete successful archive output while reporting success.
- **Codebase:** Improved cancellation cleanup so partial compression and extraction outputs are removed consistently.
- **Codebase:** Fixed Windows atomic write flow to avoid data-loss windows, and fixed `save_settings`/LRU edge cases.
- **Codebase:** Improved convert pipeline option carry-through (password, header encryption, SFX, split-volume, timestamp) and encrypted-input handling.
- **Codebase:** Refactored Rust backend modules, consolidated compression switch construction, added runtime result-shape validation, and hardened async status refresh paths.
- **Codebase:** Synced preset fallbacks with `SETTING_DEFAULTS`, documented policy boundaries and `-sfx` rationale, and clarified `from_utf8_lossy` chunk limitations.
- **Testing:** Added subset-sync test for TS/Rust allowlists.
- **Codebase:** Expanded ESLint coverage to `scripts/`, fixed `.githooks/` tracking for fresh clones, pinned GitHub Actions SHAs, added explicit workflow permissions, and cleaned up stale CI/updater config.
- **Security:** Added CI security gates with `npm audit`, `cargo audit`, and Clippy `-D warnings`.
- **Misc:** General bug fixes and final UI polish.
- **PKG:** Updated packages.

## Changes in `v0.4.0:`

### IMPORTANT: THIS IS A SECURITY UPDATE. UPDATE NOW!

- **Security:** Updated Tauri V2 updater signer key.
  - I accidentally leaked the (still encrypted) private key via a `package.json` entry on another project. Zinnia sadly shared the same signer key (bad practice; lessons learned). Rookie mistake  -  I am very sorry, I know how annoying this is. You will have to manually download and install from this release to update the pubkey.
  - Since the private key that was leaked was still encrypted with a password, it is a better state than if it was the full unencrypted privkey.
  - All previous releases and accompanying binaries have been removed from github and my mirror. The tags still remain.
- **UNZIP:** Added the new Unarchive UI feature set to all OS's! If you open an archive via your OS's context menu with Zinnia, the quick unarchive UI will open instead.
- **UNZIP:** Modified the behavior for the custom unarchiver where unarchived items now go into a folder of their own in the parent folder.
- **Licenses:** Cargo licenses are now included.
- **NEW - Basic / Advanced mode:** Added two new views for essential items only (Basic) and more for power users (Advanced).
  - Basic mode's UI is now a totally different UI from advanced with simple options and an easy/friendly UI!
  - Advanced mode's spacing has been compressed for better space efficiency.
- **PKG:** Updated packages.

---

</details>

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
- **Code Signing:** macOS releases are fully signed. Windows releases are fully signed using Azure Artifact Signing. Linux releases are GPG signed.
- **Windows installers:** Separate x64 and Arm64 installers are provided for their respective architectures.
