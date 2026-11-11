# Settings persistence and Settings dialog failure inventory

This inventory was written before changing production code. It covers audit
items B-08, B-15, C-13, C-14, C-17, C-21 and the identity-cache part of C-46
(plan.md). Each item lists the ways the fix could fail or regress.

## B-08: corrupt `settings.json` can never be saved over

Context: `save_settings` refuses to write when the existing file does not
parse. The user is stuck with a wizard on every launch and a message that
asks them to delete a file by hand. The fix renames the bad file to
`settings.json.corrupt-<UTC timestamp>` and writes the new settings.

1. The rename targets a path that already exists (two corrupt saves in the same
   second). The second rename overwrites the first quarantined file and loses
   the original bytes. The name needs a unique suffix or a collision check.
2. The timestamp is not UTC or not zero-padded, so names sort wrongly or differ
   by locale. The timestamp helper must be checked against known epoch values.
3. The rename runs for a file that is valid JSON with a reserved key. Dropping
   `_setupWizardVersion` there would reintroduce the wizard. Only unparsable
   bytes lose the key; a valid object is merged as before.
4. A valid JSON value that is not an object (for example `[]`) has no keys to
   keep. It must still be quarantined, or every later save fails again.
5. The rename happens before the new file is durable. A crash between rename and
   write leaves no `settings.json` at all. The new contents must be written to a
   temp file first and renamed over the path only after that succeeds.
6. A symlink or non-regular file at the settings path must not be renamed. The
   existing `read_bounded_settings_file` checks must still run first and still
   refuse those paths.
7. An oversized file (over 512 KiB) is treated as unparsable and quarantined.
   It must instead keep the existing error, because it may be a legitimate file
   that is only too large.
8. The rename succeeds but the warning is not logged, so the user has no trace
   that their settings were moved. The warning must go through a visible
   channel (`eprintln!` with the `Warning:` prefix used in this module).
9. The corrupt file is left in the settings folder and the reset path
   (`reset_settings_files`) does not delete it. This is acceptable, but the E2E
   check must not assume the folder is empty except for `settings.json`.
10. `atomic_write_text` returns an error after the rename succeeded (parent
    directory sync fails). The UI then rolls back in memory while the disk holds
    the new values. The fix logs the sync failure and returns success.
11. The post-rename tolerance hides a real failure before the rename. The
    tolerance must apply only to the directory sync step, not to temp-file
    write or rename errors.
12. Frontend load on an unparsable file loads defaults with `setupComplete`
    false, so the wizard shows on launch. That is intended until the user
    finishes or skips it; the E2E case must not treat the first wizard as a
    failure.

## B-15: Compression method list shows unsupported methods

Context: `#s-method` in Settings lists LZMA2, LZMA, PPMd, BZip2, Deflate and
Zstandard for every format. The runtime only supports 7z {LZMA2, LZMA} and zip
{Deflate, LZMA}. The list must follow the selected format, as the main form does
through `updateCompressionOptionsForFormat` in `src/presets.ts`.

1. The Settings allow-list drifts from `validMethods` in `src/presets.ts`. The
   two lists are duplicated because `presets.ts` is read-only for this area. A
   mismatch silently offers a method the main form does not.
2. Formats without a method choice (tar, gzip, bzip2, xz) must show a disabled
   `N/A` option with value `""`. Leaving a real method selected there sends
   nothing useful to 7-Zip and the saved value means nothing.
3. The method list is filtered when the modal opens but not when the format
   changes. The change listener must be on `#s-format`, wired once.
4. The change listener is registered twice (modal open and wire-up). Two
   listeners reset the selected method twice; a repeated wire-up must not add a
   second listener.
5. On format change the selected method is dropped even when it is still valid
   for the new format (for example lzma with 7z to zip). It should be kept when
   it is in the new list and fall back to the first option otherwise.
6. Saved values outside the list (zip with lzma2, 7z with deflate, zstd) are
   kept silently. They must be normalized on load in `normalizeUserSettings`,
   not only in the UI.
7. Normalization runs on the format from the same payload. If it reads the
   format from the defaults instead, a zip file with lzma2 is normalized against
   7z and stays wrong.
