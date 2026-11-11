# E2E runner failure inventory

Failure cases considered before the process-capture changes:

- Changed frontend input, generated sidecar, Cargo environment, binary, commit, or fixture is attributed to the wrong E2E run or leaves a stale binary stamp valid.
- A build input changes during compilation or between final validation and stamp writing, yet the newly built binary is marked fresh.
- A hung command, nonzero archive build, successful command with a detached child, or WebDriver close failure leaves a resistant descendant alive.
- `test:all` stops `test:e2e` before its own timeout and bounded process cleanup can finish.
- Windows tree cleanup trusts taskkill success while descendants survive, cannot stop an active leader after an empty process snapshot, or allows PID reuse to target an unrelated process.
- Windows process identity capture finishes after a short-lived leader exits, and cleanup incorrectly turns an otherwise successful command into an intermittent failure.
- A Windows identity query never captures a still-running timed-out leader, so cleanup waits indefinitely instead of respecting its deadline.
- A Windows child or grandchild is first seen after the leader exits, or after its recorded parent PID has been reused, and is adopted or killed without live-parent ownership proof.
- A child seen while its parent is live exits before its own child can be safely observed; a grandchild appears after leader exit; or a child appears during cleanup after the last process snapshot.
- A process inventory read fails, an identity lacks a creation time, or a late process has an unresolved parent, but cleanup still reports the tree stopped.
- A successful E2E run omits durable suite logs, hashes, fixture manifest, binary, source, or commit evidence; a failed run omits its result artifact.
- The E2E result artifact reports a successful run without recording that Windows process cleanup was unproven.
- A missing fixture or suite log prevents even a failed proof from persisting, or backend startup errors are omitted from the artifact.
- A changed npm 12 release is selected by the Flatpak workflow as calendar time advances.
- An unrelated local Tauri app owns port 4445; reservation reports port zero, leaves a probe socket open, or selects an unavailable port.
- Another process takes a released WebDriver port, or the runner releases its reservation before the one-use app launcher consumes it.
- A Linux quality-gate E2E proof is not uploaded after a later step fails.
- Archive benchmark checkout, toolchain, npm, or preparation failure lacks a diagnostic artifact; hard Actions cancellation prevents the always-run diagnostic step.
- A successful Windows command exits before its leader PID and creation time are captured; the runner warns and reports success with cleanup unproven.
- Windows cleanup targets a reused PID, reports verified after an inventory/identity failure, or misses a short-lived parent whose detached grandchild survives.
- A fenced Windows launch starts the real command before the exact wrapper identity is captured, accepts the wrong/duplicate handshake, or waits forever after an identity/handshake failure.
- The Windows launch fence changes command arguments, environment, working directory, stdout/stderr, exit status, or signal forwarding; its temporary launcher/payload is left behind.
- A Windows success artifact has no verified process-cleanup record, CI accepts it, or archive benchmark freshness is stamped after unproven build cleanup.
- A fast Windows command detaches a grandchild; runner claims verified while the grandchild remains and the test profile cannot be removed.

