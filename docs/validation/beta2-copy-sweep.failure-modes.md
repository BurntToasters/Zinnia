# Beta 2 copy sweep failure inventory

This inventory was written before changing production copy. It covers every
user-facing string change in the frontend for 0.7.0-beta.2 (wording only: no
behaviour, layout, id or data attribute changes). The E2E spec is
`e2e/specs/beta2-copy-sweep.spec.js`. Vitest assertions that quote a changed
string are updated in the same change.

## Inventory

### Items fixed explicitly

| # | File:line (before edit) | Old | New | Rule |
|---|---|---|---|---|
| 1 | src/archive/inspection.ts:351 | "...listing over 64 MiB, roughly 200,000 entries)..." | "...listing over 64 MiB)..." | stale entry estimate, backend drops unread lines before the cap |
| 2 | src/index.html:807,815,823,839,861,883 | `status-pill status-pill--warn` on "Checking…" | `status-pill status-pill--unknown` | initial checking state |

Item 1 has no mutations.ts counterpart: src/archive/mutations.ts:635 says
"Archives whose listing is over 64 MiB cannot be converted yet." and contains no
entry estimate, so it stays as written.

### Ellipsis ("..." to "…")

| File:line | Old | New |
|---|---|---|
| src/index.html:1066 | placeholder "Filter by path..." | "Filter by path…" |
| src/index.html:2791 | "Extract selected..." | "Extract selected…" |
| src/index.html:2798 | "Add files..." | "Add files…" |
| src/index.html:2806 | "Convert..." | "Convert…" |
| src/extract.html:93 | "Preparing..." | "Preparing…" |
| src/archive/ops.ts:545 | "Cancelling..." | "Cancelling…" |
| src/extract-window/run-core.ts:157,343 | "Cancelling..." | "Cancelling…" |
| src/extract-window/run-core.ts:405,616,672,707 | "Starting extraction..." | "Starting extraction…" |
| src/extract-window/run-core.ts:497,511,542 | "Extracting ${x}..." / "Extracting..." | "…" |

Not changed: src/progress-update.ts:6 `SAFE_COPY_PROGRESS_LABEL`. It is an IPC
sentinel compared with `===` in src/basic/progress.ts:367 and
src/extract-window/run-core.ts:476, and the Rust constant
src-tauri/src/process/archive_snapshot.rs:81 holds the same three-dot text.
Changing it would break the progress match, and Rust is outside this sweep.
Reported to the manager.

Not changed: "Choose another folder" (src/extract.html:125) stays, because it is a
descriptive action label, not a generic picker button. A comment in
src/basic/progress.ts:625 mentions "Cancelling..." and is code commentary.

### Plurals ("(s)" and computed counts)

A `pluralize(count, singular, plural?)` helper is added to src/utils.ts and used
at each site below.

| File:line | Old | New |
|---|---|---|
| src/basic/actions.ts:234 | "dropped N archive(s) and M other file(s). Extract the archives?" | computed plurals; "archive" singular when one |
| src/archive/selective-run.ts:140 | "(N path(s))" | computed plural |
| src/archive/mutations.ts:221 | "Added N file(s) to archive." (debug log) | computed plural |
| src/incoming-paths.ts:67 | "excess path(s) were not added" (activity log) | computed plural |
| src/incoming-paths.ts:182,246 | "Received N path(s)" (dev log) | computed plural |
| src/output-logging.ts:26 | "N line(s), M chars" (log entry) | computed plural |

### Path-count limits from MAX_ARCHIVE_PATHS

`MAX_ARCHIVE_PATHS` is 4096 in src/archive-rules.ts:43. Hard-coded copies are
replaced by the constant with `toLocaleString()`, the formatter already used in
src/archive/browse-ui.ts and src/archive/selective-tree-ui.ts.

| File:line | Old | New |
|---|---|---|
| src/basic/actions.ts:144 | "Selected the first 4,096 items" | `MAX_ARCHIVE_PATHS.toLocaleString()` |
| src/basic/wire.ts:176 | same literal | same |
| src/app-init.ts:627 | "Added the first ${MAX_ARCHIVE_PATHS}" (no separator) | toLocaleString |
| src/files.ts:198 | same | same |
| src/incoming-paths.ts:62,67 | same | same |
| src/archive-rules.ts:104 | "At most ${MAX_ARCHIVE_PATHS} paths" | toLocaleString |

The "N more were not added" tail is rewritten inline at each site as
`${rejected} more ${rejected === 1 ? "item was" : "items were"} not added`, so
"1 more item was not added" reads correctly. No new export is added to
src/archive-rules.ts, because several Vitest files mock that module with a
factory that only returns `MAX_ARCHIVE_PATHS`.

### Terms, case and format names

