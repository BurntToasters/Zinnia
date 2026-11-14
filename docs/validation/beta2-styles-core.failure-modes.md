# Main-window and quick-extract style core failure inventory

This inventory was written before changing the stylesheets. It covers the
shared main-window (Power and Basic) and quick-extract styles: toasts, High
Contrast, disabled controls, overflow, overlays under the startup banner,
contrast and size lows, picker selection, and token and dead-CSS cleanup.

The cases are in `e2e/specs/beta2-styles-core.spec.js`. Cases 1a to 7 are
E2E checks against the running app. Forced-colors and reduced-motion rules
cannot be emulated in this harness. Those rules are verified by reading the
CSS and are marked "read-verified" below.

## Toasts (case 1a, case 1b)

Context: error toasts are no longer dismissed by a body click, so the
pointer cursor on the toast body is wrong. `box-shadow: var(--shadow)` is
invalid because `--shadow` is a colour, so the shadow never renders. A long
error grows without bound.

1. Removing `cursor: pointer` from `.toast` must not remove the pointer from
   the close and copy buttons. Case 1a reads `.toast-message` and the toast
   cursor and expects not `pointer`. The buttons keep `cursor: pointer`
   (read-verified in `.toast-dismiss` and `.toast-copy`).
2. A real `box-shadow` must not be clipped by an ancestor. `.toast-region`
   has no overflow clip, so the shadow paints. Case 1a expects the computed
   `box-shadow` not to be `none`.
3. `max-height` on `.toast` with `overflow-y: auto` makes the toast scroll.
   The copy and close buttons sit at the top of the flex row, so they scroll
   away with long text. That is accepted, and the message stays readable.
   Case 1b checks the cap, the vertical overflow and the scroll height.
4. `overflow-y: auto` computes `overflow-x` to `auto` as well. A long
   unbroken message would then scroll sideways. `.toast-message` uses
   `overflow-wrap: anywhere`, and case 1b checks `scrollWidth <= clientWidth`.
5. `toast.test.ts` reads the first `.toast {` rule and requires
   `background: var(--surface)`. The new declarations must stay in that
   rule, and `.toast--success` and `.toast--error` must keep their
   `background-image` form. Covered by `npm test` (unit test, not E2E).
6. `.toast-copy` reuses `.btn--ghost`, so its hover background is the ghost
   hover. Focus must still show an outline. Read-verified only.
7. `.toast-count` must stay at 12 px or larger, because the audit-a11y
   text-size case fails below that. It uses opacity, which can reduce
   contrast. Read-verified only.
8. Forced colours keep the toast's 2 px `ButtonText` border (read-verified).
   Forced colours cannot be emulated in this harness.

## High Contrast: segmented and settings tabs active state (read-verified)

Context: under `forced-colors: active` the active segment and the active
settings tab keep their accent background, which the system forces to the
canvas colour. Their active state is then invisible.

1. The forced rule must use system colours (`Highlight` and `HighlightText`)
   on `.segmented__btn.is-active` and `.settings-tab.is-active`. A plain
   colour is overridden by the forced palette and does not help.
2. Specificity: `.segmented__btn.is-active` must beat the titlebar forced
   rule `.segmented__btn { border }` and the base `.segmented__btn` colour.
   The class pair (0,2,0) placed inside the forced media query satisfies
   this.
3. `.settings-tab.is-active` in forced colours must beat the titlebar forced
   `.settings-tab` border shorthand. It uses (0,2,0) against (0,1,0).
4. Focus rings must stay visible on the active state. The existing
   `:focus-visible` outlines are not changed.
5. `forced-color-adjust` must not be set to `none`, or the system colours
   would be ignored. It is not set anywhere in the owned files.

## Reduced motion: quick-extract indeterminate bar (read-verified)

Context: `.extract-progress-fill.is-indeterminate` is (0,2,0). The reduced
motion rule `.extract-progress-fill { animation: none }` is (0,1,0), so the
indeterminate class keeps the animation under `prefers-reduced-motion`.

1. The reduced-motion rule for `.extract-progress-fill.is-indeterminate`
   must use the same (0,2,0) selector and sit later in the source so that it
   wins.
2. The static indeterminate state must not look like a determinate 0%
   bar. It uses a fixed 40% width offset to 30% so the progress is visible.
3. Determinate states are not affected. `.is-determinate` already sets
   `animation: none !important`, and the `pct-N` classes set width with
   `!important`, so the static width cannot override them.
4. The error fill keeps `width: 100%` and its own `animation: none`.

## Disabled controls: hover suppression and the title (case 2)

