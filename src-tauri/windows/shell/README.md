# Windows 11 modern context menu (`zinnia_shell`)

`IExplorerCommand` DLL + **sparse MSIX identity package** so Zinnia appears in the
Windows 11 primary right-click menu (not only under “Show more options”).

Zinnia does **not** install as a Store/AppX application. The NSIS installer places
`zinnia.exe` like a normal Win32 app. The sparse MSIX (`ZinniaContextMenu.msix`)
is identity-only metadata registered with `Add-AppxPackage -ExternalLocation`;
it points at the already-installed shell DLL and does not relocate the app.

## Menu shape

- **Zinnia** submenu on files/folders: **Extract**, **Compress** (DLL icon via
  embedded `icon.ico` resource string `zinnia_shell.dll,-101`)
- **Zinnia** submenu on folder **background** (`Directory\Background`): Compress
  the current folder (DLL resolves the open folder via `IObjectWithSite` /
  `IFolderView` when selection is empty)
- Top-level **Extract with Zinnia** on supported archives. Sparse-package file
  type associations make per-extension `ItemType` registrations reliable;
  `.001` remains dynamically checked for a split-volume sibling.

Keep exactly one command on `ItemType Type="*"`: the Root command. Putting both
Root and Extract there makes Explorer add its own app-attributed **Zinnia**
flyout around Root's **Zinnia** flyout, producing the redundant
**Zinnia > Zinnia** nesting. Archive `ItemType`s register only Extract; Root is
already inherited from `Type="*"`.

Classic NSIS registry verbs remain for the legacy menu (including
`Directory\Background\shell\ZinniaCompress` with `%V`).

## Build (Windows only)

Requires Visual Studio 2022 or **2026** (C++ workload), CMake (**4.2+** for VS 18),
and the Windows SDK (`makeappx`). The build script picks
`Visual Studio 18 2026` when VS 18 is installed, else `Visual Studio 17 2022`.

**Publisher DN is required for signing to succeed.** Azure Artifact Signing’s
certificate Subject (full DN) must match both:

1. `AppxManifest.xml` `<Identity Publisher="…">`
2. The DLL’s embedded `<msix publisher="…">` identity

```powershell
# Best: copy Subject from a previously signed zinnia.exe
$env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN = (Get-AuthenticodeSignature .\zinnia.exe).SignerCertificate.Subject
# Or set it from the Azure portal certificate profile "Subject name" field.

.\scripts\build-windows-context-menu.ps1 -Arch x64
# Or: .\scripts\build-windows-context-menu.ps1 -PublisherFromSignedFile .\zinnia.exe
```

CN-only (`AZURE_ARTIFACT_SIGNING_PUBLISHER`) often fails with `0x8007000B` when
the cert Subject includes extra fields (`O=`, `C=`, …).

Outputs:

- `src-tauri/windows/shell/out/zinnia_shell.dll`
- `src-tauri/windows/shell/out/ZinniaContextMenu.msix`

Tauri lists these under `bundle.resources`, so the paths must exist for
`cargo check` / `tauri dev` / `tauri build`. Empty CI stubs are enough for that:

```powershell
npm run prepare:win-shell-stubs
```

`release:prepare`, `tauri:dev`, and `tauri:build` create stubs automatically when
missing. Real DLL/MSIX: `npm run build:win:context-menu` (or `build:win:*`).

Sparse MSIX identity requires `uap10:AllowExternalContent` in the Appx
manifest so `Add-AppxPackage -ExternalLocation` can point at `$INSTDIR`
(error `0x80073D2E` without it). Packaging uses `makeappx pack /nv` because
payload files live outside the MSIX; AppxManifest.xml is written UTF-8
without a BOM (PowerShell's default UTF-8 encoding breaks makeappx).

`npm run build:win:*` builds the real package automatically (unless
`SKIP_WIN_CONTEXT_MENU=1`), signs both artifacts with Azure Artifact Signing,
then bundles them into the NSIS installer. Post-install runs
`scripts/register-windows-context-menu.ps1`
(remove-before-add + `Add-AppxPackage -ExternalLocation`). Failures are written
to `$INSTDIR\zinnia-context-menu-register.log` without aborting the install
(classic verbs still work).

On Windows, Tauri’s resource directory is `$INSTDIR` (next to `zinnia.exe`).
The DLL looks for `zinnia.exe` in the same folder first, then the parent
(if the package is ever mapped under `resources\`). NSIS registration looks for
`zinnia_shell.dll` / MSIX / `register-windows-context-menu.ps1` in `$INSTDIR`,
then `$INSTDIR\resources`.

Signed builds **require** `AZURE_ARTIFACT_SIGNING_PUBLISHER_DN` (full Subject).
CN-only is rejected. `verify-windows-authenticode.ps1` also checks the signed
DLL and MSIX (skipping empty CI stubs).

Azure Artifact Signing **does** work for this flow: trusted Authenticode on the
DLL + signed sparse MSIX is what Win11 requires. Classic NSIS verbs still work
without the modern menu if packaging is skipped.

## CLSIDs

| Role | CLSID |
|---|---|
| Zinnia root submenu | `{B7E2A91C-6D4F-4A3E-9C1B-8F0E2D3A4B5C}` |
| Top-level Extract | `{B7E2A91C-6D4F-4A3E-9C1B-8F0E2D3A4B5D}` |
