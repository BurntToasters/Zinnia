# Archive password retry and 7-Zip error hint failure inventory

This inventory was written before changing production code or adding the
`audit-password` E2E spec. It covers plan items B-13 (password retry loop and
prompt controls), A-01 (when password fields are cleared, as it applies to
`src/archive/runtime.ts`), and C-08 (7-Zip 26.06 error hints).

## Captured 7-Zip 26.06 output (bundled sidecar, macOS arm64)

Captured with `src-tauri/binaries/7z-aarch64-apple-darwin` on 2026-11-09.

Non-archive file named `fake.7z` (15 bytes of text), `x` and `l`:

```
ERROR: fake.7z
Open ERROR: Cannot open the file as [7z] archive
ERRORS:
Is not archive
Can't open as archive: 1
```

Exit code 2. `l` prints the same two lines after `Listing archive: fake.7z`.
The old matcher looked for "can not open", so this output never produced the
not-an-archive hint.

Destination file blocked by permissions (archive `ok.zip`, output folder
`ro2` with mode 555):

```
ERROR: Cannot open output file : errno=13 : Permission denied : ro2/src.txt
```

Exit code 2. This line says "Permission denied", so the permission hint is
correct here.

Destination folder cannot be created (parent folder mode 555, or a regular
file in the path). Both runs printed the same text:

```
ERROR:
Cannot create output directory : errno=17 : File exists : ro2/newdir/deep/
System ERROR:
errno=17 : File exists
```

Exit code 2. The output never says access denied or permission denied, so
"cannot create" must not be reported as a permission problem.

Encrypted 7z (`-mhe=off`), extracted with no password: stdout contains
`Enter password:` (the existing password matcher handles this). With a wrong
password: `ERROR: Data Error in encrypted file. Wrong password? : hello.txt`.

## Password retry loop (B-13)

Context: `runWithPasswordRetry` in `src/archive/runtime.ts` and the quick-extract
copy in `src/extract-window/password-retry.ts` prompt once. A second wrong
password fails the operation. The first prompt has no reveal toggle and an empty
submit acts as cancel.

1. The loop does not terminate. After a wrong password the retry result must
   again be checked with `looksLikePasswordRequiredError`, and the prompt must
   reopen. The loop must end on a correct password, a non-password result, or a
   cancel.
2. A retry that fails for a non-password reason (corrupt data, missing file)
   must return that result, not prompt again.
3. A cancel from the prompt sets `state.cancelRequested` only in the Power path.
   Cancel must still return the existing cancelled result so the batch loop in
   `ops.ts` breaks. A cancel that leaves the flags unset would continue the next
   archive.
4. Skip must not set `state.cancelRequested` or `state.batchCancelled`. The
   batch loop would stop instead of moving to the next archive.
5. Skip is only offered when the caller asks for it. A single-archive run,
   browse, or selective extract must not show "Skip this archive". The batch
   caller lives in `src/archive/ops.ts`, which this change does not own, so the
   skip option needs wiring there before a batch can skip (see Deferred).
6. The carried password (`passwordCarry`) must be updated only on a submitted
   password. A cancel or skip must not overwrite the carried value with an empty
   string, and a wrong carried password must be replaced by the next entry.
7. The retry label must still say the previous password was incorrect. The
   existing E2E waits for "Incorrect password. Enter the archive password:", so
   the wording must not change. Changing it would break the Basic and Power
   label waits in `extract-flows.spec.js`.
8. `withPassword` must replace the earlier `-p` switch, not append a second one.
   A second `-p` could make 7-Zip use the first password.
9. Each prompt is a fresh user action, so the loop must not reuse
   `expectedArchiveIdentity` in a way that skips the identity check on retry.
   The retry must keep passing the identity as the first attempt does.
10. The quick-extract loop keeps throwing `EXTRACT_PASSWORD_PROMPT_CANCELLED` on
    cancel, because `run-core.ts` (not owned here) depends on that error.
11. `shouldAbort()` and `signal.aborted` must be checked before each prompt and
    after each retry. Otherwise a window closed during a retry opens a prompt
    that nothing can answer.
12. Progress and cancel state must be restored between attempts:
    `startIndeterminateProgress` before each retry and `setCancelAvailable`
    must not be left false while a prompt is open.

## Password prompt controls (B-13)

Context: `promptInput` in `src/prompt-modal.ts` is shared by presets, the
confirm flows, and the password prompts. The password prompt needs a reveal
toggle, a skip button, and a validation message. These controls are built in
TypeScript because `src/index.html` is owned by another worker. `extract.html`
has the same modal ids and is used by the quick-extract window.

1. Changing `promptInput` for every caller would change presets and other
   prompts. An empty preset name or an existing cancel-on-empty behavior would
   change. Password-only behavior must stay behind a separate function.
2. The reveal toggle must use the same wording as the existing toggles:
   `aria-label="Show password"` / `"Hide password"`, `aria-pressed` true or
   false, and text "Show" / "Hide". Its state must reset on each prompt, since
   the field is always reset to `type="password"` in cleanup.
