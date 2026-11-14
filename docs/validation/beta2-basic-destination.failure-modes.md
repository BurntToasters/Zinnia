# Basic destination failure inventory (H5)

This inventory was written before changing production code. It covers H5:
Basic hid where it writes. Basic Compress wrote beside the source without
saying so, Basic Extract wrote to a hidden destination, and an output path
typed earlier in Power was silently reused.

The fix shows a read-only "Save to" row (Compress) and an "Extract to" row
(Extract), re-derives both paths from the current inputs whenever Basic is
entered or its inputs change, and runs from exactly the path shown.

Coverage names: `E2E-1` to `E2E-8` are the eight cases in
`e2e/specs/beta2-basic-destination.spec.js`, in file order (E2E-1 compress,
E2E-2 stale Power path, E2E-3 Change, E2E-4 extract one, E2E-5 Change extract,
E2E-6 two archives, E2E-7 placeholders, E2E-8 layout). "Existing" names a spec that
already drives the flow. "Review" means no automated check reaches it; it is
checked by reading the code.

## A. Visible rows

A1. The row shows a path the run does not use (for example the row renders
from a value the run never reads). Covered: E2E-1 (the file appears at the
shown path), E2E-4 (the extracted folder equals the shown folder).

A2. The row keeps the old text after Change. Covered: E2E-3 and E2E-5 wait for
the row to show the chosen path before running.

A3. The row shows "undefined", "null" or a stale path when the field is empty.
Covered: E2E-7 (placeholder text with no files, and with a protected source).

A4. A long path wraps to a second line or grows the row, pushing the primary
button out of the 500x650 window. Covered: E2E-8 (button rectangle inside the
viewport, path element at most one line high) for Compress and Extract.

A5. The ellipsis hides the file name on long folders (an end-only ellipsis
removes the name). Covered: E2E-8 (the name element is not clipped and its
text is the file name).

A6. The "Each archive gets its own folder." note shows for one archive or is
hidden for two. Covered: E2E-4 (note hidden), E2E-6 (note visible with text).

A7. The accessible names are missing. "Save to" and "Extract to" must label
the output, and the Change buttons must say what they change. Covered: E2E-1,
E2E-4 (`aria-labelledby` and `aria-label` values).

A8. The hidden fields come back. The name-location section, the extract
destination field and the extract password field must stay `display: none`.
Covered: E2E-1 and E2E-4 (computed display checks).

A9. A color token that does not exist in one theme makes the row unreadable in
light or dark mode. Review only: the CSS uses existing `--surface-alt`,
`--border`, `--text`, `--text-secondary` and `--surface` tokens, which are
defined for both themes. No automated color check covers the new row.

A10. The Change button stays disabled after an apply ends. The apply
flag (`incomingPathsApplying`) clears without a Basic render, so a render made
during the apply keeps a stale lock. Found in GUI run 1. Fixed by keeping only
the run and preparation locks, which both re-render at their transitions.
Covered: E2E-7 (Change enabled for a protected source after the apply).

A11. The E2E build skips the production Basic resize (`resizeWorkspaceWindow` returns early under `isE2eFrontend`), so the window measured 500x680, not 500x650. Covered: E2E-8 applies the production 500x650 inner size through `plugin:window|set_size`, asserts it, records before, during and after, and restores the original size.

## B. Re-derive on entering Basic

B1. A stale Power output path is copied into Basic on Compress entry (the
original H5 bug). Covered: E2E-2.

B2. A stale Power extract destination is copied on Extract entry or on a
workspace switch. Covered: E2E-4 (Power's extract path is set to a stale value
before Basic Extract is entered).

B3. Re-derive is skipped on a Settings switch (`resumeBasicView` path). Existing:
`beta2-fe-basic-sync` keeps the typed Compress password through a Settings
save and a workspace round trip. Review for the derive call, because that spec
does not check the path.

B4. Re-derive is skipped on app start in Basic. Review only: the first
Compress or Extract entry re-derives through `setBasicView`, which every
entry point calls.

B5. A change of inputs in Power is not reflected when Basic is entered again.
The input key recorded at the last derive is compared on entry. Covered: E2E-2
(Power round trip re-derives the Basic path).

B6. An explicit Change choice survives a change of inputs. It must be
discarded. Covered: E2E-3 (after a new file set, the row shows the derived
path again).

