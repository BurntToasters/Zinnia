# Handoff: Zinnia 0.7.0-beta.3 audit fixes

Date: 2026-11-22. Branch `next-0.7.0`, base commit `1c58ad74f8fdc448064ceb98b5e9bca33fe1ad0c` (version `0.7.0-beta.3`). All work below is uncommitted on the original Windows machine. It reaches you only if the owner pushed or copied the working tree. First check that `git status` shows the files in "Changed files". If they are missing, stop and ask the owner.

## Rules for this repo

- Read `AGENTS.md` first. Its top section is mandatory: never write unit tests after the code; prefer E2E tests and leave a repeatable artifact; for isolated tests, write the failure modes first, then the tests, then the code; no agent co-authors on commits or PRs.
- Add no code comments. The owner does not want new comments in this repo.
- Do not commit, push, or open a PR unless the owner asks.
- Run one GUI E2E run at a time per machine. Run it in the foreground. Never start two `scripts/test-e2e.js` runs at once: they share ports and processes, and the second run fails.
- The prior audit report is `.tmp/audit-beta3/report.md` (ignored by git, so it may not exist on your machine). This file replaces it as the source of truth.

## What was wrong (audit findings) and what was done

| Finding | Status |
|---|---|
| Blocker: `CHANGELOG.md` beta.3 entry was the placeholder `(add release notes)`, so `npm run validate:changelog` failed | Fixed. Five entries written. Validation passes. |
| High: Convert checked the archive, opened the options dialog, then captured a fresh identity and extracted that. A file replaced while the dialog was open got converted unchecked; an encrypted replacement could lose encryption without the confirmation. | Fixed in `src/archive/mutations.ts` `convertArchive`: keeps the first identity, aborts with a sticky toast before `reserve_temp_extract_path` if it changed, and passes the kept identity to `runWithPasswordRetry`. Two new E2E cases in `e2e/specs/audit-convert.spec.js` (plain and encrypted replacement). |
| High: AppImage updater moved the live AppImage into a temp dir before writing the new one. An interruption left the launch path empty. | Fixed. New helper `replace_file_atomically` in `src-tauri/vendor/tauri-plugin-updater/src/install_safety.rs` (stage beside the target, `sync_all`, copy permissions, rename over). `install_appimage` in `updater.rs` uses it for raw bytes and the `.tar.gz` entry. `select_same_device_temp_dir` and its tests were removed. |
| Medium: macOS payload check compared the marketing version (always `0.7.0` for every 0.7.0 beta), so an older signed beta passed. | Fixed. `macos_plist_build_version`, `dotted_build_cmp`, `payload_build_is_newer` in `install_safety.rs`; macOS `install_inner` refuses a payload whose `CFBundleVersion` is not newer than the installed one, and falls back to the old check if either build is unreadable. Build scheme: `macBundleVersionFromSemver` in `scripts/sync-version-helpers.js` (beta.2 = `0.7.3002`, beta.3 = `0.7.3003`, stable = `0.7.9999`). |
| Medium: all app copies in one folder shared `.zinnia-update-backup`; updating a healthy copy deleted another copy's recovery backup. | Fixed. `macos_update_backup_path` now returns `.zinnia-update-backup-<bundle name>`. `recover_macos_app_backups` restores from the scoped backup, or from the legacy shared one only when the live bundle is incomplete, and never deletes the legacy dir or another bundle's backup. |
| Harness: `cancel-race` counted every `7z*` process on the machine, so another run or a system 7-Zip failed it. | Fixed. `sevenZipProcesses` in `e2e/helpers/recovery-harness.js` keeps only processes whose executable lies inside this checkout. |

Failure modes for the updater changes are written in `src-tauri/vendor/tauri-plugin-updater/install-safety.failure-modes.md`. `src-tauri/vendor/README.md` lists the three new updater patches.

### Windows background E2E mode (from the earlier session, kept)

Local Windows E2E runs now default to background mode, like macOS: `scripts/test-e2e.js` sets `ZINNIA_E2E_BACKGROUND=1` unless CI or `ZINNIA_E2E_FOREGROUND=1`; `src-tauri/src/launch/mod.rs` `e2e_background()` makes the window unfocusable on Windows. Linux keeps its existing display mode. Tests for this are in `scripts/e2e-runner-reliability.test.mjs`; failure modes in `scripts/e2e-background.failure-modes.md`.

## Changed files (uncommitted)

```
CHANGELOG.md
e2e/helpers/recovery-harness.js
e2e/specs/audit-convert.spec.js
e2e/specs/beta2-quick-extract-recovery.spec.js
e2e/specs/release-safeguards.spec.js
scripts/e2e-background.failure-modes.md
scripts/e2e-runner-reliability.test.mjs
scripts/test-e2e.js
src-tauri/src/launch/mod.rs
src-tauri/vendor/README.md
src-tauri/vendor/tauri-plugin-updater/install-safety.failure-modes.md   (new)
src-tauri/vendor/tauri-plugin-updater/src/install_safety.rs
src-tauri/vendor/tauri-plugin-updater/src/updater.rs
src/archive/mutations.ts
handoff.md   (this file; delete it when done)
```

