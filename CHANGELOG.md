> [!NOTE]
> 🅱️ This is a BETA build.

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2! 

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> MacOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-Linux-x64.AppImage) <!--/  [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.AppImage) --> |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>--> | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-Linux-x64.deb) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.deb)--> |
| <!--*See MSI note below*--> | | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-Linux-x64.rpm) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.rpm)--> |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.4/Zinnia-Linux-x64.flatpak) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.flatpak)--> |

> [!IMPORTANT]
The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
⚠️ Arm64 Linux Binaries are *NOT* available at the moment. Its something I may get around to in the future but its not a priority. However, I do have the logic setup in the repo in-case people would like to build their own :)

## Changes in `v0.5.0-beta.4:`

- **Security:** Fixed a cancel/completion race condition that could silently delete a successfully-created archive while reporting success. Cancellation is now derived from the actual process exit code, not a flag that can be set after the child has already finished.
- **Security:** The Rust `build.rs` now verifies SHA-256 checksums of all bundled 7-Zip sidecar binaries against `7z-checksums.json` before copying them into the build output. A mismatch or missing entry fails the build.
- **Security:** `prepare-7z.js` now exits fatally if the checksum manifest is missing, unreadable, or lacks an entry for a source binary. Previously it only warned and copied anyway.
- **Security:** Added `@listfile` rejection before the `--` separator in the Rust argument validator — 7z response files are no longer passable from the frontend as defense-in-depth.
- **Security:** The extract command now requires a `-o<dir>` output directory in the Rust validator, preventing extraction into an unpredictable working directory.
- **Security:** Added a 10-minute watchdog timeout to `run_7z` — if 7z blocks on an interactive prompt (overwrite/password) it no longer hangs the single process slot forever.
- **Security:** Compression settings (`level`, `method`, `dict`, `wordSize`, `solid`) are now validated against known allow-sets when loaded from persisted settings, preventing corrupt values from reaching 7z as raw switches.
- **Security:** Passwords are now cleared from DOM input fields after a successful compress/extract operation.
- **UI:** Fixed warning badge color being unreadable on System theme + light OS — the `@media (prefers-color-scheme: light)` block was missing `--warning` and `--warning-bg` variables.
- **UI:** Basic mode compress and extract now show determinate progress bars with real percent data from 7z, matching the Power mode and extract-window behavior.
- **UI:** Bumped minimum field label font size from 10px to 11px (compact: 9px to 10px) for improved legibility.
- **UI:** Interactive target sizes (`.btn--sm`, list remove buttons, selective tree twisties) now meet the WCAG 2.2 minimum of 24x24 CSS pixels.
- **UI:** Lucide icons now render with `aria-hidden="true"` so screen readers skip decorative icons.
- **UI:** Basic mode password toggle buttons now expose `aria-pressed` state for screen readers.
- **UI:** The selective extract modal now restores keyboard focus to the trigger element on close, matching the behavior of all other modals.
- **UI:** Empty selection in the selective extract picker now shows a confirmation dialog instead of silently extracting the entire archive.
- **Convert:** "Convert archive" now threads the password field through the extract step (encrypted archives no longer fail) and carries password, encrypt-headers, SFX, split-volume, and timestamp options into the recompress step.
- **Codebase:** Added password-retry prompting to selective and batch extract paths — previously only single-file extract prompted for encrypted archives.
- **Codebase:** Fixed `save_settings` silently dropping reserved `_`-prefixed keys when the existing settings file can't be read. It now fails with an error instead of overwriting.
- **Codebase:** Fixed `atomic_write_text` on Windows using a remove-then-rename pattern that could lose the file on crash. It now renames to a `.bak` before writing, restoring from backup on failure.
- **Codebase:** Fixed the LRU cache eviction in `state.ts` incorrectly evicting a live entry when re-caching an existing key.
- **Codebase:** Custom preset fallback values now derive from `SETTING_DEFAULTS` instead of differing hardcoded strings.
- **Codebase:** Added a sync test that verifies the TypeScript extra-arg allow-list is a valid subset of the Rust allow-list, preventing silent drift.
- **Codebase:** Documented `extract-policy.ts` and `compression-security.ts` accurately — their names previously oversold the protection they provide (they handle overwrite-mode and format capabilities, not zip-slip or decompression bombs).
- **Codebase:** Added `assertRunResult` runtime shape validator for critical `invoke()` responses.
- **Codebase:** Wrapped `refreshOsIntegrationStatus` in try/catch to prevent unhandled promise rejections.
- **Codebase:** Cancelled extractions now clean up the partial output directory (previously only cancelled compressions cleaned up their partial archive file).
- **Codebase:** Documented `-sfx` as intentionally supported in the Rust allow-list with rationale.
- **Codebase:** Documented the `from_utf8_lossy` per-chunk limitation for non-ASCII filenames split across event boundaries.
- **Codebase:** Destructive npm scripts (`b`, `r`) now prompt for confirmation before running `git reset --hard` + `git clean -fd`.
- **Codebase:** CI workflow now has a `permissions: contents: read` block and all GitHub Actions are pinned to full SHA commits instead of mutable `@v4` tags.
- **PKG:** Updated packages.

