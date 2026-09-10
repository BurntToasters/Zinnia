# Dependency update safety

Set the new version by editing `package.json`, then run `npm run u`. That
command copies the `package.json` version across the repo and proposes
dependency lockfile updates. It does not bump `package.json` itself, install
npm packages, run npm lifecycle scripts, compile Rust, execute Cargo build
scripts or procedural macros, format source files, or run tests.

The command requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`, npm 12.0.1 or newer, and an already-installed Rust stable toolchain. It performs these steps:

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
