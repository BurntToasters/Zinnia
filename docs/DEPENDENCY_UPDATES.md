# Dependency update safety

## Rust toolchain pin

`rust-toolchain.toml` is the sole source for the Rust compiler version,
profile, and components. To bump Rust, edit only `rust-toolchain.toml`; the npm
scripts, GitHub workflows, and Flatpak build read the pinned channel from it at
runtime. Do not add a Rust version literal to another file.

## Application version

Set the new version by editing `package.json`, then run `npm run u`. That
command copies the `package.json` version across the repo and proposes
dependency lockfile updates. It does not bump `package.json` itself, install
npm packages, run npm lifecycle scripts, compile Rust, execute Cargo build
scripts or procedural macros, format source files, or run tests.

The command requires Node.js `^24.22.1 || >=26.13.0`, npm 12.2.1 or newer, and the Rust toolchain pinned in `rust-toolchain.toml` to be installed. It performs these steps:

1. Resolve npm updates with `--package-lock-only`, `--ignore-scripts`, and a three-day minimum release age in a disposable npm cache.
2. Reject high-severity npm audit findings without populating the project `node_modules` directory.
3. Resolve Cargo updates through the local crates.io age-filter proxy in a disposable Cargo home.
4. Reject releases younger than 72 hours, unknown registries, unapproved Git revisions, concurrent lock edits, and unverifiable publication metadata.
5. Atomically install only the validated lockfile and remove temporary caches.
6. Run `sync-version` and `update-metainfo.js` so Cargo, Tauri, Windows shell
   resources, changelog URLs, and AppStream match `package.json`.

Both updaters serialize their own runs. npm rollback and final Cargo lock installation compare expected bytes, preserving a concurrent process's lockfile edit instead of overwriting it.

Review both lockfile diffs before committing. Push the update branch and let GitHub-hosted CI perform code-executing validation. CI installs npm packages with lifecycle scripts disabled, verifies registry signatures, and only then runs dependency code. CI is intentionally the first environment that installs or executes newly selected dependency code.

Do not run `npm run workspace:prepare`, `npm run test:all`, Cargo checks, builds, or tests on a workstation immediately after updating locks. Those commands execute dependency code. If local validation is necessary, use a disposable VM with no credentials, mounted home directory, SSH agent, signing keys, cloud metadata access, or persistent package caches.

The three-day delay reduces exposure to newly published supply-chain attacks; it cannot prove that an older package is benign. Emergency young-crate and Git overrides must name one exact version or revision and include a written reason.

## Development-only advisories

CI audits the production dependency graph separately (`npm audit --omit=dev`)
and also runs `npm run audit:dev-reviewed`. `npm run u` uses the same pair of
checks. The production audit rejects high-severity findings in shipped
dependencies. The reviewed-dev check parses the full npm audit report and
fails only when an affected installed node is not marked `dev` in
`package-lock.json`. Proven development-only findings, including the
WebdriverIO/Puppeteer test chain, are warnings. They do not block lockfile
updates or CI, because they do not ship to users.

Known GHSA entries may be listed in `scripts/npm-dev-audit.cjs` for tracking.
Re-evaluate that list when upstream releases a compatible patched chain. A
reviewed advisory becoming production-reachable still fails closed.

Cargo audit's reviewed transitive warning set is also fail-closed. The exact
`src-tauri/.cargo/audit.toml` ignore IDs are checked by
`npm run check:rustsec-ignore-policy`, and the review date expires so the GTK3
and other transitive debt must be re-evaluated rather than silently growing.

The `audit.toml` ignores expire on 2027-03-01. No ignore is due before then.

## Tauri updater plugin

`@tauri-apps/plugin-updater` stays pinned to exact `2.10.1` in `package.json`.
The Rust side is vendored at `src-tauri/vendor/tauri-plugin-updater`, and the
vendored copy carries local patches. Upstream is at 2.14.x.

A re-vendor against upstream 2.14.x was scheduled after 0.7.0-beta.1 and is not
part of 0.7.0-beta.2. It must
re-apply every documented patch: macOS transactional install, confined tar
extraction, Linux helper PATH, Windows ShellExecute, download stall limit,
minisign-verify 0.3, and zip 9. Do not bump the npm pin on its own.

## Vendored crate watch

`npm run deps:vendored` reads the `[package]` name and version from each
`src-tauri/vendor/*/Cargo.toml`, asks the crates.io API for the latest stable
release of each crate, and prints a table with the crate, the vendored version,
the latest stable version, and a status:

- `current`: the vendored version is the latest stable release, or a
  pre-release newer than it.
- `behind`: crates.io has a newer stable release.
- `not on crates.io`: crates.io returned 404 for the crate name.
- `fetch failed`: the request timed out, failed at the network level, returned
  a non-404 HTTP error, or returned a response without a usable stable version.
  The reason is printed in parentheses. A failure for one crate does not stop
  the report for the others.

The command is report-only. It exits 0 unless the script itself fails, such as
a vendored `Cargo.toml` with no literal `[package]` name or version. It does
not edit files, change `Cargo.toml`, or open issues. Requests send the
User-Agent `zinnia-vendored-crates-watch`. The weekly `7-Zip watch` workflow
runs it with `continue-on-error`, so the table appears in the job log without
failing the job. The script's own tests run in `npm run test:cargo-safe-update`,
which `npm run test:all` also runs.

A `behind` result does not mean a vendored crate should be re-vendored now.
Updating a vendored crate still follows
[`src-tauri/vendor/README.md`](../src-tauri/vendor/README.md): re-apply every
documented patch to the new upstream release, keep the `[patch.crates-io]`
entry until upstream carries the same fixes, and do not drop a vendored copy
without an equivalent upstream fix.

## Lucide

`lucide` is bumped from 1.68.0 to 1.70.0, with the caret range kept as
`^1.70.0`. It is a shipped runtime dependency, so the production audit covers it.
