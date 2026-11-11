#!/bin/bash
# Native filesystem/bookmark integration proof; no installed app or Dock edits.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS required' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/zinnia-update-identity.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p coverage/macos-update-identity
rm -f coverage/macos-update-identity/result.json coverage/macos-update-identity/inputs.sha256
source_path="$PWD/src-tauri/vendor/tauri-plugin-updater/src/install_safety.rs"
cat > "$work/install.rs" <<RUST
#[path = "$source_path"] mod install_safety;
fn main() {
    let a: Vec<_> = std::env::args_os().skip(1).collect();
    install_safety::install_macos_app_contents(std::path::Path::new(&a[0]), std::path::Path::new(&a[1]), std::path::Path::new(&a[2])).unwrap();
}
RUST
rustc --edition=2021 "$work/install.rs" -o "$work/install"
rustc --edition=2021 --test "$source_path" -o "$work/tests"
"$work/tests" | tee coverage/macos-update-identity/rust-tests.txt
swift -module-cache-path "$work/modules" scripts/verify-macos-update-identity.swift "$work" "$PWD/coverage/macos-update-identity/result.json"
shasum -a 256 "$source_path" src-tauri/vendor/tauri-plugin-updater/src/updater.rs scripts/verify-macos-update-identity.* > coverage/macos-update-identity/inputs.sha256