3. The toggle must not sit inside the `<label>` that wraps the input. A button
   inside the label adds "Show" to the input's accessible name. Insert it as a
   sibling after the label instead.
4. Dynamic controls must be removed in `cleanup`. A leftover skip button or toggle
   would still receive clicks after the prompt closes and could resolve a
   later prompt.
5. The reveal toggle must not persist the password in the DOM after the prompt
   ends. The cleanup must set `field.type = "text"` and clear the value as it
   does today, and must also reset the toggle.
6. An empty submit must keep the prompt open and show a validation message.
   It must not resolve with `""`, must not call cancel, and must leave focus in
   the field. Enter on the empty field and the OK button must behave the same
   way.
7. Keep `isImeComposing` on the Enter path. Composing Enter must not submit a
   password, and it must not skip either.
8. Keep `markKeyHandled` on Escape. Escape must still cancel and must mark the
   event handled so the Power shortcuts do not also act on it.
9. Enter on the skip button must skip, and Enter on the cancel or X button must
   cancel. The existing test "cancels on Enter from %s" must still pass with the
   new button present.
10. Overlay-click dismissal must stay disabled for password prompts.
11. Focus trap: `trapFocus` builds its focus list when Tab is pressed, so the
    dynamic buttons must be in the modal DOM before `trapFocus` is called.
    A skip button added after the trap would be skipped by Tab.
12. Only one prompt may be open. The `promptOpen` guard must stay in place for
    the new function. A concurrent call must return the cancel outcome and must
    not replace the open prompt's title or label.
13. The validation message must be removed or cleared on the next prompt, so a
    stale "Enter a password" does not show on a later prompt.
14. Focus must return to the trigger after the prompt closes, as it does now.
15. `trapFocus` and `releaseFocusTrap` must be balanced on every exit path,
    including abort and missing-node early returns.

## Power runtime clears (A-01 as it applies to runtime.ts)

Context: plan A-01 says password fields are cleared only after 7-Zip has
started. In this checkout `runSingleOperation` and `runBatchExtract` in
`ops.ts` already gate `clearPasswordFields` on `sevenZipStarted` and
`batchStarted`. `runtime.ts` itself never clears fields.

1. A new retry loop in `runtime.ts` must not call `clearPasswordFields` before
   the first `invokeGuardedRun7z` call returns. A pre-run error thrown by
   `ensureRuntimeReady` or by backend validation must keep the field value.
2. A cancel at the prompt is after 7-Zip has started (the first attempt ran), so
   clearing afterward is correct. The new code must not clear on a confirm
   that was rejected for an empty value, because that keeps the prompt open.
3. Passing `passwordCarry` must not clear the main form field.

## C-08 error hints (`src/error-hints.ts`)

Context: `describe7zError` maps 7-Zip text to a short hint. The not-an-archive
branch never matched 26.06 output. The "cannot create" text always produced the
permission hint.

1. The not-an-archive matcher must accept "Cannot open the file as [7z]
   archive" and "Is not archive". It must not match "Cannot open output file"
   with "Permission denied", which is a permission problem.
2. The old "can not open" plus "as archive" wording must still match, so that
   older 7-Zip output keeps its hint.
3. "cannot create" maps to the permission hint only when the same text says
   access denied, permission denied, or read-only. Otherwise it maps to the
   generic "could not create" hint. The generic hint must name the destination
   path problem and must not say permission.
4. Permission matching for "Cannot open output file ... Permission denied" must
   still produce the permission hint.
5. Hint order matters. The password check runs first, so "Wrong password?" in a
   data error must still produce the password hint and not the corrupt-archive
   hint.
6. The corrupt-archive hint ("CRC Failed", "Data Error") must not capture
   "Data Error in encrypted file" before the password check. The existing order
   already protects this; the new branches must not move above it.
7. "Not enough disk space" and "no space left" must stay ahead of the create
   branches, because a full disk can also report "Cannot create".
8. Matching must stay case-insensitive. 7-Zip output mixes "ERROR:" and
   "Cannot"; the lowercase text must be the one matched.
9. `userFacing7zErrorDetail` and `userFacingBackendError` depend on
   `describe7zError`. A changed hint must not expose raw 7-Zip lines. The
   fallback to "Something went wrong" must still apply when no hint matches.
10. The existing unit test "hints for create/permission failures" expects
    "Can not create output file" to produce the permission hint. That
    expectation intentionally changes under C-08 because the output has no
    permission words.

## Deferred

- Batch "Skip this archive" wiring and the skipped count in the batch summary
  live in `src/archive/ops.ts` (`runBatchExtract`, the call at about line 358
  and the summary block). That file is not owned by this area. `runtime.ts`
  accepts an `allowSkip` option and returns a result with `skipped: true`, but
  the batch caller must pass the option and count skipped archives before a
  batch can skip and report it.
- The existing `extract-flows` test "shows the friendly wrong-password hint in
  Power" expects the hint after one wrong retry. Under B-13 the prompt reopens
  instead. That spec is not owned by this area and needs its expectation updated
  by its owner.