8. Normalizing a tar or gzip method to `""` must not break the saved-default
   round trip. A later save must write `""` back, not the old value.
9. Custom presets carry a method too. If they are not normalized, applying a
   preset that uses an unsupported method leaves the select empty, which 7-Zip
   then runs with its default. Presets use the same normalization.
10. Read-only consumers (`extract-window/fx.ts`, `debug-console-window.ts`) use
    `parseSettingsRaw` and must keep getting a valid object for a bad method.
11. Session values copied into Settings (`useSessionCompressionValues`) can
    carry a method that is not in the new list. The copy must go through the
    same filter.

## C-13: closing Settings with unsaved edits drops them silently

Context: Esc, Cancel, the close button, a click on the overlay, and Ctrl/Cmd+,
all close the modal and discard edits. The fix asks before discarding, and only
when something changed.

1. "Changed" is computed against a snapshot taken after `populateSettingsModal`.
   A snapshot taken before populate reports false dirty on every open.
2. Save closes the modal through the same path. If the prompt runs after save,
   the saved values differ from the open-time snapshot and the user is asked to
   discard changes that were just saved. Save must skip the prompt.
3. `keyboard.ts` calls `closeSettingsModal()` without `await`. The prompt is
   async, so the close must not be a synchronous path that the caller depends on.
   The return value must not be relied on by callers.
4. Esc pressed twice while the prompt is open stacks two prompts. A guard flag
   must make the second request a no-op.
5. The live window-effects preview (`basicWindowEffects`) is restored only when
   the modal really closes. A cancelled discard must keep the preview, and a
   confirmed discard must restore it.
6. Discard confirmed, but the focus trap is not released or the trigger does
   not regain focus, so keyboard users are stuck in a hidden modal.
7. The prompt uses the native `ask` dialog. In E2E builds it must go through
   `confirmWithE2eQueue` so the spec can answer it. A direct `ask` call blocks
   WebDriver.
8. The snapshot includes the threads input. Changing an unrelated field and
   then changing it back must not prompt; the comparison is by value, not by
   event.
9. Existing unit test "restores the live window-effects preview when settings
   are cancelled" expects a synchronous close after a change. It will change on
   purpose and must be updated, not deleted.
10. Reset (`#reset-settings`) and the wizard re-run close or act on the modal
    too. The re-run path closes without edits and must not prompt; the discard
    prompt must not block the reset dialog.

## C-14: reset confirmation does not name everything it deletes

Context: `reset_settings`, `clear_logs`, the Basic recent list, and custom
presets are all removed on reset. The confirmation text lists only settings.

1. The text is changed but the confirmation title is not recorded for E2E. The
   spec can only check the title through `confirmDialogTitles`, so the title
   argument must be passed to `confirmWithE2eQueue`.
2. Custom presets are saved in `settings.json`, so they are removed with the
   settings file. The text must still name them, because that is the user-facing
   consequence.
3. The text claims logs are deleted when `clear_logs` fails. The message says
   what the reset is designed to delete, and failures stay in the logs as they
   are now.
4. The text is long and wraps badly in the native dialog. Keep one sentence per
   item group.
5. Wording must not use an em dash (`scripts/validate-no-em-dash.js`).

## C-17: factory defaults do not match the Balanced preset

Context: `SETTING_DEFAULTS` uses dict `256m` and solid `16g`. Balanced is
`64m` and `4g`, so a first run shows "Custom". Only the defaults change; the
Balanced preset itself must not change.

1. Changing `SETTING_DEFAULTS.dict` and `.solid` also changes what a missing
   key means in old files. Users who never saved compression settings move to
   Balanced on the next launch. That is the intent, but it must be noted.
2. The defaults must match `PRESETS.balanced` exactly on all six fields (format,
   level, method, dict, wordSize, solid). Threads is not part of the preset.
3. `presets.test.ts` or `settings-model.test.ts` may assert `256m`/`16g`. The
   expectation must change to the Balanced values, not be removed.
4. A saved file that has `dict` but not `solid` would mix old and new defaults.
   Each key falls back independently, so this is acceptable and must be checked
   in the E2E first-run case.
5. The 256 MB dictionary was chosen for memory use with all cores. The change
   lowers memory use, which must not be reported as a behaviour change for
   existing users with saved values.

