# Basic sync, Basic run keys and Basic failure panels: failure inventory

This inventory was written before changing production code for beta 2 piece
1D. It covers H2 (Basic secrets overwritten from stale Power fields), M6
(Basic Extract validation rejection left the run silent), M8 (Ctrl/Cmd+Enter
ran the Power flow in Basic) and the Low items (overlay guards, open-folder
feedback, Basic view after returning from Power, drops during a run).

Test home: `e2e/specs/beta2-fe-basic-sync.spec.js`. Each `it` below is named by
its short label T1 to T12. No Vitest file was added: AGENTS.md prefers E2E,
and the existing Vitest assertions are checked in the last section.

## H2: Basic password and extract password survive stale Power values

Context: Basic has its own `basic-password` and `basic-extract-password`
fields. Power's `password` and `extract-password` are the fields the run code
reads. Before this change, `syncPowerToBasicCompress` and
`syncPowerToBasicExtract` copied Power into Basic unconditionally. Entering
Compress or Extract, toggling the workspace, and saving Settings all ran that
copy. A typed Basic secret was therefore replaced by Power's empty value, and
the next Compress wrote an unencrypted archive with no warning.

Fix: mirror each Basic secret into Power on its `input` event; copy Basic
secrets into Power before leaving Basic; fill an empty Basic secret from Power,
or replace it with a non-empty Power value, but never clear a non-empty Basic
secret with an empty Power value. The run path still copies Basic into Power.

Ways the fix could fail or regress:

1. The compress mirror listener is missing or bound to the wrong element, so
   the Basic password never reaches `#password` until a run. Test: T1 reads
   `#password` right after typing, after the workspace round trip, and checks
   that the archive is encrypted.
2. The extract mirror listener is missing, so `#extract-password` is stale.
   Test: T2 reads `#extract-password` after typing and after the round trip.
3. The rule is written as an unconditional copy again, so an empty Power value
   clears a typed Basic secret on entering Compress or Extract, after a
   workspace toggle, or after Settings save. Test: T1 and T2 read the Basic
   field after each step.
4. The rule is written so strictly that a non-empty Power value never reaches
   Basic, leaving a stale Basic secret. Test: existing Vitest "syncs power
   extract/browse passwords and custom split into basic" (basic-ui.test.ts),
   which still passes and asserts that a non-empty Power value is copied.
5. An empty Basic field is not filled from a non-empty Power value. Test:
   the same existing Vitest case, which starts from an empty Basic field.
6. The run path stops copying Basic secrets into Power, so 7-Zip receives an
   empty password. Test: T1 (the output must answer `t -p<password>` with exit 0
   and `t -p<wrong>` with a failure, and `l -slt` must show `Encrypted = +`).
   T2 (the extraction after the password prompt). Existing Vitest "syncs basic
   controls into power controls before running" and "syncs extract/browse
   passwords for basic compress runs".
7. Leaving Basic for Power copies Basic secrets even when the user is already
   in Power, so an older Basic value overwrites a Power edit. The copy in
   `power-events/chrome.ts` runs only when the previous mode was Basic and the
   target is Power. Test: none in E2E. Covered by code review of the guard.
8. Settings save that switches from Basic to Power copies the Basic secrets
   after the mode change, or not at all. Test: none in E2E. The per-input
   mirror (items 1 and 2) already keeps Power current before the switch, so a
   wrong order would only matter for a Basic value typed without an `input`
   event. Partly covered by reasoning, not by a test.
9. Settings save while staying in Basic drops the Basic secret, because the
   re-sync from Power runs before Power holds the value. Test: T1 (Settings
   save happens between typing and re-entering Compress, and the Basic field is
   read back).
10. Clearing the Basic field does not clear Power. The next Power screen would
    show a stale secret, although the run path still copies the Basic value.
    Test: none in E2E. The effect is limited to what Power displays before a
    run.
11. A password cleared in Power is no longer cleared in Basic when the user
    returns to Basic. This follows from the required rule, so it is an accepted
    behaviour change, not a regression. Test: none. Reported to the manager.
