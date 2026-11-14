# Beta 2 password retry, browse password and batch extract failure inventory

This inventory was written before changing production code. It covers the
password retry fix (M4), the remembered browse password fix (M5), the batch
outcome fix (M13), the per-archive batch folders (user decision), and three
low-severity items: member-name false positives in the password hint, the
missing `ban` icon, and relative output paths for protected source locations.

E-numbers refer to the `it` blocks in
`e2e/specs/beta2-fe-password-batch.spec.js`. V-items refer to the Vitest file
`src/tests/beta2-fe-password-batch.test.ts`. "Existing" means a test already in
the repository that this change must keep passing.

## M4: password retry survives a backend rejection inside the retry loop

Context: `archive/runtime.ts` and `extract-window/password-retry.ts` turn a
backend rejection that looks like a password prompt into a normal result. The
first call did this. The retry call inside the loop did not, so a second wrong
password on a header-encrypted archive threw out of the loop.

1. A second wrong password on a header-encrypted archive is still rejected by
   the backend. The conversion must also apply to that call, or the exception
   escapes, the prompt does not reopen, and the run ends in an error. Covered
   by E1 (three prompt opens, then extraction) and V-runtime-retry (Power) and
   V-extract-window-retry (quick-extract window).
2. The converted result must enter the loop. Its exit code (255) must satisfy
   `code > 1` and its stderr must carry the password phrase. Covered by E1 and
   the two retry tests above.
3. A non-password backend rejection inside the retry loop must still propagate
   and must not open another prompt. Covered by V-runtime-non-password and
   V-extract-window-non-password.
4. With `retryForMissingPassword` false (Basic browse), the first call must keep
   rethrowing a password rejection, because Basic browse uses its own password
   field and must not open the modal. Covered by V-runtime-no-retry (locks
   existing behaviour).
5. After a converted failure the next prompt must use the incorrect-password
   label, because `passwordSent` must already be true. Covered by E1 (second and
   third prompt labels are the retry label).
6. The raw backend text ("Could not list archive members ...") must not reach
   the user-facing status or toasts after the final run. Covered by E1, which
   checks the status and toast texts for 7-Zip markers.
7. Cancel while the retry prompt is open must still end the loop without
   another run. The conversion sits after the cancel check and does not change
   it. Not covered by a new test; existing cancel specs exercise the run cancel
   path.

## M5: the remembered browse password is forgotten at the right boundaries

Context: `archive/inspection.ts` remembers the password that opened the last
browsed archive, so Basic "Extract all" and the convert and add flows can reuse
it for the same archive identity. Before the fix it was cleared only when the
next browse began, so it survived mode changes, input-list changes and password
field clears.

1. Basic "Extract all" on the same unchanged archive reuses the browse password
   with no second prompt. That is the settled design (covered by
   beta2-fe-basic-sync). E3 instead covers a real clearing path: the archive
   file changes at the same path, so the identity no longer matches and Extract
   all asks for the password. E3 checks that the prompt opens with the
   first-attempt label, then cancels; nothing is extracted. The cleared state is
   the remembered password, not the file path.
2. The remembered password survives a replacement of the input list. Covered by
   E2 (the second archive prompts with the first-attempt label, so no password
   is sent). E2 also passes before the fix, because a drop that auto-browses
   already clears the browse field. It is a regression guard.
3. The remembered password survives a password-field clear after a successful
   run or test. Covered by V-clear-password-fields, which checks that
   `clearPasswordFields` runs the forget listeners.
4. The browse password field keeps the value typed for the previous archive
   when the input list changes. Covered by V-clear-browse-fields (the browse
   field clear runs the listeners) and E2 (the browse of the second archive
   starts without a password).
5. The forget listener is not registered because the inspection module is not
   loaded. The app loads archive/index at boot, so the listener is registered.
   Covered by E3, which needs the listener to be active for its clearing path.
6. Forgetting must not break a browse that is running. The listener clears only
   the module variable, not the `passwordCarry` used by the run. Covered by E2
   (the second browse completes after its prompt).
7. The identity check still refuses a different file at the same path. The
   check in `browsedArchivePasswordFor` is unchanged. Review only.
