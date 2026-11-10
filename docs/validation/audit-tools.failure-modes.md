# Audit tools failure inventory

This inventory was written before changing production code for the audit items
B-16, B-17, C-07, C-25, C-26, C-27, C-40 and C-49. It covers the benchmark run
in About/Tools, the native context menu guard, the quick-extract window
(`src/extract-window/`), and the updater prompt and indicator.

## B-16 Benchmark runs under the normal running state

The benchmark currently calls `run_7z` with `b` without `setRunning`, so the
rest of the UI stays live and an archive job fails with a busy error. The fix
routes it through `setRunning(true/false)` with a Cancel control.

1. The benchmark sets busy state but never clears it on the error path, so the
   Run button and archive controls stay disabled until restart.
2. `setRunning(false)` is skipped when `invokeRun7z` rejects, leaving
   `state.running` true and blocking every archive job.
3. Cancel calls `cancel_7z` but the result handler still shows a rating, so a
   cancelled run looks like a finished run.
4. Cancel is clicked while the 7-Zip child is still starting (`preparing`), the
   backend arms cancellation, and the run then completes normally. The UI must
   still show "Benchmark cancelled." instead of a stale rating.
5. `cancel_7z` fails (IPC error). The Cancel button stays disabled with no way
   to retry, or the run is marked cancelled while 7-Zip keeps running.
6. The Cancel button stays visible after the run because `hidden` is not
   restored in `finally`.
7. The rating parser drops the unit. The label must say MIPS, and a thousands
   separator must not change the number. Output without a `Tot:` line must
   still show the existing "no rating" text.
8. A `Tot:` line with a number that is not the last column (for example a
   usage percentage) is picked as the rating, so the reported unit is wrong.
9. Starting an archive job while the benchmark runs must be refused by the
   normal busy check (`state.running`), not by a backend busy error only.
10. A second benchmark click during a run starts a second `b` process. The
    guard must return early while `state.running` is true.
11. The E2E scenario depends on a real 7-Zip `b` run. A slow first run can make
    the busy assertion race the finish. The spec must wait for the busy state
    before asserting and must not assume a fixed duration.

## B-17 Native context menu on editable targets

`installNativeWebviewContextMenuGuard` suppresses `contextmenu` everywhere. The
fix allows the native menu on editable targets while keeping it suppressed
elsewhere.

1. The check uses `isContentEditable`, which is not implemented in jsdom, so
   unit tests and the browser disagree. Use a selector match instead.
2. Text-like check includes `checkbox`, `radio`, or `button` inputs, which
   would expose the menu on controls that never need it.
3. The check misses `input` elements with an empty or missing `type`, which
   default to text.
4. `contenteditable="false"` inside an editable region is treated as editable.
5. The debug-mode flag must still allow the menu everywhere, and turning debug
   off must suppress it again.
6. The Tauri initialization script
   (`src-tauri/src/launch/webview_context_menu.rs`) runs before page scripts and
   calls `preventDefault` on every `contextmenu` event. A frontend-only change
   cannot un-cancel that event. The script now applies the same editable check,
   and its Rust tests assert the check runs before `preventDefault` and keeps the
   debug-flag path.
7. A `contextmenu` event whose target is `document` or a text node has no
   `Element` target. The guard must not throw on non-element targets.

## C-07 Quick-extract failure offers Retry

A failed run in the quick-extract window currently shows only Close. The fix
adds a Retry button that reruns the full attempt for the same archive and
destination.

1. Retry reruns with a stale `expectedArchiveIdentity` or `destination`, so
   the run targets the wrong item after a failure. Retry runs validation again.
2. Retry leaves the previous error box visible, or leaves the progress
   listeners of the failed run attached, so events from two runs mix.
3. Retry is offered for validation failures, where it cannot succeed, and
   hides the real reason. Offer it only after a 7-Zip run failure.
4. Retry must stay hidden and unclickable while a run is active, or a double
   click starts two runs.
5. Retry must be hidden again on success, cancel, and "Open destination"
   paths.