12. `updateBasicPasswordField` still clears the Basic secret for formats that
    cannot be encrypted (for example GZIP), and the Power copy follows the same
    order as before. Test: existing Vitest "switches to compress view and
    enforces format encryption support" (basic-ui.test.ts), unchanged.

## M6: Basic Extract validation rejection shows the failure panel

Context: in `basic/actions.ts`, `validateArchivePaths` was awaited outside the
guarded block when the encryption probe returned `null`. A rejection left no
visible result, and the unexpected-error path rethrew after clearing the
password fields.

Fix: wrap the validation await in its own try block. On rejection, show the
Basic extract failure panel ("Operation failed") with the user-facing message.
Keep the typed password, and do not rethrow.

Ways the fix could fail or regress:

1. The rejection still produces no panel. Not covered by E2E. The harness cannot
   force `validate_archive_paths` to reject: the real backend does not reject
   it, a JavaScript override of `__TAURI_INTERNALS__.invoke` never reached the
   app's own calls, and `browser.tauri.mock` did not intercept them either
   (run 5 of the 1D retry: the validation command was not intercepted). Covered
   by code review only. Adding a Vitest test now would break AGENTS.md (code
   already written), so this item stays open for the manager to decide.
2. The panel appears for a preparation that is no longer current (the user
   changed view during the await). The catch checks `isBasicPreparationCurrent`
   before showing anything. Test: none in E2E, covered by code review.
3. The typed Basic extract password is cleared by the new path. The catch does
   not clear fields and does not rethrow, so the pre-run rule that keeps typed
   passwords still holds. Not covered by E2E (item 1).
4. The Run button stays disabled or the progress panel stays visible after the
   failure. Not covered by E2E (item 1).
5. Raw 7-Zip output reaches the panel. Not covered by E2E (item 1). The panel
   text is built by `userFacingBackendError`, the same helper the other Basic
   panels use.
6. The existing "Check your choices" validation branch changes. Test: T9 (a
   real validation failure after the archive vanished; the panel's title may be
   "Check your choices" or "Operation failed" depending on which check reports
   the missing file, and the spec accepts either).
7. Unexpected rejections in other parts of `handleBasicExtractActionOnce` still
   rethrow and clear the password fields. Test: existing Vitest "clears copied
   extraction passwords when runAction rejects" (basic-ui.test.ts), which is
   unchanged.

## M8: Ctrl/Cmd+Enter routes to the visible Basic run button

Context: `power-events/keyboard.ts` handled Ctrl/Cmd+Enter in Basic by calling
`syncBasicBeforeRun()` and then `runAction()` or `browseArchive()`. That path
skipped Basic's own confirmations, password checks, and progress panel. In
Basic, the Power inputs and output path could start an operation from Home.

Fix: in Basic, the shortcut clicks the visible primary button for the current
view: Run Compress for Compress, Run Extract for Extract, and Extract all for
Browse. Home does nothing. Power keeps its existing branch.

Ways the fix could fail or regress:

1. Ctrl+Enter on Home still starts an operation from Power inputs. Test: T3
   (Power inputs and a sentinel Power output path are set; no file may appear
   and no progress panel may open).
2. Ctrl+Enter in Compress does not run the Basic flow (no progress panel, no
   archive). Test: T4 (the progress panel is observed becoming active, and the
   archive is created with the "Archive created" completion).
3. Basic's own checks are bypassed. Test: T5 (no inputs must show the Basic
   "Add at least one input." failure panel, not a Power error).
4. A key inside a Basic text field runs twice. The Basic keyboard handler also
   clicks Run for Enter in a text field, so both handlers see the event. The
   second one must stop at `operationPreparing` or `running`. Test: T4 sends
   the key from `#basic-output-path`, and asserts the single completion and no
   "operation is already running" message.
5. Extract routes to the wrong handler, or runs without the mode set by the
   Basic path. Test: T6 (the typed destination must receive `hello.txt`, and
   the completion must read "Extraction complete").