## C-21: setup wizard has no skip after step 0, and Esc is swallowed

Context: `index.html` has only a Skip button on step 0. `keyboard.ts` calls
`preventDefault` on Esc while the wizard is open and does nothing else, so Esc
does nothing. Re-running the wizard and choosing Basic does not resync the Basic
view (`runSetupWizardFlow` never calls the Basic sync that the Settings save
path calls).

Markup is read-only in this area, so the Skip buttons for steps 1 to 4 are
created in TypeScript inside `setup-wizard.ts`.

1. Skip buttons added to a step must be removed or reused on the next wizard
   run. Otherwise a second run adds a second button to each step.
2. Skip must resolve the same way as the step 0 Skip (`null`, which marks setup
   complete and applies no choices). A different path would apply half-made
   choices from an unfinished step.
3. Esc handled on `document` must be removed in `cleanup`. Otherwise a closed
   wizard still closes Settings or re-runs cleanup on the next Esc.
4. Esc must not reach other handlers while the wizard is open. Basic's Escape
   handler returns to Home (B-09); that must stay blocked while the wizard is
   up. Today `keyboard.ts` returns early for the wizard, so the new handler must
   not break that.
5. "Required first-run step" exception: step 0 already has Skip, so no step is
   required. Esc therefore closes the wizard the same way Skip does on every
   step. No exception is added. If Skip were ever removed from step 0, Esc would
   need the exception documented here.
6. Esc with the wizard open but a focused `<select>` (update channel) must still
   close the wizard, not just change the select.
7. The Flatpak step list (`FLATPAK_STEPS` = 0, 1, 2, 4) must still get a Skip on
   step 4 and must not get one on the hidden step 3.
8. Re-running the wizard and choosing Basic must call the Basic sync only after
   `applySettingsToForm`. Calling it before the power form has the new values
   copies stale compression values into Basic.
9. The resync must not call `setBasicView("home")` while an operation is
   running. `setBasicView` already refuses in that case; the check must not
   assume it succeeded.
10. A wizard version bump still forces returning users through every step. This
    audit item is not changed here; Skip now lets them leave early.

## C-46 (identity-cache part): reset does not clear the identity cache

Context: `resetRuntimeStateForFirstRun` clears the browse info and selection
maps but not `state.browseArchiveIdentityByPath`. The reset relaunches the app,
so the stale entry is only visible if the reset runs without a relaunch (for
example from a unit test or if the relaunch fails).

1. The clear is added to the wrong map (`browseArchiveInfoByPath` is already
   cleared). The unit test must assert the identity map specifically.
2. A relaunch failure after reset leaves the identity map populated. That is the
   case the change protects, so the unit test must not depend on a relaunch.
3. The test is written after the code. The unit test is written first (it fails
   before the change) so the failure is proven.
4. Clearing the identity map while an operation is running could break a
   pending identity check. Reset refuses while running (the settings button
   is disabled), so this should not happen; it is noted for review.

## Coverage plan

- E2E (`e2e/specs/audit-settings.spec.js`): corrupt file recovery (B-08), zip
  method list and load-time normalization (B-15), Esc discard prompt and the
  no-prompt case (C-13), reset confirmation title (C-14), first-run Balanced
  preset (C-17), wizard Skip on step 2 and Esc on the wizard (C-21).
- Rust unit tests in `src-tauri/src/settings_store.rs`, written before the code:
  quarantine name and timestamp (B-08), the write core for the corrupt and
  valid-but-not-object cases (B-08), and tolerance for a failed directory sync
  after rename (B-08).
- Frontend unit test (`src/tests/power-helpers.test.ts`), written before the
  code: identity cache cleared on reset (C-46).
- The reset confirmation is checked in E2E by its title and by the decline
  path (settings kept). The native dialog body text is not readable from the
  E2E hook, so its wording is reviewed in the diff, not asserted in the spec.

## Deferred

- C-21 wizard version bump forcing every step (item 10 above) is not changed.
  Skip gives users an exit; a separate decision is needed for the bump itself.
- The Settings threads default (`SETTING_DEFAULTS.threads` mutated at startup in
  `app-init.ts`) is part of C-46 but owned by another area. It is not changed
  here.
