# Selective picker and activity log failure inventory

This inventory was written before changing production code. It covers C-28
(keyboard focus in search mode), C-44 (selective picker rebuild cost and
sorting), C-43 (activity log and debug console append cost), and the
remaining IME part of B-10 (Enter in the picker tree).

## Search-mode focus after a toggle (C-28)

In search mode the picker shows a flat list. Toggling a row re-renders the
whole list, and the old focus restore only looked for `role="treeitem"` rows,
so focus fell back to the document body and keyboard users lost their place.

- The fix must restore focus after a full re-render for flat rows as well as
  tree rows. A test that only checks the checkbox state would miss a lost
  focus.
- The replacement row must be found by its archive member path, not by
  index. Index lookup jumps to a neighbour once the result list changes.
- When focus was on the row's checkbox, restore the checkbox. When focus was
  on a tree row, restore the row. Restoring the wrong kind of element breaks
  Space toggling for the next key press.
- Focus restore must not run when the focused member no longer appears in
  the list (for example after the query changes). Falling back to the first
  row would steal focus from the search field the user is typing in.
- Toggling in place (no rebuild) keeps focus on the same element, so an
  in-place update must not replace the row or checkbox that holds focus.
- Flat rows need `data-member-path`. Without it the restore cannot identify
  the row, and the E2E helpers cannot address search results.
- Restoring focus in a microtask must not move focus after the user has
  already moved on to another element.

## Activity log append cost (C-43)

`log()` appends with `textContent +=` and then re-splits the whole text to
trim it. Each line costs O(total text). The trim must still keep the newest
lines and the cap must still apply.

- Line counting must match what the user sees. A message fragment can contain
  embedded newlines, so counting messages instead of lines lets the log grow
  past the cap.
- Trimming a partially removed text node must cut at a line boundary.
  Cutting by character count leaves half a line at the top of the log.
- The tracked nodes must be resynchronised when other code clears the
  element. `power-helpers.ts:63` and `power-events/session.ts:46` set
  `textContent = ""` directly. A stale count then trims too early, or never.
- A `textContent` assignment from `renderDockedFromBuffer` or the debug seed
  path replaces all child nodes. The same resync must cover this.
- The cap changes from 999 to 1,000 visible lines. The old split-and-join
  kept the trailing empty string as a line, so a steady log held 999 real
  lines. Document the change and make the E2E assert the exact count.
- Scroll position must still follow the newest line when the log is at the
  bottom, and the existing `scrollTop` update must not be dropped.
- Local-log persistence (`persistLocalLog`) must still receive each message
  once, with the same redaction and fragment chunking.
- The debug console (`debug-mode.ts` `debugLog`) and the popped-out window
  (`debug-console-window.ts`) must keep the same line cap as before, 1,000.
- `copyDebugConsole` reads `lineBuffer`, not the DOM, so the DOM change must
  not alter the buffered line list.

## Picker rebuild and filter cost (C-44)

Every toggle, expand and search keystroke rebuilt the entry tree, filtered
all entries, re-detected separators and rendered up to 1,000 rows. Toggles
and keystrokes must produce the same selection as before.

- A cached tree or filter result must be keyed on the listing identity and
  the query. A cache keyed only on the archive path can keep a stale tree
  after a re-browse.
- `buildEntryTree` can throw for hostile depth or path length. The throw must
  still happen before the modal opens, so the browse error path still shows
  its toast. A cache must not store a partial result on throw.
- An in-place checkbox refresh must update every rendered row, including the
  indeterminate state of folders whose descendants are outside the rendered
  rows. Refreshing only the clicked row leaves ancestors wrong.
- The summary line counts shown rows. After an in-place refresh the shown
  count must still come from the rendered row list, not from the filter
  result.
- The 1,000-row cap and its notice must stay. Rows past the cap must not be
  rendered by the in-place path either.
- `resolveSelectiveExtractMemberPaths` must keep its exact semantics. Folder
  paths with children are dropped. Empty folders are kept so 7-Zip creates
  them. A folder with a trailing separator must not count itself as a child.
  A root folder with an empty normalized path must not match everything.
- A linear prefix count must not count the target entry as its own child.
  Duplicate archive paths must count once.
- Numeric-aware sorting (`numeric: true`) changes only order. It must not
  change which members are selected, and `sensitivity: "base"` must still
  place folders before files.
- The debounce for search input must stay at or below about 150 ms. It
  already exists in `browse-ui.ts` (120 ms, not an owned file). Adding a
  second debounce in `power-events/selective-modal.ts` would double the delay.
- A pending debounced render must not run after the picker closes. The
  existing timer clear in `closeSelectiveExtractModal` covers this, so the
  owned code must not schedule a new timer.
- Select-all and clear (in `browse-ui.ts`) still call the full render. The
  in-place path must not leave their results stale.

## Enter during IME composition (B-10, picker part)

The tree keydown handler calls `checkbox.click()` on Enter. An IME that uses
Enter to confirm a candidate must not toggle a row.

- `isImeComposing` checks `isComposing` and `keyCode === 229`. Checking only
  `isComposing` misses WebKit events that report the 229 key code.
- Space must keep toggling when it is not composing. Blocking the whole
  handler during composition would also block arrow navigation, which is not
  part of the fix.
- The ignored Enter must not call `preventDefault`, so the IME still receives
  the key.

## Deferred

- Expand and collapse still do a full re-render of up to 1,000 rows. Only
  toggles use the in-place path. Expansion changes which rows exist, so an
  incremental insert is a larger change than this fix needs.
- The browse table keeps archive order and does not sort names in the
  frontend. The numeric sort applies to the picker tree only.
- Real Space and Enter delivery is not exercised by the E2E. Local macOS runs
  are backgrounded (`hasFocus()` is false), so WebDriver keystrokes never reach
  the checkbox. The focus test focuses the row by script and toggles with
  `checkbox.click()`, which runs the same change handler. Key-level coverage
  needs a foreground run (`ZINNIA_E2E_FOREGROUND=1`).
- The debounce for search input stays at 120 ms in `browse-ui.ts` (not an owned
  file). The brief asked for about 150 ms; 120 ms was left in place.