Context: `.btn:disabled { pointer-events: none }` hides the explanatory
`title` that os-integration.ts sets on disabled buttons, because the
browser never hit-tests the element for a tooltip.

1. Removing `pointer-events: none` must keep a disabled `.btn` tooltip-able.
   Case 2 checks computed `pointer-events` is not `none` and that the
   `title` is intact.
2. A disabled `.btn` must not fire clicks. The `disabled` attribute still
   blocks click events in the browser, and case 2 checks `disabled` stays
   true for the node under test.
3. `cursor: not-allowed` must be applied to the disabled `.btn`. Case 2
   checks the computed cursor.
4. Hover suppression for disabled variants: `.btn--primary:disabled:hover`
   and the other variant rules are (0,3,0), so they beat the variant hover
   rules (0,2,0). A variant rule placed before the generic one would lose.
   Hover cannot be forced in this harness, so the hover look is read-verified.
5. Titlebar buttons get `inert` during a modal, not `disabled`. The inert
   hover suppression uses `[inert] .titlebar-btn:hover` at (0,3,0), and the
   close button needs `!important` because `.titlebar-btn--close:hover` uses
   `!important`. Read-verified: a modal must be open and the pointer over the
   control.
6. The extract window `.btn:disabled` rules are read-verified. No quick-extract
   case in this spec opens a disabled extract button.

## Status bar: long names (case 3)

Context: a 300-character name with no spaces has a min-content width equal to
its length, so the flex item pushes the platform and version labels past the
window edge. The Basic workspace hides the status bar
(`basic-chrome-hide-titlebar.css`), so case 3 runs in the Power workspace.

1. `min-width: 0` on each `.statusbar__item` lets the item shrink below its
   content width. Case 3 checks `status.scrollWidth > status.clientWidth`
   (the text overflows and is clipped) with `text-overflow: ellipsis`.
2. `overflow: hidden` and `white-space: nowrap` on the item keep the bar
   height fixed. A wrapped name would add a second line and push the window.
3. `overflow: hidden` on `.statusbar` keeps the bar from scrolling
   horizontally. Case 3 checks `documentElement.scrollWidth <= innerWidth`.
4. `.statusbar__item` also covers the update-ready button. It can now shrink
   and clip. Read-verified only: the indicator is hidden at this width.
5. The version and platform labels must stay on screen. Case 3 checks their
   right edge is inside the window.

## Overlays under the startup banner (case 4)

Context: the startup banner is in body flow above `#app`. Modal overlays are
`position: fixed` with `top: 32px` (Windows and Linux) or `38px` (macOS), so
with the banner showing the overlay starts above the banner bottom and over
the titlebar window controls.

1. Changing `.modal-overlay` to `position: absolute` moves its containing
   block to `.app`, which is `position: relative` and sits directly below the
   banner. The existing `top` offsets then count from below the banner, with
   no new variable and no TypeScript change. Case 4 checks overlay top is at
   or below the banner bottom.
2. The overlay must still clear the titlebar. Case 4 checks overlay top is at
   or below the titlebar bottom when the titlebar is visible.
3. The overlay must still cover the window to the bottom edge, including the
   status bar that is inside `.app`. Case 4 checks overlay bottom is at or
   past the window bottom minus one pixel.
4. `.setup-wizard-overlay` gets the same change. It is not shown in this
   harness (the wizard appears only before setup completes). Read-verified.
5. The banner stays interactive above modals (`keepInteractiveDuringModal` in
   utils.ts), and its z-index (10060) is above the overlay (10050). Unchanged.
6. Basic workspace: `#settings-overlay` in basic-settings-modal.css is
   `position: fixed` with its own `top: 32px` (Windows) and full-window size.
   The Basic Settings overlay still starts under a visible startup banner.
   That file belongs to 4S1 and is reported, not changed here. Case 4 runs in
   the Power workspace for this reason.
7. Basic `#input-modal-overlay` (basic-glass.css) sets only background, so
   its position change is read-verified only.

## Contrast and size lows

1. License text: raising `.license-card__text` from 11 px to 12 px can wrap
   more lines inside its `18rem` cap. The text is scrollable. Read-verified
   only, because the licenses list renders only after it is opened.
2. "Checking..." status pills: the markup in `src/index.html` gives them
   `status-pill--warn`. CSS cannot target them by text, so this needs a markup
   change to `status-pill--unknown`. Reported, not done here.
3. Extract window input border: `.extract-input-field input` moves from
   `--border-strong` to `--control-border`, which matches the main window
   input token. Read-verified only: the quick-extract input is not in the main
   window cases.