- On Windows, the E2E source digest walks `src-tauri\binaries` because the ignored path uses `/` while `path.join` uses `\`.
- Artifact tests that do not pass a platform inherit the host platform, so Windows hosts fail on fail-closed cleanup policy rather than the evidence under test.
- An artifact that fails for both changed evidence and unproven Windows cleanup reports only the cleanup reason.
- `cargo test` without the `e2e` feature rewrites the tracked `acl-manifests.json` and dirties the working tree.
- Windows-only runner tests never run in CI because `test:e2e-runner` runs only on Linux.
- The archive WDIO timeout test never starts Windows identity capture, so cleanup refuses to kill and the test fails on Windows hosts.

Windows Job Object confinement failure cases considered before the change:

- The fenced wrapper exits, or its PID is reused, between identity capture and job assignment, and an unrelated process is assigned to the job.
- The job helper cannot start, cannot compile its native bindings, or cannot assign the wrapper, but the command still starts without confinement.
- Nested jobs are not supported, or the wrapper is already in a job that rejects nesting, and assignment silently fails.
- A descendant uses detached or breakaway creation flags and leaves the job.
- The job helper exits or the runner crashes while the command runs, and the command tree is left alive.
- Job termination returns but processes remain because the kill is pending or denied, yet cleanup reports verified.
- The job helper stops responding during termination, and cleanup waits past its deadline.
- Job confinement replaces snapshot cleanup even when the job was never assigned, so simulated capture failures report verified.
- Disposing a fenced launch leaves its job helper process running.

Windows fenced commands run inside a kernel Job Object. A PowerShell helper creates the job with kill-on-close and no breakaway permission. It assigns the fenced wrapper only after it opens the wrapper by PID and matches the captured creation time, and only then does the wrapper start the real command. Cleanup terminates the job and reports verified only when the job's active process count reaches zero. If the job cannot be assigned, the command does not start. When no job is assigned, cleanup falls back to the PID plus creation-time snapshot path, which stays fail-closed.

## Local spec filter

Failure cases considered before `--only` / `ZINNIA_E2E_ONLY`:

- A filtered run writes `status: "passed"` and is accepted as release or CI proof.
- `npm run test:all` forwards the filter or runs fewer E2E suites while still recording full proof.
- An unknown spec name runs nothing and still exits zero or writes a passing artifact.
- The filter skips build, profile setup, fixture preparation, or teardown that the selected spec still needs.
- Selecting only `crash-recovery` or a recovery phase without the matching crash launch leaves the profile without the expected transaction state.
- Spec files under `e2e/specs/` that are not part of the recovery plan (for example `archive-io-benchmark`) cannot be selected; only names listed in the unknown-spec error are valid.

## 0.7.0 audit follow-up E2E

Failure cases considered before the runner selection fixes and the new specs:

Runner selection (`scripts/test-e2e.js`):

- `--only crash-recovery` or a single case token runs the restart launch without its crash launch. The relaunch finds no transaction state, so the recovery spec would only check an empty profile and can pass vacuously. Each recovery selection must also run its crash launch, and `crash-recovery` must fail if the crash marker or journal is missing.
- `resolveE2eOnlySelection(tokens, root)` reads the repo plan instead of the plan under `root`. A fixture root with a different plan would accept names the root does not list, or reject names it does. The selection must read `root/e2e/recovery-plan.json`.
- `ZINNIA_E2E_PAUSE_AT` inherited from a developer shell pauses every extraction in every spec and turns unrelated runs into timing tests. Each launch must blank it, as it does for `ZINNIA_E2E_CRASH_AT`.
- A pause marker left by an earlier launch satisfies the spec's wait before the pause starts, so Cancel lands after the window and the spec passes without racing. Each cancel-race profile must start with no marker, and the spec must check the marker content equals its point.
- A new spec missing from `scenarioSpecs` or from `suiteCount` is silently skipped on a full run, or fails only at the end. `suiteCount` must match the plan on every full run.
- A new name with no envOverrides runs without `ZINNIA_E2E_PAUSE_AT`, so Cancel never lands inside the pause window. The spec must fail on the marker wait, not pass.

`pending-registry.spec.js`:

- The app ignores a seeded `pending-stages.json` at startup. No corrupt copy appears, so the spec must fail on its wait for the copy, not pass.
- The app preserves the bytes but leaves the unreadable registry in place. The spec must fail on the registry-absent check.
- A second corrupt copy is created by a later read in the same session. The spec must fail on the count check after the extract.
- The preserved copy is re-serialized or truncated. The spec must fail on the SHA-256 comparison with the seeded bytes.
- The copy is written to a different directory than the cache dir the seed used. The spec must fail on its cache-dir glob.
- The leaked stage directory is deleted, or its `staged.txt` changes. The spec must fail on the tree-manifest comparison.
- The normal Power extract after startup is blocked or writes no payload. The spec must fail on the payload wait and the content check.
- The normal extract leaves a new `.zinnia-extract-*` behind. The spec must fail on the exact leftover list, which must contain only the leaked stage.
- A relaunch on the same profile adds a copy. The runner runs one launch per scenario spec, so this is not detected. Only a stability check within the session is run; this limitation is recorded in the spec evidence.
- The spec passes vacuously if the seed helper writes nothing. The app consumes the registry at startup, before any spec hook runs, so the spec cannot check the seed pre-launch. The preserved copy must match the recorded seed digest, which fails if nothing was seeded.

`cancel-race.spec.js` and `cancel-race-compound.spec.js`:

- The pause point is never reached, for example a misnamed point or an archive that skips the member listing. The marker wait must time out and fail the spec.
- The Cancel click lands after the pause ends, so the cancel did not race the operation. The spec must fail when the click is not inside the pause window, as recorded from the marker time.
- The app ignores a cancel issued during the pause and completes. The spec must fail on the `Extraction complete.` toast or on the payload being present.
- The app reports `Cancelled` while a 7-Zip process keeps running. The spec must fail on the 7-Zip process check after cancel. A live 7-Zip process at the pause is recorded only, because the member listing can exit before the pause ends.
- A cancelled run leaves a destination, a `.zinnia-*` stage, or a journal behind. The spec must fail on those absence checks.
- The operation outlives pause plus 15 seconds. The spec must fail on the bounded idle wait and record the timing.
- The UI shows `Cancelled` but the Power button stays disabled. The spec must fail on the idle wait, not accept the status alone.
- A second normal extract after the cancel fails or writes a different payload. The spec must fail on the payload check.
- The compound fixture is missing from `zips/`. The helper must throw before launch rather than run without the fixture.
- The compound case is treated as plain gzip and never reaches `compound-tar-spawned`. The marker wait must fail.
