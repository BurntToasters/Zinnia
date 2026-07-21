> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                          | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux        |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-macOS.dmg)**   | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-Linux-x64.AppImage) |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>-->                     | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-macOS.zip)**   | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-Linux-x64.deb)           |
| <!--*See MSI note below*-->                                                                                                                                                                                                |                                                                                                                 | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-Linux-x64.rpm)           |
|                                                                                                                                                                                                                            |                                                                                                                 | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia-Linux-x64.flatpak)   |

> macOS downloads require macOS 26 or later.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
> ⚠️ Arm64 Linux Binaries are _NOT_ available at the moment. Its something I may get around to in the future but its not a priority. However, I do have the logic setup in the repo in-case people would like to build their own :)

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2!

## Changes in `v0.6.0-beta.4:`

- **Fix:** Updater manifest validation accepts Tauri’s prehashed Minisign alg id (`ED`) as well as legacy `Ed`.
- **Fix:** Updater signature verifier uses a heap read buffer (avoids Windows stack overflow / exit `3221225725` on large installers).
- **Fix:** Flatpak source export keeps git porcelain leading spaces (so ` M gen/schemas…` is recognized) and allows dirty generated ACL schemas after `tauri build`.
- **Fix:** macOS zip verifier expects the 7z sidecar to carry the same `allow-jit` entitlement Tauri applies from `entitlements.plist`.
- **Fix:** Windows sparse context-menu MSIX packing uses `makeappx /nv` and UTF-8-without-BOM manifests (fixes “manifest is not valid”).
- **Fix:** macOS release entitlement verify requests `codesign --xml` so plutil can parse modern entitlements dumps (not `[Dict]` text).
- **CI:** macOS rust-check and smoke-build runners pin `macos-26` (not `macos-latest` / macOS 15) so bundled 7-Zip and `minimumSystemVersion` 26.0+ can execute.
- **Reliability:** Archive commit/rollback finalization runs on `spawn_blocking` so large extract trees do not stall the async runtime; the operation slot is cleared even if that task panics (avoids soft-lock until restart).
- **Reliability:** Timed-out OS integration commands kill the process group (Unix) or process tree (`taskkill /T`, Windows) so descendant pipe holders cannot leave reader threads blocked.
- **Compatibility:** macOS builds require macOS 26 or later because the official bundled 7-Zip 26.02 binary has a native macOS 26 deployment floor; the bundle and release checks enforce 26.0+.
- **Security:** Extract preflights archive member paths (`7z l -slt`) and rejects `..` / absolute paths that could write into existing sibling folders; sibling name snapshot still catches new top-level escapes.
- **Security:** Windows staging ACL verify uses SID/SDDL (`icacls /save`) instead of locale-specific account-name matching; broad principals are removed by well-known SID (unblocks Desktop compress where name-only verify failed).
- **Fix:** Directory fsync `PermissionDenied` is ignored only on Windows (Unix still surfaces the error).
- **Fix:** Pending stage registry cleans orphan `.zinnia-*` dirs after a crash before the transaction journal is written; recovery journal is written immediately after staging is created.
- **Fix:** Removed Absolute path archive creation because those unsafe member paths correctly fail Zinnia's extraction preflight; all new archives are relocatable.
- **Security:** Extraction preflight and extraction now use the same private snapshot of the complete input volume family, closing the normal source-path mutation window.
- **Security:** Updater publication cryptographically verifies every artifact/Minisign pair with Zinnia's embedded public key and validates the generated manifests before upload.
- **Security:** 7-Zip provenance records the exact official 26.02 archives, archive hashes, and extracted members; checksum updates require an explicit reviewed version.
- **macOS:** Default-archiver integration now uses macOS 26 `NSWorkspace` and `UTType` APIs instead of deprecated Launch Services/CoreServices calls; signed artifacts enforce an exact entitlement allowlist.
- **Windows:** Authenticode verification now checks the full certificate Subject DN in addition to the publisher Common Name.
- **Linux:** Flatpak builds consume an exact clean Git commit export so dirty or untracked workspace files cannot enter sideload bundles.

## Changes in `v0.6.0-beta.3:`

- **Fix:** Setup wizard Skip no longer fails with Windows `Access is denied (os error 5)` from AppData directory fsync; startup continues if settings persistence warns.
- **Fix:** Basic-mode titlebar no longer meshes brand text with Support/Settings on Windows (hide centered logo while chrome overlays the strip).

