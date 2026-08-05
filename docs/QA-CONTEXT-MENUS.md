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

## macOS Finder context menu (Finder Sync)

1. Install a packaged `.app` / DMG build that embeds `Contents/PlugIns/ZinniaFinderSync.appex`.
2. Launch Zinnia once so the extension is registered, then quit it before the
   cold-launch checks below.
3. Settings → **OS Integration** → **Finder context menu** → **Enable…**
   (or System Settings → General → Login Items & Extensions → enable **Zinnia Finder**).
4. With Zinnia stopped, select an archive in Finder → right-click → **Extract
   with Zinnia**. Confirm quick extract receives the selected path (not merely
   an activated empty app window).
5. Keep Zinnia running, select a file/folder → **Compress with Zinnia** from
   the primary menu. Confirm the already-running app receives that new request.
6. Confirm both items are in Finder's **primary** menu (not only under Services),
   then refresh OS Integration: Finder context menu shows **Enabled**.
7. Trigger Compress and then Extract rapidly. Confirm they arrive oldest-first,
   exactly once, and no action from a failed/aborted launch appears more than 120
   seconds later.
8. On the release VM, verify `codesign -dvvv` reports the same `TeamIdentifier`
   for the app, Finder Sync appex, and `Contents/MacOS/7z`. Confirm both app and
   appex entitlements contain exactly
   `<TeamIdentifier>.run.rosie.zinnia.findersync`.

## macOS Finder Services

1. Install a packaged `.app` / DMG build (not a bare `cargo run` binary).
2. Launch Zinnia once so Services register (`NSUpdateDynamicServices`).
3. Select an archive in Finder → right-click → **Services**.
4. Confirm **Extract with Zinnia** launches quick extract (no lingering main-window flash).
5. With Zinnia not running, use **Compress with Zinnia** from Finder: main opens for compress; later Extract must not destroy that workspace.
6. Settings → **OS Integration** → **Finder Services**: **Enabled** only when both
   services have an explicit enable toggle in `pbs` prefs; otherwise **Not enabled**
   (not Unknown). Registration is confirmed via `pbs -dump_cache` for help text.
   **Enable…** writes the `pbs` enable prefs (Services remain a fallback beside Finder Sync).
7. Dev tip after Info.plist changes: `/System/Library/CoreServices/pbs -flush`
   Inspect registration: `/System/Library/CoreServices/pbs -dump_cache`
   Finder Sync election: `pluginkit -m -v -i run.rosie.zinnia.findersync`

> **Release gate:** On a clean macOS 26+ machine, install the signed and
> notarized universal artifact; verify Finder Sync primary-menu items, Finder Services,
> archive Open With, a signed updater check, and `spctl --assess` before publishing.

## Windows 11 modern menu

Zinnia installs as a **normal NSIS Win32 app**. The sparse `ZinniaContextMenu.msix`
is only package identity for the shell DLL (not a Store/AppX app install).

Requires a **signed** NSIS install with full `AZURE_ARTIFACT_SIGNING_PUBLISHER_DN`.

1. Confirm package + signature:
   ```powershell
   Get-AppxPackage -Name run.rosie.zinnia.contextmenu
   Get-AuthenticodeSignature "…\Zinnia\shell-<current-version>\zinnia_shell.dll"   # Status = Valid
   ```
2. If registration failed, check `$INSTDIR\zinnia-context-menu-register.log`.
3. Right-click a `.zip`, `.7z`, `.rar`, and `.tgz` (primary menu, not “Show
   more options”). Also test the first `.001` file from a split-volume archive.
   Confirm `.rar` opens with the packaged full runtime (`7z.exe` beside
   `7z.dll`) and `.tgz` publishes the inner TAR contents in one operation.
4. Expect top-level **Extract with Zinnia** and **Zinnia** ▸ Extract / Compress
   (not “Zinnia Context Menu”, and not nested duplicate Zinnia arrows). Both
   entries should show the Zinnia logo (not an empty icon slot).
5. **Click** Extract and Compress: Zinnia must launch. Settings “Registered” only means the package is present.
6. Right-click a non-archive file/folder → one **Zinnia** ▸ Compress menu (no
   outer iconless **Zinnia** wrapper, no top-level Extract; submenu Extract disabled).
