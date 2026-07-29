# Build prerequisites for Zinnia

## Windows

- Windows 10/11 x64 or ARM64
- PowerShell 7.x
- Developer PowerShell / Command Prompt for VS 2022 or VS 2026 (C++ workload)
- **CMake 3.20+** (bundled with the VS C++ workload, or standalone; **4.2+** when building
  against Visual Studio 18 / 2026). Builds locate CMake via `vswhere` when it is not on PATH.
- After upgrading to **Visual Studio 2026**, re-check Visual Studio Installer → **Modify** →
  **Desktop development with C++** includes **C++ CMake tools for Windows** (updates can drop
  optional components; an old VS 2022 `cmake` on PATH stops working when 2022 is removed).
- **Windows SDK** (`makeappx.exe`) for Win11 sparse context-menu packages
- Node.js 22.12 through 24.x
- Rust (rustup) + Visual Studio Build Tools (clang: x64 and arm64)

## macOS

- macOS 26 or later
- Xcode Command Line Tools
- Node.js 22.12 through 24.x
- Rust (rustup)

## Linux

- Build public AppImage and DEB artifacts on Ubuntu 24.04. It is the oldest
  supported glibc baseline, so an AppImage built there remains compatible with
  the documented Ubuntu 24.04+ support floor. Do not build AppImages on Debian
  13, Fedora 43, or an unpinned newer host.
- Build and test RPM artifacts on Fedora 43. Test the DEB/AppImage on Debian
  13 and the RPM on Fedora 43; these distributions are runtime targets, not
  interchangeable AppImage build baselines.
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

Before a stable release, run the packaged-artifact QA matrix in
[`docs/QA-CONTEXT-MENUS.md`](docs/QA-CONTEXT-MENUS.md) on those platform build
VMs. CI compile smoke does not prove operating-system shell registration,
notarization, updater behavior, or desktop-environment MIME integration.

## Release artifact freshness

The normal `npm run release:win`, `release:mac`, and `release:linux` entry points
run `release:prepare` themselves. Preparation installs locked dependencies,
runs the complete quality gate once, removes old bundles, and creates a
commit- and environment-bound build session. Release builds reuse the generated
versions, licenses, and sidecars instead of preparing them again.

If `npm run release:prepare` was run separately and completed successfully, use
the matching `release:win:resume`, `release:mac:resume`, or
`release:linux:x64:resume` command. `release:linux` is the x64 release alias;
run `release:linux:arm64` only on native ARM64 hardware or an explicitly
configured emulator. Resume still runs branch/upstream preflight
and refuses sessions from a different commit, version, lockfile, platform,
architecture, Node/Rust toolchain, or sessions older than 24 hours. Do not run
`release:prepare` manually and then use the non-resume entry point, because the
normal entry point intentionally prepares and tests again.

The GPG staging script also verifies the session and rejects artifacts older
than its marker, including versionless canonical installer names, so a stale
bundle cannot be signed accidentally.

Flatpak packaging additionally exports the exact clean `HEAD` tree into an
ignored staging directory. It refuses tracked working-tree changes; commit the
intended release state before running `npm run flatpak:bundle`. npm and Cargo
downloads remain integrity-locked for this sideload-only build.

Updater manifests are generated only after each Tauri Minisign signature has
been cryptographically matched to its artifact with the public key in
`tauri.conf.json`. The generated manifests are schema-validated before upload.

The `b`, `r`, and `release:*` scripts intentionally reset and clean their Git
worktrees. Run them only on disposable, isolated build VMs. Before publishing,
verify that the draft contains the expected Windows x64/ARM64 NSIS installers,
universal macOS DMG/ZIP, Linux x64 AppImage/DEB/RPM/Flatpak, updater
manifests/signatures, SHA-256 lists, and GPG detached signatures. Include Linux
ARM64 AppImage/DEB/RPM only when intentionally running `release:linux:arm64`;
the normal public release currently ships Linux x64 only.

The Tauri plugins are already declared in `package.json` and
`src-tauri/Cargo.toml`; do not re-add them during normal setup.
