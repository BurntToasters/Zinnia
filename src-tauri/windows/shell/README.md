# Windows 11 modern context menu (`zinnia_shell`)

`IExplorerCommand` DLLs + **sparse MSIX identity packages** so Zinnia appears in the
Windows 11 primary right-click menu (not only under “Show more options”).

Zinnia does **not** install as a Store/AppX application. The NSIS installer places
`zinnia.exe` like a normal Win32 app. The sparse MSIX files are identity-only
metadata registered with `Add-AppxPackage -ExternalLocation`; they point at the
already-installed shell DLLs and do not relocate the app.

## Menu shape

- **Zinnia** submenu on files/folders: **Extract**, **Compress** (DLL icon via
  embedded `icon.ico` resource string `zinnia_shell.dll,-101`)
- **Zinnia** submenu on folder **background** (`Directory\Background`): Compress
  the current folder (DLL resolves the open folder via `IObjectWithSite` /
  `IFolderView` when selection is empty)
- Top-level **Extract with Zinnia** on supported archive `ItemType`s. Its
  separate sparse identity prevents Windows 11 from grouping it with the
  **Zinnia** submenu; `.001` remains dynamically checked for a split-volume
  sibling. The Extract identity is not registered as a file opener.

Windows 11 groups multiple verbs from one app identity into an attributed
flyout. Root and Extract therefore use separate sparse packages and DLLs, with
one command identity in each package. This produces sibling root entries instead
of the redundant **Zinnia > Zinnia** nesting.

Classic NSIS registry verbs remain for the legacy menu (including
`Directory\Background\shell\ZinniaCompress` with `%V`).

## Build (Windows only)

Requires Visual Studio 2022 or **2026** (C++ workload), CMake (**4.2+** for VS 18),
and the Windows SDK (`makeappx`). The build script picks
`Visual Studio 18 2026` when VS 18 is installed, else `Visual Studio 17 2022`.

**Publisher DN is required for signing to succeed.** Azure Artifact Signing’s
certificate Subject (full DN) must match every:

1. Sparse manifest `<Identity Publisher="…">`
2. DLL embedded `<msix publisher="…">` identity

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
- `src-tauri/windows/shell/out/zinnia_extract_shell.dll`
- `src-tauri/windows/shell/out/ZinniaContextMenu.msix`
- `src-tauri/windows/shell/out/ZinniaExtractContextMenu.msix`

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

`npm run build:win:*` builds the real packages automatically (unless
`SKIP_WIN_CONTEXT_MENU=1`), signs both artifacts with Azure Artifact Signing,
then bundles them into the NSIS installer. Post-install runs
`scripts/register-windows-context-menu.ps1`
(remove-before-add + `Add-AppxPackage -ExternalLocation`). Failures are written
to `$INSTDIR\zinnia-context-menu-register.log` without aborting the install
(classic verbs still work).

On Windows, Tauri’s resource directory is `$INSTDIR` (next to `zinnia.exe`).
The DLLs look for `zinnia.exe` in the same folder first, then the parent
(if the packages are ever mapped under `resources\`). NSIS registration looks
for both DLLs, both MSIX files, and `register-windows-context-menu.ps1` in
`$INSTDIR`, then `$INSTDIR\resources`.

Signed builds **require** `AZURE_ARTIFACT_SIGNING_PUBLISHER_DN` (full Subject).
CN-only is rejected. `verify-windows-authenticode.ps1` also checks the signed
DLLs and MSIX files (skipping empty CI stubs).

Azure Artifact Signing **does** work for this flow: trusted Authenticode on the
DLLs + signed sparse MSIX files are what Win11 requires. Classic NSIS verbs still work
without the modern menu if packaging is skipped.

## CLSIDs

| Role | CLSID |
|---|---|
| Zinnia root submenu | `{B7E2A91C-6D4F-4A3E-9C1B-8F0E2D3A4B5C}` |
| Top-level Extract | `{B7E2A91C-6D4F-4A3E-9C1B-8F0E2D3A4B5D}` |
