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
  <img width="85%" height="1012" alt="Zinnia screenshot" src="./media/Zinnia-1.png" />
&nbsp;
</p>
      </td>
    </tr>
  </table>
</div>

See [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[SECURITY.md](SECURITY.md).

## Dev
- `npm install`
- `npm run tauri:dev`
- `cargo doc --manifest-path src-tauri/Cargo.toml`

Direct Cargo commands work without a separate `npm run prepare:7z`; the Tauri
build script refreshes ignored sidecar binaries from tracked assets before the
native build runs.

## OS integration
- Zinnia registers common archive file types in packaged builds.
- Windows NSIS builds add per-user Explorer verbs for `Open with Zinnia` and
  `Extract with Zinnia`.
- Linux `deb`, `rpm`, and Flatpak bundles include desktop `Open`, `Extract`, and
  `Compress` actions.
- macOS users can choose Zinnia from Finder's Open With/Get Info default-app
  flow; Zinnia routes archive launches to the quick extract window.

## Builds
- Windows: `npm run build:win`
- macOS: `npm run build:mac:universal` then `npm run build:mac:zip`
- Linux: `npm run build:linux`
- Flatpak: `npm run flatpak:bundle`

## Release signing
- `npm run release:sign:gpg`

## Updater setup
- Updater is already configured in `src-tauri/tauri.conf.json`.
- CI runs tests and checks on Linux, Windows, and macOS. It never builds release
  binaries, publishes releases, or consumes release signing secrets.
- Signed releases are intentionally explicit: run the platform-specific
  `release:win`, `release:mac`, and `release:linux` scripts for the same version.
  They stage updater manifests, artifacts, checksum files, and detached `.asc`
  signatures in the matching draft GitHub release.
- Do not push a release tag until every platform artifact is present and its
  updater signature and checksum have been verified.
