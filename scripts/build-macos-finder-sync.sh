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
# A macOS-style App Group needs no provisioning profile, but macOS verifies
# that its Team ID prefix matches both signed processes. Signed Zinnia builds
# therefore require an explicit APPLE_TEAM_ID even when notarization uses an
# App Store Connect API key.
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" && "${APPLE_SIGNING_IDENTITY}" != "-" && -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "build-macos-finder-sync: APPLE_TEAM_ID is required with APPLE_SIGNING_IDENTITY" >&2
  exit 1
fi
if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
  APP_GROUP_ID="${APPLE_TEAM_ID}.run.rosie.zinnia.findersync"
else
  # Unsigned local builds cannot prove a Team ID. This keeps their generated
  # entitlements internally consistent; signed releases must use the branch above.
  APP_GROUP_ID="group.run.rosie.zinnia.findersync"
fi
HOST_ENTITLEMENTS="$OUT_DIR/Zinnia.entitlements"
EXT_ENTITLEMENTS="$OUT_DIR/ZinniaFinderSync.entitlements"

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
/usr/libexec/PlistBuddy \
  -c "Set :ZinniaAppGroupIdentifier $APP_GROUP_ID" \
  "$CONTENTS/Info.plist"

# Generate matching host/extension entitlements in the ignored build directory.
# The main app is intentionally not sandboxed; App Groups support communication
# between a sandboxed extension and its containing non-sandboxed macOS app.
cp "$ROOT/src-tauri/entitlements.plist" "$HOST_ENTITLEMENTS"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" "$HOST_ENTITLEMENTS"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups: string $APP_GROUP_ID" "$HOST_ENTITLEMENTS"
cp "$SRC/ZinniaFinderSync.entitlements" "$EXT_ENTITLEMENTS"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" "$EXT_ENTITLEMENTS"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups: string $APP_GROUP_ID" "$EXT_ENTITLEMENTS"

# Sync extension versions with the containing app. CFBundleVersion is numeric
# and must advance on every distributed build so pluginkit sees updates.
if command -v node >/dev/null 2>&1; then
  VERSION="$(node -pe "require('$ROOT/package.json').version" 2>/dev/null || true)"
  BUNDLE_VERSION="$(node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('$ROOT/src-tauri/tauri.conf.json')); process.stdout.write(c.bundle?.macOS?.bundleVersion || '')" 2>/dev/null || true)"
  if [[ -n "${VERSION:-}" ]]; then
    MARKETING_VERSION="${VERSION%%-*}"
    if [[ ! "$MARKETING_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "build-macos-finder-sync: invalid macOS marketing version: $VERSION" >&2
      exit 1
    fi
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MARKETING_VERSION" "$CONTENTS/Info.plist"
  fi
  if [[ -n "${BUNDLE_VERSION:-}" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUNDLE_VERSION" "$CONTENTS/Info.plist"
  fi
fi

compile_arch() {
  local arch="$1"
  local out="$2"
  "$SWIFTC" \
    -sdk "$SDK" \
    -target "${arch}-apple-macosx${MIN_OS}" \
    -module-name "$MODULE" \
    -application-extension \
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

# Copy bundle resources (must happen before codesign, which covers Resources/).
RESOURCES_DIR="$CONTENTS/Resources"
mkdir -p "$RESOURCES_DIR"
cp "$SRC/zinnia-menu.png" "$RESOURCES_DIR/zinnia-menu.png"

# Ad-hoc sign for local embeds; release VMs re-sign with Developer ID via Tauri.
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "$IDENTITY" && "$IDENTITY" != "-" ]]; then
  codesign --force --sign "$IDENTITY" --entitlements "$EXT_ENTITLEMENTS" \
    --options runtime --timestamp "$APPEX"
else
  codesign --force --sign - --entitlements "$EXT_ENTITLEMENTS" "$APPEX"
fi

echo "build-macos-finder-sync: wrote $APPEX"