## Changes in `v0.6.0-beta.2:`

- **Fix:** Sparse context-menu MSIX declares `uap10:AllowExternalContent` (fixes `Add-AppxPackage -ExternalLocation` `0x80073D2E`).

## Changes in `v0.6.0-beta.1:`

_I had so many new ideas for the UI this turned from version `0.5.4` to `0.6.0`._

- **UI:** Major Basic mode redesign: drop-first home, warmer floral accent, friendlier copy, and Basic/Power + Support + Settings folded into the custom titlebar.
- **UI:** Translucent Basic window with OS-native blur on macOS (vibrancy) and Windows (Mica / Acrylic). Linux Basic stays fully opaque. Toggle in Settings (live-applies).
- **UI:** Basic Settings sheet is roomier (sectioned tabs, collapsed title into the tab row); related General rows sit side-by-side (Updates / Appearance) with compact controls.
- **UI:** `Ctrl`/`⌘` + `,` opens Settings (listed in the keyboard shortcuts help).
- **UI:** macOS menu bar: About, Check for Updates, Settings (`⌘,`), Edit/Window standards, plus Help (shortcuts, Support, Licenses).
- **UI:** macOS Finder Services: Extract with Zinnia / Compress with Zinnia; OS Integration tab shows Enabled/Off/Unknown and an Enable button that opens Keyboard Shortcuts → Services.
- **UI:** Windows 11 modern context menu (signed NSIS): **Zinnia** submenu (Extract / Compress) plus top-level **Extract with Zinnia** on archives; classic Explorer verbs kept for Show more options. Uses a sparse identity MSIX for the shell DLL only — Zinnia remains a normal NSIS install (not a Store/AppX app). OS Integration shows Registered / Not registered.
- **Fix:** Win11 shell DLL resolves `zinnia.exe` beside itself or in the parent dir; NSIS finds the register script next to the DLL (`$INSTDIR`); Appx remove-before-add with visible install warning on failure; builds require full `AZURE_ARTIFACT_SIGNING_PUBLISHER_DN`.
- **Fix:** macOS Services Extract no longer forces the main window open (keeps quick-extract); cold-start fallback is cancelled/hidden to avoid a main-window flash; `NSApplicationIdentifier` nested under `NSRequiredContext`; Extract UTIs use `public.archive` (not broad `public.data`).
- **Fix:** Win11 modern menu + classic NSIS verbs register on folder background (`Directory\Background`); shell DLL resolves the open folder via Explorer site when selection is empty.
- **Fix:** macOS Services Compress cancels the cold-start main-window fallback so a later Extract cannot destroy that workspace; the 150ms fallback also skips if main already exists.
- **Fix:** Basic Escape/Enter shortcuts respect overlay `[hidden]` (modals no longer swallow keyboard).
- **Fix:** Basic Settings category tabs hide inactive panels again (Compression / OS / About no longer stuck under General).
- **Fix:** Opaque native background when FX are off / unsupported; Windows Acrylic tint follows light/dark theme.
- **Fix:** Basic completion surfaces real `errorDetail` text and output/extract path labels; recent archives list on home.
- **Fix:** Quick-extract no longer leaves a Dock/app zombie after the window closes. “Keep ready after quick extract” is off by default; when enabled, macOS hides the Dock and uses a menu-bar tray until idle timeout or Quit.
- **Fix:** Warm-idle exit re-checks on the main thread so a newly opened extract window cannot race an idle quit; waking from warm clears the tray; tray has Open Zinnia (left-click / menu).
- **Fix:** Extract-window teardown clears bindings on OS close; extract capability no longer allows direct `destroy` (must use cancel-aware close).
- **Security:** Extract promote rejects sibling writes outside the stage directory; `run_7z` re-validates archive headers for extract/list/test; `probe_7z` attests 7-Zip version for the Windows RAR gate.
- **Security:** Base file associations omit `.rar` (macOS/Linux configs re-add); Unix promote opens use `O_NOFOLLOW` where available.
- **CI:** `validate:changelog` + `validate:updater` run inside `npm run test:all`. Job renamed to `smoke-build` (unsigned `--no-bundle` only); signed releases stay on build VMs.
- **Known:** Windows RAR **extraction** stays disabled while attested 7-Zip remains ≤ `26.02` (CVE-2026-58052); browse/test for RAR remain available.
- **Known:** Archive passwords are passed to 7-Zip via `-p` and can appear in process listings even when entered in the UI (see `SECURITY.md`).

