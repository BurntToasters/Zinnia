> [!NOTE]
> 🅱️ This is a BETA build.

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2! 

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> MacOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-Linux-x64.AppImage) <!--/  [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.AppImage) --> |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>--> | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-Linux-x64.deb) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.deb)--> |
| <!--*See MSI note below*--> | | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-Linux-x64.rpm) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.rpm)--> |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.2/Zinnia-Linux-x64.flatpak) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.flatpak)--> |

> [!IMPORTANT]
The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
⚠️ Arm64 Linux Binaries are *NOT* available at the moment. Its something I may get around to in the future but its not a priority. However, I do have the logic setup in the repo in-case people would like to build their own :)

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
* **UI:** Extraction now shows real progress and an ETA, plus the file currently being processed. 📈
* **UI:** Added non-blocking toasts for successful operations instead of blocking dialogs.
* **UI:** Inputs now show inline ✓ / ✗ validation badges with a reason on hover.
* **UI:** Failed operations now include a plain-language hint (wrong password, disk full, damaged archive, permission denied, and more).
* **UI:** Drag-and-drop now works from every Basic view, and a mixed drop of archives and files asks whether to extract or compress.
* **UI:** Encrypted extracts now prompt for a password and retry automatically.
* **OS Integration:** Fixed "Compress with Zinnia" from the right-click menu opening the wrong screen and failing with "Invalid parameters." It now always opens the compress view (in whichever mode you use) with your selection ready to go.
* **OS Integration:** Right-clicking an existing archive and choosing "Compress with Zinnia" now adds it as input to a new archive instead of jumping into extract.
* **OS Integration:** Installer now registers a proper "Compress with Zinnia" / "Compress folder with Zinnia" Windows entry and a Linux compress desktop action, and cleans up stale entries from older installs.
* **Security:** Hardened the Rust-side 7-Zip argument validator with a strict switch allowlist so only known-safe switches can reach the sidecar, even if the UI is bypassed. 🔒
* **Security:** ZIP archives with a password now use AES-256 instead of legacy ZipCrypto.
* **Security:** The argument validator now also rejects `..` path segments as defense-in-depth, and passwords are kept out of logs and the command preview.
* **Security:** Bundled 7-Zip binaries are now checksum-verified against a tracked manifest on every build; a mismatch fails the build.
* **Codebase:** Split the Rust backend out of one file into focused modules and de-duplicated the 7-Zip spawn logic.
* **Codebase:** Cancelling a compression now deletes the partial output instead of leaving a corrupt file behind.
* **Testing:** Added Rust integration tests that exercise the real bundled 7-Zip end to end, raised the coverage gate, and added a pre-commit hook.
* **DEV:** CI now runs `npm audit`, `cargo audit`, and Clippy (`-D warnings`) as a security gate.
* **Misc:** Added Dependabot and CONTRIBUTING / ARCHITECTURE / SECURITY docs.

## Changes in `v0.5.0:`
* **UI:** Reworked Basic mode into a task-first launcher for opening, extracting, and compressing archives.
* **OS Integration:** Added Settings and setup wizard guidance for default archive app setup.
* **OS Integration:** Added Windows Explorer open/extract verbs and Linux desktop actions where supported.
* **DEV:** Direct Cargo doc/check commands now prepare required ignored 7-Zip sidecar binaries automatically.

## Changes in `v0.4.2:`
* **7Zip:** Updated 7Zip to `26.01`
* **PKG:** Updated packages.

## Changes in `v0.4.0:`
### IMPORTANT: THIS IS A SECURITY UPDATE. UPDATE NOW!

* **Security:** Updated Tauri V2 updater signer key.
  * I accidentally leaked the (still encrypted) private key via a package.json entry on another project. Zinnia sadly shared the same signer key (bad practice; lessons learned). Rookie mistake I am very sorry I know how annoying this is. You will have to manually download and install `v0.9.2` from this release to update the pubkey.
  * Since the private key that was leaked was still encrypted with a password, it is a better state than if it was the full unencrypted privkey.
  * All previous releases and accompanying binaries have been removed from github and my mirror. The tags still remain.
* **UNZIP:** Added the new Unarchive UI feature set to all OS's! If you open an archive via your OS's context menu with Zinnia, the quick unarchive UI will open instead :)
* **UNZIP:** Modified the behavior for the custom unarchiver where unarchived items now go into a folder of their own in the parent folder.
* **Licenses:** Cargo licenses are now included.
* **NEW - Basic / Advanced mode:** Added two new views for essential items only (Basic) and more for power users (Advanced).
  * Basic mode's UI is now a totally different UI from advanced with simple options and an easy/friendly UI!
  * Advanced mode's spacing has been compressed for better space efficiency.
* **PKG:** Updated packages.

<details>
<summary>Full changelog</summary>

v0.5.0 introduces a rebuilt task-first Basic mode, expanded OS integration setup guidance, and platform launcher/context integration improvements.

</details>

[i] This changelog is made using the BCLS Standard: https://github.com/BurntToasters/BCLS