B7. An explicit Change choice is lost on a Power round trip with the same
inputs. Covered: E2E-3 (round trip keeps the chosen path).

B8. A re-derive during a run replaces the path that is running (for example
after the archive name is cleared at run start). Review only: derivation is
skipped while `state.running`. No E2E run observes a mid-run render.

B9. A value written by a test or a script, with no `input` event, is treated as
an auto value and replaced. Existing: `beta2-fe-password-batch` E3 and E8,
`audit-basic`, `audit-operations` (native save with an empty field),
`audit-presets` (Change then rename keeps the folder), `main.spec.js` (Basic
Extract and Compress typed destinations). The explicit test is "value differs
from the last derived value".

B10. Power's format change is not carried to Basic, so the row keeps the old
extension while the format reads the new one. Covered: E2E-2 (Power format is
set to zip, the row and the written archive end in `.zip`).

B11. A Basic archive name carried from Power changes the derived path without
the row updating. The row always shows the value that runs, so the change is
visible rather than silent. Review only.

## C. Run from what is shown

C1. The run reads a different field from the row (for example Power's output
path). Covered: E2E-2 (the stale path does not exist after the run), E2E-3 (the
chosen path is written), E2E-4 and E2E-6 (the derived folders are written).

C2. An empty path runs without asking for a location. Existing:
`audit-operations` ("does not confirm a second time when the native save dialog
chose the archive") runs with an empty field and checks the dialog is used.
E2E-7 checks the placeholder and that Change is enabled for a protected source.

C3. Ctrl+Enter runs a different path from the button. Existing:
`beta2-fe-basic-sync` (Ctrl+Enter in Compress and Extract).

C4. Cancelling the Change dialog keeps the previous path, and does not record
a choice. Review only: the stub cannot express a cancelled native dialog
(a null queue entry falls through to the real dialog), so the guard
`outputVal !== before` is checked by reading the code.

## D. Paths that cannot be derived

D1. A source in a protected folder (Windows folder, Program Files, Start Menu,
ProgramData) derives no path. The row must say "Choose where to save" and
Change must stay enabled. Covered: E2E-7 (source under the Windows folder).

D2. With no files the row says "Add files first" and Change is disabled, so a
location cannot be chosen for nothing. Covered: E2E-7.

D3. Extract with several archives on different drives derives no parent. The
row must say "Choose a folder". Review only: this needs archives on two drives,
which the E2E fixtures do not provide.

## E. Multiple archives

E1. The parent shown is not the parent the batch uses. Covered: E2E-6 (row
equals the folder the archives sit in, and both extracts land under it).

E2. Two archives share one folder. Covered: E2E-6 (`alpha/` and `beta/` both
exist, nothing at the parent root).

E3. The first archive's password prompt runs for the whole batch. Existing:
`beta2-fe-password-batch` E8 (partial completion for a batch).

## F. Batch 1 behaviour that must keep working

F1. Basic secrets mirror to Power. Existing: `beta2-fe-basic-sync` (password
through Settings, workspace round trip, Browse).

F2. The validation failure panel and "Open folder" toast. Existing:
`beta2-fe-basic-sync` (validation panel, Open folder toast).

F3. The browsed password is carried into Extract. Existing:
`beta2-fe-basic-sync` (Browse extract with the browse password) and
`beta2-fe-password-batch` E3.

F4. Multi-archive autofill passes the inputs and batch extract gives each
archive its folder. Covered: E2E-6.

## G. Power is not changed

G1. Power's output and extract fields change behaviour. Covered: E2E-2 (Power's
typed value stays in Power's field), existing `ui-surfaces` (round trip keeps
typed destinations in both directions).

## H. Unit tests

H1. `src/tests/basic-ui.test.ts` asserts that entering Compress copies Power's
output path into the hidden Basic field. That is the H5 behaviour. The
assertion is updated to expect the stale Power value to be discarded. No new
Vitest file is written, because every item above is reached by E2E or by
review.

## I. Known conflict with an existing spec

I1. `e2e/specs/main.spec.js`, test "replaces the Basic extract archive from its
archive card": after a typed Basic Extract destination, a replacement archive
must keep that typed destination. The owner rule re-derives on any change of
inputs unless the choice was made for the same inputs, so the typed value is
discarded. The assertion `domValue("#basic-extract-path") === typed` after the
second replacement fails under this fix. The spec is not in this worker's
ownership list, so it is left unchanged and must be updated by its owner.