## Changes in `v0.5.4-beta.3:`

- **Fix:** Quick-extract no longer leaves a Dock/app zombie after the window closes. “Keep ready after quick extract” is off by default; when enabled, macOS hides the Dock and uses a menu-bar tray until idle timeout or Quit.
- **Fix:** Warm-idle exit re-checks on the main thread so a newly opened extract window cannot race an idle quit; waking from warm clears the tray; tray has Open Zinnia (left-click / menu).
- **Fix:** Extract-window teardown clears bindings on OS close; extract capability no longer allows direct `destroy` (must use cancel-aware close).
- **Security:** Extract promote rejects sibling writes outside the stage directory; `run_7z` re-validates archive headers for extract/list/test.
- **UI:** Basic mode home redesign (drop-first layout, friendlier copy, warmer floral accent). On macOS/Windows, Basic can use a translucent window with OS-native blur (toggle in Settings); Linux Basic stays opaque.
- **UI:** In Basic mode, Basic/Power, Support, and Settings sit in the custom titlebar; Power keeps the separate header row.

## Changes in `v0.5.4-beta.2:`

- **Performance:** Quick-extract (file association / Open with Zinnia) injects archive + destination at window create, skips recovery lock when no journal exists, lazy-loads the password prompt, and can stay warm for faster follow-up opens.
- **Settings:** “Keep ready after quick extract” toggle plus idle timeout (5/10/30/60 minutes).
- **UI:** Quick-extract status no longer flashes missing-glyph boxes from noisy 7-Zip progress text; `hidden` controls work again in both main and extract windows.
- **UI:** Prefer system fonts before Segoe so non-Latin glyphs fall back correctly on macOS.

## Changes in `v0.5.4-beta.1:`

- **Security:** Hardened extract staging against Windows reparse points (junctions/cloud placeholders), not only classic symlinks.
- **Security:** Main-window “open folder” is limited to destinations from recent successful compress/extract; extract windows bind `-o` and open-folder to the spawn-time destination.
- **Security:** Tightened 7z extra-arg allow-lists (dropped `-ssw`, narrowed `-m*`), require a safe extract overwrite policy (`-aou`/`-aos`), and redact `-p` secrets in backend output/logs.
- **Security:** Interrupted-transaction recovery only accepts strict `.zinnia-extract-` / `.zinnia-archive-` stage directory names.
- **Windows:** RAR **extraction** stays disabled while bundled 7-Zip remains on `26.02` (CVE-2026-58052); browse/test for RAR remain available. File associations still omit `.rar` on Windows.
- **Basic mode:** Compress runs force relative path mode and disable update-mode so Power-only options cannot leak into Basic.
- **UI:** Password sync and browse/extract flows improved across Basic and Power; convert extract uses the same safe overwrite policy as other extract paths.
- **CI:** Updater manifest JSON fixtures are schema-checked; unsigned release dry-run covers Linux, macOS, and Windows.
- **Docs:** Clarified Flatpak filesystem access, open-folder allowlists, and the temporary Windows RAR extract restriction in `SECURITY.md`.
- **Misc:** General bug fixes and reliability improvements around staging, cancel/close, and journal recovery.

## Changes in `v0.5.3:`

- **Misc:** General bug fixes and improvements.
- **Release reliability:** Release-asset mirroring now reports source/destination failures and stops before VM cleanup; script entrypoints no longer depend on path-string comparisons.
- **Dependencies:** Updated JavaScript and Rust dependencies using the current stable toolchain.

## Changes in `v0.5.1:`

- **License menu:** Fixed an issue with the license menu rendering in basic mode.

* **NEW - Windows code signing:** WOO HOO!! Windows Binaries are now signed by Azure Artifact Signing!
  - After a good while of not having it, Windows Binaries are now signed by Azure Artifact Signing!
* **Windows security:** Temporarily disabled RAR operations and RAR file associations while conflicting CVE-2026-58052 affected-version data is resolved.

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

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
- **Code Signing:** macOS releases are fully signed. Windows releases are fully signed using Azure Artifact Signing. Linux releases are GPG signed.
- **Windows installers:** Separate x64 and Arm64 installers are provided for their respective architectures.
