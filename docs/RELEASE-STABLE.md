# Stable release runbook

This runbook covers the final transition from an accepted beta to its stable
release. In commands below, replace `X.Y.Z` with the stable version and `N`
with the accepted beta number. Do not use it to bypass a failed candidate or
`main` gate. Every command below is expected to run from a clean checkout of
the canonical repository.

## 1. One-time release branch enforcement

Both release branches must be protected before any beta or stable release.
With a GitHub CLI account that has repository administration permission, run:

```sh
npm run repo:protect-release-branches
```

The command protects both `beta` and `main`, requires the source-bound `ci-gate`
status check that aggregates every CI proof job, requires the branch to be up
to date, allows the intentional administrator bypass, and disables force pushes
and branch deletion. CI remains limited to tests, audits, validation, and
unsigned compile smoke; all release building, signing, and publishing stays on
the manually operated release VMs. `release:preflight` verifies the active
release branch on every release VM while allowing the administrator bypass.

Confirm the repository Settings page shows the rule before continuing.

## 2. Freeze and prove the stable candidate

The stable candidate is `next-X.Y.Z`, which is promoted directly to `main`.
The published `beta` branch is not an intermediate merge target and does not
need to contain post-beta test-only fixes.

The production source must remain the accepted beta source users tested.
Review every post-beta difference and prove that any accepted difference is
limited to tests or documentation and cannot enter release binaries. No
production, packaging, updater, installer, or release-tooling path may change
without another beta. Then run the complete gate, including E2E:

```sh
git switch next-X.Y.Z
git pull --ff-only origin next-X.Y.Z
git diff --name-status vX.Y.Z-beta.N..HEAD
git diff --check vX.Y.Z-beta.N..HEAD
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
```

Do not run `release:preflight` on `next-X.Y.Z`; it deliberately accepts only an
actual release branch (`beta` for beta versions and `main` for stable versions).
Open the promotion pull request from `next-X.Y.Z` directly to `main`. All GitHub
Actions jobs for that exact pull-request head must be green on every supported
runner before merge. Do not treat a platform-local release build as a
replacement for cross-platform CI. If the production-tree comparison above
finds a runtime change, stop: that runtime must be beta-tested before stable
promotion.

If the accepted beta still needs to be published, use the normal beta release
flow first and complete beta smoke testing before the stable version change.

## 3. Promote the tested source to main

Merge the exact accepted `next-X.Y.Z` pull-request head into protected `main`
through the normal GitHub merge flow. Do not merge it through `beta` first and
do not force push either release branch. Require the post-merge `main` CI run to
pass, then start a short-lived stable-metadata branch from that pushed `main`
tip:

```sh
git switch main
git pull --ff-only origin main
git switch -c release/X.Y.Z
```

Change only the release metadata needed for stable `X.Y.Z`. Set the package
version and synchronize every platform version field:

```sh
npm pkg set version=X.Y.Z
npm run sync-version
node scripts/update-metainfo.js
```

Edit `CHANGELOG.md` so the current section is the final stable `X.Y.Z` entry and
remove beta-only release wording. Review the resulting diff carefully, then
commit it and merge the stable-metadata branch to protected `main` through the
normal pull-request flow. Require every pull-request and post-merge `main` CI
job to pass.

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
It accepts only HTTPS repositories and exact recorded commit hashes. If the
exact source revision also contains no license text, only an explicit
package-version-scoped source-omission review may satisfy the gate; generic
SPDX templates and moving-branch content are never accepted.

Also confirm:

- `git status --short` is empty apart from generated Tauri schema paths that the
  release tooling explicitly permits.
- `npm audit --omit=dev --audit-level=high` passes.
- `npm run audit:dev-reviewed` passes without a new or expired exception.
- `cargo audit` reports no unignored vulnerability.
- The stable version is `X.Y.Z` everywhere and contains no `-beta.N` suffix.

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

The second command must prove the live updater feed and signatures for `X.Y.Z`.
Verify GitHub shows `vX.Y.Z` as the latest non-prerelease release and that the
tag resolves to the exact stable `main` commit.

## 9. Post-release checks

Install or update to `X.Y.Z` through each supported distribution path and perform
a short smoke test of compress, extract, browse, updater, and platform shell
integration. Keep `main` and `beta` protection enabled for the next cycle.

If any publish-time verification fails, stop distribution work and repair the
release metadata or assets. Do not create a second same-version stable release.
