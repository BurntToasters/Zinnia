# Build prerequisites for Zinnia

## Windows
- Windows 10/11 x64 or ARM64
- PowerShell 7.x
- Developer PowerShell / Command Prompt for VS18 
- Node.js 22.12 through 24.x
- Rust (rustup) + Visual Studio Build Tools (clang: x64 and arm64)

## macOS
- macOS Sonoma or later
- Xcode Command Line Tools
- Node.js 22.12 through 24.x
- Rust (rustup)

## Linux
- Ubuntu 24.04+/Debian 13+/Fedora 43+
- Node.js 22.12 through 24.x
- Rust (rustup)
- Build essentials (gcc, g++, make)
- AppImage, rpm, deb tooling if building those bundles
- Flatpak + flatpak-builder if building Flatpak

## Rust toolchain policy

Zinnia always builds with the newest Rust `stable` available at build time. Do
not pin a Rust release. Install or refresh it before building:

```sh
npm run rust:update
```

## Verify the toolchain

```sh
npm ci
npm run prepare:7z
npm run test:all
npx tauri build --no-bundle
```

CI runs tests and checks only. It must never invoke `release:*` scripts or build
release binaries; signed bundles are produced on isolated platform build VMs.

## Release artifact freshness

Always run `npm run release:prepare` before a platform release build. It removes
old bundles and creates a versioned build-session marker. The GPG staging script
rejects artifacts older than that marker, including versionless canonical
installer names, so a stale bundle cannot be signed accidentally.

The `b`, `r`, and `release:*` scripts intentionally reset and clean their Git
worktrees. Run them only on disposable, isolated build VMs. Before publishing,
verify that the draft contains the expected Windows x64/ARM64 NSIS installers,
universal macOS DMG/ZIP, Linux x64 AppImage/DEB/RPM/Flatpak, updater
manifests/signatures, SHA-256 lists, and GPG detached signatures. Include Linux
ARM64 AppImage/DEB/RPM only when intentionally running `release:linux:arm64`;
the normal public release currently ships Linux x64 only.

The Tauri plugins are already declared in `package.json` and
`src-tauri/Cargo.toml`; do not re-add them during normal setup.
