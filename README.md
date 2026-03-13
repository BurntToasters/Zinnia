# Zinnia
A cross-platform 7z GUI built with Tauri.

## Dev
- `npm install`
- `npm run tauri:dev`

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
