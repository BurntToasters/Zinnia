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
