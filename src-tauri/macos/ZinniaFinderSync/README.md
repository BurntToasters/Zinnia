# ZinniaFinderSync

macOS **Finder Sync** app extension that adds **Extract with Zinnia** /
**Compress with Zinnia** to Finder's primary context menu.

## Build

```bash
npm run build:macos:finder-sync
# → src-tauri/macos/build/ZinniaFinderSync.appex
```

`prepare:macos:finder-sync` runs automatically from Tauri `beforeBuildCommand`
on macOS. The appex is signed first with its sandbox entitlement profile;
Tauri then signs the containing app and notarizes the completed bundle.

## Bundle

Embedded as `Zinnia.app/Contents/PlugIns/ZinniaFinderSync.appex`
(`bundle.macOS.files` in `tauri.conf.json`).

## Runtime

The sandboxed extension atomically queues each Extract/Compress request in a
shared App Group, then activates the host. Zinnia drains that queue on cold
launch, on reopen, and while already running. This avoids relying on launch
arguments, which macOS ignores when supplied by a sandboxed extension.

Requests carry a millisecond timestamp, are processed oldest-first, and expire
after 60 seconds. Invalid, oversized, future-dated, and over-1,000-path requests
are discarded. If activating the host fails, the extension removes the queued
request so it cannot run during an unrelated later launch.

Signed builds require both `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID`. The
generated App Group is `<TeamIdentifier>.run.rosie.zinnia.findersync`; release
packaging fails unless the host, extension, sidecar, signed entitlements, and
extension Info.plist all agree on the signing team and App Group.

Users enable it through the Finder Sync extension-management interface, or
under **System Settings → General → Login Items & Extensions**. `pluginkit`
remains a best-effort registration/election compatibility fallback.
