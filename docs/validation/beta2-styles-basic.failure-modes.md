# Beta 2 Basic styles failure inventory

This inventory was written before changing any stylesheet. It covers the Basic
workspace CSS for H7 (Browse layout), the Basic part of M16 (High Contrast
progress fill and Settings focus ring), the Basic part of M17 (disabled
controls), M20 (home drop target), M21 (Browse status states), the Basic toast
and skip link placement, the hooks added by earlier batches, and the removal of
dead Basic selectors.

Forced-colors and reduced-motion rules cannot be emulated in this WebDriver
harness. Those items are verified by reading the rules and are listed as
unverified at the end.

## H7: the Browse table wrap is the scroller and the actions stay visible

Context: `#basic-browse` is a column flex view with `overflow: hidden`. Its
`.basic-card` child has no `min-height: 0`, so the card cannot shrink below its
content. A 2,000-entry listing makes the card taller than the view, and the
"Extract all" and "Test integrity" buttons below it are clipped.

1. Making only `.basic-browse-table-wrap` scroll is not enough. The card must
   also be able to shrink (`flex: 1 1 auto; min-height: 0`), or the wrap still
   measures its full content height and never scrolls.
2. The Basic table renders at most 1,000 rows and then a notice row. A test
   that uses fewer rows could pass even with the bug, so the case builds a
   2,000-entry archive and asserts the summary reports 2000 files.
3. The window must be 500x650 during the check. The spec sets it in `before`
   and restores the starting size in `after`, so a failing case does not leave
   the window small.
4. The Cancel button is hidden when idle. The check must not depend on its
   visibility.
5. The password field is hidden by default. The header and actions must keep
   their natural height so the field cannot push the buttons out.
6. The check must read the button rectangles and the wrap scroll metrics
   together, so a view that is only clipped (not scrolled) fails.

Covered by: E2E case 1 (`Browse layout`).

## M21: Browse status line states

Context: `setBasicBrowseStatusMessage` in `src/basic/progress.ts` sets
`is-loading`, `is-success` or `is-error` on `#basic-browse-status`. No
stylesheet defined them, so an error looked like "Archive loaded".

1. The three states must differ from each other and from the idle line in
   computed color or border. If loading uses `--accent-fg`, it is close to
   `--danger-fg` in the Basic palette (both salmon), so loading uses the text
   color instead.
2. Error must not share success's color or background. The error state uses
   `--danger-fg`, `--danger-bg` and `--danger-border`.
3. The error banner adds padding and a border, which moves the status line
   down by a few pixels. The buttons below stay visible because the view has
   room for them (checked by case 1 in the idle state).
4. The rules are scoped to `.basic-browse-summary`, so Power browse is not
   affected.
5. Forced colors: the error border uses `ButtonText`. Unverified in the
   harness.

Covered by: E2E case 2 (computed color, background and border for each class,
and error against success).

## M17: disabled Basic controls do not light up on hover

Context: `.basic-btn[disabled]` dims the button, but the hover rules for
primary, secondary, ghost and danger still apply. The Basic global rule
`#app[data-workspace-mode="basic"] button { cursor: default !important }`
also overrides the disabled `cursor: not-allowed`.

1. `pointer-events: none` on disabled controls would hide their explanatory
   `title` (the Change save location and Change extract folder buttons are
   disabled with a reason in `title`). Disabled controls keep pointer events.
   The `.basic-home__link:disabled` rule that used `pointer-events: none` is
   changed too.
2. Every hover rule for a Basic control that can be disabled needs the
   `:not(:disabled)` guard: `.basic-btn` variants, `.basic-file-item__remove`
   (disabled while running), `.basic-password-toggle` (disabled without
   password support), `.basic-home__link` (disabled and `.is-disabled`), and
   the dropzone (`aria-disabled` plus `.is-disabled`, no native disabled).
   A missed rule leaves a lit hover on a disabled control.
3. The dropzone uses `aria-disabled` and the `.is-disabled` class, not the
   native `disabled` property, so its guard must use the class.
4. The guard must not change enabled hover. The enabled hover cannot be
   emulated in WebDriver, so this is verified by reading.
5. The disabled cursor override must beat the global `cursor: default
!important` rule. A selector scoped under `#app[data-workspace-mode="basic"]`
   with `!important` has higher specificity than that rule.
