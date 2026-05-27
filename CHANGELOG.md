> [!NOTE]
> 🅱️ This is a BETA build.

### ℹ️ Enjoying Zinnia? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Zinnia! A cross platform 7Z gui frontend built on Tauri V2! 

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> MacOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **EXE: [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-Linux-x64.AppImage) <!--/  [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.AppImage) --> |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>--> | **[Universal ZIP](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-Linux-x64.deb) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.deb)--> |
| <!--*See MSI note below*--> | | **RPM:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-Linux-x64.rpm) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.rpm)--> |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/Zinnia/releases/download/v0.5.0-beta.1/Zinnia-Linux-x64.flatpak) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.flatpak)--> |

> [!IMPORTANT]
The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
⚠️ Arm64 Linux Binaries are *NOT* available at the moment. Its something I may get around to in the future but its not a priority. However, I do have the logic setup in the repo in-case people would like to build their own :)

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
  * Advanced mode's spacing has been compressed for better space efficency.
* **PKG:** Updated packages.

<details>
<summary>Full changelog</summary>

v0.5.0 introduces a rebuilt task-first Basic mode, expanded OS integration setup guidance, and platform launcher/context integration improvements.

</details>

[i] This changelog is made using the BCLS Standard: https://github.com/BurntToasters/BCLS