6. Browse routes to Extract all while the button is disabled, or the shortcut
   silently does nothing. Test: T7. Behaviour change: in Basic Browse,
   Ctrl+Enter now extracts everything (Extract all is the only primary button
   there). Power Browse still runs its listing. Flagged in the report.
7. Power Ctrl+Enter changes (browse lists, other modes run). Test: existing
   Vitest "handles keyboard shortcuts for browse, run, and escape overlays"
   (main-bootstrap.test.ts), updated only where it encoded the Basic routing.
8. The Basic route bypasses the busy guards (`running`, `operationPreparing`,
   `incomingPathsApplying`). Those guards stay above the routing. Test: none in
   E2E, covered by code review. The Basic button handlers have their own
   `isBasicInteractionLocked` guard.

## Basic Browse password: field reveal and Extract all handoff

Context: a header-encrypted archive opened in Basic through the incoming-path
handoff (`applyIncomingPaths`) starts a Power `browseArchive()`. That listing
shows Power's browse password field, but Basic's own field is shown only by
`runBasicBrowseArchive`, so the user got "Wrong or missing password" with no
field in Basic. Separately, Basic "Extract all" called `setMode("extract")`,
which hides the browse password field and forgets the remembered browse
password, so the extraction prompted again.

Fix: `basic/wire.ts` runs `revealBasicBrowsePasswordIfNeeded` on every status
change, which reveals Basic's field when Power's field is visible in Basic
browse (reveal only, never clears). `basic/browse-events.ts` snapshots the
remembered browse password before `setMode("extract")` and restores it after.
`basic/actions.ts` reads the remembered password at the start of the Basic
extract flow, before the asynchronous encryption probe. The restore alone was
not enough: after the click the remembered password was still present
synchronously, but the later lookup found it gone. The cause inside the probe
window was not identified. The early read is synchronous, and extraction still
checks the archive identity.

Ways the fix could fail or regress:

1. Basic's password field stays hidden after a password-required listing.
   Test: the "extracts an encrypted archive from Basic Browse" case, which
   types the password into the revealed field and waits for the listing.
2. The reveal clears a typed password (for example a reveal that hides the
   field and clears values). The helper never hides. Test: the same case
   types the password before the Enter that starts the listing.
3. Extract all still prompts after a password browse. Test: the same case,
   which asserts that no prompt opens during Extract all.
4. The remembered password is cleared before the lookup again (the cause in
   item 3 is not identified). The early read covers the window seen in the
   diagnostics, but a clear that happens before the click is not covered.
   Test: the same case would catch it.
5. The snapshot restores a password for a different archive. The restore is
   guarded by `browsed.archive === state.inputs[0]`, and extraction still
   validates the archive identity before use. Test: none, covered by code
   review.

## Low: convert dialog overlay guards

Context: `convert-overlay` is a `.modal-overlay`. The `?` and Ctrl/Cmd+Enter
guards in `power-events/keyboard.ts` did not list it. The convert dialog closes
its own Escape in a capture-phase listener in `archive/mutations.ts`. That file
exports no close function.

Fix: add `convert-overlay` to the `?` guard and the Ctrl/Cmd+Enter guard. Leave
Escape unchanged, because the dialog already handles it. While the real dialog
is open, its capture-phase listener stops these keys before the document
handlers run, so the new guards matter for overlay states without that listener.
The E2E sets the overlay visible directly to reach them. `basic/keyboard-events.ts`
already returns for any visible `.modal-overlay`, so it needs no change.

Ways the fix could fail or regress:

1. `?` opens the shortcuts sheet above the convert dialog. Test: T11.
2. Ctrl/Cmd+Enter starts a Basic run while the convert dialog is open. Test:
   T11 sends the key from the Basic output field, so both the Power guard and
   the Basic `.modal-overlay` guard are exercised.
3. Escape is changed and closes the wrong sheet. Not changed. The convert dialog
   closes itself. Existing E2E: audit-convert.spec.js dispatches Escape on the
   convert dialog.
