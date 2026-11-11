# Accessibility, input attribute and CSS failure inventory

This inventory was written before changing production code. It covers the
audit items B-11, C-29, C-30, C-33, C-34 and the `variables.css` part of C-46
in the frontend markup, styles and small status and log modules.

## B-11: Text inputs allow autocorrect, spellcheck and smart punctuation

Context: only `#basic-browse-password` sets `spellcheck="false"`. Path,
archive-name, extra-args, split-size, search and password inputs use the
WKWebView defaults, so typed text can change (smart dashes turn `--` into a
dash, autocorrect rewrites a visible password). Create fields must not offer
saved passwords with the wrong hint.

1. A fix that adds the attributes only to the static markup misses the
   password fields after "Show": the toggle code (`basic/actions.ts`,
   `ui/inputs.ts`, `prompt-modal.ts`) only changes `type`. The E2E must read the
   attributes after clicking each toggle, not before.
2. A toggle that recreates the `<input>` element would drop the attributes. The
   audited toggles only assign `input.type`; a later refactor that replaces the
   node must fail the E2E.
3. `autocorrect` and `autocapitalize` are not in the HTML attribute list that
   some validators know. A repository lint that rejects unknown attributes would
   fail the build. The attributes are needed for WebKit, so the check must not
   be relaxed to hide them.
4. `autocomplete="new-password"` on an extract or browse field would make the
   password manager offer to save a password that is only read. Only compress,
   Basic compress and the convert dialog are create fields.
5. `input-modal-field` is shared by the generic prompt and the password prompt.
   Its `type` changes at each open, so the attributes must be static in markup.
6. TypeScript-created inputs: none exist in the files this area owns, so no
   TS change is made for B-11. Dynamic inputs in other files must be checked by
   their owners.
7. The Convert dialog toggle (`convert-toggle-password`) has its listener only while
   that dialog is open, so the Show-toggle check cannot click it from the page at
   rest. `convert-password` is checked statically; the toggle code only sets
   `type`, so the attributes persist. Opening the dialog needs an archive convert
   action, which this spec does not drive.
8. Number inputs (`#threads`, `#s-threads`) are not text and are excluded. Adding
   spellcheck to them would be a no-op and would make the target list vague.

## C-29: Progress is announced every 75 ms

Context: `#progress`, `#status` and `#log` are polite live regions, and the
progress text is written for every backend tick (`setProgress` in
`archive/runtime.ts` and `archive/ops.ts`, both outside this area). A screen
reader reads every percent.

1. Removing `aria-live` from `#progress` alone silences the run. The run then
   has no announcement at all, so a separate polite announcer is required.
2. `#log` has `role="log"`, which implies `aria-live="polite"`. Removing the
   attribute keeps the implicit live region, so the explicit value must be
   `aria-live="off"`.
3. The announcer must receive the start, 25, 50, 75 and the finish, error or
   cancel. A milestone check that uses `>=` instead of a bucket can repeat 25
   on every tick between 25 and 49. Milestones are tracked per run.
4. A percent parsed from text is fragile. The text format is `${percent}%...`
   and the start may show "Still working..." with no percent. A parse failure
   must not announce, and must not throw.
5. A restart without a terminal status (cancel path that skips `setStatus`)
   leaves the milestone state stale. The next run would then announce nothing
   until 100. A percent lower than the last milestone must reset the state.
6. Terminal messages come through `setStatus("Done"|"Error"|"Cancelled")`, but
   `hideProgress()` is called before them in `ops.ts`. Clearing the run flag in
   `hideProgress` would drop the finish announcement, so only the terminal
   status clears it.
7. `#status` must keep announcing status changes. Only `setStatus` writes it,
   so the percent churn does not reach it. A regression would show up as the
   status text changing per tick.
8. The announcer element must not be `hidden` or `display: none`, or some
   screen readers skip the live update. It is visually hidden instead.
9. The E2E counts text changes of the announcer during a compress. Counting
   childList records would count the remove and add as two changes; the count
   must compare the text value.
10. A very fast compress may produce no percent at all. The assertion allows
    zero to six announcements and requires the run to end with a terminal one.

## C-30: Accessible names and list semantics

Context: Basic progress bars are labelled by a status text that changes
("Compressing..." and similar), so the name is not stable. `#input-list` has
`role="list"` with `div` children and no `listitem`. The two completion `<h3>`
titles are empty until a run finishes.

1. `aria-labelledby` pointing to the status text makes the bar name change
   during a run. A static `aria-label` avoids that, and the E2E must read the
   name through the same rule a screen reader uses (`aria-label` first).
2. The Basic tabs already have `aria-controls` and the panels already have
   `aria-labelledby` in this copy. A change here must not break those ids; the
   existing `basic-accessibility` unit test checks the progressbar markup.
3. `#input-list` items are `div` elements rendered by `ui/inputs.ts`, which is
   outside this area. Dropping `role="list"` and keeping the name with
   `role="group"` avoids a `listitem` mismatch without a TS change. If the
   owner later renders real `li` items, the role can return.
4. An `aria-label` on a generic `div` is not exposed. The group role is needed
   to keep the label.
5. The completion titles are filled by `basic/progress.ts`, which always
   writes `textContent`. Using `hidden` on the `<h3>` would hide the title
   forever, because that file does not un-hide it. Default text is used
   instead; the completion container is `display: none` until it becomes
   active, so the default text is not seen.
