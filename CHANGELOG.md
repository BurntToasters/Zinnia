<!-- > [!NOTE]
> 🅱️ This is a Beta build. -->

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-Linux-x64.AppImage) |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>--> | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-Linux-x64.deb) |
| <!--*See MSI note below*--> | | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-Linux-x64.rpm) |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.3/Zinnia-Linux-x64.flatpak) |

> [!IMPORTANT]
The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
⚠️ Arm64 Linux Binaries are *NOT* available at the moment. Its something I may get around to in the future but its not a priority. However, I do have the logic setup in the repo in-case people would like to build their own :)

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2!

## Changes in `v0.5.3:`

- **Misc:** General bug fixes and improvements.
- **Release reliability:** Release-asset mirroring now reports source/destination failures and stops before VM cleanup; script entrypoints no longer depend on path-string comparisons.
- **Dependencies:** Updated JavaScript and Rust dependencies using the current stable toolchain.

## Changes in `v0.5.1:`
* **License menu:** Fixed an issue with the license menu rendering in basic mode.
- **NEW - Windows code signing:** WOO HOO!! Windows Codesigning is here!
  - After a good while of not having it, Windows Binaries are now signed by Azure Artifact Signing!
- **Windows security:** Temporarily disabled RAR operations and RAR file associations while conflicting CVE-2026-58052 affected-version data is resolved.

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