4. The guard is added to the wrong list, so an unrelated overlay stops
   responding. Test: existing Vitest "handles keyboard shortcuts for browse,
   run, and escape overlays" (main-bootstrap.test.ts) and T11 for the convert
   overlay itself.

## Low: open-folder failure shows a toast

Context: `openPathWithFeedback` logged a failed `open_path` call and showed
nothing to the user.

Fix: show `Could not open the folder: <reason>` as an error toast (5 s), and
keep the log line.

Ways the fix could fail or regress:

1. A failure stays silent. Test: T12 (the folder was never produced by a recent
   successful operation, so the real backend rejects `open_path`, and the toast
   must name the folder and the reason).
2. A success shows a toast. Test: existing Vitest "wires Basic extraction
   controls and completion actions" (basic-ui.test.ts), which checks the
   `open_path` call only.
3. The reason is shown as raw 7-Zip text. The reason goes through
   `userFacingBackendError`, the same helper the Basic failure panels use.
   Test: T12 checks the plain-words prefix.

## Low: Basic view after returning from Power

Context: `power-events/chrome.ts` always called `setBasicView("home")` after
Power returned to Basic, and `power-events/settings.ts` did the same when
Settings switched from Power to Basic.

Fix: restore the Basic view the user left (`resumeBasicView` in `basic/sync.ts`).
Extract and Browse fall back to Home when there are no inputs. Compress and
Home are always kept. Clicking the Basic button while already in Basic still
goes Home, as before. The Power mode is not changed on return.

Ways the fix could fail or regress:

1. Compress or Extract is lost on return. Test: T8.
2. Extract with no archives stays on an empty view. Test: T8 (clears Power
   inputs, returns, and expects Home).
3. Browse with no archives stays on an empty view. Test: none in E2E. Same rule
   and same code path as Extract, covered by review.
4. The Settings path (Power to Basic) still resets to Home. Test: none in E2E,
   covered by review. Same helper.
5. Clicking the Basic button while in Basic stops going Home. Test: none in
   E2E, covered by review. The branch is unchanged.
6. Returning to Basic changes the Power mode. The restore does not call
   `setMode`. Test: none in E2E, covered by review.

## Low: drops during a run keep the current rejection

Context: `handleBasicDrop` rejects drops while an operation is active with a
toast. The brief asks for no queueing.

Fix: none. The message "An operation is already running. Drop the files again
in a moment." is unchanged.

Ways it could fail or regress:

1. The message text changes. Test: none added. The string is not edited, and
   the existing drop tests in basic-ui.test.ts cover the locked drop path.

## Out of scope, unchanged

- The Basic browse password is still copied from Power when the workspace is
  entered. It is mirrored to Power on `change`, which fires on blur before any
  toggle click, so the stale-overwrite risk is smaller than for the two
  passwords in H2. Left as is.
- `basic/index.ts` is a barrel that this piece does not own. The new functions
  are imported from `basic/sync.ts` directly. The barrel should be updated in
  a later piece if the export surface needs it.

## Existing Vitest assertions reviewed

Each file below was run against the change. An assertion is updated only if it
encoded the old behaviour, and each update is listed in the worker report.

- `src/tests/main-bootstrap.test.ts`: the keyboard shortcut test ran Ctrl+Enter
  in Basic mode through the Power flow (`syncBasicBeforeRun` and
  `browseArchive`), which is the M8 defect. Updated: the Power assertions now
  set Power mode explicitly, and a Basic part asserts that Ctrl+Enter clicks the
  visible Compress run button and does nothing on Home. The fixture gains
  `#convert-overlay` (present in `index.html`), and the `../basic` mock gains
  `getBasicView`. Click counts are compared as deltas because earlier test
  modules leave their keydown listeners attached.
- `src/tests/basic-ui.test.ts`: password sync, extract picker cancellation,
  open-folder call, and unexpected-rejection tests pass unchanged.
- Full `npm test` after the change: 70 of 70 files pass.
