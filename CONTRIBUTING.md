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

## CI and merge protection

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the quality gate on
every push (all branches) and on PRs to `main` and `beta`, plus Rust checks on
Windows/macOS and a security audit (`npm audit`, `cargo audit`,
`cargo clippy -D warnings`).

Release branches must require the `quality-gate` check. A repository admin can
apply the project policy to both `main` and `beta` with:

```sh
npm run repo:protect-release-branches
```

The command requires strict status checks, applies enforcement to admins, and
disables force pushes and branch deletion. Release preflight verifies the
active release branch and fails closed if this protection is missing or
weakened. Additional checks such as `rust-check` and `security-audit` may also
be required in repository settings.

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
  `SKIP_E2E=1` is refused (exit 1) so quality-gate proof cannot skip the suite.
  `ZINNIA_E2E_REBUILD=1` forces a rebuild of the
  debug app.
- See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map.

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
