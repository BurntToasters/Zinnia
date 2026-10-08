# Contributing to Zinnia

## Setup

```sh
npm ci --ignore-scripts
node scripts/install-git-hooks.js
npm run tauri:dev  # run the app
```

`.npmrc` sets `ignore-scripts=true`, so `npm install` / `npm ci` will not run
the `prepare` hook. Install git hooks with `node scripts/install-git-hooks.js`.

Prerequisites per platform are in [build-setup.md](build-setup.md).

## Checks

| Command                       | What it does                                                        |
| ----------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck`           | `tsc --noEmit` (strict)                                             |
| `npm run lint`                | ESLint over `src/`, `scripts/`, and `e2e/`                          |
| `npm run format:check`        | Prettier check (use `npm run format` to fix)                        |
| `npm run validate:no-em-dash` | Rejects Unicode em dash (U+2014) in tracked text                    |
| `npm test`                    | Vitest (frontend)                                                   |
| `npm run test:archives`       | Real 7-Zip extract/list/create/add/convert against [`zips/`](zips/) |
| `npm run test:e2e`            | Unpackaged-app WebdriverIO against Basic/Power UI                   |
| `npm run test:rust`           | `cargo test` (backend)                                              |
| `npm run test:all`            | All of the above, the way CI runs them                              |

Rust changes should also pass `cargo clippy --manifest-path src-tauri/Cargo.toml
--all-targets -- -D warnings`.

## Git hooks

`npm ci --ignore-scripts` (or `npm install`) does not install git hooks because
`.npmrc` has `ignore-scripts=true`. Run `node scripts/install-git-hooks.js`,
which points git at the tracked [`.githooks`](.githooks) directory.

- `pre-commit` runs format/lint/typecheck when staged files touch `.ts/.css/.html/.js`.
- `prepare-commit-msg` / `commit-msg` strip `Co-authored-by` trailers that
  include an email, so GitHub does not add extra contributors. To keep a
  human co-author, prefix the email with `!`:

  `Co-authored-by: Name <!you@example.com>`

  The hook removes the `!` and leaves a normal GitHub trailer. Agent
  addresses (`@cursor.com`, Copilot, Claude) cannot be kept this way.

- Enable manually: `git config core.hooksPath .githooks`
- Bypass once: `git commit --no-verify`

## CI and merge expectations

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on PRs to `main` and
`beta`, then runs again on pushes to those branches to prove the exact
post-merge tip. Feature-branch pushes with an open PR are not run twice. The
workflow includes Windows/macOS Rust checks, every supported platform/CPU
compile smoke, and `npm audit`/`cargo audit` security checks.

The `main` and `beta` branches intentionally have no branch protection. The
`beta` branch may be deleted and recreated. Pull request review and hosted CI
checks remain mandatory release-process requirements, and operators must verify
them before merging; branch rules do not enforce them. The source-bound
`ci-gate` check aggregates every independent proof job. Before releasing,
confirm a successful hosted `ci-gate` for the exact `main` or `beta` commit;
release preflight does not check it.

A repository admin can install the immutable beta release-tag ruleset (optional
for now; release preflight and the release-policy check do not require it) with:

```sh
npm run repo:protect-beta-tags
```

This ruleset protects `v*-beta.*` tags from updates and deletions. It does not
protect `main` or `beta`; a deleted `beta` branch can be recreated while its
published beta tags remain immutable.

## Cutting a stable release

Stable versions (no `-beta.N`) have manual steps that automation cannot prove:
the changelog banner removal, `licenses:cargo:strict`, draft verification, and
the publish/verify ordering. Follow `docs/RELEASE-STABLE.md`.

## Conventions

- Match the surrounding code's style; no framework: vanilla TS + DOM.
- Use ASCII punctuation only in repo text: no Unicode em dash (U+2014). Use `-`, `,`, or `:` instead (see `.cursor/rules/no-em-dash.mdc`).
- Add tests with each change. Pure logic is unit-tested directly; DOM-dependent
  code uses the jsdom fixture in [`src/tests/setup-dom.ts`](src/tests/setup-dom.ts).
- New 7z switches/commands need both a Vitest arg-builder test and a Rust
  `validate_run_7z_args` test.
- Archive format coverage lives in [`zips/`](zips/). Regenerating writable
  fixtures: `npm run prepare:7z && npm run test:archives:generate`. Do not
  overwrite `hello.rar` unless you pass `--write-rar` (7-Zip cannot create RAR).
- GUI E2E is `npm run test:e2e` (also part of `test:all`). It builds a debug
  binary with `--features e2e` and never belongs in release/signed builds.
  The WebDriver capability is inlined in [`src-tauri/tauri.e2e.conf.json`](src-tauri/tauri.e2e.conf.json)
  so production ACL generation never sees `wdio-webdriver`. Linux CI uses xvfb.
  `SKIP_E2E=1` is refused (exit 1). Release commands temporarily use
  `test:all -- --require-clean-proof --skip-e2e`; their proof explicitly records
  `e2e: "skipped"`. Normal `test:all` and CI still require GUI E2E.
  `ZINNIA_E2E_REBUILD=1` forces a rebuild of the
  debug app.
- See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map.

### Windows GUI E2E

A Windows release-machine run failed before WebDriver became ready. The app
exited with code 101 during the Tauri setup hook because WebView2 creation
returned `HRESULT(0x80070578): Invalid window handle.` The build succeeded.

An SSH or service session without an interactive desktop is a suspected cause,
not a confirmed diagnosis. Tauri users report the same error over SSH and a
successful launch from the Windows desktop in
[discussion #6008](https://github.com/orgs/tauri-apps/discussions/6008).
Run `npm run test:e2e` from PowerShell inside a logged-in Windows desktop to
verify GUI behavior. Backend startup logs are in `logs/wdio-*.log`;
`coverage/e2e/result.json` records the suite result and verification evidence.

For now, `release:prepare` and all platform release commands skip GUI E2E while
running the remaining checks. Their quality-gate proof and release session
record `e2e: "skipped"`; this is not GUI verification. Resume and continuation
commands still verify the release session. `workspace:prepare`, normal
`test:all`, and hosted CI continue to run GUI E2E. Remove the temporary release
skip after Windows desktop E2E succeeds in the supported release environment.

### Where to put new code

| Change                             | Prefer                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Basic workspace UI / sync          | `src/basic/`                                                                                                    |
| 7z arg building or archive ops     | `src/archive/`                                                                                                  |
| Shared status/progress/mode chrome | `src/ui/`                                                                                                       |
| App boot / Power event wiring      | `src/app-init.ts`, `src/power-events.ts`, `src/power-helpers.ts`, `src/power-shortcuts.ts`, `src/power-logs.ts` |
| Staging, journal, `run_7z`         | `src-tauri/src/process/`                                                                                        |
| OS integration / defaults          | `src-tauri/src/platform/`                                                                                       |
| File-open / extract window routing | `src-tauri/src/launch/`                                                                                         |