6. Toolbar tabs keep their existing `:hover:disabled` reset. The lock disables
   every `#basic-workspace button`, so toolbar `:disabled` rules are live.
7. Pressing a disabled button must not apply the `:active` scale. The `:active`
   rule is guarded with `:not(:disabled)`.
8. Pills are never disabled in `src/basic`, so no pill disabled rule is added.

Covered by: E2E case 3 (pointer events stay `auto`, the disabled button dims,
the cursor is `not-allowed`, and every Basic button hover rule in the
stylesheets excludes disabled buttons). Items 2 for the non-button controls,
4, 6 and 7 are verified by reading.

## M20: home drop target feedback wins over the glass rule and works with reduced motion

Context: `.basic-dropzone.is-drag-over` (0,2,0) lost to
`#app[data-workspace-mode="basic"] .basic-dropzone` with `!important` (1,2,0),
and to the glass hover rule. Under reduced motion the pulse is removed, so no
feedback was left.

1. The drag-over selector must outrank the glass base rule (`!important`,
   1,2,0), the glass hover rule (1,4,0 after the guard), and the native glass
   background rule (1,3,1). `#app[data-workspace-mode="basic"]
#basic-dropzone.is-drag-over` has specificity (2,2,0). A class-only selector
   at (1,4,0) would tie with the glass hover rule and lose on source order.
2. The `!important` on the drag-over border and background is required to beat
   the glass `!important` base declarations. The box-shadow ring stays
   non-important so the pulse animation can still run.
3. The pulse animation must not be the only feedback. Its border and background
   change is static, so under `prefers-reduced-motion: reduce` the animation is
   removed and the border and background change remains.
4. The drag-over state must still win while the pointer hovers the dropzone.
5. The TS guard in `handleBasicDragDrop` already refuses to add the class while
   the Basic interaction lock is active, so the CSS does not need a disabled
   guard.
6. The whole-workspace drag target (`.basic-workspace.is-drag-over`) is not
   changed.
7. Forced colors: the existing `border-color: Highlight` for drag-over is kept.
   Unverified in the harness.

Covered by: E2E case 4 (computed border or background differs with and without
`is-drag-over`). Reduced motion and native glass are verified by reading.

## M19: Basic settings overlay respects the startup banner

Context: the Basic `#settings-overlay` was `position: fixed` at the viewport top
(32px or 38px for the titlebar). The startup recovery banner sits above `#app`,
so with the banner visible the fixed overlay covers the banner and the window
controls. 4S2 made the Power overlays absolute inside `.app`, which is
`position: relative`, so the banner pushes them down.

1. The Basic overlay must be `position: absolute` with `top: 0` and bottom, left
   and right set to 0, so it is measured from `.app` and not the viewport.
2. The platform titlebar offsets (32px Windows and Linux, 38px macOS) stay, so
   the window controls in the titlebar strip are not covered.
3. The viewport height calc is removed. A `100vh` height would extend past the
   bottom of `.app` when the banner takes space, and the Save footer would move
   out of the 500x650 window.
4. The stale `.setting-divider` rule was already removed in the dead CSS pass.

Covered by: E2E case 9 (overlay position is absolute, its top is at or below the
banner bottom, and Save is inside the 500x650 window while the banner is shown).

## Basic toast placement

Context: `.toast-region` is `position: fixed; bottom: 16px; right: 16px`, and
it is appended to `<body>`, a sibling of `#app`. At 500 px it covers the full
width Run button in the sticky action bar.

1. The toast region is not inside `#app`, so the Basic scope must be
   `body:has(#app[data-workspace-mode="basic"])`. Scoping on `#app` alone
   matches nothing.
2. A bottom offset that sits above the action bar would depend on the action
   bar height, which changes with progress and completion. The region is
   anchored below the header instead (`top: 46px`), which is always above the
   sticky action bar in a 500x650 window.
3. A long stack of toasts must not reach the action bar. The region gets
   `max-height: 40vh` and `overflow-y: auto`. Those alone do not scroll: the
   toasts are flex items of a column region, and `overflow-y: auto` on each
   toast makes its automatic minimum height 0, so they shrink to fit the region
   and nothing overflows. Each Basic toast gets `flex-shrink: 0`, so it keeps
   its natural height (capped by its own `max-height`) and the stack overflows
   the region. The case checks that the region scrolls and that every toast is
   at least its natural height.
