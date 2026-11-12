# Updater frontend failure modes

Failure inventory written before the changes in `src/updater.ts`. Each item
names a way the fix can fail and the test that is meant to catch it. Tests
live in `src/tests/updater.test.ts`.

## A. Install succeeded, reservation release or relaunch failed

- Release rejects after `update.install()` succeeded and the code still reports
  an install failure, although the new version is on disk.
  Test: "reports an installed update when release and relaunch both fail".
- Release rejects and relaunch is skipped, so the app never restarts.
  Test: "still requests relaunch when reservation release IPC fails after install".
- Release fails and relaunch resolves. The backend may defer the exit while the
  reservation is held, so the app stays open with no message. The failed release
  must still show the "Quit and reopen Zinnia to finish" toast and status.
  Test: "reports an installed update when release fails and relaunch resolves".
- Release fails and relaunch also throws, so the toast is shown twice.
  Test: "reports an installed update when release and relaunch both fail" asserts one toast.
- Relaunch rejects after a successful release and the error is rethrown, so the
  entry point shows a misleading install failure.
  Test: "reports an installed update when relaunch throws after release succeeds".
- The persistent toast is not sticky (non-zero duration), so it disappears
  before the user reads "Quit and reopen Zinnia to finish".
  Test: the same test checks `data-sticky="true"`.
- A failure of `update.install()` itself stops being reported, or the
  reservation is not released.
  Test: "keeps install errors as failures and does not relaunch" and
  "releases the archive-operation reservation when install fails".
- Status stays "Installing update" or becomes "Idle" after an installed update
  that did not relaunch, hiding the restart requirement.
  Test: the same tests assert status "Update installed".

## B. Double restart prompt

- A second indicator click or interactive check opens a second `ask()` while
  the first is still open.
  Test: "does not open a second restart prompt from the indicator or an interactive check".
- The guard flag is set but never cleared (no `finally`), so the indicator
  stays dead after "Later". Same test: a click after "Later" prompts again.
- The guard path closes the pending update the open prompt still needs.
  Same test asserts `close` is not called on the pending update.
- A candidate found by an interactive check while a prompt is open is neither
  pending nor closed. Test: "closes a new candidate found while a prompt is open instead of stacking prompts".
- Discarding during an open prompt resets the guard, reopening the race. The
  guard is intentionally not reset by discard; the prompt's `finally` owns it.

## C. Background checks download the installer

- Background checks still call `download()`.
  Test: "parks a background update without downloading and notifies without prompting for permission".
- Notification permission probing failure breaks the background park.
  Test: "parks the background update when notification permission probing fails".
- The parked update is not marked undownloaded, so a click skips the download
  and installs a partial archive.
  Test: "downloads on indicator click before prompting".
- A failed download on click clears the pending update, so the user cannot retry.
  Test: "keeps the update parked after a failed download and retries on the next click".
- A failed download leaves the status at "Downloading update" or "Idle" instead
  of "Update available".
  Test: the same test asserts status "Update available"; the interactive case is
  "restores Update available when an interactive check cannot download a parked update".
- Two clicks, or a click plus an interactive check, start two downloads.
  Test: "does not start a second download while one is running".
- An interactive check while an undownloaded update is parked does nothing
  instead of downloading and prompting.
  Test: "downloads a parked update when an interactive check runs".
- Discarding during an in-flight download calls `close()` on a resource the
  download still uses. Discard skips the close while a download runs; the
  download closes the stale update after it settles.
  Test: "closes a parked update discarded mid-download once the download settles".
- `clearPendingUpdate` does not reset `pendingDownloaded`, so a newly parked
  update is treated as downloaded and a click skips the download.
  Test: "treats a newly parked update as not downloaded after discard".
- The indicator shows "ready" text for an undownloaded update, or "available"
  text for a downloaded one. Tests check the exact indicator text in each state.
- The interactive download path loses its immediate download, so the
  "downloads update and defers install when user chooses later" test fails.
