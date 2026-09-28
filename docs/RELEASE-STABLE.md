# Stable release runbook

This runbook covers the final transition from an accepted beta to its stable
release. In commands below, replace `X.Y.Z` with the stable version and `N`
with the accepted beta number. Do not use it to bypass a failed candidate or
`main` gate. Every command below is expected to run from a clean checkout of
the canonical repository.

## 1. One-time beta-tag enforcement

The `main` and `beta` branches intentionally have no branch protection. The
`beta` branch is mutable and may be deleted and recreated. Pull request review,
hosted CI, and promotion policy checks are mandatory release-process gates that
operators must verify; GitHub does not enforce them through branch rules. With
a GitHub CLI account that has repository administration permission, you can
install the beta-tag ruleset. It is optional for now: neither
`release:preflight` nor the `release-policy` check requires it.

```sh
npm run repo:protect-beta-tags
```

First land the trusted `.github/workflows/release-policy.yml` and
`scripts/release-promotion-policy.mjs` on `main` through a separately reviewed
policy bootstrap. The workflow runs from the PR base, so adding it only to a
candidate branch cannot enforce that candidate; requiring its check before it
exists on `main` would block every PR. After bootstrap, operators must verify
the hosted `ci-gate` and `release-policy` checks before merging a promotion PR.
`ci-gate` aggregates CI proof; `release-policy` reads PR commits as Git data
from base-owned code and never executes PR code. CI remains limited to tests,
audits, validation, and unsigned compile smoke; release building, signing, and
publishing stay on manually operated release VMs.

`release-policy.yml` grants only `contents: read`, `pull-requests: read`,
`actions: read`, and `checks: write`. Before checkout it creates a
`release-policy` check run with `GITHUB_TOKEN` on the event's exact PR head
SHA. It checks out only the base SHA and reads the candidate as Git data. Before
success, it reads the current PR label history and actor permission, requires
the latest event for the exact accepted-beta label to be an application by a
currently verified repository maintainer or admin, verifies the matching tag
has a published non-draft prerelease, and requires the latest trusted GitHub
Actions push run of `.github/workflows/ci.yml` on `refs/heads/beta` for that
exact beta SHA to have succeeded. Its `ci-gate` must belong to that run's check
suite and use the GitHub Actions app. It repeats the PR, label, release, and CI
reads and rejects changes between the two snapshots, then resolves the beta tag
again immediately before completing the same check as success or failure.
Missing API evidence or a missing/failed policy check blocks promotion. The
beta-tag ruleset is not checked for now.

For a public repository, verify the repository or organization Actions event
policy explicitly permits this restricted `pull_request_target` workflow;
GitHub's default public-repository policy will block that event when enforced.
Because neither release branch has protection, operators must require the
appropriate PR reviews and checks before merging. `release:preflight` no longer
checks hosted CI status. Operators must confirm a successful hosted push
`ci-gate` on the exact `main` (stable) or `beta` (beta) HEAD before releasing,
including when a direct push bypasses the normal review flow.

The command creates an active repository ruleset named `Immutable beta release
tags`. It targets only `refs/tags/v*-beta.*`, blocks updates and deletions, and
has no bypass actors. It still permits creating a new beta tag. This ruleset
protects tags only; it does not protect either branch, so `beta` remains
deletable and recreatable. The ruleset is optional for now; without it, beta
tags can be moved or deleted, so do not rewrite a published beta tag.

## 2. Freeze and prove the stable candidate

The only stable candidate source branch is `next-X.Y.Z`, promoted directly to
`main`; promotion CI enforces this source/target pairing. Operators must review
the PR and verify all required checks because branch rules do not enforce them.
The published `beta` branch is not an intermediate merge target and does not
need to contain post-beta test-only fixes.

The production source must remain the accepted beta source users tested.
Review every post-beta difference and prove that any accepted difference is
limited to tests or documentation and cannot enter release binaries. No
production, packaging, updater, installer, build, or release-toolchain path may
change without another beta. Any such change requires a fresh beta, repeated
beta smoke testing, and a full new burn-in period before stable promotion. Then
run the complete gate, including E2E:

```sh
git fetch --tags origin
git rev-parse --verify "refs/tags/vX.Y.Z-beta.N^{commit}"
git switch next-X.Y.Z
git pull --ff-only origin next-X.Y.Z
git diff --name-status vX.Y.Z-beta.N..HEAD
git diff --check vX.Y.Z-beta.N..HEAD
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
```

Confirm that the displayed beta-tag commit is the exact published beta source
users tested. Use this tag as the comparison baseline; do not substitute the
mutable `origin/beta` branch tip.

