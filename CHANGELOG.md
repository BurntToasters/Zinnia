# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                          | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux        |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-macOS.dmg)**   | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-Linux-x64.AppImage) |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>-->                     | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-macOS.zip)**   | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-Linux-x64.deb)           |
|                                                                                                                                                                                                                            |                                                                                                                 | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-Linux-x64.rpm)           |
|                                                                                                                                                                                                                            |                                                                                                                 | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.7.0-beta.1/Zinnia-Linux-x64.flatpak)   |

> macOS downloads require macOS 15 or later.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
> ⚠️ Linux ARM64 AppImage/DEB/RPM are published only when that release is built for ARM64; Flatpak stays x64.

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2!

## Changes in `v0.7.0-beta.1:`

### Breaking

- Settings no longer restore from `.bak` backups. Old setting names that Zinnia no longer uses are removed the next time settings are saved. Upgrading from 0.6.x does not show the setup wizard again.
- SFX, delete-after-archive and path-mode options were removed from Settings and the compress form.
- Recovery records from older Zinnia versions are no longer restored automatically, and incomplete recovery records are refused. Your files are left in place. Use 0.6.2 to finish an older recovery, or dismiss the recovery banner to clear it.
- Users who never saved compression values now start with the Balanced preset (dictionary 64 MB, solid block 4 GB). Values you saved are kept.

### Compress and extract

- Power's first mode tab is now **Compress**. The Basic home card still says "Make an archive", and its buttons say **Compress**.
- Compress output is labelled **Output archive**, and extract targets are labelled **Destination folder**. In Basic, the output save button is **Choose location**.
- The selective picker is **Extract selected** everywhere: the quick action, the Browse button, the picker title, and the shortcuts list. Listing is **List contents**.
- Update mode asks "Replace" or "Add files" based on the Update checkbox at the moment you click Run. A successful update says "Archive updated."
- Changing the format swaps the output file extension, including `.tar.gz` and `.tgz`. A typed archive name keeps the folder you chose with Browse. A name with a slash is refused with a message.
- The Store preset writes ZIP entries without compression, and level 0 no longer leaves a stale dictionary setting behind.
- Split volumes such as `a.7z.001` use the base name (`a`) for the default folder.
- Custom preset names reject built-in names such as `constructor`, and names are limited to 64 characters.
- Command preview quotes paths with spaces and escapes quotes, and masks passwords before quoting.
- A 7-Zip failure shows a plain hint (for example, wrong password, not an archive, or permission denied) instead of raw 7-Zip text. The hint matches 7-Zip 26.06 output.
- Passwords you typed stay in place when a run fails before 7-Zip starts, and are cleared once 7-Zip has started.
- Adding files to an encrypted 7z or ZIP requires the archive password and checks it before writing. Before this, an empty or wrong password could store new files unencrypted or under a different key.
- Adding files to a ZIP with ZipCrypto members is refused. Convert it to an AES-256 ZIP first.
- Add files and Convert show a percent and ETA, and clear their progress line on success, failure and cancel.
- Compress and extract progress reaches the UI while the run is live, and the bar reaches 100% on success.
- Power's Cancel shows "Could not cancel" and keeps the running state when the cancel request fails.
- Benchmark runs in the normal busy state. Cancel stops it and shows "Benchmark cancelled." The rating is labelled MIPS.

### Convert

- Convert has its own dialog. It no longer reads hidden Add-tab settings. Each time it opens, it defaults to 7z with no password.
- Converting an encrypted archive without an output password asks first. Declining writes nothing and keeps your typed values.
- Convert refuses to write over the source archive, and refuses an extension that does not match the chosen format.
- Split size and file-name encryption are checked in the dialog before anything runs.
- Esc and Ctrl+Enter stay in the dialog while it is open.

### Browse and extraction

- Browse lists archives with listings up to 64 MiB, which covers archives with tens of thousands of entries. The archive listing is shown in full, not as a partial list.
- Extraction checks archives with listings up to 256 MiB, up from 32 MiB. Extracting 30,000 files publishes every file.
- Selective extract accepts large selections, such as 9,000 files, which used to fail.
- Selective extract handles names that start with `-`, such as `-notes.txt`, `-web/app.js` and `-sidebar.png`, and names with leading or trailing spaces or quotes.
- The extraction safety check waits as long as the archive size needs, so a large TAR on a slow USB stick or network share no longer fails after two minutes.
- When Zinnia copies an archive before reading it, the copy shows progress and can be cancelled.
- A ZIP with data after its end extracts with a warning instead of an error.
- Basic progress shows the current file name without its folder path.

### Basic mode

- Basic progress shows a percent and ETA while the bar moves. The label stays "Compressing..." or "Extracting..." during the run.
- Cancelling a Basic run shows its own "Cancelled" result, not an error.
- Basic validation problems show "Check your choices" instead of "Operation failed." The busy message says an operation is already running.
- Repeat buttons are enabled only after an action that can be repeated.
- Basic's open-archive dialogs include split first volumes (`.001`) and an "All files" option.
- Basic browse of a header-encrypted archive asks for the password. A wrong password asks again, and Cancel ends the browse without an error.
- A large archive whose encryption state cannot be checked no longer shows a password prompt with no way to skip it.
- Extract all uses the browse password only for the archive it was typed for.
- The native save dialog confirms an overwrite once, not twice.
- Enter with IME composition (Japanese, Chinese, Korean) no longer opens a dialog, starts a browse, or starts an extraction in Basic.