7. Right-click **empty folder background** → **Zinnia** ▸ Compress (current folder).
8. “Show more options” should **not** stack duplicate classic Extract/Compress
   verbs on top of the package entries. Expect **Open with Zinnia** (ProgId)
   plus the same package-backed Extract / Zinnia submenu already visible in the
   primary menu. Classic HKCU Extract/Compress verbs appear only when Win11
   package registration failed (see Failure modes).
9. Upgrade smoke: install an earlier 0.6.0 beta that used unversioned shell DLLs,
   invoke the modern menu once so its shell DLL is loaded, then update to the
   current build. Installation must complete without an **Error opening file for
   writing** prompt, and both modern menu entries must work after Explorer
   reloads them.
10. After a reboot, confirm older `shell-*` directories have been removed.
11. Run the current installer again after invoking its modern menu; reinstall
    must complete without a file-write prompt and both menu entries must work.
12. Uninstall → Appx packages are gone; classic `ZinniaCompress` keys are gone
    when they were present; confirm no versioned shell directories remain after
    any requested reboot.
13. OS Integration → archive defaults: formats already set to Zinnia in Windows
    Settings show green **Zinnia** / Default (not perpetual yellow “Choose in
    Windows Settings”).

> **Release gate:** Steps 5-13 are required before publishing a signed Windows
> build. CI unsigned shell compile smoke does **not** satisfy this gate.
>
> Optional (not a release): run
> `REQUIRE_UPDATER_LIVE=1 npm run validate:updater:live` on a networked machine
> to require both complete standard live channel matrices. Linux ARM64 remains
> optional unless added with `REQUIRED_UPDATER_TARGETS`. Default CI fixture
> validation remains the pre-publish check.

### Failure modes

| Scenario                            | Expect                               |
| ----------------------------------- | ------------------------------------ |
| Unsigned / `SKIP_WIN_CODESIGN=1`    | Classic verbs only                   |
| Stub MSIX (≤1 KiB)                  | Classic verbs only                   |
| CN-only publisher DN                | Context-menu build fails             |
| MSIX missing `AllowExternalContent` | Register log shows `0x80073D2E`      |
| Reinstall / upgrade                 | Versioned shell directory + remove-before-add; no file-write prompt |

## Classic Windows verbs

**Fallback only** when Win11 sparse-package registration fails (stubs, missing
script, or `Add-AppxPackage` error). Do not leave these installed alongside a
successful modern-menu registration  -  package verbs also appear under “Show
more options,” and stacking causes duplicate Extract/Compress entries.

When the fallback path is active (HKCU):

- Archives: **Open with Zinnia** (ProgId) and **Extract with Zinnia**
- Files/folders: **Compress with Zinnia** / **Compress folder with Zinnia**
- Folder background: **Compress with Zinnia** (`%V`)

When modern packages register successfully, keep ProgId **Open with Zinnia**
only; Extract/Compress come from the sparse packages.

## Linux desktop integration

Build the AppImage and DEB on Ubuntu 24.04. Test the AppImage on Ubuntu 24.04,
the DEB on Ubuntu 24.04 and Debian 13, and the RPM on Fedora 43. Exercise both
Wayland and X11 where the desktop environment supports them.

1. Install the matching DEB/RPM or launch the AppImage. For Flatpak, install
   the locally produced bundle (Zinnia is intentionally sideload-only).
2. Confirm the launcher entry, icon, archive MIME association, and desktop
   actions **Open**, **Extract**, and **Compress** appear in the file manager.
3. Exercise each action with ZIP, 7z, RAR, and TGZ archives, a normal file, a
   folder, and an encrypted archive. Confirm TGZ publishes the inner TAR
   contents in one operation, the destination is correct, and no action prompts
   for network access.
4. On Flatpak, confirm the selected archive and destination work through the
   intentional home-filesystem permission, then inspect
   `flatpak info --show-permissions run.rosie.zinnia` for only the documented filesystem, display,
   IPC, and DRI permissions.
5. Confirm the Ubuntu 24.04-built AppImage starts on Ubuntu 24.04; this catches
   accidental glibc drift from a newer build host.

> **Release gate:** Complete the package-specific matrix above before publishing
> a stable Linux artifact. One distro is not a substitute for the others.