## Changes in `v0.5.0-beta.3:`

- **Linux:** Fixed the password prompt and "Save preset" not working — they used a browser dialog that WebKitGTK silently blocks. Both now use an in-app dialog that works everywhere.
- **UI:** Compress and extract now show live progress with the current file and an ETA, not just at the end of the operation.
- **UI:** Batch (multi-archive) extraction now shows live progress and an N-of-M counter for the whole run.
- **UI:** The pick-files tree is now exposed to screen readers (`tree` / `treeitem` roles with expand and selection state).
- **UI:** Made the Basic mode dropzone keyboard-accessible — it now has the correct ARIA role and responds to Enter/Space so keyboard-only users can trigger the file picker without a mouse.
- **Convert:** "Convert archive" now honors your full compression options (level, method, dictionary, solid, threads) instead of using 7-Zip defaults.
- **Security:** Narrowed the webview CSP `connect-src` to `'self'` only — the GitHub domains previously listed there were only used Rust-side by the updater (not CSP-bound) and were an unnecessary webview allowance.
- **Codebase:** Fixed the pre-commit hook being silently untracked — the `.gitignore` catch-all dot-directory rule was accidentally excluding `.githooks/` (only `.github/` and `.cargo/` had exceptions). Fresh clones now get the formatting, lint, and typecheck gate active immediately after `npm install`.
- **Codebase:** `scripts/` directory is now covered by eslint (`no-explicit-any`, `no-unused-vars`); `lint` and `lint:fix` include it.
- **Codebase:** Consolidated the compression-switch building so create and convert always stay in sync, and hardened the progress listener cleanup.
- **Codebase:** Removed stale `next-0.5.0` CI branch trigger, removed dead `"dialog": true` updater config, and added inline documentation to the macOS entitlements, security policy, and process single-slot design.

## Changes in `v0.5.0-beta.2:`
* **NEW - Split archives:** Added multi-volume archive creation. Pick a volume size (100 MB, 700 MB, 1/4 GB, or custom) in the advanced compression options.
* **NEW - Custom presets:** You can now save the current compression options as a named preset, apply it later, and delete it. Presets persist between sessions.
* **NEW - Archive update:** Added an "Update existing archive" mode that adds or refreshes files inside an existing archive instead of recreating it.
* **NEW - Add files from browse:** While browsing an archive you can now add files straight into it.
* **NEW - Convert archive:** Added "Convert..." in the browse view to recompress an archive into another format.
* **NEW - CPU benchmark:** Added a benchmark in Settings to measure compression speed and help pick a thread count.
* **NEW - Selective extract tree:** The pick-files dialog is now a collapsible folder tree with tri-state checkboxes instead of a flat list.
* **NEW - Keyboard shortcuts help:** Press `?` to see the shortcut cheat sheet.
* **UI Modes:** Added experimental save states between basic <-> advanced.
* **UI:** Extraction now shows real progress and an ETA, plus the file currently being processed.
* **UI:** Added non-blocking toasts for successful operations instead of blocking dialogs.
* **UI:** Inputs now show inline validation badges with a reason on hover.
* **UI:** Failed operations now include a plain-language hint (wrong password, disk full, damaged archive, permission denied, and more).
* **UI:** Drag-and-drop now works from every Basic view, and a mixed drop of archives and files asks whether to extract or compress.
* **UI:** Encrypted extracts now prompt for a password and retry automatically.
* **OS Integration:** Fixed "Compress with Zinnia" from the right-click menu opening the wrong screen and failing with "Invalid parameters." It now always opens the compress view (in whichever mode you use) with your selection ready to go.
* **OS Integration:** Right-clicking an existing archive and choosing "Compress with Zinnia" now adds it as input to a new archive instead of jumping into extract.
* **OS Integration:** Installer now registers a proper "Compress with Zinnia" / "Compress folder with Zinnia" Windows entry and a Linux compress desktop action, and cleans up stale entries from older installs.
* **Security:** Hardened the Rust-side 7-Zip argument validator with a strict switch allowlist so only known-safe switches can reach the sidecar, even if the UI is bypassed.
* **Security:** ZIP archives with a password now use AES-256 instead of legacy ZipCrypto.
* **Security:** The argument validator now also rejects `..` path segments as defense-in-depth, and passwords are kept out of logs and the command preview.
* **Security:** Bundled 7-Zip binaries are now checksum-verified against a tracked manifest on every build; a mismatch fails the build.
* **Codebase:** Split the Rust backend out of one file into focused modules and de-duplicated the 7-Zip spawn logic.
* **Codebase:** Cancelling a compression now deletes the partial output instead of leaving a corrupt file behind.
* **Testing:** Added Rust integration tests that exercise the real bundled 7-Zip end to end, raised the coverage gate, and added a pre-commit hook.
* **Codebase:** CI now runs `npm audit`, `cargo audit`, and Clippy (`-D warnings`) as a security gate.
* **Misc:** Added Dependabot and CONTRIBUTING / ARCHITECTURE / SECURITY docs.

[i] This changelog is made using the BCLS Standard: https://github.com/BurntToasters/BCLS
