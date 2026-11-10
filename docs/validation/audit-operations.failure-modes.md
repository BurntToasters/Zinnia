# Archive operation flow failure inventory

This inventory was written before changing production code. It covers the
frontend operation flow for Power (`src/archive/ops.ts`,
`selective-run.ts`, `inspection.ts`) and Basic (`src/basic/actions.ts`,
`browse-events.ts`): password field lifetime (A-01), listing and password
prompts (B-07, C-05), confirm dialogs (C-01, C-02), log levels (C-10),
cancel feedback (C-11), and operation copy (C-39, browse limit copy).

## Password field lifetime (A-01)

- Clearing the password fields in a `finally` block erases the user's intent
  on pre-run errors. A wrong output extension, a GZIP/BZIP2/XZ batch error,
  or a runtime probe failure leaves the fields empty; the retry then creates
  an unencrypted archive.
- Gating the clear on "7-Zip started" must set the flag at the right point.
  Setting it before `ensureRuntimeReady()` clears on probe failures; setting
  it after `withLiveProgress` begins misses nothing but must not run for a
  declined "Replace archive" confirm.
- A cancel that arrives before the spawn (`state.cancelRequested` already set)
  must not clear the fields. A cancel of a running job must clear them.
- The success branch clears the fields and must keep doing so after a
  successful run, including on the Basic extract path.
- Basic extract copies a prompted password into `#basic-extract-password` and
  `#extract-password` before `runAction`. Removing the unconditional clear in
  `handleBasicExtractAction` must not leave a copied password behind when the
  run never starts. Fields that were never populated stay as they were.
- Batch extract (`runBatchExtract`) clears the fields in its `finally`. The
  same gate applies: a batch that is cancelled or fails before its first
  archive is spawned must keep the password.
- `testArchive` and `selective-run.ts` have the same `finally` shape and need
  the same gate. The `passwordCarry` object used internally by batch extract
  is in-memory only and can still be cleared unconditionally.
- Power and Basic share `runAction`; the Basic compress path has no clear of
  its own and must still keep the password on pre-run errors.
- A declined Replace confirm must leave the output path and password exactly
  as typed, so the next Run asks again rather than running unencrypted.

## Encryption check and upfront prompt (B-07)

- `isArchiveEncrypted` returns `null` for three cases: IPC or probe failure,
  truncated listing, and an exception. Treating `null` as "encrypted" shows a
  password prompt with no "no password" escape, so a plain archive can never
  be extracted in Basic when the listing is large.
- Skipping the prompt on `null` must still allow a real encrypted archive to
  prompt. The run then goes through `runWithPasswordRetry`, which prompts on a
  recognised password error. The prompt must not be lost in the path from
  `handleBasicExtractActionOnce` to `runAction`.
- An explicit `false` must still skip the prompt; an explicit `true` must
  still prompt before the destination dialog.
- A `null` result combined with an invalid archive path must still show the
  validation completion and not start a run.
- The log line that says "treating it as encrypted" becomes stale and must
  change with the behaviour.

## Update-mode confirm and success copy (C-01)

- The title and button must be read from the `#update-mode` checkbox at the
  time of the Run click, not from the format. Non-update compress keeps
  "Replace archive" and "Replace".
- Update mode with an existing archive must show the new title and button;
  Cancel must still stop the run before any 7-Zip spawn.
- Success text in update mode must say "Archive updated." Non-update success
  keeps "Archive created." and extraction keeps "Extraction complete."
- The title passed to the E2E confirm recorder must match the native title,
  or the E2E confirm assertion checks a value the user never sees.

## Basic overwrite double confirm (C-02)

- The native save dialog already confirms overwrite. Zinnia's confirm must be
  skipped only for the path that came from that dialog (or the E2E dialog
  queue that stands in for it).
- A path typed into `#basic-output-path`, or a path filled from a previous
  native dialog that is still in the field, must keep Zinnia's confirm.
- The skip must not survive into a later run. It is per invocation, so a
  second Run with the field populated asks again.
- An absent output file must still run without a confirm, as before.

## Browse of header-encrypted archives (C-05)

- `browseArchive` calls `invokeGuardedRun7z` directly. A password-required
  listing shows a sticky error toast and never prompts. Routing the listing
  through `runWithPasswordRetry` must keep the identity check: the retry
  result is the one whose `archiveIdentityAfter` is compared with the
  identity captured before the listing.
- A user cancelling the prompt must end the browse quietly (status
  "Cancelled", no error toast) and must not leave a stale browse cache entry.
- A wrong password entered in the prompt must still produce a clear error
  instead of an infinite prompt loop. `runWithPasswordRetry` retries once; a
  second wrong password returns the failed result.
- The password that worked for the browse must be the one the Basic "Extract
  all" button reuses. It must only be reused for the same archive path and
  identity, and it must be forgotten when a new browse starts.
- "Extract all" must still ask for a password when the browse did not succeed
  with one (for example, the user browsed a plain archive that was later
  replaced).
- The Power browse path (`#browse-password` filled by the user) must keep
  working without a prompt.
- Non-password listing failures (corrupt archive, exit 2 without password
  text) must keep their existing hint and not open the password prompt.

## Log levels (C-10)

- Changing the level must not change the message text. The local log stores
  the level as a tag, so an error-level line must still include the same
  text and be redacted in the same way.
- Only the failure lines listed in the plan are changed. Info lines for
  successful or cancelled runs keep their level.

## Cancel feedback (C-11)

- A failed `cancel_7z` must not reset to "Idle" while the job runs. The status
  must keep showing the running state and a "Could not cancel" toast.
- After a failed cancel the cancel intent stays recorded (existing unit test
  "keeps cancellation intent when backend cancellation errors"), so the next
  checkpoint still honours it. The inventory accepts this: a failed cancel
  does not silently discard the user's request.
- A successful cancel keeps the existing "Cancelling..." then "Cancelled"
  path.
- A cancel while idle (`cancel_7z` returns false) keeps its current behaviour.
- The failing-cancel path depends on an IPC error from `cancel_7z`. It cannot
  be produced through the GUI on this host, so it is not covered by this
  spec. Its code path is reviewed by reading only.

## Operation copy (C-39 and browse limit)

- Basic validation completions ("Add at least one input.", the GZIP/BZIP2/XZ
  single-input rule, "Select an archive to extract.", and the invalid archive
  path reason) move from "Operation failed" to "Check your choices". Dialog
  open failures keep "Operation failed" because they are real failures.
- The Basic busy toast must say an operation is already running. Other
  lock-related messages keep their meaning.
- The "archive listing too large" toast must give the new 64 MiB copy and must
  keep the error styling and sticky duration.
- Copy changes in files this worker does not own (for example
  `incoming-paths.ts`, which says "dropped files" for Explorer hand-offs) are
  listed in the report rather than edited.
- Basic completion copy is rendered from the same string in both the toast and
  the completion panel. Changing one must not leave the other stale.

## E2E coverage and gaps

- Covered by `e2e/specs/audit-operations.spec.js`: Power wrong-extension and
  declined Replace keep the password; Basic wrong-extension and typed-path
  Replace; Basic native save path skips the second confirm; browsing a
  header-encrypted 7z prompts and lists; Update-mode confirm title and success
  text; Basic validation title.
- Not covered by E2E: B-07 `null` encryption result (needs a truncated listing
  or a probe failure), C-11 failed cancel (needs an IPC error), C-10 log level
  (the local log file is not asserted), and the browse limit toast (needs a
  listing above 64 MiB). These are reviewed by code and listed as gaps in the
  report.
