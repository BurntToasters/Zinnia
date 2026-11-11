# Basic progress, status and quick-action failure inventory

This inventory was written before changing production code. It covers the
audit items C-04, C-12, C-45, the remaining part of B-10 (IME Enter guard) and
the remaining part of C-22 (Basic open-archive filters) in the Basic frontend.

## C-04: Basic progress shows percent, ETA, file name and keeps the label

Context: Basic progress is a bar with no number. The structured 7-Zip progress
event is capped at 99%, the label is overwritten with "Running", and a cancel
leaves no visible confirmation.

1. The percent text is computed from the same capped value as the bar, so a
   fix that shows 100% during the run contradicts the bar contract. The live
   value must stay at or below 99 until success.
2. Success must set the bar to 100 before the progress container is hidden. If
   `resetBasicBar` still runs in the inactive branch, the 100 value is lost and
   the bar never reads 100 at completion.
3. `updateBasicStatus("Running")` and `updateBasicStatus("Idle")` must not write
   the label. `setStatus("Idle", ...)` runs 2 seconds after every timed status,
   so an unguarded write would replace "Compressing..." with "Idle" mid-run.
4. The operation label must be reset at the start of every run. A stale
   "Finalizing..." or "Cancelling..." from the previous run must not survive.
5. `formatEta` returns an empty string for 0%, 100% or sub-second elapsed time.
   The ETA element must be empty in those cases rather than showing "NaN" or a
   stale estimate.
6. The ETA start time must be captured per run. A module-level start time would
   give a huge ETA for the second run.
7. `currentFile` from the backend can be a full path. Showing it raw leaks the
   directory; `basename` must be applied except for the safe-copy label, which
   must be shown as-is.
8. The "Working..." heartbeat must not replace a live percent or file name.
9. The "Finalizing..." event must not show a file name or ETA, and must still
   disable Cancel as it does today.
10. The new percent, ETA and file elements are created in TypeScript inside
    the existing progress container. If they are created twice (once per run),
    the DOM grows and the text updates land on the first copy only.
11. `aria-live` on the new detail text must not make the polite status region
    announce every progress tick. A tick every few hundred milliseconds would
    flood screen readers.
12. A cancel must show a visible "Cancelled" completion in Basic. Reusing the
    error variant would show a red alert icon and an "Operation failed" style
    for a user's own choice, so the cancelled variant needs its own class.
13. The completion secondary button must still dismiss without clearing inputs
    after a cancel, and must not clear inputs on a success-only path.
14. A failed cancel ("Could not cancel") or "Cancelling..." status arrives
    while the run is still active. It must be shown in the detail line, not
    turned into a completion.
15. `updateBasicStatus` is also called with browse statuses. The browse branch
    must keep its existing behavior and not be affected by progress changes.
16. The Power progress stream (`withLiveProgress`) must not be changed. The
    Basic handler must not depend on `sevenZipRunInFlight` ordering changes.

## C-12: Repeat Last only enabled when there is something to repeat

Context: `setRunning(false)` sets every `[data-quick-action-btn]` to enabled,
including the "Repeat last" buttons, even when no action was recorded.

1. A fresh profile has no recorded quick action. After a Basic compress
   (which does not record quick actions), the Repeat buttons must stay
   disabled. Clearing `disabled` for them is the regression.
2. The rule must match `refreshQuickActionRepeatState`. If `setRunning` and
   refresh disagree, a Repeat button flips state depending on which ran last.
3. Repeat buttons must stay disabled while running (active), and their
   re-enable must not depend on the mode the user is currently in.
4. A recorded non-repeat action in the mode must enable that mode's Repeat
   button after the run ends.
5. Repeat actions are never recorded as the replay target. A fix that stores
   "add-repeat" would make Repeat call itself.
6. An unknown or stale key in `state.lastQuickActionByMode` must not enable a
   Repeat button that cannot run.
7. The existing quick-action unit test that expects a non-active mode's Repeat
   button to be enabled encodes the old rule and must be updated, not worked
   around.

## C-45: Interaction lock, Close-label checks and mode-wide reset

Context: `disabledBeforeBasicLock` is a `Map` that keeps removed controls
alive. Two Basic buttons decide their action by comparing the label to "Close".
`setRunning` resets only the current mode's run and cancel buttons.

1. Changing the Map to a WeakMap must keep `get`, `set` and `delete` semantics.
   If the lock is released through a path that relies on iteration, the change
   breaks it. The code only uses keyed access, so this is safe, but verify.
2. A control removed from the DOM while locked must not be re-enabled on the
   next unlock, because its entry is now unreachable.
3. Changing the button label to "Close" in one place must not be the only
   state signal. The explicit state must be set in the same function that
   sets the label, or the two can diverge.
4. Clicking the secondary button after a failure must dismiss without clearing
   inputs. A dataset value that is not set (for example after a reload into
   the completion state) must default to the success behavior, not dismiss.
5. `setRunning(false)` must reset the run and cancel buttons of both the add
   and extract modes. Hiding a Cancel button in one mode but not the other
   leaves a visible Cancel control after a mode change.
6. `setRunning(true)` must show Cancel only for the current mode, so that the
   non-current Cancel button stays hidden during a run.
7. Browse buttons keep their existing behavior. Browse must not be changed as a
   side effect of the add and extract reset.

## B-10 (remaining part): Enter during IME composition

