# Beta 2 frontend cleanup failure inventory

This inventory was written before changing production code for worker piece
3D. It covers the low-severity frontend defects, the two open bugs carried from
earlier batches (A: Power header-encrypted archive with no password, B: Basic
changed archive stuck at Running), and the dead code in the owned files.

Test ids:

- E-P1, E-B1, E-R1, E-C1, E-S1: cases in `e2e/specs/beta2-fe-cleanup.spec.js`.
- V-*: cases in `src/tests/beta2-fe-cleanup.test.ts` (Vitest, written before
  the code they guard; red items fail on the unchanged code).
- Review: covered by reading the diff, the lint and typecheck gates, or the
  existing suites named in the entry.

## Open bug A: header-encrypted archive, Power, no password

Root cause found by reproduction with the bundled 7-Zip 26.06 sidecar. A
header-encrypted archive opened with an empty password makes 7-Zip print
`Enter password (will not be echoed):` on stdout and exit 255 with stderr
`Break signaled` (stdin is closed). The backend member-safety listing
(`src-tauri/src/process/staging/slt.rs`, `listing_exit_rejection` and
`preflight_failure_detail`) quotes only stderr and rejects the invoke with
`Could not list archive members for path safety: Break signaled`. The
frontend's `invokeRunForPasswordRetry` in `src/archive/runtime.ts` converts a
rejection only when `looksLikePasswordRequiredError("", detail)` matches, and
`Break signaled` does not match, so the error is rethrown and no prompt opens.
The fix stays in the frontend. A backend change (quote stdout as well as
stderr) would also work but is not needed.

1. The new match is too broad and makes ordinary failures prompt. Guard: the
   match only applies when `convertPasswordRejection` is true (extract and test
   retries), and only to the `Break signaled` signature. V-pw-2 checks that an
   ordinary listing rejection (`Headers Error`, CRC, disk full) still rejects.
2. The converted result is not recognised by the retry loop, so no prompt
   opens. Guard: the converted result carries `passwordRequired: true` and the
   loop checks that flag as well as the text match. V-pw-1 and E-P1 check the
   prompt opens.
3. The first prompt shows the "Retrying" label or the "Incorrect password"
   label. Guard: `passwordSent` stays false for the first run, so the label is
   the first-attempt label. E-P1 checks the label text.
4. Cancelling the prompt must not loop or extract. Guard: the cancel outcome
   returns the cancelled result before any retry. V-pw-1 covers cancel.
5. The right password must extract. Guard: the retry uses the same
   `withPassword(args, value)` path as the other password failures. E-P1
   extracts the file and compares its content.
6. Batch extraction with Skip must keep working (`allowSkip`). Covered by the
   existing `audit-password` batch-skip case; the change does not touch the
   skip branch. Review.
7. Non-header encrypted archives (7-Zip prints the prompt on stdout, so the
   existing path is used) must be unchanged. Covered by the existing
   `audit-password` and `beta2-fe-password-batch` E1 cases. Review.
8. If a future 7-Zip build changes the word `Break signaled`, the prompt stops
   opening and the error toast returns. This is a fail-safe, not a silent
   extraction. Documented here; not fixable in the frontend alone.

## Open bug B: Basic changed archive, password entered, Running for 60 s

Not reproduced. What was checked:

- The frontend path after the Basic prompt is linear: `handleBasicExtractActionOnce`
  writes the password to `basic-extract-password` and `extract-password`,
  `syncBasicBeforeRun` copies it to Power, `runAction` builds args with
  `buildExtractArgsFor`, and `setStatus("Running")` is the last frontend status
  before `run_7z`. No frontend timer waits 60 s (the runtime probe timeout is 7 s).
- `prompt-modal` has no timeout. A second open while one is active returns
  "cancel" immediately instead of hanging.
- The 7-Zip sidecar does not hang in the stdin variants checked: a header-encrypted
  archive with stdin left open exits 2 within the shell timeout, and a
  password written to stdin on an explicit `-p` exits 2 (wrong password) rather
  than blocking.
- The backend path (`prepare_password_transport` in `commands/spawn.rs`, the
  10 s `complete_password_transport_blocking` timeout, and the identity checks
  in `commands/run.rs`) is in Rust and out of scope for this worker. The 60 s
  symptom is most likely a backend wait and needs a GUI trace (the E3 timeline
  in `beta2-fe-password-batch.spec.js` records log, status and overlay events).

E-B1 is a regression guard: after the password is entered the run must finish
and write the changed file. If the stall exists, E-B1 fails at its 60 s wait
with the UI diagnostics attached.

1. The changed archive must still prompt (not reuse the browsed password). E3 in
   `beta2-fe-password-batch` covers the prompt. E-B1 checks it again.