### Password prompts

- A wrong password opens the prompt again with "Incorrect password." Cancel ends the run.
- The password prompt has a Show/Hide toggle. An empty submit keeps the prompt open with a message.

### Picker and activity log

- Toggling an entry in search results keeps keyboard focus where it was.
- Toggling and typing in the picker are faster on large archives.
- The picker sorts numbers naturally (`file2` before `file10`) and keeps folders first.
- The activity log keeps the newest 1,000 lines and appends faster.

### Quick extract

- A failed quick extract offers **Retry**. Retry is not offered for validation failures.
- Cancelling a quick extract shows an empty progress bar every time.
- Copy details falls back to a plain copy when the clipboard is blocked, and says "Copy failed" if that fails too.

### Settings and setup

- A corrupt `settings.json` is moved aside as `settings.json.corrupt-<UTC time>` and replaced with new settings, so Save works again. The original file is kept next to it.
- The compression method list follows the selected format. Saved methods that the format does not support are reset when settings load.
- Closing Settings with unsaved changes asks before discarding them. Save never asks.
- The reset confirmation names what is removed: settings, custom presets, the recent list and logs.
- Setup wizard steps all have Skip, and Esc closes the wizard. Choosing Basic when the wizard is re-run updates the Basic view.
- On first run, the thread count uses the detected CPU count. If detection fails, it uses 8.
- Local logging is described accurately: it writes operations, paths and errors to a log file on this device.

### Windows, macOS and Linux

- Closing or quitting while an operation runs asks for confirmation. Declining keeps the operation running. Accepting cancels it safely and then closes.
- Files dropped or handed to Zinnia during a running job are queued, and a toast says they will be added when the current operation finishes.
- Hand-offs over 4,096 new items show the same limit message as drops.
- The Power window saves its restored size after maximize or full screen. Double-clicking the Power title bar toggles maximize.
- Right-click in text fields shows the native menu with Copy and Paste.
- macOS path and password fields no longer autocorrect, use smart dashes, or auto-capitalize.
- Finder Services ignores non-file items and refuses very large selections.
- Keyboard Shortcuts does not open over another dialog.
- Esc closes only the dialog or menu on top. Esc does not also return Basic to Home.
- The Basic Recent menu supports arrow keys, Home and End, and returns focus to its button on Esc.
- Opening a dialog places focus on a visible, enabled control.
- The status bar keeps an "Update ready" button until the update is installed or discarded.
- Choosing "Later" on the update prompt no longer asks for notification permission.
- The restart prompt does not appear during an archive operation or a background update check.

### Accessibility

- Timed toasts can be dismissed with a Dismiss button or Esc.
- Toast text keeps its line breaks and wraps long Windows paths. At most three sticky toasts stay on screen; the oldest closes when a fourth appears.
- Basic progress bars have accessible names, and the input list is announced as a group.
- Screen readers hear progress at 25%, 50% and 75%, and at the end, instead of every percent.
- Control borders meet 3:1 contrast in both themes, and text is at least 12 px.
- The density toggle keeps one label and changes its pressed state. The settings button announces that it opens a dialog.
- The hidden About logo toggle is not in the tab order.
- The selective picker keeps focus in search mode.

### Display

- File sizes show "0 B" for empty files and round fractional byte counts.

### Security

- Convert asks before it writes an unencrypted copy of an encrypted archive.
- Crash recovery only touches the destination archive and its numbered volumes. Recovery records that name other files are refused.
- Finder Services rejects very large selections before converting them.
- The updater refuses a download larger than 1 GiB instead of buffering it.
- The Windows updater uses `zip` 9, which fixes RUSTSEC-2026-0367, -0368, -0369 and -0429.

### Other

- Raw 7-Zip output is no longer shown in toasts, Basic, or the extract window. Friendly hints are shown instead, and the raw text stays in the activity log.
- The version and platform labels no longer flash placeholder text on startup.
- The keyboard shortcuts help lists Basic-mode keys.
- Saving Settings no longer stores the current Power compression values as new defaults. Use "Use current session values" to copy the Power form into Settings.
- The main window opens at the Basic workspace height instead of growing after launch.
- Finder Sync enable reports `pluginkit` errors.
- The About dialog's debug toggle is hidden from keyboard navigation.
- Bundled 7-Zip is updated to `26.06`. On macOS, Zinnia combines the separate Apple Silicon and Intel 7-Zip downloads into one universal helper. Each half is copied byte for byte from the official download. Build checks stop if a macOS download has the wrong architecture.

### Known issues

- Archives with more than about 100,000 entries extract very slowly.
- Convert cannot handle archives whose listing exceeds 64 MiB.
- Browse and extraction read the full listing before showing it. A streaming parser is not in this release.
- Quick extract does not offer "Choose another folder". Use Retry, or extract from Power.
- The read-only volume extraction fallback is not implemented. If the destination is read-only, choose a writable folder.
- Dependabot cannot watch vendored path crates, so those are updated by hand.
- Linting uses an explicit rule list. `eslint:recommended` needs the `@eslint/js` dev dependency first.

### FULL CHANGELOG:

<details>
  <summary>ℹ️ Click here to see previous major releases!</summary>

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