Context: `isImeComposing` exists in `src/utils.ts`. Basic keyboard shortcut
(`basic/keyboard-events.ts`) already checks it. The Enter and Space handlers in
`basic/wire.ts` (drop zone, archive info cards) and `basic/extract-events.ts`
(browse password) and `power-events/about-tools.ts` (debug toggle) do not.

1. Enter used to confirm a Japanese, Chinese or Korean composition must not
   trigger the drop zone dialog, the archive card dialog or the browse run.
2. The guard must run before the key check. A guard placed after `Enter` only
   does not stop a Space handler from acting during composition.
3. `keyCode === 229` is set by some WebKit builds with `isComposing` false.
   The `isImeComposing` helper covers both. Do not reimplement it.
4. A plain Enter must still open the dialog or run the browse. The guard must
   not swallow non-composing keys.
5. The Basic extract destination field: Enter with `isComposing: true` must
   start no extraction. The document-level handler in `keyboard-events.ts`
   already guards this. The E2E must prove the behavior holds end to end, and
   the guard must not be lost when the field is focused.

## C-22 (remaining part): Basic open-archive filters

Context: Basic's three open-archive dialogs in `basic/wire.ts` use a filter list
with only archive extensions, and no "All files" option. `files.ts` offers an
"All files" entry, but its helper is not exported.

1. The filter list must include "001" (split first volume), the same as the
   Power list. Dropping it would hide split archives.
2. The "All files" filter must use `extensions: ["*"]`. A filter with an empty
   list would show no files on macOS.
3. Dialog filter arrays are shared objects. Mutating one call's array must not
   change the next call's filters. Build fresh arrays per call.
4. Extension lists must not include a leading dot; the dialog plugin rejects or
   mis-matches dotted entries.
5. The file-picker drop zone (add files) is not an open-archive dialog and must
   keep its current options.

## E2E coverage

`e2e/specs/audit-basic.spec.js` covers, in order:

- Repeat buttons stay disabled after a Basic compress in a fresh profile (C-12,
  C-45 mode-wide reset).
- A Basic compress of 8 MiB shows a numeric percent, keeps the "Compressing..."
  label while running, never shows "Running", and ends with the bar at 100
  (C-04).
- A Basic extract cancelled with the Cancel button shows the "Cancelled"
  completion and re-enables Run (C-04).
- Enter with `isComposing: true` in the Basic extract destination starts
  nothing, and a plain Enter starts the extraction (B-10).

Not covered by E2E, with reasons:

- C-45 Map-to-WeakMap and label state: internal to the lock and button state.
  The E2E covers the visible effect (Run re-enabled after cancel and after
  success). The dataset-based secondary button is covered by the existing
  Basic unit test, which is updated for the explicit state.
- C-22 filters: the native file dialog cannot be driven from WebDriver on this
  path. The filter list is asserted by the existing unit test for the picker
  options, updated to cover the "All files" entry.
- B-10 Enter guards in the drop zone, the archive cards and the browse password
  and debug toggle: each one is an `isImeComposing` check at the top of the
  handler. Opening a native dialog is not observable from WebDriver, and no
  unit test was added for these guards (AGENTS.md forbids unit tests written
  after the code). They rest on the shared helper, which the Basic keyboard
  E2E already exercises (`audit-keyboard`).

## Compress progress delivery

Context: 7-Zip writes compress and update progress on stdout as backspace-
refreshed segments with no newline (`-bsp1`, piped stdout), for example
`  0%\b\b\b ... 20% + big.bin`. Extract output carries `\r`, so its percent
already reaches the UI. The stdout reader only closed a record at `\r` or
`\n`, so a short run arrived as one record at EOF and the percent never reached
the UI while the run was live.

Ways the fix could fail or regress:

1. Extract progress regresses when the record boundary change alters `\r`
   handling. The `\r` and `\n` boundaries stay in place.
2. A backspace boundary splits one percent token across two records (for
   example `2` and `1%`). Records only close on a backspace byte, so a number
   is never split by a read boundary alone.
3. One record per backspace byte floods the IPC channel with tiny events. Close
   a record once per backspace run, not per byte.
4. "Finalizing…" overrides a live percent. It is emitted after the child exits
   and after all stdout records are read, so no later percent can follow it.
5. The "Working…" heartbeat replaces a live percent. Basic ignores heartbeats;
   Power fills only a blank status, so a live percent stays visible.
6. Throttling drops the last percent before Finalizing. Keep the latest
   skipped update and flush it when the stream ends.
7. Basic bar does not reach 100 on success. Basic clamps live values to 99 and
   only Finalizing sets 100, so the Finalizing event must still reach the
   listener while the run is in flight.
8. Listener registration is async. Events before registration are lost; percent
   events keep arriving, so the bar still moves.
9. Fixture too small. A 16 MiB compress finishes before 7-Zip prints a second
   update (measured: only `0%`). The E2E fixture needs about 200 MB so an
   intermediate percent exists.
10. A record larger than the 16 KiB cap still holds several updates. The parser
    takes the latest non-blank segment, so the newest percent still wins.
11. The collected stdout or stderr text changes. Record splits must only change
    callback chunking. The exit-1 classifier, logs and listing parsers read the
    collected text, so their bytes must match one read of the whole stream.
    Guarded by the `record_split_keeps_collected_stdout_bytes_identical` test
    in `spawn.rs`. That test was written after the framing change, so it guards
    the identity property rather than failing on the old code.