8. Clearing the browse field on an input-list change must not erase a password
   the user is typing for the same archive. Input-list changes happen on drop,
   remove and replace, not while typing. Review only.

## Batch extract folders: one folder per archive

Context: `runBatchExtract` passed one `-o<destination>` for every archive, so
archives with overlapping member names merged. Each archive now extracts to
`<destination>/<derived folder name>`. Duplicate derived names get a suffix.

1. Two archives with the same member path overwrite or merge into one folder.
   Covered by E4 (three archives with the same member, each in its own folder
   with its own content).
2. Two archives with the same base name collide in one folder. Covered by E5
   (`data.7z` and `data.zip` in different folders) and V-batch-folders.
3. Derived names that differ only by case collide on Windows (`data` and
   `DATA`). The uniqueness check is case-insensitive. Covered by V-batch-folders.
4. A suffixed name collides with a name already derived from another archive
   (`a (2).7z` derives `a (2)`). The loop skips every name already used. Covered
   by V-batch-folders.
5. A destination with a trailing separator must not produce a double separator.
   Covered by V-batch-folders.
6. A Windows destination must join with a backslash, and a POSIX destination
   with a slash. Covered by V-batch-folders.
7. An unsafe stem (`CON.zip`, a name ending in a dot) falls back to
   `_extracted`, and two such archives must still get unique folders. Covered by
   V-batch-folders.
8. A single-archive extract must keep its current folder layout. The single
   path in `runSingleOperation` is not changed. Covered by the existing
   extract-flows E2E (selective and wrong-password extracts, not changed) and
   the existing archive-flow Vitest tests.
9. The destination autofill for several inputs must name the common parent
   folder, not the first archive's folder. Covered by V-autofill-common-parent.
10. Inputs from different folders with a shared ancestor autofill that ancestor.
    Covered by V-autofill-common-parent.
11. Inputs with no common ancestor (different drives) autofill nothing, so the
    field stays empty for the user. Covered by V-autofill-common-parent.
12. A derived folder that already exists in the destination is merged, as in
    the single-archive case. The existing destination confirm covers it. Review
    only.
13. A cancel in the middle of a batch leaves the folders of finished archives.
    That matches the current behaviour. Review only.

## M13: the batch outcome names the failed and skipped archives

Context: the batch summary reported counts only. Basic's completion treated a
skipped-only batch as full success.

1. A skipped-only batch shows "Extraction complete" in Basic. After the fix it
   shows a partial state that names the skipped archive. Covered by E8, which
   fails before the fix.
2. A failed archive is counted but not named in the Power toast. Covered by E6,
   which fails before the fix (the toast must contain `corrupt.7z`).
3. A skipped archive is not named in the Power summary. Covered by E8 (Basic
   message) and by the existing audit-password skip test, which still asserts
   "1 skipped".
4. The name list is unbounded. After the fix it shows five names and then "and N
   more". Covered by V-name-list.
5. The plural is wrong ("1 archives"). Covered by V-plural.
6. A warning exit (exit code 1) counts as failed and must be named. Covered by the
   existing archive-flow test "counts batch warning exits as failures", which
   still asserts the count sentence. The name itself is review only.
7. A thrown error for one archive must be named. The catch branch records the
   same name as the failed branch. No E2E can inject a throw. Review only.
8. A cancelled batch must not list names. The cancelled branch is unchanged.
   Review only.
9. Basic must still show success for a plain "Done" without a detail. Covered by
   the existing basic-ui test "maps status strings to completion UI".
10. The partial panel must show the destination path and the Open folder button,
    and its secondary button must dismiss without clearing inputs, so the user
    can retry the failed archives. Covered by E8.
11. The Power toast for a skipped-only batch keeps the success type. Review only.
12. The log gets one summary line in addition to the per-archive lines. Covered
    by E6, which reads the activity log.

## Error hints: member names are not password prompts

Context: `looksLikePasswordRequiredError` searched stdout and stderr combined.
With `-bb1`, 7-Zip writes member names to stdout, so a member named
"wrong password.txt" in a non-encrypted archive opened the password loop.

