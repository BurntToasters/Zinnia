# Zinnia

A cross-platform 7z GUI built with Tauri.

<div align="center">
  <table>
    <tr>
      <td valign="middle" align="center" width="220">
        <img src="./media/icon.png"
             alt="Zinnia logo" width="140" />
      </td>
      <td valign="middle" align="center">
        <p align="center">
  <img width="85%" height="850" alt="Zinnia screenshot" src="./media/Zinnia-1.png" />
&nbsp;
</p>
      </td>
    </tr>
  </table>
</div>

See [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[SECURITY.md](SECURITY.md).

## System requirements

- macOS 26 or later. The universal build supports Intel and Apple silicon Macs
  that can run macOS 26+.
- Windows 10 version 2004 (build 19041) or later, on x64 or ARM64. The modern
  Explorer integration requires a signed NSIS install.
- Linux x64: Ubuntu 24.04+, Debian 13+, or Fedora 43+ (or a compatible
  distribution with the required WebKitGTK runtime). The public release ships
  x64 AppImage, DEB, RPM, and sideloaded Flatpak bundles. ARM64 AppImage/DEB/RPM
  are published only when explicitly built for that release; Flatpak stays x64.

## Dev

- `npm install`
- `npm run tauri:dev`
- `cargo doc --manifest-path src-tauri/Cargo.toml`

Direct Cargo commands work without a separate `npm run prepare:7z`; the Tauri
build script refreshes ignored sidecar binaries from tracked assets before the
native build runs.

## OS integration

- Zinnia registers common archive file types in packaged builds.
- Windows NSIS builds add per-user Explorer verbs for `Open with Zinnia`,
  `Extract with Zinnia`, and `Compress with Zinnia` as the classic fallback
  (including Explorer’s “Show more options” path when the modern package is
  unavailable).
- Signed Windows NSIS builds also register a Win11 modern context menu via a
  **sparse identity MSIX** + `zinnia_shell.dll` (`Zinnia` submenu, plus top-level
  Extract on archives). After a successful modern registration, classic verbs
  are removed so they do not stack under Show more options; they remain the
  fallback when package registration fails. Zinnia itself stays a normal
  per-user NSIS Win32 install; the MSIX is not a Store/AppX app package; it only
  grants package identity so Explorer can load the shell DLL. See
  `src-tauri/windows/shell/README.md` and `docs/QA-CONTEXT-MENUS.md`.
- Linux `deb`, `rpm`, and Flatpak bundles include desktop `Open`, `Extract`, and
  `Compress` actions.
- macOS users can choose Zinnia from Finder's Open With/Get Info default-app
  flow; Zinnia routes archive launches to the quick extract window. Packaged
  builds also expose Finder Sync context-menu items and Finder Services:
  **Extract with Zinnia** and **Compress with Zinnia**. Finder Sync only
  monitors Desktop, Documents, Downloads, Movies, Music, Pictures, and
  `/Volumes`. Use Finder Services for files in other folders.

## Builds

- Windows: `npm run build:win`
- macOS: `npm run build:mac:universal` then `npm run build:mac:zip`
- Linux x64: `npm run build:linux` (or `npm run build:linux:x64`)
- Linux ARM64 (on native ARM64 hardware/emulation): `npm run build:linux:arm64`
- Flatpak: `npm run flatpak:bundle`

## Release signing

- `npm run release:sign:gpg`

## Updater setup

- Updater is already configured in `src-tauri/tauri.conf.json`.
- CI runs tests and checks on Linux, Windows, and macOS. It never builds release
  binaries, publishes releases, or consumes release signing secrets.
- Signed releases are intentionally explicit: run the platform-specific
  `release:win`, `release:mac`, and `release:linux` scripts for the same version.
  `release:linux` is x64; run `release:linux:arm64` only from a suitable ARM64
  build environment.
  They stage updater manifests, artifacts, checksum files, and detached `.asc`
  signatures in the matching draft GitHub release.
- Beta `release:*:continue` signing auto-syncs that VM's `latest-*-beta-*.json`
  manifests onto the latest stable `/releases/latest`, **including while the
  tag is still a draft**. That is intentional: beta clients poll the live feed,
  so each platform's updater JSON is published as soon as that VM signs.
  Use `npm run release:sync-beta-manifests` only for recovery/re-sync after a
  published beta if needed.
- After the draft is complete, run `npm run release:verify:draft` (read-only).
  After publishing, run `npm run release:verify:published`. It requires the
  complete standard target matrix for the current stable or beta channel and
  verifies the exact release version, then downloads referenced updater
  artifacts and checks their signatures. Stable verification also requires the
  beta-target endpoints that move final-beta installs onto stable.
  `REQUIRED_UPDATER_TARGETS` adds intentional optional targets such as Linux
  ARM64 to that required set.
- GitHub may temporarily expose an unpublished draft under an `untagged-*`
  identifier. Release scripts accept it only when the draft name and target
  commit match exactly, then set the intended `vX.Y.Z` tag during publication.
- Each full release command prepares and runs every non-E2E quality gate once.
  Native E2E is skipped for local release commands because CI runs it on Linux,
  Windows, and macOS; a direct `npm run test:all` still includes E2E. If
  `release:prepare` was already run separately on the same VM, use the matching
  `release:*:resume` command; its build session is bound to the exact commit,
  lockfiles, platform, architecture, and Node/Rust toolchain and expires after
  24 hours.
- After changing the package version, `release:prepare` / `workspace:bootstrap`
  write the AppStream release entry via `node scripts/update-metainfo.js`
  (commit the XML change with the version bump). `npm run u` / `u2` only update
  lockfiles; they do not write AppStream. You can also run the metainfo script
  alone. `--check` remains available if you only want validation.
- Do not push a release tag until every platform artifact is present and its
  updater signature and checksum have been verified.
