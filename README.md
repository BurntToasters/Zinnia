# Chrysanthemum
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
- Generate a Tauri updater keypair and replace `REPLACE_WITH_TAURI_PUBLIC_KEY` in `src-tauri/tauri.conf.json`.
- Publish `latest.json` and the updater artifacts to GitHub releases.