1. A member named "wrong password.txt" with a failing exit must not open the
   password loop. Covered by V-listing-lines (the listing line returns false).
   E7 covers the success path, where the loop does not run in any case.
2. A `Path = ` listing line (browse, `-slt`) with a password phrase must not
   match. Covered by V-listing-lines.
3. A progress record that carries a member name (`  5% 2 - enter password.md`)
   must not match. Covered by V-listing-lines.
4. The true positives keep working: "ERROR: Wrong password", a bare "wrong
   password" on stdout, "Enter password:" on stdout, "Encrypted Headers".
   Covered by the existing archive-helpers tests, which are not changed, and
   V-listing-lines.
5. `describe7zError` uses the same rule for its password hint. Covered by
   V-listing-lines.
6. Residual risk, not fixed: an error line on stderr that names a member with
   a password phrase (for example "ERROR: CRC Failed : wrong password.txt") still
   matches, because the member name and the message share the line. Fixing it
   needs a catalogue of 7-Zip message formats. Not covered.

## Ban icon

1. The cancelled completion shows no icon because `ban` is not registered.
   Covered by V-ban-icon, which fails before the fix (no `svg.lucide-ban`).
2. Registering `ban` must not drop the icons already registered. Covered by
   V-ban-icon, which also renders `check`.

## Protected source location: no relative output path

1. A source in a protected folder (Program Files, Start Menu, ProgramData)
   without a `\Users\` profile produced a bare `name.7z`. A relative output path
   can write into the working directory. Covered by V-output-never-relative.
2. The autofill then writes that relative path into the output field. The fix
   returns nothing, so the field stays empty and validation asks the user.
   Covered by V-output-never-relative (null result) and the existing
   `resolveOutputArchiveAutofill` tests.
3. Callers that used the bare name for an OS save dialog now get no suggested
   name for that location. The user picks the name. Review only.
4. A protected-looking path that still has a usable Desktop fallback keeps the
   Desktop result. Covered by the existing extract-path test "avoids Start Menu
   and Program Files parents".

## Not covered by a new test

- Basic "Extract all" call-site order. `basic/browse-events.ts` calls
  `setMode("extract")` before `handleBasicExtractAction`, so the mode-change
  forget now runs before that handler reads the password. This is intended for
  M5 and is reported as a call-site note.
- The Basic destination autofill (`basic/sync.ts`) passes one archive, so a
  multi-archive Basic batch still autofills the first archive's folder until
  that call site passes the input list.
- Inputs in a progress record that does not start the line. Only line-start
  forms are matched.
- Observed in a GUI run, not investigated here: after a Basic Extract all on a
  changed archive, the password prompt was confirmed, the run set status
  "Running", and no log line, status change or output followed for 60 s. E3
  stops at the prompt and does not reach that run.
- Harness: the E2E hook's `applyIncomingPaths` waits until the app is idle. A
  Power browse of an encrypted archive therefore keeps that call pending until
  its password prompt is answered. E2 starts such browses without awaiting the
  hook, and every case starts from an idle app (`returnToIdle`).
- The non-password hints in `describe7zError` (disk space, CRC, permission and
  so on) still search stdout including listing lines. A member named
  "crc failed.txt" can still pick the damaged-archive hint. Out of scope for
  the password rule; not changed.
- Power extract of a header-encrypted archive with no password does not open
  the prompt. With stdin closed, 7-Zip writes "Enter password" to stdout and
  "Break signaled" to stderr, and the backend's member-safety rejection quotes
  stderr only, so the password phrase is absent. This predates the batch and is
  not changed here. E1 therefore starts from a wrong password typed in Power.
- `e2e/specs/extract-flows.spec.js` Power wrong-password case used to expect the
  old abort after one wrong retry. It now asserts the reopened incorrect-password
  prompt, no raw 7-Zip text in status, toasts, banner or prompt, then Cancelled
  with no output files. Real 7-Zip output is recognised by the matcher
  (V-real-7z); the change is the in-loop conversion, not the matcher.
- `e2e/specs/audit-password.spec.js` (skip batch and batch carry) asserts the
  old flat output layout. It needs the per-archive folder paths. Not owned by
  this worker.
