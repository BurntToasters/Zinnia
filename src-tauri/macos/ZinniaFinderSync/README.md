# ZinniaFinderSync

macOS **Finder Sync** app extension that adds **Extract with Zinnia** /
**Compress with Zinnia** to Finder's primary context menu.

## Build

```bash
npm run build:macos:finder-sync
# → src-tauri/macos/build/ZinniaFinderSync.appex
```

`prepare:macos:finder-sync` runs automatically from Tauri `beforeBuildCommand`
on macOS. Release builds re-sign the nested appex via
`scripts/resign-macos-finder-sync.js` after `tauri build`.

## Bundle

Embedded as `Zinnia.app/Contents/PlugIns/ZinniaFinderSync.appex`
(`bundle.macOS.files` in `tauri.conf.json`).

## Runtime

The extension launches the host app with the same argv shapes as Services:

```
Zinnia.app/Contents/MacOS/zinnia --extract /path/archive.zip
Zinnia.app/Contents/MacOS/zinnia --compress /path/item
```

Users enable it under **System Settings → General → Login Items & Extensions**,
or via OS Integration → **Finder context menu → Enable…** (`pluginkit -e use`).