2. After the password the run must complete and write the changed content.
   E-B1 checks the file content.
3. Identity check of the carried password must stay in place. Unchanged;
   `browsedArchivePasswordFor` is not edited. Review.

## Item 3: `setRecentArchiveHandler` registered twice

Both registrations (module load in `src/basic/actions.ts`, and
`initBasicWorkspace` in `src/basic/wire.ts`) call `handleBasicDrop([path])`. The
kept registration is the one in `initBasicWorkspace`, which `app-init.ts` calls
at boot before any Recent click. The module-load registration and its import
are removed.

1. Removing the wrong one breaks Recent. Guard: keep `initBasicWorkspace`.
   E-R1 clicks a Recent item and checks that Basic Browse opens the right
   archive.
2. A click before `initBasicWorkspace` runs would have no handler. Boot order
   makes this impossible: `app-init.ts` calls `initBasicWorkspace` before the
   header is usable. Review.
3. A single archive must still open in Browse, and several archives in Extract
   (the behaviour of `handleBasicDrop`). E-R1 checks Browse.

## Item 4: Recent shows only base names

The menu item gets a `header-recent__name` span (base name) and a
`header-recent__folder` span (parent folder, full text). The `title` keeps the
full path. Only `textContent` and `createElement` are used.

1. Two archives with the same name in different folders must show different
   folder text. E-R1 checks both folder strings.
2. Drive-root and POSIX-root paths (`C:\a.7z`, `/a.7z`) must give a folder that
   is still a readable path. V-recent-folder-1 checks both.
3. The folder text must not be parsed as HTML. Only `textContent` is set.
   Review.
4. Existing `basic-recent.test.ts` assertions compare the item's whole
   `textContent`. Those assertions are updated to read the name span (listed in
   the report). `clickBasicRecentArchive` uses `includes(basename)`, which still
   matches.
5. Long folder text may overflow the menu. Visual; batch 4 owns the CSS
   selector `.header-recent__folder`.

## Item 5: Basic completion path truncates the file name

The completion path label keeps the full path when it fits. When it is longer
than 48 characters, the folder part is cut from the start with a leading
ellipsis and the last segment is kept whole. The element's `title` is the full
path.

1. The file name is cut off. Guard: the folder is shortened first; the name is
   kept whole unless the name alone exceeds the budget. E-C1 checks the last
   segment is in the text.
2. A short path changes. Guard: paths at or under the budget are returned
   unchanged. `basic-ui.test.ts` ("shows the chosen extract destination")
   checks a short path and still passes.
