# Release source proof failure modes

Before changing the release proof flow, account for these failure modes:

1. **A checked source file changes between gate stages.** Typecheck or frontend tests may inspect old bytes while later gates pass on newer bytes; final proof must not be recorded.
2. **A non-ignored untracked file is added during the gate.** It may enter a release source bundle without having been tested; reject proof.
3. **A tracked file is deleted during the gate.** Git still lists the tracked path, so the digest must represent the missing file and reject proof.
4. **A package or Cargo lockfile changes during the gate.** Lockfile identity must still be checked explicitly and reject proof.
5. **A supported dirty tree exists before the first gate stage.** The gate may test that exact tree; it must remain eligible for proof when no relevant identity changes afterward.
6. **An allowlisted generated Tauri schema is rewritten during the gate.** This expected build output must not invalidate the source identity; exclusions must remain limited to the exact existing schema filenames.
7. **An ignored output or the proof file itself changes during the gate.** These outputs must not become source identity inputs or recursively invalidate their own proof.
8. **A gate stage fails after an older proof exists.** The old proof must be removed at run start and must not be recreated.
9. **The recorder silently recomputes identity after the controller's final drift check.** A later snapshot could differ from the verified tested identity; recording must use the captured identity supplied by the controller.
10. **The identity-capture seam is omitted from mocked controller tests.** Those tests would hash the live repository and could fail on unrelated concurrent edits; mocked tests must inject identity while a disposable Git fixture exercises real hashing.
11. **An exception or unavailable identity command occurs before/after checks.** No successful proof may be left behind; failures should propagate as a failed run rather than record partial evidence.
12. **Release E2E skip and filtered-run policy changes accidentally.** Keep the approved release-only GUI E2E skip metadata and existing filtered-run denial unchanged.
