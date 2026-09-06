# Stable 0.6.1 release runbook

This runbook covers the final transition from `v0.6.1-beta.9` to stable
`v0.6.1`. Do not use it to bypass a failed beta gate. Every command below is
expected to run from a clean checkout of the canonical repository.

## 1. One-time release branch enforcement

Both release branches must be protected before any beta or stable release.
With a GitHub CLI account that has repository administration permission, run:

```sh
npm run repo:protect-release-branches
```

The command protects both `beta` and `main`, requires the `quality-gate` status
check, requires the branch to be up to date, applies the rule to administrators,
and disables force pushes and branch deletion. `release:preflight` verifies the
active release branch on every release VM and fails if this protection is
missing or weakened.

Confirm the repository Settings page shows the rule before continuing.

## 2. Freeze and prove beta.9

Do not promote a different commit than the beta.9 candidate users tested.
On `beta`, verify the pushed commit and run the complete gate, including E2E:

```sh
git switch beta
git pull --ff-only origin beta
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
npm run release:preflight
```

All GitHub Actions jobs for that exact commit must be green on every supported
runner before promotion. Do not treat a platform-local release build as a
replacement for cross-platform CI.

If beta.9 still needs to be published, use the normal beta release flow first
and complete beta smoke testing before the stable version change.

## 3. Promote the tested source to main

Merge the exact accepted `beta` tip into protected `main` through the normal
GitHub merge flow. Do not force push either release branch. Then start from the
pushed `main` tip:

```sh
git switch main
git pull --ff-only origin main
```

Change only the release metadata needed for stable 0.6.1. Set the package
version and synchronize every platform version field:

```sh
npm pkg set version=0.6.1
npm run sync-version
node scripts/update-metainfo.js
```

Edit `CHANGELOG.md` so the current section is the final stable 0.6.1 entry and
remove beta-only release wording. Review the resulting diff carefully, then
commit and push it to protected `main` through the normal merge flow.

## 4. Prove the stable source

On the exact pushed stable commit, run the complete quality gate and strict
license collection:

```sh
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
npm run licenses:cargo:strict
npm run release:preflight
```

The strict Cargo license step may fetch the exact immutable VCS revisions
recorded by crates.io when a published crate omitted a workspace-root license.
It accepts only HTTPS repositories and exact recorded commit hashes. Any text
that still cannot be recovered keeps the gate red.

Also confirm:

- `git status --short` is empty apart from generated Tauri schema paths that the
  release tooling explicitly permits.
- `npm audit --omit=dev --audit-level=high` passes.
- `npm run audit:dev-reviewed` passes without a new or expired exception.
- `cargo audit` reports no unignored vulnerability.
- The stable version is `0.6.1` everywhere and contains no `-beta.N` suffix.

## 5. Build and sign on isolated platform VMs

Use clean, isolated release VMs. The normal entry points run release preflight,
prepare locked dependencies, regenerate notices and sidecars, and create or
reuse the commit-bound draft:

```sh
# Windows release VM
npm run release:win

# macOS release VM
npm run release:mac

# Linux x64 release VM
npm run release:linux
```

Run `release:linux:arm64` only on the supported ARM64 release environment when
that artifact is part of the release. Do not use beta recovery overrides for a
stable release.

The platform release commands intentionally skip GUI E2E on the signing VM.
That is acceptable only because step 4 and protected CI already proved the
exact stable commit with E2E enabled.

## 6. Packaged-artifact QA

Before publishing, execute the packaged operating-system integration matrix in
[`QA-CONTEXT-MENUS.md`](QA-CONTEXT-MENUS.md) against the signed artifacts.
Include updater behavior, Windows shell registration, macOS Finder integration
and notarization, and Linux MIME/desktop integration where applicable.

Fix and rebuild any failing artifact. Do not publish a draft that has not
passed this matrix.

## 7. Verify the draft before publishing

After all required platform assets and signatures are present:

```sh
npm run release:verify:draft
```

This must pass against the complete stable draft. Resolve duplicate drafts,
missing signatures, incorrect manifest URLs, or a wrong target commit instead
of overriding the verifier.

## 8. Publish, then verify the live feed

Publish only through the guarded command, which reruns draft verification
before changing the GitHub release state:

```sh
npm run release:publish
npm run release:verify:published
```

The second command must prove the live updater feed and signatures for 0.6.1.
Verify GitHub shows `v0.6.1` as the latest non-prerelease release and that the
tag resolves to the exact stable `main` commit.

## 9. Post-release checks

Install or update to 0.6.1 through each supported distribution path and perform
a short smoke test of compress, extract, browse, updater, and platform shell
integration. Keep `main` and `beta` protection enabled for the next cycle.

If any publish-time verification fails, stop distribution work and repair the
release metadata or assets. Do not create a second same-version stable release.
