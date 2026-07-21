# QA: OS context menus

## Stable-release platform matrix

Record the package hash, OS build, CPU architecture, install/upgrade/uninstall
result, archive association result, and one successful compress/extract cycle
for every applicable row:

| Platform | Architecture | Required artifact/integration |
| --- | --- | --- |
| macOS 26+ | Apple silicon | Universal DMG and ZIP; Gatekeeper, notarization, Finder Services, updater |
| macOS 26+ | Intel, while supported by macOS 26 | Universal DMG and ZIP; launch, Finder Services, updater |
| Windows 11 | x64 | Signed NSIS, modern and classic Explorer menus, updater |
| Windows 11 | ARM64 | Signed ARM64 NSIS, native shell DLL, modern and classic menus, updater |
| Windows 10 | x64 | Signed NSIS, classic Explorer verbs, updater |
| Ubuntu 24.04 | x64 | AppImage, DEB, sideload Flatpak; Wayland and X11 |
| Debian 13 | x64 | Ubuntu-built AppImage and DEB |
| Fedora 43 | x64 | RPM and AppImage |

The release scripts remain platform-local. This matrix is the packaged OS
integration gate that compile smoke tests cannot replace.

**CI scope:** GitHub Actions runs quality gates, unit/coverage tests, and
unsigned `--no-bundle` smoke builds only. It does **not** produce signed NSIS,
DMG, AppImage, or sparse context-menu packages. Signed Windows modern-menu and
macOS Services behavior must be verified on release VMs using the checklists
below before publishing.

## macOS Finder Services

1. Install a packaged `.app` / DMG build (not a bare `cargo run` binary).
2. Launch Zinnia once so Services register (`NSUpdateDynamicServices`).
3. Select an archive in Finder → right-click → **Services**.
4. Confirm **Extract with Zinnia** launches quick extract (no lingering main-window flash).
5. With Zinnia not running, use **Compress with Zinnia** from Finder: main opens for compress; later Extract must not destroy that workspace.
6. Settings → **OS Integration** → **Finder Services**: **Enabled** only when both
   services have an explicit enable toggle in `pbs` prefs; otherwise **Not enabled**
   (not Unknown). Registration is confirmed via `pbs -dump_cache` for help text.
   **Enable…** opens Keyboard Shortcuts and selects **Services** (not Login Items &
   Extensions / File Providers: that UI is for Finder Sync appexes like Keka;
   Zinnia uses `NSServices`).
7. Dev tip after Info.plist changes: `/System/Library/CoreServices/pbs -flush`
   Inspect registration: `/System/Library/CoreServices/pbs -dump_cache`

> **Release gate:** On a clean macOS 26+ machine, install the signed and
> notarized universal artifact; verify both Finder Services, archive Open With,
> a signed updater check, and `spctl --assess` before publishing.

## Windows 11 modern menu

Zinnia installs as a **normal NSIS Win32 app**. The sparse `ZinniaContextMenu.msix`
is only package identity for the shell DLL (not a Store/AppX app install).

Requires a **signed** NSIS install with full `AZURE_ARTIFACT_SIGNING_PUBLISHER_DN`.

1. Confirm package + signature:
   ```powershell
   Get-AppxPackage -Name run.rosie.zinnia.contextmenu
   Get-AuthenticodeSignature "…\Zinnia\zinnia_shell.dll"   # Status = Valid
   ```
2. If registration failed, check `$INSTDIR\zinnia-context-menu-register.log`.
3. Right-click a `.zip` / `.7z` (primary menu, not “Show more options”).
4. Expect top-level **Extract with Zinnia** and **Zinnia** ▸ Extract / Compress
   (not “Zinnia Context Menu”, and not nested duplicate Zinnia arrows). Both
   entries should show the Zinnia logo (not an empty icon slot).
5. **Click** Extract and Compress: Zinnia must launch. Settings “Registered” only means the package is present.
6. Right-click a non-archive file/folder → **Zinnia** ▸ Compress only (no top-level Extract; submenu Extract disabled).
7. Right-click **empty folder background** → **Zinnia** ▸ Compress (current folder).
8. “Show more options” still shows classic verbs (including background Compress).
9. Uninstall → Appx package gone; HKCU `ZinniaCompress` keys gone.

> **Release gate:** Steps 5-7 are required before publishing a signed Windows
> beta. CI unsigned shell compile smoke does **not** satisfy this gate.
>
> Optional (not a release): after publishing updater artifacts, run
> `REQUIRE_UPDATER_LIVE=1 npm run validate:updater:live` on a networked machine
> so missing `latest-*.json` (including `*-beta-*`) fails the gate. Default CI
> fixture validation remains the pre-publish check.

### Failure modes

| Scenario                            | Expect                               |
| ----------------------------------- | ------------------------------------ |
| Unsigned / `SKIP_WIN_CODESIGN=1`    | Classic verbs only                   |
| Stub MSIX (≤1 KiB)                  | Classic verbs only                   |
| CN-only publisher DN                | Context-menu build fails             |
| MSIX missing `AllowExternalContent` | Register log shows `0x80073D2E`      |
| Reinstall / upgrade                 | Remove-before-add (see register log) |

## Classic Windows verbs

Always registered by NSIS (HKCU):

- Archives: **Open with Zinnia**, **Extract with Zinnia**
- Files/folders: **Compress with Zinnia** / **Compress folder with Zinnia**
- Folder background: **Compress with Zinnia** (`%V`)

## Linux desktop integration

Build the AppImage and DEB on Ubuntu 24.04. Test the AppImage on Ubuntu 24.04,
the DEB on Ubuntu 24.04 and Debian 13, and the RPM on Fedora 43. Exercise both
Wayland and X11 where the desktop environment supports them.

1. Install the matching DEB/RPM or launch the AppImage. For Flatpak, install
   the locally produced bundle (Zinnia is intentionally sideload-only).
2. Confirm the launcher entry, icon, archive MIME association, and desktop
   actions **Open**, **Extract**, and **Compress** appear in the file manager.
3. Exercise each action with a ZIP and 7z archive, a normal file, a folder, and
   an encrypted archive. Confirm the destination is correct and no action
   prompts for network access.
4. On Flatpak, confirm the selected archive and destination work through the
   intentional home-filesystem permission, then inspect
   `flatpak info --show-permissions run.rosie.zinnia` for only the documented filesystem, display,
   IPC, and DRI permissions.
5. Confirm the Ubuntu 24.04-built AppImage starts on Ubuntu 24.04; this catches
   accidental glibc drift from a newer build host.

> **Release gate:** Complete the package-specific matrix above before publishing
> a stable Linux artifact. One distro is not a substitute for the others.
