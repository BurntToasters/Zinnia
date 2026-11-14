# Beta 2 main-window boot, stop and banner failure inventory

This inventory was written before changing production code. It covers the
beta 2 items H3 (close during a batch extract keeps extracting), M10 (fatal
startup removes the titlebar) and the boot-order, banner, recovery-text,
drain-queue and Maximize-label lows in `src/app-init.ts`, `src/main.ts` and
`src/extract-window.ts`. `src/window-events.ts` is read only for H3.

## Batch loop audit (read only, H3 precondition)

Every loop or multi-step flow that runs more than one 7-Zip process must read
`state.batchCancelled` or `state.cancelRequested` at a checkpoint. Results:

- `src/archive/ops.ts` `runBatchExtract`: the `for` loop reads both flags at
  the top of each iteration and after each run, and the `catch` reads them
  too. Covered.
- `src/archive/runtime.ts` `runWithPasswordRetry`: the password `while` loop
  reads both flags before each prompt and after a prompt returns. Covered.
- `src/archive/mutations.ts` (`addFilesToArchive`, `convertArchive`): no batch
  loop. Each is one run with checkpoints that read `cancelRequested` (and
  `batchCancelled` in convert). Covered for single runs only.
- `src/archive/selective-run.ts`: no loop. One run, checkpoints read
  `cancelRequested`. Covered for a single run only.
- `src/archive/inspection.ts` (browse): no batch loop. Not part of H3.

Only `runBatchExtract` has a batch loop that runs several archives, so the
H3 bug is that the main window never sets the flags it reads.

## H3: Accept on close or quit stops the whole batch

Context: `listenForStopRequests()` runs without a `beforeStop` callback in the
main window, so an accepted "Cancel and close" kills archive N with
`cancel_7z` but leaves both flags clear. `runBatchExtract` treats the killed
run as a failure and starts archive N+1.

1. The fix must set both `state.cancelRequested` and `state.batchCancelled`.
   Setting only one leaves a checkpoint that reads the other flag unaware.
2. `beforeStop` runs only after accept. Declining must leave both flags clear
   so the batch keeps running. Covered by E2E (decline first, then accept).
3. A decline followed by an accept must still stop the batch. The decline
   must not consume the stop intent. Covered by E2E.
4. If `stopOwnedOperation` returns false ("Could not stop the operation"), the
   flags stay set. The batch then stops at the next checkpoint, which matches
   the user's accepted intent and the existing `cancelAction` behaviour. Not
   covered by automation; reviewed in code.
5. Stale flags after an accept with no run in progress must not abort the
   next operation. Every entry point resets both flags before its first
   checkpoint: `runSingleOperation`, `runBatchExtract`, `addFilesToArchive`,
   `convertArchive`, `runSelectiveExtractFromModal`, and the inspection
   functions. Reviewed in code; not covered by automation.
6. The archive after the current one must not start. Covered by E2E: no output
   for archives 2 and 3 after the accepted close, with evidence written.
7. The first archive must still be running when the close is requested,
   otherwise the test proves nothing. Covered by a precondition assertion on
   the stage size in the E2E.
8. The quit path (Cmd+Q, `exit(0)`) shares the same `beforeStop`. Not covered
   by E2E; the same code path as close.
9. A password prompt open during the batch when the close is accepted.
   `cancel_7z` is idle, `is_7z_running` is false, and the window closes. Not
   covered by automation; reviewed in code.
10. The listener is registered in `init()` and runs in the main window only.
    The extract window keeps its own `armCancelForClose` (not touched).
11. Changing the confirm copy or titles would break the existing E2E helper
    `confirmDialogTitles`. The copy is not changed.

## M10: Fatal startup keeps the titlebar and a Close button

Context: `main.ts` and `extract-window.ts` replace `document.body.textContent`
on a fatal startup error. On Windows and Linux the window is frameless, so the
titlebar and its close button disappear with the content.

1. `#titlebar` must still exist after a fatal startup. Covered by Vitest
   (`beta2-fe-boot-stop.test.ts`, main window).
2. A visible Close button must exist in the main content area and call
   `getCurrentWebviewWindow().close()` exactly once. Covered by Vitest.
3. The titlebar close and minimize buttons must work when `init()` failed
   before `wireTitlebar()` ran. Covered by Vitest with `init` rejected before
   any listener was attached.
4. The titlebar close must not fire twice when `wireTitlebar()` had already
   attached a listener before the failure. The buttons are replaced with fresh
   clones, which drops the old listeners. Covered by Vitest with a listener
   attached before startup.
5. The error text must be inserted with `textContent`. A message containing
   markup must render as text and create no element. Covered by Vitest.
6. A non-Error rejection (a string) must still render. Covered by Vitest.
7. The Maximize button is disabled in the fatal state so it cannot be a dead
   control. Covered by Vitest.
8. The alert uses `role="alert"` so the failure is announced. Covered by
   Vitest.
9. The extract window: `#extract-app` is replaced with the same alert and Close
   button, and its titlebar works after a failed `runExtractWindow()`. Covered
   by Vitest (`beta2-fe-boot-stop.test.ts`, extract window).
10. If `#main-content` is missing, the panel is appended to `document.body`
    and the titlebar is not removed. Reviewed in code; not covered by
    automation.
11. A close during an extraction whose run-core listener is still attached is
    handled by the native close request, not by this fallback. Reviewed in
    code; not covered by automation.

## Boot order (low): theme, density and icons before the setup wizard

Context: `runSetupWizardFlow` runs before `applyTheme`, `setUiDensity` and
`refreshIcons`, so the wizard renders with the wrong theme and no icons. The
wizard can change the theme and the workspace mode, and `runSetupWizardFlow`
already re-applies both after the wizard.