After beta smoke testing and burn-in, a maintainer must create and apply one
acceptance label for the exact beta tag, with its peeled commit SHA recorded in
the label description. Do this only for the beta actually accepted for stable:

```sh
TAG_SHA=$(git rev-parse "refs/tags/vX.Y.Z-beta.N^{commit}")
gh label create "accepted-beta:vX.Y.Z-beta.N" --color 0E8A16 --description "sha=$TAG_SHA"
gh pr edit PR_NUMBER --add-label "accepted-beta:vX.Y.Z-beta.N"
```

Keep the tag immutable after acceptance. The trusted policy requires exactly
one `accepted-beta:` label on the promotion PR, an exact branch/version/tag
match, the tag at the SHA in that label description, a published non-draft beta
prerelease for that tag, and a successful trusted hosted `ci-gate` on that exact
beta SHA from the successful push run of `.github/workflows/ci.yml` on
`refs/heads/beta`, with `ci-gate` bound to that run's check suite and GitHub
Actions app. It reads the PR issue-event history to identify who applied the
current label and checks that account's current repository role is maintainer
or admin; it repeats the evidence reads, resolves the tag once more, then
publishes success. It also requires no changes from the accepted beta tree
except added or modified
documentation and test files on a strict allowlist. A merge commit ancestry
relationship is not required; comparison is between the two trees. A
production, packaging, dependency, workflow, or release-tooling change requires
another published and accepted beta. The base-owned policy verifies the active
update/deletion rules and re-resolves the remote tag before it reports success.
The acceptance label does not replace the independent required PR approval.
Verify the label and SHA in the PR's audit trail before merge.

Do not run `release:preflight` on `next-X.Y.Z`; it deliberately accepts only an
actual release branch (`beta` for beta versions and `main` for stable versions).
Open the promotion pull request from `next-X.Y.Z` directly to `main`. Both
required checks and all GitHub Actions proof jobs for that exact pull-request
head must be green on every supported runner before merge. Do not treat a
platform-local release build as a replacement for cross-platform CI. If the
production-tree comparison above finds a runtime change, stop: that runtime
must be beta-tested before stable promotion. Require all six platform-specific `archive-io-promotion-*`
release-scale benchmark artifacts for that exact PR head. Each artifact must
identify the PR head as candidate and the commit resolved from
`vX.Y.Z-beta.N` as baseline. Review every platform report against that accepted
beta baseline and record an explicit disposition in the PR for every target
miss and measured regression. Benchmark timings remain report-only, so a green
check alone does not resolve those findings.

If the accepted beta still needs to be published, use the normal beta release
flow first and complete beta smoke testing before the stable version change.

## 3. Promote the tested source to main

Merge the exact accepted `next-X.Y.Z` pull-request head into `main` through the
normal GitHub review flow after an operator verifies the required reviews and
checks. Do not merge it through `beta` first. Require the post-merge `main` CI
run to pass, then start a short-lived stable-metadata branch from that pushed
`main` tip:

```sh
git switch main
git pull --ff-only origin main
git switch -c release/X.Y.Z
```

Change only the release metadata needed for stable `X.Y.Z`. Edit `package.json`
`version` to `X.Y.Z`, then synchronize that value without performing dependency
updates:

```sh
npm run sync-version
node scripts/update-metainfo.js
```

Edit `CHANGELOG.md` so the current section is the final stable `X.Y.Z` entry and
remove beta-only release wording. Review the resulting diff carefully, then
commit it and merge the stable-metadata branch to `main` through the normal
pull-request flow after verifying every required review and check. Require
every pull-request and post-merge `main` CI job to pass. CI accepts
`release/*` to `main` only when the base version is the
same beta series, the head removes only the beta suffix, the diff is the exact
synchronized metadata set, and every machine-readable file matches its
version-only transformation. Additions, deletions, renames, dependency changes,
and build-policy changes fail closed.

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
- `npm run audit:dev-reviewed` passes (fails only if an advisory is production-reachable).
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

The platform release commands run the full gate, including unpackaged GUI E2E,
on each signing VM before building artifacts. Keep the verifiable
`coverage/e2e/result.json` and suite logs with the release evidence, and check
the commit recorded there equals the stable `main` HEAD. Protected CI also
uploads `e2e-proof-*` artifacts for its Windows and macOS jobs. Neither the
local nor hosted E2E proof substitutes for packaged-artifact QA below.

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
integration. The `main` and `beta` branches remain intentionally unprotected.
The `beta` branch may be deleted and recreated; immutable beta release tags
are protected only when the optional tag ruleset is installed.

If any publish-time verification fails, stop distribution work and repair the
release metadata or assets. Do not create a second same-version stable release.
