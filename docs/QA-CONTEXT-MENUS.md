# QA: OS context menus

## macOS Finder Services

1. Install a packaged `.app` / DMG build (not a bare `cargo run` binary).
2. Launch Zinnia once so Services register (`NSUpdateDynamicServices`).
3. Select an archive in Finder → right-click → **Services**.
4. Confirm **Extract with Zinnia** launches quick extract (no lingering main-window flash).
5. With Zinnia not running, use **Compress with Zinnia** from Finder — main opens for compress; later Extract must not destroy that workspace.
6. Settings → **OS Integration** → **Finder Services**: Enabled / Off / Unknown; **Enable…** opens Keyboard Shortcuts → Services.
7. Dev tip after Info.plist changes: `/System/Library/CoreServices/pbs -flush`

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
4. Expect top-level **Extract with Zinnia** and **Zinnia** ▸ Extract / Compress.
5. **Click** Extract and Compress — Zinnia must launch. Settings “Registered” only means the package is present.
6. Right-click a file/folder → **Zinnia** ▸ Compress; Extract disabled on non-archives.
7. Right-click **empty folder background** → **Zinnia** ▸ Compress (current folder).
8. “Show more options” still shows classic verbs (including background Compress).
9. Uninstall → Appx package gone; HKCU `ZinniaCompress` keys gone.

> **Release gate:** Steps 5–7 are required before publishing a signed Windows beta.

### Failure modes

| Scenario | Expect |
|---|---|
| Unsigned / `SKIP_WIN_CODESIGN=1` | Classic verbs only |
| Stub MSIX (≤1 KiB) | Classic verbs only |
| CN-only publisher DN | Context-menu build fails |
| Reinstall / upgrade | Remove-before-add (see register log) |

## Classic Windows verbs

Always registered by NSIS (HKCU):

- Archives: **Open with Zinnia**, **Extract with Zinnia**
- Files/folders: **Compress with Zinnia** / **Compress folder with Zinnia**
- Folder background: **Compress with Zinnia** (`%V`)
