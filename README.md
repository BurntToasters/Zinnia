# Zinnia
A cross-platform 7z GUI built with Tauri.

## Dev
- `npm install`
- `npm run tauri:dev`
- `cargo doc --manifest-path src-tauri/Cargo.toml`

Direct Cargo commands work without a separate `npm run prepare:7z`; the Tauri
build script prepares ignored sidecar binaries from tracked assets when needed.

## OS integration
- Zinnia registers common archive file types in packaged builds.
- Windows NSIS builds add per-user Explorer verbs for `Open with Zinnia` and
  `Extract with Zinnia`.
- Linux `deb` and `rpm` bundles include desktop `Open` and `Extract` actions.
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
- The release workflow automatically publishes `latest-{{target}}-{{arch}}.json` manifests and updater artifacts to GitHub releases.
- The release workflow also publishes `SHA256SUMS-{{target}}-{{arch}}.txt` checksum files and detached `.asc` signatures.
