# Window lifecycle, incoming paths and window size failure inventory

This inventory was written before changing production code. It covers the
close and quit confirmation (B-14), Power drop and hand-off feedback (C-06),
the 4,096-path copy (C-39), Power window size persistence (C-20), the
detected CPU count (C-46), and the quick-extract safe-copy label (B-04).

## Close and quit confirmation (B-14)

- The prompt must appear only when the window that owns a 7-Zip run asks to
  close or quit. A close of an idle window, or of a window whose operation is
  owned by the other window, must not prompt.
- The Rust close and exit handlers must `prevent_close` / `prevent_exit` before
  any await. If the prompt request is sent but the prevention is missed, the
  window closes and cancels the run without asking.
- A declined prompt must leave the window, the run and the recovery journal
  untouched. The E2E case checks that the job still runs and then completes.
- Two close clicks, or a close followed by Cmd+Q, must not stack two prompts.
  The frontend keeps one prompt open at a time; the second request is ignored.
- Accepting the prompt must run the existing safe teardown. The main window
  must wait until `is_7z_running` is false before `close()`; otherwise the
  second close request is prompted again or the window closes mid-cleanup.
- A timed-out cancel must keep the window open and show an error, not close.
- The owner check must match the window label. `cancel_7z` rejects other
  owners; the prompt routed to the wrong label would never be answered.
- An update install reservation (`blocks_quit_for_update_install`) is not a
  user operation. It must keep the existing behaviour and must not prompt.
- If the owning window cannot be found, there is nobody to ask. The handler
  must fall back to the existing cancel-and-close path, not leave the window
  stuck with a prevented close.
- The quit prompt on macOS comes from `ExitRequested` (Cmd+Q). Accepting it
  must end in `exit(0)` from the frontend, which needs `process:allow-exit`
  in the capability of the window that shows the prompt.
- Quick-extract titlebar close: while an extraction is running the titlebar
  must not arm the local abort before the user confirms. Declining must leave
  the abort unarmed so the run continues.
- Quick-extract titlebar close while idle keeps the current abort and
  `close_extract_window` path.

## Power drops and hand-offs during a running job (C-06)

- Drops during a job or Basic preparation are queued until the job ends. The
  decision is to queue and say so, not to refuse. The toast must appear once
  per drop or hand-off, before the wait starts.
- Only `running` or `operationPreparing` should show the "will be added when
  the current operation finishes" text. A wait on another hand-off
  (`incomingPathsApplying`) is not an operation and must not show it.
- Enter/over/leave events must keep ignoring while busy; the toast must not
  appear for hover events.
- The drop path is native (`onDragDropEvent`) and cannot be driven through
  WebDriver. The shared helper is exercised by the E2E hand-off case, which
  calls `applyIncomingPaths` while a job runs. The drop wiring itself is
  covered only by the code review of `app-init.ts`. This is a known gap.
- The hand-off helper awaits the lock, so the E2E call during a job must not
  be awaited, or the test blocks until the job ends.

## Hand-off limit copy (C-06, C-39)

- Hand-offs over 4,096 unique inputs must show the same toast the drop path
  shows ("Added the first N unique items; M more were not added."), not only a
  log line.
- The toast must count only the excess after de-duplication, the same way
  `mergeIncomingPaths` does. A hand-off whose paths are all known must not
  show a limit toast.
- Log lines stay for diagnostics; they must not replace the toast.
- Copy: "dropped files" must not appear in hand-off errors. The archive-type
  detection failure uses "selected files" because `applyIncomingPaths` serves
  Explorer, Finder and launch arguments.

## Power window size (C-20)

- Saving only when `isMaximized()` and `isFullscreen()` are both false keeps
  the normal size. A failed or missing state query must skip the save, not
  fall back to `innerWidth`.
- The resize handler is async. An older query answer must not overwrite a
  newer resize. A sequence counter keeps only the latest answer.
- Leaving maximized state fires a resize with normal dimensions. That resize
  must save again, or the restored size never persists.
- The query needs `core:window:allow-is-fullscreen` in `default.json`. Without
  it the call rejects and, with the fail-closed rule above, saves would stop.
- Double-click on the titlebar uses the drag region. `drag.js` invokes
  `plugin:window|internal_toggle_maximize` on `detail === 2`. That command is
  not in `default.json`, so the double-click is rejected today. Granting
  `core:window:allow-internal-toggle-maximize` is needed for the double-click
  path. Basic mode stays locked because the command checks `is_resizable`.
- The E2E case calls the maximize IPC directly, so it proves the save path
  and the permission, not the mouse gesture.

## Detected CPU count (C-46)

- `SETTING_DEFAULTS.threads` must stay 8. Mutating it at startup changes the
  default for every later reader, including the settings-model fallback.
- The detected count is kept in its own runtime value. Readers of the default
  switch to the exported getter, which falls back to 8 when detection failed.
- First run: settings with no persisted `threads` key must show the detected
  count, as before. Persisted values win over the detected count.
- Call sites outside this area still read `SETTING_DEFAULTS.threads` (see the
  report). Until they switch, a blank threads field falls back to 8.
- Detection failure must keep the default of 8, not 0 or NaN.

## Quick-extract safe-copy label (B-04)

- The label is driven by the structured progress event `currentFile`. The
  label must replace the "Extracting <name>..." text only while the safe copy
  runs, and must not be stored as `lastFile`.
- The copy text must come from `SAFE_COPY_PROGRESS_LABEL`, not a second
  literal, so the backend and frontend cannot drift.
- After the copy finishes, the next progress update with a real file name
  must show "Extracting <name>..." again.
- A heartbeat ("Working…") during the copy must not overwrite the label.
- Not covered by E2E: the copy path needs a filesystem without clones or hard
  links (ext4, exFAT). On macOS APFS the clone path is used. Verify manually on
  exFAT before release.

## Deferred

- The native drop path has no WebDriver driver (see C-06). Covered by review.
- The safe-copy label has no E2E case on APFS (see B-04).