4. The region keeps `pointer-events: none`, so the gaps do not block clicks.
   Toast items keep their own pointer events, and a wheel over a toast scrolls
   the region.
5. An empty region has zero height, so the case injects a toast fixture with
   the same markup as `src/toast.ts`. The check is meaningful only with a
   toast present. The fixture is removed in `finally`.
6. A visible sticky toast can cover the Basic tab row until it is dismissed.
   This is accepted; it is a transient overlay.
7. The Power workspace is unaffected because the rule is scoped to the Basic
   body. Verified by reading.

Covered by: E2E case 5 (the region's bottom is above the action bar's top, and
its height is bounded).

## Skip link visible above the Basic header

Context: `.skip-link` is a body child with `z-index: 10000`. The Basic header is
`position: absolute; z-index: 10000` inside `#app`, and it comes later in the
DOM, so it paints over the focused skip link.

1. The fix must raise the skip link only under the Basic scope. The Power
   layout has no overlapping header, so the change is scoped to
   `body:has(#app[data-workspace-mode="basic"]) .skip-link:focus` with
   `z-index: 10100`, above the Basic header (`.header`, `z-index: 10000`).
2. The app window has no OS focus during E2E (`document.hasFocus()` is false),
   so `:focus` never matches and real focus cannot be produced. The check does
   not depend on focus. It reads every `.skip-link:focus` rule from
   `document.styleSheets` whose selector, with `:focus` removed, matches the
   link in the current workspace (so the Power scope is not picked up in
   Basic). It inserts those declarations at the end of the loaded stylesheet with
   `insertRule` (the app CSP blocks inline `<style>` elements), reads the
   link's computed box and stacking, then deletes the inserted rules.
3. The header is `pointer-events: none`, and `elementFromPoint` skips elements
   with that property, so the check sets `pointer-events: auto` on `.header`
   inline for the probe and restores it afterwards. The link must then be the
   top element at its centre, which is a paint-order test.
4. The link's computed `z-index` must exceed the header's, and its rect must lie
   inside the window (top at or above 0, bottom at or above the window height).
5. The probe asserts that at least two focus rules apply and that the computed
   `left` is `8px`, so the copied declarations are the focus rules and not the
   hidden base rule.
6. The real `:focus` paint path (a focused link in a focused window) is verified
   by reading the rules, not in the harness.

Covered by: E2E case 6 (two or more focus rules apply in Basic, `left` is 8px,
the link is inside the window, its z-index beats the header, and
`elementFromPoint` at its centre returns the link with the header made hit-test
visible).

## Hooks added by earlier batches

### `.header-recent__name` and `.header-recent__folder`

1. `.header-recent__item` is a button with a name span, a text node and a
   folder span. Left as `display: block`, the spans sit inline and the folder
   cannot ellipsize separately. The Basic scope uses a flex row.
2. Both spans need `min-width: 0`, `overflow: hidden`, `text-overflow: ellipsis`
   and `white-space: nowrap` to stay on one line.
3. The folder text is 12px, the floor that audit-a11y enforces for every text
   node. The hierarchy comes from the name's weight (600) and the folder's
   secondary color, not from a smaller size. Both must share the first line.
4. The rules are scoped to Basic because the Recent control is hidden in Power.

Covered by: E2E case 8 (single-line height, both inside the item, folder font at
least 12px, and a weight or color difference between name and folder).

### `#basic-update-indicator`

1. The indicator is hidden with the `hidden` attribute. `[hidden] { display:
none !important }` in `src/styles/main-pre.css` keeps it hidden, so the
   sizing rule is guarded with `:not([hidden])` to avoid any display override.
2. The size matches the other Basic header buttons (30px high, 0 8px padding,
   0.75rem font).
3. `white-space: nowrap` keeps the label on one line in the header.
4. The header at 500 px shares 350 px between the Basic/Power switch, Recent,
   the indicator, Support and Settings. Overflow with all of them visible is
   not measured by this batch and is listed as a residual risk.

Covered by: E2E case 7 (30px high and displayed while not hidden, `display:
none` while hidden).

### `.basic-completion__path`

1. The element has `max-width: 100%` with 6px and 8px padding under
   content-box sizing, so it is 16 px wider than its container. `box-sizing:
border-box` fixes the overflow. JS already truncates the text.
2. `white-space: nowrap` stays, so the path cannot wrap.

