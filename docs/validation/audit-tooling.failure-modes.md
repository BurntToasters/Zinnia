# Audit tooling failure inventory (C-47, C-48)

This inventory was written before changing lint, TypeScript, Cargo, or workflow
config. Baseline on `next-0.7.0` before these edits: `npm run typecheck` exits 0,
`npx eslint src/ scripts/ e2e/` exits 0 with no output, and `bench/` is not
linted by any script. The `.mjs` and `.cjs` files under `scripts/` are picked up
by ESLint's default file list but match no config block, so they get no rules.
Proof for each item is the real command output, not a browser or E2E run.

## C-47: ESLint coverage for scripts and bench

ESLint 10 does not depend on `@eslint/js`, and `globals` is not declared. Neither
package is in `node_modules`. `eslint:recommended` needs `@eslint/js`, so it
cannot be added without a `package.json` devDependency and lockfile change. That
change is outside this worker's allowed edits, so it is deferred.

1. Importing `@eslint/js` or `globals` fails at config load, which fails every
   `npm run lint` run. Neither import is added.
2. A hand-written Node globals list can drift from the runtime. Missing names
   produce false `no-undef` hits. The list is derived from `globalThis` plus the
   CommonJS wrapper names, so it tracks the Node runtime that runs ESLint.
3. CommonJS files need `require`, `module`, `exports`, `__dirname`, and
   `__filename` declared as globals, or `no-undef` reports them.
4. `bench/` is not in the `lint` or `lint:fix` script arguments, so new rules
   there do nothing until `package.json` lists it. Only those two script lines
   are edited.
5. Enabling rules on existing `.mjs` and `.cjs` files can make `npm run lint`
   red. Each hit is fixed in a `scripts/` or `bench/` file, not suppressed.
   Result: 25 hits with the first, broader glob: 19 in `.mjs` files and 6 in
   `.js` files (listed below).
   Unused imports were removed. A fake-server parameter that was never read was
   dropped with its call-site argument. One escaped quote was reduced to the
   same string value.
   Empty `catch {}` blocks are deliberate best-effort cleanup. `no-empty` uses
   `allowEmptyCatch: true` rather than adding comments to nine catch sites.
   Six hits in `.js` files under `scripts/` (`dist-tools.js`, `gpg-sign.js`,
   `prepare-7z.js`, `updater-signature-verifier.js`,
   `validate-updater-manifest.js`) are outside the new core-rule block. Other
   workers may touch those `.js` files, so they are not edited here.
6. A lint fix in a script can change behavior, for example by removing a binding
   that a dynamic path still reads. The changed scripts are exercised by their
   existing `node --test` files (`test:cargo-safe-update`,
   `e2e-runner-reliability.test.mjs`) and by `test:release-dry-run`, which runs
   the fake GitHub server.
7. Type-aware rules need `parserOptions.project` to include every linted file.
   The new `.mjs` and `.cjs` blocks must not set `project`, or ESLint reports
   "file not included in project".
8. `src/` and `e2e/` are not edited. If the base rules fire there, the hits are
   reported with counts instead of fixed.

## C-47: tsconfig split (Node types out of webview code)

9. A solution-style root `tsconfig.json` with `files: []` and `references`
   makes `tsc --noEmit` check nothing. This was verified: a deliberate type error
   in a referenced project still exits 0. `npm run typecheck` runs
   `tsc --noEmit`, and only `package.json` `typecheck` can make it run two
   projects. That line is outside this worker's allowed edits, so the root
   `tsconfig.json` keeps covering everything and no split is wired in.
10. Probe result: `src/**/*.ts` excluding `src/tests/**` compiles with
    `types: []`, zero errors, 95 files. A deliberate `process` reference fails
    with TS2591, so the probe is not vacuous.
11. `src/e2e-wdio-plugin.ts` is a Node-side Vite plugin. It belongs in the
    Node project, not the webview project.
12. `vite.config.ts` and `vitest.config.ts` are Node-side and must stay in the
    Node project. `src/vite-env.d.ts` is needed by both projects.
13. `src/tests/**` needs DOM and Node types. It belongs only in the Node project.
14. ESLint type-aware rules use `parserOptions.project: ./tsconfig.json`. That
    file must keep including `src/` or the typed rules break.

## C-48: Cargo release profile

15. `overflow-checks = true` in release means integer overflow panics instead of
    wrapping. With `panic = "abort"`, that aborts the process. Any release path
    that relies on wrapping arithmetic on untrusted sizes or counts becomes an
    abort. This is a runtime risk the manifest change does not prove away. The
    manifest parse proof does not cover it.
16. The profile edit must not change the lockfile. `cargo check --locked` must
    pass without writing `Cargo.lock`.
17. The new key must sit under `[profile.release]`, not under `[profile.dev]`
    or a `[[bin]]` table.

## C-48: CI timeout-minutes

18. `quality-gate` runs `npm run test:all`, which includes E2E, and `rust-check`
    runs `npm run test:e2e`. `scripts/test-e2e.js` `e2eWrapperTimeoutMs` gives
    `2 * build + 2 * suite + 60s`: 121 minutes on Linux and macOS, 131 on Windows
    with the defaults. A limit below that cancels a healthy run, so these jobs use
    180 minutes.
19. Jobs without a limit: `commit-message-policy`, `quality-gate`, `rust-check`,
    `updater-manifest`, `security-audit`, `ci-gate` in `ci.yml`, and
    `evaluate-release-policy` in `release-policy.yml`. Jobs that already have a
    limit are left unchanged.
20. Limits above the hosted maximum (360) are rejected or silently capped. Every
    value added here is at most 180.
21. `timeout-minutes` must sit at job level. Placed under `steps:` or a matrix
    entry, GitHub ignores it and the job keeps the default 360.
22. A YAML indentation error breaks every workflow in the file. Each edited file
    is parsed with the `yaml` package before the change is reported.
23. The `ci-gate` `needs` list and its `if` and `test` lines must not change.

## C-48: Dependabot for vendored crates (deferred, no entry added)

24. `src-tauri/Cargo.toml` pulls both vendored crates in only through
    `[patch.crates-io]` `path = "vendor/..."` (lines 68 and 69). Dependabot's
    Cargo updater does not update `path` dependencies, so the `/src-tauri`
    entry never proposes changes to them.
25. A separate `directory: /src-tauri/vendor/<crate>` entry would parse each
    vendored crate's own `Cargo.toml` and `Cargo.lock`. The root build resolves
    dependencies from `src-tauri/Cargo.lock` and ignores those lockfiles. Such an
    entry would open PRs that change nothing the app builds, so no entry is added.
    Dependabot's behavior here is from knowledge of its updater, not a live test.
26. Vendored crate version requirements therefore drift without automation. That
    is recorded as a gap. The fix is a manual update process, not a no-op entry.

## Deferred

- `eslint:recommended`: blocked on `@eslint/js` and `globals` being declared
  devDependencies (item 1). Once approved, `js.configs.recommended` replaces the
  explicit core rule list in `eslint.config.js`.
- Webview/Node tsconfig split wiring: blocked on the `typecheck` script
  (item 9). The split projects are verified with `tsc -p` but not used by
  `npm run typecheck`.
- Dependabot for vendored crates: not applicable to path dependencies (items
  24 to 26).
