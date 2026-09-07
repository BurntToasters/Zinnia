# Dependency update safety

`npm run u` is a lockfile-only dependency proposal. It does not install npm packages, run npm lifecycle scripts, compile Rust, execute Cargo build scripts or procedural macros, format source files, or run tests.

The command requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`, npm 12.0.1 or newer, and an already-installed Rust stable toolchain. It performs these steps:

1. Resolve npm updates with `--package-lock-only`, `--ignore-scripts`, and a three-day minimum release age in a disposable npm cache.
2. Reject high-severity npm audit findings without populating the project `node_modules` directory.
3. Resolve Cargo updates through the local crates.io age-filter proxy in a disposable Cargo home.
4. Reject releases younger than 72 hours, unknown registries, unapproved Git revisions, concurrent lock edits, and unverifiable publication metadata.
5. Atomically install only the validated lockfile and remove temporary caches.

Both updaters serialize their own runs. npm rollback and final Cargo lock installation compare expected bytes, preserving a concurrent process's lockfile edit instead of overwriting it.

Review both lockfile diffs before committing. Push the update branch and let GitHub-hosted CI perform code-executing validation. CI installs npm packages with lifecycle scripts disabled, verifies registry signatures, and only then runs dependency code. CI is intentionally the first environment that installs or executes newly selected dependency code.

Do not run `npm run workspace:prepare`, `npm run test:all`, Cargo checks, builds, or tests on a workstation immediately after updating locks. Those commands execute dependency code. If local validation is necessary, use a disposable VM with no credentials, mounted home directory, SSH agent, signing keys, cloud metadata access, or persistent package caches.

The three-day delay reduces exposure to newly published supply-chain attacks; it cannot prove that an older package is benign. Emergency young-crate and Git overrides must name one exact version or revision and include a written reason.

## Reviewed development-only advisories

CI audits the production dependency graph separately and also runs
`npm run audit:dev-reviewed`. The latter does not ignore the development graph:
it parses the full npm audit report, proves every affected installed node is
marked dev-only in `package-lock.json`, and permits only the exact GHSA entries
listed in `scripts/npm-dev-audit.cjs` until that review expires.

This temporary review exists because the current WebdriverIO/Puppeteer test
chain still pulls advisory-bearing versions for which a compatible patched
upgrade is not available. Any new advisory, a reviewed advisory becoming
production-reachable, or the review expiration makes CI fail. Re-evaluate the
allowlist as soon as upstream releases a compatible dependency chain; do not
extend the date without checking the current advisories and running the full
E2E suite.

Cargo audit's reviewed transitive warning set is also fail-closed. The exact
`src-tauri/.cargo/audit.toml` ignore IDs are checked by
`npm run check:rustsec-ignore-policy`, and the review date expires so the GTK3
and other transitive debt must be re-evaluated rather than silently growing.