Covered by: reading only. The completion path is not in the E2E cases.

### Save to and Extract to rows

1. This batch does not change `.basic-destination*` rules. The existing
   `beta2-basic-destination` layout case at 500x650 covers the fit and
   ellipsis.

## Dead Basic CSS (item 9)

Removed, each with no match in `src/index.html`, `src/extract.html`, or any
`classList`, `className`, `id` or template string in `src/` outside tests:

1. `.basic-step-number` (`basic-chrome-forms-buttons.css`).
2. `.basic-field-grid` (`basic-chrome-forms-buttons.css`) and its
   `@media (max-width: 560px)` rule (`basic-chrome-browse-actions.css`).
3. `.basic-back-link`, `.basic-back-link::before`, `.basic-back-link:hover`
   (`basic-chrome-home-dropzone.css`).
4. `.basic-step-card`, `.basic-step-head`, `.basic-step-head h3`,
   `.basic-step-head p` (`basic-chrome-home-dropzone.css`).
5. `.setting-divider` inside the Basic settings modal (`basic-settings-modal.css`).
6. `.basic-toolbar__tab.is-disabled`, `.basic-toolbar__back.is-disabled`, and
   their `[aria-disabled="true"]` and hover forms (`basic-chrome-browse-actions.css`).
   Nothing sets `is-disabled` or `aria-disabled` on toolbar tabs. The
   `:disabled` forms stay, because the interaction lock disables them.

Kept on purpose, because they are reached by dynamic class names or by
`classList.toggle`:

- `.basic-progress__percent`, `.basic-progress__eta`, `.basic-progress__file`
  and their `:empty` forms (built from `basic-progress__${part}` in
  `src/basic/progress.ts`).
- `.basic-completion--success`, `--error`, `--cancelled` (built from a tone map).
- `.basic-destination__path.is-placeholder` (set in `src/basic/sync.ts`).
- `.basic-progress__bar-fill.is-determinate` (set through `src/progress-bar.ts`).

Covered by: a static scan of the selectors against the frontend sources, run
before and after the edit. There is no runtime test for dead CSS.

## E2E coverage

`e2e/specs/beta2-styles-basic.spec.js` covers:

1. Browse layout: a 2,000-entry archive at 500x650 keeps "Extract all" and
   "Test integrity" inside the viewport, and the table wrap scrolls
   (`scrollHeight > clientHeight`) (H7).
2. Browse status states: loading, success and error have different computed
   colors and borders, and error differs from success (M21).
3. Disabled button: pointer events stay `auto`, the disabled button dims, the
   cursor is `not-allowed`, and the hover rules for Basic buttons exclude
   disabled buttons (M17).
4. Drop target: `is-drag-over` changes the computed border and background of
   `#basic-dropzone` (M20).
5. Toast placement: the Basic toast region's bottom is above the sticky action
   bar's top, the region scrolls, and each toast keeps its natural height
   (item 6).
6. Skip link: the focus rule for the link applies in Basic without OS focus,
   the link is inside the window, its z-index beats the header, and it is the
   top element at its centre (item 7).
7. Update indicator: 30px high while visible, `display: none` while hidden
   (item 8).
8. Recent entry: name and folder share one line, the folder is at least 12px,
   and the name differs from the folder by weight or color (item 8).
9. Settings overlay: with the startup recovery banner shown at 500x650, the
   Basic settings overlay is absolute inside the app shell, starts below the
   banner, and keeps Save inside the window (item M19).

Each case starts in the Basic workspace with toasts dismissed. Cases that need
an archive or a compress input clear the inputs first. Each writes evidence with
`writeEvidence`.

## Unverified in this harness

- Forced colors: the progress fill (`background: Highlight !important`), the
  Settings input focus ring (`outline: 2px solid Highlight`), the error status
  border (`ButtonText`), and the drag-over border in High Contrast.
- Reduced motion: the drag-over pulse is removed while the border and
  background change stays.
- Enabled hover rendering, because hover cannot be emulated.
- Real `:focus` on the skip link: the app window never has OS focus in E2E, so
  the skip link's focus rule is verified by reading and by the copied-rule
  probe in case 6.
- Native glass drag-over (`html[data-window-fx="basic"]`).
- Header overflow at 500 px with the update indicator and Recent both visible.
- Banner overlap with the Settings overlay in High Contrast or other platforms
  than the one the run uses.