| File:line | Old | New | Rule |
|---|---|---|---|
| src/index.html:1104 | Browse (selective destination picker) | Choose… | picker button |
| src/index.html:1744 | Choose location | Choose… | picker button |
| src/index.html:2063 | Choose folder | Choose… | picker button |
| src/index.html:2601 | Browse (Power output picker) | Choose… | picker button |
| src/index.html:2649 | Browse (Power extract picker) | Choose… | picker button |
| src/index.html:1520, os-integration.ts:136 | Make Zinnia Default | Make Zinnia default | sentence case |
| src/index.html:253 | OS Integration (tab) | OS integration | sentence case |
| src/index.html:851 | Finder Services | Finder services | sentence case |
| src/index.html:898, os-integration.ts:373 | Reset Preferred Archiver to System Archiver | Reset preferred archiver to system archiver | sentence case |
| src/index.html:981, 1028 | View Open-Source Licenses / Open-Source Licenses | View open-source licenses / Open-source licenses | sentence case |
| src/index.html:1246 | Command Preview | Command preview | sentence case |
| src/index.html:2385,2427 | Preview Command | Preview command | sentence case |
| src/index.html:2318 | Archive Session | Archive session | sentence case |
| src/index.html:2361,2369 | Run Balanced / Run Ultra | Run balanced / Run ultra | sentence case |
| src/index.html:2393,2435,2477 | Repeat Last | Repeat last | sentence case |
| src/index.html:2403 | Extract Now | Extract now | sentence case |
| src/index.html:2469 | Switch to Extract | Switch to extract | sentence case |
| src/index.html:2995, debug-console.html:16,28,68 | Debug Console | Debug console | sentence case |
| src/power-events/settings.ts:183,189 | Reset Settings | Reset settings | sentence case |
| src/basic/actions.ts:562 | Password Required | Password required | sentence case |
| src/os-integration.ts:135 | Open Default Apps | Open default apps | sentence case |
| src/os-integration.ts:275,305 | Open Extensions… / Open Services… | Open extensions… / Open services… | sentence case |
| src/index.html:1837 | Split volumes (label) | Split into volumes | one term |
| src/index.html:1808, 2076 | Password (Basic compress and extract labels) | Archive password | one term |
| src/index.html:2071 | Password (Basic extract summary) | Archive password | one term |
| src/index.html:1156, 2934 | Password (Convert and Power compress labels) | Archive password | one term |
| src/index.html:689-693, 1148-1152, 1798-1803, 2554-2559 | zip, tar, gzip, bzip2, xz (option text) | ZIP, TAR, GZIP, BZIP2, XZ | format names in labels; option values unchanged |
| src/index.html:913, 1513 | Gzip/TGZ, Bzip2/TBZ2 in prose | GZIP/TGZ, BZIP2/TBZ2 | format names in prose |

The `zip` text inside `Compression level` and `Method` labels is not changed.
Option values (`value="zip"`, `value="gzip"`) are not changed.

Not changed: "Extract to", "Save to", "Change", placeholders "Select destination
folder", "Choose where to save" (placeholder text inside the destination row),
the "Enter password:" prompt label (quoted by six E2E and Vitest files), the
macOS and Windows pane names inside tooltips, and the "Extract selected" dialog
aria-label.

### Basic activity-log mentions

| File:line | Old | New |
|---|---|---|
| src/error-hints.ts:96,124 (shared fallback, Power and Basic) | "Check the activity log for details." | neutral text with no activity-log mention |
| src/basic/progress.ts:542,618 | same | same neutral text |

Power still sees the neutral text. The change is not mode-aware, which keeps
src/error-hints.ts free of workspace state imports.

### Dialog footers

| File:line | Change |
|---|---|
| src/index.html:1327-1331 (input modal) | Cancel moved before OK, OK gets `btn--primary` |

Handlers in src/prompt-modal.ts bind by id (`input-modal-confirm`,
`input-modal-cancel`), and the Skip button is inserted before Cancel by
`insertAdjacentElement`, so the DOM reorder does not change behaviour. The
selective-extract dialog and Convert dialog already have Cancel first.

### Other visible strings

| File:line | Old | New |
|---|---|---|
| src/ui/inputs.ts:356 | "⋯ Checking" | "… Checking" (single ellipsis character) |

## Failure modes

1. An E2E or Vitest assertion quotes an old string and fails after the change.
   Covered by: the updated assertions listed in the report, and `npm test` plus
   the E2E spec's own text reads.
2. A string used as a key or compared in code changes meaning. Checked:
   `SAFE_COPY_PROGRESS_LABEL` (not changed, see above), `text === "Error"`,
   `text === "Cancelled"`, `text === "Working…"` and `text === "Finalizing…"` in
   src/basic/progress.ts and src/extract-window/run-core.ts (not changed), and
   error-matching helpers in src/error-hints.ts (`looksLikeRaw7zOutput` matches
   7-Zip output, not the fallback text). Covered by: the existing Vitest suite
   and the E2E spec running in both workspaces.
3. The fallback sentence in src/error-hints.ts is matched by a test. Covered by
   the updated assertions, and by `npm test`.
4. A changed id or data attribute by accident. Ids are not changed. Covered by
   the E2E spec, which reads ids it already relies on (`#selective-browse-dest`,
   `#basic-choose-output`, `#output-path`, `#extract-path`) and checks the
   status pill ids.
5. `aria-label` and visible text diverge. Labels under "Browse", "Choose…" and
   "Preview command" are checked for visible text only; aria-labels that name
   the old term are left alone. Covered by the E2E text walk.
6. The OS integration pill shows the wrong class after status resolves.
   `setTriStatePill` removes all three status classes before setting one, and
   `setBadge` removes `--unknown`. Covered by the E2E spec: each pill has
   `--unknown` before the status resolves, and `--ok` or `--warn` after.
7. A reset path back to "Checking…" would show the old `--warn`. None exists in
   src/os-integration.ts, so no change is needed there.
8. Dialog reorder breaks Enter or Escape. Covered by the input modal's existing
   keyboard handlers, which bind by id. The E2E spec opens the Settings,
   Shortcuts and About surfaces and checks that the footer order is Cancel then
   primary.
9. The count helper prints "1 files". Covered by the E2E text walk (no "(s)"
   text in any dialog or page), by the shipped-markup check, and by the
   updated Vitest assertions in src/tests/output-logging.test.ts (now
   `/\d+ lines?, /`).
10. The `toLocaleString()` path count changes a test that quotes "4096". Covered
    by updating src/tests/archive-rules.test.ts:225.
11. The mixed-drop confirm dialog copy changes its OK label. The OK label is not
    changed.
12. A format name in an option value is capitalised by mistake, which would
    break a `value` sent to 7-Zip. Covered by leaving every `value="..."` alone.