6. The default text must not be read as the outcome. "Compression finished"
   before a run is never shown, because the container is hidden.

## C-33: Density toggle and settings trigger semantics

Context: the density toggle is `aria-pressed` in markup, but `setUiDensity` in
`ui/workspace.ts` rewrites its label between "Compact" and "Comfortable". The
settings trigger has `aria-expanded` and `aria-controls`, which `settings.ts`
rewrites on open and close. The hidden debug toggle is an `img` with
`tabindex="0"`.

1. The label cannot be made stable from markup. `ui/workspace.ts` writes
   `textContent` on every call. This is a TS change outside this area and is
   reported, not made.
2. Removing `aria-expanded` from `#open-settings` markup is undone the first
   time the settings open or close, because `settings.ts`
   (`syncSettingsTriggerState`) writes it. Only the owner can remove that call.
   The E2E therefore checks `aria-haspopup` and the absence of `aria-controls`,
   not the absence of `aria-expanded` after a use.
3. `aria-haspopup="dialog"` on a trigger that opens a non-menu dialog is the
   right value. A value of `menu` would promise arrow-key semantics the dialog
   does not have.
4. The debug toggle's `click` and `keydown` handlers (`power-events/about-tools.ts`)
   stay on the element. `tabindex="-1"` keeps mouse focus and the click path.
   Keyboard users lose the hidden toggle, which is the intent.
5. Removing the element instead of hiding it from the tab order would break
   the five-click activation. `tabindex="-1"` is kept.

## C-34: Control border contrast and text below 12 px

Context: the input border token is `--border-strong` (8-14% alpha). The Basic
input border is `--border` (6-8% alpha). Both are roughly 1.1 to 1.6:1 against
the input background and the surrounding surface. Text is 10 px in some rules
and 11 px in others, including `--field-label-size` (11 px comfortable, 10 px
compact).

Contrast before and after. Computed for an input on `--surface-alt` inside a
`--surface` card, the border colour composited over its background:

| Theme | Token                      | Alpha | vs input bg | vs surface |
| ----- | -------------------------- | ----- | ----------- | ---------- |
| dark  | `--border-strong` (before) | 0.14  | 1.57        | 1.41       |
| dark  | `--border` (before)        | 0.08  | 1.27        | 1.14       |
| dark  | `--control-border` (after) | 0.40  | 3.67        | 3.30       |
| light | `--border-strong` (before) | 0.12  | 1.32        | 1.38       |
| light | `--border` (before)        | 0.06  | 1.14        | 1.20       |
| light | `--control-border` (after) | 0.46  | 3.46        | 3.64       |

0. In Basic mode `basic-glass.css` overrides every text, password, number input and
   select with `border: 1px solid var(--basic-glass-border) !important` (11% of
   the text colour). That is the border a Basic user sees, so the override uses
   `--control-border` too. A contrast check that reads only the power input
   passes while the visible Basic input still fails.
1. `--border-strong` and `--border` are used by cards, panels and dividers too.
   Raising them would make every panel outline heavy. A separate control token
   keeps the change to form controls.
   Measured in the E2E run after the change (computed style, worst case of the power and Basic inputs): dark 3.54 to 3.64 and light 3.45 to 3.47 against both the input and the surface.

2. The contrast must hold against both the input's own background and the
   outside surface. The E2E checks both.
3. The alpha must be applied in each theme block. Light has three selectors
   (explicit light, system light guard, and the shared root), so the new
   tokens must appear in each, or the system-light case stays at the old value.
4. Hover and focus must stay stronger than the rest state. `--control-border-hover`
   is above `--control-border` in both themes.
5. Raising text to 12 px can overflow compact rows (session cards, status bar,
   Basic labels). A layout regression is checked by the `ui-surfaces`, `main`
   and `settings-flows` runs, not by the contrast check.
6. The font-size check must read computed sizes, not the CSS source. `rem` and
   `var()` values resolve to px at runtime, and the 16 px root is an assumption.
7. Elements with no direct text (icons, SVG) are excluded from the size check.
   Hidden elements are checked too, since a hidden label becomes readable when
   its panel opens.
8. Kept tiny text: none. Every readable text rule is raised to at least 12 px,
   so no documented exception is needed.

## C-46 (variables.css part): duplicated light-theme tokens

Context: the light palette appears in `[data-theme="light"]` and again in
`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) }`.
Both selectors are needed for the cascade, because the explicit attribute must
win over the system dark preference and the media guard cannot apply to an
explicit attribute.

1. Moving a token into a shared `:root` block changes its cascade only if a
   theme block redefines it. The shared tokens are removed from every theme
   block, so no override remains.
2. The unit test `color-contrast.test.ts` reads `accent` and `text-on-accent`
   from the theme block by regex. Moving them to `:root` makes that read return
   undefined. The test must read the root block as well; only that expectation
   source changes.
3. The two light selectors cannot be merged. CSS has no selector that matches
   "system light and no explicit theme" without a media condition, and no media
   condition that matches an attribute. Only the shared tokens can be removed.
4. The dark-mode guard structure stays as it is.
5. `--control-border` tokens are per-theme and so remain in all three theme
   blocks. They are not shared.

## Deferred

Items that need a change outside this area (reported, not made):

- C-33 density label: `ui/workspace.ts` (`setUiDensity`) rewrites the label.
- C-33 `aria-expanded` on `#open-settings`: `settings.ts` (`syncSettingsTriggerState`).
