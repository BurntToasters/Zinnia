# Linux RPM prerelease bundling

Observed: CLI 2.12.4 builds AppImage and deb successfully, then RPM generation
rejects `0.7.0-beta.1`. Its bundler passes the SemVer string directly to rpm
0.30, which rejects hyphens in Version. CLI 2.12.2 uses rpm 0.16. The upstream
development branch converts SemVer prereleases to RPM versions, but npm's
latest CLI is still 2.12.4 at the time of this fix.

Sources:
- https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/linux/rpm.rs
- https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/Cargo.toml
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/rpm.rs

Failure modes recorded before implementation:

- Beta RPM packaging fails after compilation has succeeded.
- A workaround changes the application or updater version and breaks identity.
- Fixing x64 leaves the supported Linux arm64 release path broken.
- A dependency update silently restores the affected native Linux bundler.
- A broad rollback removes Windows/macOS CLI fixes unnecessarily.
- The wrapper and older Linux native binding are incompatible.
- A stable version stops bundling or RPM files fail release-name matching.

Containment: pin only the native GNU Linux CLI packages for the two supported
release architectures to 2.12.2 using npm overrides. The JS wrapper and other
platform binaries stay on 2.12.4. This also temporarily rolls back intervening
native Linux CLI changes (including its bundled ZIP-library update); remove
these overrides after verifying a released upstream fix. Application runtime
dependencies and version strings are unchanged.

E2E proof: `node scripts/e2e-linux-rpm.mjs` on Linux with Node and Rust available.
It compiles a disposable executable and invokes the actual installed Tauri CLI
to bundle beta and stable RPMs. Artifacts and command output remain under
`coverage/linux-rpm-prerelease/`, with checksums in `result.json`.