6. A read-only parent must surface as an extraction failure, not as a
   validation failure, so the button appears. The E2E fixture makes the parent
   read-only before launch.
7. Choose another folder is not offered (see Deferred). The quick-extract
   destination is bound at spawn, and a rebind would widen that boundary.

## C-25 "Later" must not request notification permission

`promptInstallAndRestart` calls `notify()`, which calls `requestPermission()`
when permission is not granted.

1. Switching the else-branch to `notifyIfAlreadyGranted` must still send the
   notification when permission is already granted.
2. The change must not stop the status from becoming "Update ready".
3. `notify` stays exported because `src/tests/updater.test.ts` imports it.
   Removing the export breaks an existing test that covers a different path.
4. A later background check must not re-request permission either.

## C-26 Persistent "Update ready" indicator

`setStatus("Update ready")` is overwritten by the next status message. The fix
adds a button in the status bar that stays visible until the pending update is
installed or discarded.

1. The indicator is hidden by `clearPendingUpdate` only, so a discarded or
   channel-changed update still shows a stale button.
2. Clicking the indicator while an install is in flight starts a second
   install. Guard with `installInFlight`.
3. The indicator is missing from an extract window or about page that does not
   have the status bar. Absence must be a no-op.
4. Clicking the indicator without a pending update must do nothing.
5. The button text must not depend on a language string that changes later
   status text.
6. The element is wired when the module loads. If the element is absent (unit
   tests), the wiring must not throw.
7. A failed install (`update.install()` throws) keeps `pendingUpdate`, so the
   indicator must stay for a retry.

## C-27 No native restart modal while an archive operation runs

`promptInstallAndRestart` already checks `archiveOperationIsRunning()` before
`ask`, but a background download shows the modal with no user action.

1. A background download (`autoCheckUpdates`) must not open the modal, so it
   cannot appear over an active or later operation. The indicator carries the
   state instead.
2. The archive check runs before `ask`. An operation that starts while the
   modal is open is still caught by `reserve_update` on "Restart now".
3. Interactive Check now with an operation running must show the toast and
   keep the indicator, not the modal.
4. The fallback path when `is_7z_running` throws must still fail closed (no
   modal, no install).

## C-40 Consistent final bar on every cancel path

Cancelled finishes currently pass 0 or 100 percent. The fix uses one final
state: an empty bar for every cancel path.

1. A cancel path that calls `finish` with 100 percent leaves a full red or
   green bar next to a "Cancelled" title.
2. `stopProgressAt` clears `aria-busy`. Using a different path leaves
   `aria-busy="true"` on a finished cancel.
3. The password-prompt cancel path throws `EXTRACT_PASSWORD_PROMPT_CANCELLED`
   and must also reach the empty-bar final state.
4. The title bar close path sets `cancelRequested` and must not show a
   different bar.
5. Changing the 0-percent cancel path must not change success or failure bars.

## C-49 Settings read once; clipboard fallback

`run-core.ts` loads settings and `fx.ts` loads them again. "Copy details" has
no fallback when `navigator.clipboard` fails.

1. Settings are passed down, but the FX sync must still run when settings
   fail to load (defaults: effects on, system theme).
2. Moving the settings load after the FX sync must not delay the titlebar
   wiring.
3. The fallback copy uses a hidden textarea. It must be removed on every path,
   or it leaks into the window.
4. `document.execCommand` can return false. The button must show "Copy failed"
   and not "Copied".
5. The fallback must not run when the clipboard API succeeds.
6. `execCommand` is missing in some runtimes. Calling it must be guarded so the
   handler does not throw.

## Deferred

- C-07 "Choose another folder": not implemented. The quick-extract destination
  is bound at spawn (`ExtractBoundDestination`,
  `assert_extract_bound_destination` in `src-tauri/src/launch/open_path.rs`).
  Letting the window pick a new destination would widen that security boundary,
  and the owner decided against a backend rebind command. Retry is the only
  recovery action.
- E2E for C-07 needs the scenario launcher to start the extract window with
  `--extract` on a read-only fixture. That launcher is outside this worker's
  files.