1. `applyTheme` must run before `showSetupWizard`. Covered by Vitest (call
   order).
2. `setUiDensity` must run before `showSetupWizard`. Covered by Vitest.
3. `refreshIcons` and the icon refresh hook must run before the wizard.
   Covered by Vitest.
4. `setWorkspaceMode` must stay after the wizard. Calling it earlier would put
   the wrong layout under the wizard overlay and resize the window twice.
   Covered by Vitest (no call before the wizard).
5. Post-wizard theme and density re-application must remain. Covered by the
   existing `runs setup wizard path` test in `main-bootstrap.test.ts`.
6. The wizard flow failure still must not abort the bootstrap. Covered by the
   existing `runs setup wizard path` test.
7. Persisting `setupComplete` is unchanged. Not touched.

## Banner (low): bounded, deduplicated message list

Context: `showPersistentAlertBanner` appends every message to the previous text
with no limit, so repeated warnings grow the banner without bound.

1. At most the latest three distinct messages are kept. Covered by Vitest
   (open-paths-dropped listener, five messages in).
2. Newest message is last. Covered by Vitest.
3. A repeated message is shown once, moved to the newest position. Covered by
   Vitest.
4. A blank or whitespace-only message is not added to the list. Covered by
   Vitest.
5. Dismiss clears the list, so the next warning starts fresh. Covered by
   Vitest.
6. A successful acknowledgement clears the earlier list before showing the
   backend's success message. Covered by Vitest.
7. No E2E hook can trigger the banner from the webview: `open-paths-dropped`
   is emitted only by the Rust open routing, and the webview capabilities do
   not allow emitting events. This is why the banner is covered by Vitest.
8. The banner remains a `role="alert"` element with `textContent` updates.
   Reviewed in code.

## Recovery text (low): acknowledge failure keeps kind and pending text

Context: the acknowledge handler resets `preservedRecoveryKind` to
"ambiguous" and clears the text before `acknowledge_preserved_transaction`
resolves. A failure then shows the wrong dialog title on retry, and the
pending recovery text is gone.

1. A failed acknowledgement keeps `preservedRecoveryKind`, so the retry dialog
   title matches the original kind (newer, older or ambiguous). Covered by
   Vitest (kind "newer" retried after a failure).
2. A failed acknowledgement keeps the pending text visible, followed by the
   "Could not clear the recovery marker" message. Covered by Vitest.
3. A failed acknowledgement keeps the acknowledge button visible. Covered by
   the existing `keeps preserved-recovery acknowledgement available` test.
4. A successful acknowledgement resets the kind to "ambiguous", hides the
   acknowledge button and shows only the backend's success message. Covered by
   Vitest.
5. The success path must reset the kind only after `invoke` resolves. Covered
   by Vitest (kind still "newer" during the failing attempt).
6. A second click while the first call is in flight is still not blocked by
   the handler. Existing behaviour; not changed; not covered.

## Drain queue (low): initial drain shares the open-paths queue

Context: the initial `drainPendingPaths()` runs after `await openPathsQueue`,
outside the queue, so it can run at the same time as an event-triggered drain.

1. The initial drain must go through `openPathsQueue`. Covered by Vitest: the
   maximum number of concurrent `drain_pending_paths` invocations is one while
   a `pending-paths-changed` event fires during the launch-args apply.
2. Launch-args apply still runs before the drain. Covered by Vitest ordering.
3. A failing drain must not break the queue for later events. Reviewed in code
   (each step has its own `catch`).
4. The existing batch tests (`processes pending path batches`, cold-start
   handoffs) keep passing. Covered by `main-bootstrap.test.ts`.

## Maximize label (low): Restore when the window is maximized

Context: the Maximize button never changes its label, so it always says
"Maximize" even when maximized, including after a double-click or a snap.

1. Power mode: the label becomes "Restore" after a titlebar maximize click and
   returns to "Maximize" after restore. Covered by E2E (2).
2. OS-driven maximize (`plugin:window|internal_toggle_maximize`) also updates
   the label. Covered by E2E (2).
3. Basic mode: maximize stays ignored, the title keeps the "Maximize is
   unavailable in Basic mode" text set by `syncBasicWindowChrome`, and the
   label does not show "Restore". Covered by E2E (2) for the window state and
   the title; the existing `ignores titlebar maximize clicks in Basic mode`
   Vitest test covers the click.
4. A window that starts maximized in Power shows "Restore" on startup. The
   first sync runs while the DOM still says Basic, so `init()` runs the sync
   again after the saved workspace mode is applied. Reviewed in code; not
   covered by automation.
5. A rejected `onResized` registration must not break the titlebar or
   bootstrap. Reviewed in code (`.catch`).
6. The Basic-mode check must not call `isMaximized` on startup, so the
   existing Vitest assertion that Basic does not query maximize state keeps
   holding.

## Test fixture changes in existing Vitest files

`src/tests/main-bootstrap.test.ts` mocks of `getCurrentWebviewWindow` must
provide `onResized` because `wireTitlebar()` now subscribes to resize events.
These are fixture additions only. No existing assertion is changed.

## E2E coverage

`e2e/specs/beta2-fe-boot-stop.spec.js` covers, in order:

- Maximize label: Power titlebar maximize sets "Restore", the OS-driven toggle
  restores "Maximize", and Basic keeps maximize ignored (item 1, 2, 3 above).
- Batch extract of three archives with a 1 GiB first archive: a declined close
  keeps the batch running, then an accepted close stops it. Archives 2 and 3
  never publish output (H3 items 2, 3, 6, 7).

The banner (bounded list), recovery text, drain queue, boot order and M10
fatal startup are covered by `src/tests/beta2-fe-boot-stop.test.ts`, because
the webview cannot trigger those paths in E2E.
