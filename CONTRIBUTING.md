# Contributing to Zinnia

## Setup

```sh
npm install        # also installs the git pre-commit hook (see below)
npm run tauri:dev  # run the app
```

Prerequisites per platform are in [build-setup.md](build-setup.md).

## Checks

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint over `src/` and `scripts/` |
| `npm run format:check` | Prettier check (use `npm run format` to fix) |
| `npm test` | Vitest (frontend) |
| `npm run test:rust` | `cargo test` (backend) |
| `npm run test:all` | All of the above, the way CI runs them |

Rust changes should also pass `cargo clippy --manifest-path src-tauri/Cargo.toml
--all-targets -- -D warnings`.

## Pre-commit hook

`npm install` runs `scripts/install-git-hooks.js`, which points git at the
tracked [`.githooks`](.githooks) directory. The `pre-commit` hook runs
format/lint/typecheck when staged files touch `.ts/.css/.html/.js`.

- Enable manually: `git config core.hooksPath .githooks`
- Bypass once: `git commit --no-verify`

## CI and merge protection

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the quality gate on
every push and PR to `main` and `beta`, plus Rust checks on Windows/macOS and a
security audit (`npm audit`, `cargo audit`, `cargo clippy -D warnings`).

CI runs do not block merges by default. To make the quality gate a hard
requirement, a maintainer must enable branch protection on each protected
branch:

> Settings → Branches → Add rule → Branch name `main` or `beta` →
> **Require status checks to pass before merging** → select `quality-gate`
> (and `rust-check`, `security-audit` as desired).

## Conventions

- Match the surrounding code's style; no framework: vanilla TS + DOM.
- Add tests with each change. Pure logic is unit-tested directly; DOM-dependent
  code uses the jsdom fixture in [`src/tests/setup-dom.ts`](src/tests/setup-dom.ts).
- New 7z switches/commands need both a Vitest arg-builder test and a Rust
  `validate_run_7z_args` test.
- See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map.
