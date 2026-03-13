# Build prerequisites for Zinnia

## Windows
- Windows 10/11 x64 or ARM64
- PowerShell 7.x
- Developer PowerShell / Command Prompt for VS18 
- Node.js 24+ (LTS recommended)
- Rust (rustup) + Visual Studio Build Tools (clang: x64 and arm64)

## macOS
- macOS Sonoma or later
- Xcode Command Line Tools
- Node.js 24+ (LTS recommended)
- Rust (rustup)

## Linux
- Ubuntu 24.04+/Debian 13+/Fedora 43+
- Node.js 24+ (LTS recommended)
- Rust (rustup)
- Build essentials (gcc, g++, make)
- AppImage, rpm, deb tooling if building those bundles
- Flatpak + flatpak-builder if building Flatpak

## Rust
npm run tauri add dialog
npm run tauri add updater
npm run tauri add single-instance
npm run tauri add shell

