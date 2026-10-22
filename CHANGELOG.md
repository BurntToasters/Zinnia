# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                          | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux        |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-macOS.dmg)**   | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-Linux-x64.AppImage) |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>-->                     | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-macOS.zip)**   | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-Linux-x64.deb)           |
|                                                                                                                                                                                                                            |                                                                                                                 | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-Linux-x64.rpm)           |
|                                                                                                                                                                                                                            |                                                                                                                 | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.5/Zinnia-Linux-x64.flatpak)   |

> macOS downloads require macOS 26 or later.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
> ⚠️ Linux ARM64 AppImage/DEB/RPM are published only when that release is built for ARM64; Flatpak stays x64.

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2!

## Changes in `v0.6.5:`

- **7Zip:** Updated `7-Zip` to `26.05`.
- **7-Zip:** Updated bundled 7-Zip to `26.05`.

## Changes in `v0.6.4:`

- **Security:** Updated PKGs to address: https://arstechnica.com/security/2026/10/the-internet-goes-on-high-alert-after-discovery-of-8-compromised-tls-certs/

## Changes in `v0.6.3:`

- **Security - Downloaded files:** On macOS, files extracted from a downloaded archive now keep the download warning (quarantine), so Gatekeeper still checks apps that came out of an archive. Converting or updating a downloaded archive now keeps its download warning on macOS and Windows. The new archive is marked before it is saved, so an unmarked copy is never left on disk.
- **Security - Windows:** Extracted folders no longer keep the read-only or system attribute. An archive can no longer make Explorer apply its own `desktop.ini` (for example, a folder icon loaded from a network share) to the folders it creates.
- **Security - Encryption:** The backend always uses AES-256 instead of the weaker ZipCrypto when files are added with a password to an existing ZIP archive, even one whose name does not end in `.zip`.
- **Security - Paths:** Folder names that Zinnia derives from an archive name now avoid Windows device names (such as `CON` or `NUL`), `:` streams, and shell folder IDs (`name.{GUID}`) on every platform. On Windows, **Open destination** refuses folders with such names.
- **Security - Extraction:** ZIP archives that contain symbolic links are always handled with Zinnia's extra link safety checks. 7-Zip still refuses any link pointing outside the destination.
- **Security - Updater:** Zinnia never installs an update whose version is not newer than the installed one. Update signatures with a non-standard encoding are rejected.
- **Security:** Progress updates (including file names) and debug console output only reach the window that started the operation, instead of every open window.
- **Security:** Release and maintenance scripts no longer skip their work silently when run through a symbolic-linked path. Bundled 7-Zip updates require identical downloads from both official sources (7-zip.org and GitHub).
- **NEW - Archive I/O diagnostics:** Optional archive I/O phase diagnostics in the Debug Console. Diagnostics are disabled outside debug mode and redact archive paths and passwords.
- **Performance:** Reduced avoidable archive and destination copies, added stable snapshots and bounded metadata/finalization workers, and combined final validation, quota, durability, and fingerprint passes while preserving containment, rollback, cancellation, MOTW, and crash recovery. Settings and log writes no longer freeze the window on slow or network drives.
- **Compatibility:** Expanded operation and output verification across ZIP, 7z, and TAR, with separate reporting for encrypted, split, link-bearing, RAR, and unsupported filesystem or custom-ACL cases.
- **Benchmarking:** Added cross-platform Zinnia archive benchmarks for PR smoke and nightly/manual x64 and ARM64 runs. Reports compare Zinnia with bundled 7-Zip without letting timing ratios block CI.
- **Fix - Quick extract:** The extract window reliably closes when its auto-close countdown ends. Previously, mouse events without real movement, or pressing `Alt` to switch away with `Alt+Tab`, could silently cancel the countdown and leave the window open.
- **Change - Quick extract:** Moving the mouse over the extract window pauses the countdown and shows **Close (paused)**. Moving the mouse out of the window, or switching to another window, restarts it. Pressing a key (other than `Alt`, `Ctrl`, `Shift`, or the Windows/Command key) or clicking still cancels it. The countdown stays on time when the window is covered or in the background.
- **Fix - Quick extract (macOS):** Opening Settings, Check for Updates, or another app-menu item during a quick extract keeps the main window open after the extract window closes.
- **Fix - Updater:** Large updates no longer fail on slow connections. Downloads now fail only if the connection stalls for 120 seconds, instead of after 120 seconds in total.
- **Fix - Recovery:** A crash at one specific point during extraction no longer leaves a recovery state that blocks later archive operations; recovery still refuses anything it cannot verify. If a newer Zinnia version leaves an unfinished archive job and you open an older version, the older version leaves the files alone and explains how to finish the job. You can still clear it with **Accept**.
- **Fix - Extraction:** `.bz2` and `.xz` files that store no file name inside (the usual case) now extract instead of failing with "Could not parse archive member paths from 7-Zip listing."
- **Fix - Open destination (macOS):** Opening an extracted folder whose name looks like an app or package shows it in Finder instead of launching it.
- **Fix - Browse:** Archive entry names containing text like `-p...` or `password=` are no longer altered in the file list, so selective extraction finds them.
- **Fix - Logs:** Exporting logs no longer freezes the app while the save dialog is open.
- **Fix - Basic mode:** Choosing a different archive from the Extract or Browse archive card updates the shown archive name and the automatic destination. A destination you typed yourself is kept.
- **Fix - Basic mode:** Form fields are locked while an operation runs, so the completion message and Recents always show the archive that was actually created.
- **Fix - Presets:** Custom presets with default (empty) options, such as most ZIP presets, no longer disappear after restarting Zinnia.
- **Fix - Command line:** Relative paths passed to an already-running Zinnia (for example `zinnia --compress ./file.txt` from another folder) resolve against the folder you ran the command from.
- **Fix - Windows:** Read-only archives are snapshotted by copy instead of hard link, so cleanup can no longer clear the read-only flag on your original file.
- **Fix - Debug Mode:** Popping out the debug mode console no longer causes a white screen and an unresponsive console.
- **Release:** Publishing refuses a release whose existing tag points at a different commit. Replacing an existing release asset uploads the new file before removing the old one.
- **Codebase:** `npm run b` and `npm run r` refuse to run when the local `beta` or `main` branch has commits that were never pushed.
- **Testing:** End-to-end coverage for the extract-window countdown, crash recovery at each stage of extracting and creating archives, cancelling, unsafe archives, split archives, adding files, and the release process. CI runs these on ARM Windows and ARM Linux.
- **PKG:** Updated packages, including Tauri 2.12, TypeScript 7, Vitest 5, and minimum npm 12.0.2.
- **7-Zip:** Updated bundled 7-Zip to `26.04`.

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
- **Security:** Archive create/update stores symlinks and hard links (`-snl`/`-snh`) for `.app`/`.framework` round-trips; safe contained and dangling relative links publish normally while absolute and escaping links remain blocked.
- **Fix:** Compound TAR streams browse, test, and extract in one operation; Windows now packages full `7z.exe` plus `7z.dll` for RAR support with NTFS stream suppression and Mark-of-the-Web propagation.
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
  - I accidentally leaked the (still encrypted) private key via a `package.json` entry on another project. Zinnia sadly shared the same signer key (bad practice; lessons learned). Rookie mistake - I am very sorry, I know how annoying this is. You will have to manually download and install from this release to update the pubkey.
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