## Verified on Windows (x86_64-pc-windows-msvc)

- `npm run typecheck`, `npm run lint`, `npm run validate:changelog`: pass.
- `npx vitest run src/tests/archive`: 204 passed. (Note: `npx vitest run src/archive` finds no files; the tests live in `src/tests/`.)
- `cargo fmt --check` for `src-tauri/Cargo.toml` and the vendored updater: pass.
- `cargo test --locked --manifest-path src-tauri/vendor/tauri-plugin-updater/Cargo.toml --lib`: 46 passed.
- `cargo clippy --locked --manifest-path src-tauri/vendor/tauri-plugin-updater/Cargo.toml --lib`: clean. With `--all-targets -D warnings` there is one error, `clippy::manual_contains` in the existing test `linux_privileged_env_keep_session_display_and_dbus`; it is in the base commit, not from these changes, and this crate's clippy is not part of `test:all` or CI.
- `node --test scripts/e2e-runner-reliability.test.mjs`: 48 pass, 0 fail, 7 skipped (run alone). It had 6 failures when run while cargo builds loaded the machine; treat its process-tree and fenced-launch tests as load-sensitive.
- GUI E2E, background mode: `audit-convert` 7/7; `cancel-race`, `cancel-race-compound` pass; `main,extract-window,audit-keyboard,audit-picker,cancel-race` pass with zero samples of Zinnia in the foreground.
- Full GUI suite in background mode: zero focus steals, but the run stopped at `audit-a11y` with `SevereServiceError ... Tauri app exited before the embedded WebDriver server became ready (code=1)`, after `Embedded WebDriver on port ... is unreachable — restarting`. `audit-a11y` passed when rerun alone (6/6). Cause not found; treat it as a startup flake until a full run passes.

## Not verified

- The Linux and macOS `cfg` code in the vendored updater was never compiled. Windows cannot build those targets. This is the most important gap.
- `npm run test:all` on the final tree: started, then stopped at the owner's request. No full passing gate exists yet.
- `npm run test:e2e-runner`, `npm run test:release-dry-run`, `npm run release:licenses` on the final tree: not run.
- Native packaged upgrade beta.2 to beta.3, signed Explorer registration, Finder registration, Linux desktop install: no installers exist.

## Work for you, in order

1. Confirm the changed files are present (`git status`, `git diff --stat`). Read the diffs of `src-tauri/vendor/tauri-plugin-updater/src/updater.rs` and `install_safety.rs`.
2. If you are on Linux: compile and test the vendored updater, which now builds `install_appimage` for real.
   - `cargo build --locked --manifest-path src-tauri/vendor/tauri-plugin-updater/Cargo.toml`
   - `cargo test --locked --manifest-path src-tauri/vendor/tauri-plugin-updater/Cargo.toml --lib` (also runs the `cfg(unix)` tests, including `replace_keeps_original_unix_mode`)
   - `cargo clippy --locked --manifest-path src-tauri/vendor/tauri-plugin-updater/Cargo.toml --lib -- -D warnings`
   - `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` (this one is the CI gate)
   Fix only real errors in the changed code. Watch for unused imports in `install_appimage` and the `#[cfg(feature = "zip")]` branch.
3. macOS `install_inner` still needs a compile. If you cannot build for macOS, check that `cargo check --target aarch64-apple-darwin` is possible (it usually fails without the macOS SDK because of native deps). Otherwise record it as unverified; CI on a push or PR to `beta` or `main` builds macOS.
4. Run the full gate alone, nothing else running: `npm run test:all`. On Linux, GUI E2E uses its existing display setup (not background mode). If `audit-a11y` or any suite fails at startup only, rerun that suite alone with `node scripts/test-e2e.js --only=<suite>` and record both results. Keep `coverage/e2e/result.json`.
5. Then, one at a time: `npm run test:e2e-runner`, `npm run test:release-dry-run`, `npm run release:licenses`.
6. Write a short result report for the owner: per-finding status, every command with pass or fail, artifact paths, and what remains unverified. Do not commit.

## Known quirks

- `scripts/test-e2e.js` refuses to start if app inputs change during its build (`E2E app inputs changed during build (...)`). Do not edit files while a GUI run is building.
- `audit-keyboard` has a slow sticky-toast test (ten 60 s waits by design). A long pause there is normal.
- Windows-only tool `.tmp/audit-beta3/measure-focus.ps1` measured foreground focus; it does not apply on Linux.