3. A path with no separator is returned unchanged. Review.
4. Windows and POSIX separators both count as boundaries. Review; the helper
   uses the last of `/` and `\`.
5. The `title` must be the full path, not the shortened text. E-C1 compares it
   with the destination.
6. Screen readers must hear the full path, not the shortened text. A `<p>` cannot
   take an `aria-label` (the paragraph role prohibits naming), so the element
   gets `role="group"` and `aria-label` with the full path; both are removed when
   the panel has no path. V-completion-2 and V-completion-4 check the name, and
   V-completion-3 checks it is cleared.
7. The existing e2e assertion `main.spec.js` ("locks Basic compression fields
   until the archive is written") compared the element's text with the full path,
   which the truncation broke. It now checks the `title` equals the output path
   and the visible text ends with the file name. Only that assertion changed.
   No other e2e spec reads this element's text (grep of `completion-path`,
   `completion__path` and `-completion-msg` in `e2e/`).

## Item 6: Benchmark ignores the 7-Zip exit code

`runBenchmark` parses the rating from stdout even when 7-Zip exited non-zero.

1. A non-zero exit with a parseable `Tot:` line must be a failure. V-bench-1.
2. A zero exit keeps the rating. V-bench-2.
3. A cancel requested during a failing run still shows "Benchmark cancelled."
   V-bench-3.
4. The message is plain text (`Benchmark failed: 7-Zip exited with code N.`) and
   does not dump stderr. V-bench-1 checks the text.
5. The thrown-error path is unchanged. Review.

## Item 7: Default-archiver button re-enabled after an action

`setZinniaDefaultArchiver` sets `disabled = false` in its `finally` block, even
when the latest status says the action is not available.

1. The status-derived disabled state must be restored, and the title kept. The
   fix calls `configureDefaultArchiverActionButton(button, latestStatus)`, which
   sets label, disabled state and title from the same status. V-osint-1 checks
   disabled and title.
2. With no status yet, the button returns to the state it had before the action
   (`wasDisabled`). V-osint-2.
3. A successful action refreshes the status and keeps the status-derived state.
   Existing `os-integration.test.ts` cases cover the success path. Review.
4. Windows `runDefaultArchiverAction` (opens Settings, does not change the
   button) is unchanged. Review.

## Item 8: Unhandled promise rejections in the debug console

Rejections from `void` calls and from async event handlers escape. Two windows
are involved: the docked console and the pop-out page.

1. A listener installed twice logs each rejection twice. Guard: the install in
   `wireDebugConsoleControls` is guarded by `consoleControlsWired`, and the
   pop-out page installs its listener once in `run()`. V-dbg-1 counts lines.
2. With debug mode off the rejection must not be swallowed or logged. Guard:
   the main-window listener returns early when debug is disabled and does not
   call `preventDefault`. V-dbg-2.
3. A rejection with a non-Error reason (string, undefined, object) must not
   throw inside the listener. Guard: the reason is converted with `String`.
   V-dbg-3.
4. Logged text is redacted. Guard: the docked path goes through `debugLog`,
   which redacts. The pop-out page uses `redactSensitiveText`. V-dbg-4.
5. The pop-out page listener is not reachable from E2E without opening the
   pop-out window, and no Vitest case was written for it before the change.
   Review only: the listener is registered synchronously at the top of `run()`
   and uses the same `appendLine` path as relayed lines. Reported as a gap.

## Item 9: Emoji and grapheme truncation in status file names

`sanitizeStatusFileName` used a UTF-16 index from `String.match` to slice an
array of code points, so a non-BMP character before the first filename
character shifted the cut (for `🎉file.txt` the result was `ile.txt`). It also
cut between code points of one grapheme (a flag or a combining accent).

1. A leading non-BMP symbol drops the wrong characters. V-emoji-1.
2. A regional-indicator flag at the 200 boundary must stay whole. V-emoji-2.
3. A base letter plus combining accent at the boundary must stay whole. V-emoji-3.
4. The 200-character cap still applies to plain text. V-emoji-4.
5. Names that start with a combining mark or a plain symbol keep the existing
   behaviour (skipped until a filename character). Existing
   `extract-window.test.ts` cases (`sanitizeStatusFileName`) still pass.
6. `Intl.Segmenter` missing falls back to code points. Review.

## Item 10: Dead compression methods (PPMd, BZip2, Zstandard)

The Power and Settings method selects no longer offer these methods (3A owns
`index.html`). The allow-list and labels in this worker are removed.

1. A saved custom preset with one of these methods would be dropped by
   `asCustomPresets`, because `optionalPresetField` rejects it. Guard: a
   retired-method set maps those values to the default method and keeps the
   preset. V-method-1 checks the preset is kept with `lzma2`.
2. A saved global setting with one of these methods must load as the default.
   V-method-2 checks `method` is `lzma2` for 7z and `deflate` for zip.
3. The Settings method select must not be empty after load. E-S1 checks
   `#s-method` after a reload with `method: "ppmd"` seeded in the profile.
4. Presets labels for the removed methods are unreachable because
   `validMethods` offers only LZMA, LZMA2 and Deflate. Removing the branch has
   no visible effect. Review.
5. `presets-dom.test.ts` uses `setSelectValue("method", "ppmd")` to force a
   "custom" match. The test DOM fixture (`setup-dom.ts`, not owned) still has
   the option, so the test still passes. Unchanged.

## Item 11: Selected picker rows have no visual state

Not done. The rows are built in `src/archive/selective-tree-ui.ts`, which is not
on this worker's ownership list. That file already sets `aria-selected` and
`aria-checked` (`true`, `false`, or `mixed`) on each `treeitem`. Adding the
`is-selected` class needs one line in `applyState` in that file, which the
owner of that file must make. Reported to the manager.

## Item 12: Lint warning in browse-events

`if (browsed && browsed.archive === state.inputs[0])` is rewritten with an
optional chain. The rewrite must keep the empty-input case false: with no
archive browsed (`browsed` is null) and no input (`state.inputs[0]` is
undefined), `undefined === undefined` must not restore anything. Covered by the
lint gate (0 warnings) and by review; `restoreBrowsedArchivePassword(null)`
already returns early.

## Item 13: Dead exports

Exports in owned files with no reference in `src/` (including tests) or `e2e/`
are made module-private (the `export` keyword is removed). `showBasicCancelled`,
used once in the same file, keeps its function. Typecheck catches any missed
importer. Review plus the typecheck gate.

## Review-only items

- Output of the E2E and Vitest files must not contain code comments
  (`scripts/lint-comments.mjs`), and must not contain U+2014 characters
  (`validate:no-em-dash`).
- No CSS is changed. New classes for batch 4: `header-recent__name`,
  `header-recent__folder` (Recent menu), and the completion path keeps its
  existing `basic-completion__path` class.
