# Large listing, picker and input removal failure inventory

This inventory was written before changing production code. It covers the
large-archive picker cost (M11 picker), the input removal cost (M11 inputs),
the listing folder flag (suspected), the picker empty messages, and the Browse
"Show 1,000 more" control. Files: `src/archive/listing.ts`,
`src/archive/selective-tree-ui.ts`, `src/archive/browse-ui.ts`,
`src/selective-extract.ts`, `src/ui/inputs.ts`.

Test key: `E2-n` is a case in `e2e/specs/beta2-fe-large-listing.spec.js`
(E2-1 picker timing, E2-2 input removal, E2-3 folder flag and no button on a
small listing, E2-4 picker empty messages, E2-5 Power Show 1,000 more, E2-5b
Basic Show 1,000 more). `VT-n` is the nth group in
`src/tests/beta2-fe-large-listing.test.ts`: VT-1 to VT-4 are the four folder
flag tests in file order, VT-5 is the check-state group, VT-6 is the
`selectEntries` group. "Existing" names a current test that already guards the
behaviour.

## L-1: Listing folder flag precedence (listing.ts)

Context: each `-slt` record sets `Folder = +/-` and may also have an
`Attributes` line. Today the `Attributes` line writes `isFolder` after the
`Folder` line, so a later `Attributes` line lacking `D` can clear a folder.
Probe result: the bundled 7-Zip always prints `D` for ZIP and tar folder
records (ZIP `Folder = +` always came with `Attributes = D...`; tar folder
records have no `Attributes` line), so the defect is not reachable through the
real sidecar for those formats. It is reproduced with hand-written `-slt`.

1. A record with `Folder = +` followed by `Attributes = A ...` must be a
   folder. Today it is a file. VT-1 must fail before the fix.
2. A record with `Folder = -` followed by `Attributes = D ...` must be a file.
   `Folder` is authoritative whenever present. VT-2.
3. The reverse order must not matter: `Attributes = A` before `Folder = +`
   must still give a folder. VT-3.
4. A record with no `Folder` line keeps the fallback: `Attributes = D` is a
   folder and `Attributes = A` is a file. VT-4 and existing
   `src/tests/archive.test.ts` "parses real 7-Zip 26.03 ... Attributes folders".
5. Fields a backend worker removes (`CRC`, `Created`, `Accessed`, `Host OS`,
   `Characteristics`, `Comment`, `Offset`, `Volume Index`, `Version`) must not
   be read by the parser. The parser keeps only the keys it reads today. Existing
   archive tests run the same listing shape.
6. A real ZIP folder entry without the DOS directory bit (dosAttributes 0x20)
   must still show as a folder in Browse and in the picker. This is a guard
   because the bundled 7-Zip already reports it as a folder. E2-3.
7. `Encrypted`, `Method` and `zipCrypto` handling must not change. Existing
   archive tests for encryption detection.

## P-1: Per-render folder check states (selective-extract.ts, selective-tree-ui.ts)

Context: `refreshRenderedRows` runs on every checkbox click and re-applies every
rendered row. Each folder row calls `computeNodeCheckState`, which walks that
folder's whole subtree. The cost is rows x subtree size for each click.
`computeNodeCheckStates` computes all states in one post-order pass over the
tree.

1. A folder with children is `checked` when every leaf is selected,
   `unchecked` when none is, and `indeterminate` when mixed. VT-5 compares every
   node against `computeNodeCheckState` over several trees and selections.
2. A leaf or empty folder uses its own selection only. An empty folder must not
   become `indeterminate`. VT-5 includes an empty folder.
3. A toggle must recompute states before rows are re-applied. A stale map would
   leave a parent checkbox one click behind. E2-1 reads the folder checkbox
   `checked` and `indeterminate` after a folder click and after Select all.
4. Expanding a folder re-renders from the full tree. A folder whose members sit
   under a collapsed grandchild must still show the right state. VT-5 covers
   nested depths. Existing `selective-extract.test.ts` computeNodeCheckState
   cases.
5. Rows from an earlier render must not read states from another tree. States
   are passed into each refresh call, never stored on a row closure. Residual
   risk: low, because a re-render replaces every row.
6. Cost: states are computed once per click and once per render, not once per
   row. E2-1 bounds the folder click and Select all at 1,500 ms each on a
   40,200-entry ZIP.
7. `computeNodeCheckState` keeps its signature and results (it delegates to the
   new function). Existing `selective-extract.test.ts` cases.

## P-2: Select all reuses the listing tree and an indexed membership (browse-ui.ts, selective-tree-ui.ts, selectEntries)

Context: Select all currently calls `collectRenderedSelectiveScope`, which calls
`buildEntryTree` again. `selectEntries` then scans the whole scope for each
folder target, and `isPathWithinFolder` normalizes the folder with a regex on
each call. With many rendered folders that is quadratic.

1. Tree mode Select all must select only rendered rows and the full subtree of
   each rendered folder, including collapsed folders. Existing
   `audit-picker.spec.js` "extracts exactly the files under a folder toggled
   while collapsed" and `archive-flow.test.ts` (Select all in a collapsed tree).
   E2-1 also checks the selected count equals the listing count.
2. Search mode Select all must touch only visible search results. Existing
   `archive-flow.test.ts` search Select all. VT-6 checks `selectEntries` with a
   visible-only scope.
3. `selectEntries` must equal the union of `getRecursiveSelectionPaths` over the
   targets. VT-6 covers prefix collisions (`docs` and `docs2`), a folder entry
   with a trailing slash, Windows separators, and an empty folder that falls back
   to its own path. VT-6 is a characterization test written before the change.