4. Dark primary hover: `--accent-hover` in the dark block moves from `#268cdb`
   (3.59:1 with white) to `#0878d0` (4.56:1 with white, computed from the
   WCAG relative luminance). Values lighter than `#0878d0` but still at or
   above 4.5:1 do not exist near the accent, so the hover is now almost the
   same colour as the rest state, and its feedback comes from the border and
   shadow. The token is also read by `.btn--close:hover` in extract.css and
   by the basic-* stylesheets (not owned here). Case 6 measures the ratio
   from computed colours.
5. Power settings tabs below 520 px: `.settings-tabs` gets `overflow-y: auto`
   so the list stays reachable, and the scrollbar is the cue. A visible
   scrollbar takes 8 px of the 175 px column. Read-verified only: window height
   is not changed in this harness.
6. The fade cue was not added: a bottom mask would also fade the column
   background. The scrollbar is the cue.

## Picker selected rows (case 5)

Context: `selective-tree-ui.ts` adds `is-selected` to rows whose checkbox is
checked, but no style matched it.

1. `.selective-row.is-selected` must set a background that is not
   `rgba(0, 0, 0, 0)`, and it must differ from an unselected row. Case 5 reads
   both states from the same row.
2. The selected rule must come after `.selective-row:hover` at equal
   specificity, so a selected row keeps its selected colour under the pointer.
3. The forced-colours rule uses `Highlight` and `HighlightText`. The meta
   text needs its own `HighlightText` because its colour is forced. Read-verified.
4. Tree depth padding is set by `.selective-row--tree[data-depth]`. The new
   rule sets background only, so the padding is unchanged.

## Tokens and duplicate rules

1. The light-theme tokens are defined in `[data-theme="light"]` and in
   `@media (prefers-color-scheme: light) :root:not([data-theme="dark"])`.
   A single block cannot cover explicit light and OS-light automatic because
   the media condition cannot be part of a selector list. It needs
   `light-dark()`, which older WebKitGTK builds may lack. Not merged. The
   colour-contrast unit test still parses the `[data-theme="light"]` block
   by its selector text, so that block must keep that form.
2. `.visually-hidden` and `.sr-only` move into one rule in `main-pre.css`.
   `.sr-only` gains the `!important` padding and border reset that
   `.visually-hidden` already had. Case 7 compares the computed boxes of
   `#progress-announcer` (`.sr-only`) and the `h1.visually-hidden`.
3. `extract.css` keeps its `.visually-hidden` rule, because `extract.html`
   uses only that class. The duplicated titlebar rules stay in `extract.css`,
   because `extract.html` loads only `extract.css`, not `titlebar.css`.
4. Token removal: no CSS custom property in the owned files is unread. A
   scan of every `var(--name)` and `getPropertyValue` call in `src/` found no
   unread definition. Nothing was removed.

## Dead CSS (change 9, no E2E case)

Removed because no element or TypeScript class name matches (the scan read
`index.html`, `extract.html`, `debug-console.html` and every non-test `.ts`):

1. `settings.css`: `.setting-divider`, `.about-heart`.
2. `main-base.css`: `.btn.btn--explorer`, `.platform-windows .btn.btn--explorer`,
   `.platform-linux .btn.btn--explorer` (and the `.sr-only` block, merged into
   `main-pre.css`).
3. `main-mid-wizard-settings.css`: `.setup-wizard-btn-wide`, `.settings-group`,
   `.settings-group legend`, `.settings-actions`.
4. `main-mid-browse-icons.css`: `.cursor-default`.

Kept after review:

1. `.list__item-badge--unknown`, `--valid`, `--invalid`: built by
   `inputs.ts` from `InputValidationState`.
2. `.toast--success`, `.toast--error`: built as `toast toast--${kind}`.
3. `.pct-0` to `.pct-100`: built as `pct-${clamped}` in `progress-bar.ts`.
4. `.settings-actions--left`: used by `setting-actions settings-actions--left`.
5. Read-verified keep: `.debug-console__*` and `.debug-console-window__*`
   in the debug window.

Reference in a file I do not own: `basic-settings-modal.css:219` targets
`.setting-divider`. Nothing matches it, and it is 4S1's file. Reported.

## Not verifiable in this harness

1. Forced-colours and reduced-motion rules (sections above, read-verified).
2. Hover visuals for disabled buttons and the inert titlebar.
3. Setup-wizard overlay position.
4. Power settings tab layout below 520 px height.
5. Light-theme token merge (not done; see Tokens section).
