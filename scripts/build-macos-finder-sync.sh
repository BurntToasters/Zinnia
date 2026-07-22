#!/usr/bin/env bash
# Build ZinniaFinderSync.appex for embedding into Zinnia.app/Contents/PlugIns/.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos-finder-sync: skipping (not macOS)"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src-tauri/macos/ZinniaFinderSync"
OUT_DIR="$ROOT/src-tauri/macos/build"
APPEX="$OUT_DIR/ZinniaFinderSync.appex"
CONTENTS="$APPEX/Contents"
MACOS_DIR="$CONTENTS/MacOS"
MODULE="ZinniaFinderSync"
MIN_OS="${ZINNIA_FINDERSYNC_MIN_OS:-26.0}"

SDK="$(xcrun --sdk macosx --show-sdk-path)"
SWIFTC="$(xcrun --find swiftc)"
LIPO="$(xcrun --find lipo)"

rm -rf "$APPEX"
mkdir -p "$MACOS_DIR"

# Substitute extension principal class for the compiled module name.
/usr/libexec/PlistBuddy -c "Clear dict" "$CONTENTS/Info.plist" 2>/dev/null || true
cp "$SRC/Info.plist" "$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy \
  -c "Set :NSExtension:NSExtensionPrincipalClass ${MODULE}.FinderSync" \
  "$CONTENTS/Info.plist"

# Sync short version from package.json when available.
if command -v node >/dev/null 2>&1; then
  VERSION="$(node -pe "require('$ROOT/package.json').version" 2>/dev/null || true)"
  if [[ -n "${VERSION:-}" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS/Info.plist"
  fi
fi

compile_arch() {
  local arch="$1"
  local out="$2"
  "$SWIFTC" \
    -sdk "$SDK" \
    -target "${arch}-apple-macosx${MIN_OS}" \
    -module-name "$MODULE" \
    -O \
    -framework FinderSync \
    -framework Cocoa \
    -emit-executable \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -o "$out" \
    "$SRC/FinderSync.swift"
}

ARM_BIN="$(mktemp -t zinnia-findersync-arm64)"
X86_BIN="$(mktemp -t zinnia-findersync-x86_64)"
trap 'rm -f "$ARM_BIN" "$X86_BIN"' EXIT

compile_arch arm64 "$ARM_BIN"
compile_arch x86_64 "$X86_BIN"
"$LIPO" -create -output "$MACOS_DIR/$MODULE" "$ARM_BIN" "$X86_BIN"
chmod +x "$MACOS_DIR/$MODULE"

# Ad-hoc sign for local embeds; release VMs re-sign with Developer ID via Tauri.
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "$IDENTITY" && "$IDENTITY" != "-" ]]; then
  codesign --force --sign "$IDENTITY" --entitlements "$SRC/ZinniaFinderSync.entitlements" \
    --options runtime --timestamp "$APPEX"
else
  codesign --force --sign - --entitlements "$SRC/ZinniaFinderSync.entitlements" "$APPEX"
fi

echo "build-macos-finder-sync: wrote $APPEX"