4. Select all must reuse `model.tree` and must not call `buildEntryTree` again.
   Not observable in E2E. Code review and the E2-1 time bound.
5. Select none (`clearPickerSelection`) must not rebuild the tree. The render path
   already reuses `model.tree`. Existing `archive-flow.test.ts` clear checks.
6. A re-browse of the same archive must not reuse a stale tree. The listing
   model is still keyed by the entries array identity. Existing
   `archive-flow.test.ts` re-browse cases.

## I-1: Input removal validates only unknown paths (inputs.ts)

Context: `renderInputs` treats any change to `state.inputs` as a new validation
round and sends every path to `validate_archive_paths`. One removal from 500
inputs sends 499 paths. The fix validates only paths whose cached state is
`unknown`, merges results into the cache, and keeps the request-id guards.

1. Removing one of 500 inputs does not rebuild the list after a validation round
   trip. The old code re-renders the list when validation returns. E2-2 marks the
   first row in the same task as the removal click, waits 5 s, and requires the
   marker to survive. Wrapping `window.__TAURI_INTERNALS__.invoke` was tried and
   dropped: it does not reach the app's bound invoke. Residual risk: a validation
   round trip longer than 5 s would not be detected, and the old code was not run.
   The removal render itself is bounded at 1,500 ms.
2. Cached badges of the remaining inputs stay `Valid` or `Invalid`. None
   reverts to `Checking`. E2-2 waits for no `unknown` badge after the removal.
3. A newly added input is validated and gets a result. E2-2 adds one input and
   checks its badge resolves.
4. A late response from a superseded request must not overwrite results. The
   request-id guard stays. Existing validation race cases in `archive-flow.test.ts`.
5. A late response must not bring back a removed path. Results are written only
   for keys still in the cache. Residual risk: this path is reached only by a
   response that arrives after removal, and no E2E can reliably produce it.
6. A path that is still `unknown` (in flight) is included in the next request, so
   a superseded request cannot leave it at `Checking`. Residual risk: covered by
   reading the code, not by a test.
7. A mode change still re-validates every input. The cache is cleared on mode
   change. Existing `archive-flow.test.ts` mode-switch cases.
8. A validation IPC failure leaves the paths `unknown`, and the next render
   retries them. This matches the current behaviour. Existing
   `basic-recent.test.ts` and `archive-flow.test.ts` failure cases.
9. Batch 1 changes in `inputs.ts` (password reset on input change, browse secret
   forget listeners, `state.inputs` passed to extract autofill) stay in place.
   Existing `basic-ui.test.ts`, `ui.test.ts` and `archive-flow.test.ts` run
   against them.

## E-1: Picker empty messages (selective-tree-ui.ts)

Context: the picker prints "No archive entries match this search." for every
empty list, including an archive with no entries.

1. An archive with no entries and no search shows "This archive has no entries."
   E2-4 (empty archive).
2. A search with no matches shows "No entries match your search." E2-4 (search).
3. An empty archive with a non-empty search shows the archive message. The archive
   check runs first. Logic only: an empty archive cannot match a search.
4. The summary text does not change for either case. Existing
   `archive-flow.test.ts` summary assertion ("0 selected · 1 row shown ·
   1 archive entry").
5. Non-empty results never show an empty message. E2-1 and E2-5 read the list
   with rows present.

## B-1: "Show 1,000 more" in Browse (browse-ui.ts)

Context: Power Browse (`browse-tbody`) and Basic Browse (`basic-browse-tbody`)
both call `renderBrowseRows`. Each shows the first 1,000 rows and a notice row.
The button goes in that notice row, and rows are inserted before it, so the
notice stays last. The button uses the existing `btn btn--sm` class, because
`btn-secondary` does not exist in this codebase. No CSS change.

1. The button appears only when entries exceed 1,000. A three-entry archive
   has no notice and no button. E2-3 asserts this.
2. Each click appends exactly the next 1,000 rows, with no duplicates or gaps.
   E2-5 counts data rows: 1,000, then 2,000, then the full listing count.
3. The notice text updates to "Showing the first 2,000 of N entries." E2-5.
4. The notice row stays the last row of the table after each append. E2-5.
5. The button is hidden when every row is shown, and the notice reads
   "Showing all N entries." E2-5 loops clicks until the button is hidden.
6. While rows remain, focus stays on the button. E2-5 focuses the button, clicks
   it, and checks `document.activeElement`.
7. When the button hides, focus moves to the first appended row, which gets
   `tabIndex = -1`. E2-5 checks the active element is a table row.
8. Appended rows get lucide icons. E2-5 checks no `i[data-lucide]` remains in the
   table after an append.
9. Basic Browse works the same way and keeps the notice without the search
   suffix. E2-5b.
10. Up to 1,000 rows, the existing "Archive is empty." row and the one-entry table
    are unchanged. Existing `archive-flow.test.ts` single-row browse assertion.
11. The shown count is local to each render. A new browse starts at 1,000.
    Residual risk: covered by code review, because each render builds a new
    closure.
12. The Basic and Power counters are separate, so a click in one does not change
    the other. Residual risk: each table has its own closure.
13. Enter and Space activate a native button and fire `click`, so keyboard
    activation uses the same handler. E2-5 uses `click()`.

## Cross-cutting

1. No code comments in new or changed code. `npm run lint:comments` covers it.
2. No em dash. `npm run validate:no-em-dash` covers it.
3. No CSS or markup changes outside the listed owned files. `git diff` covers it.
4. The E2E spec runs under the GUI suite that the manager runs. This worker did
   not run it. `node --check` only proves it parses. Residual risk until the
   manager's GUI run.
