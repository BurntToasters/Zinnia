# Beta 2 main-window markup failure inventory

This inventory was written before changing markup or TypeScript. It covers the
M14 markup for the progress announcer and the Basic update indicator, the
accessible names of the Basic archive cards, the orphan Options label, the
live-region audit, the dead compression method options, the shortcuts dialog
workspace filter and the confirm message id.

Test map:

- E1: `#progress-announcer` outside hidden chrome, and text during a Basic compress.
- E2: Basic archive card names (Extract and Browse) include the file name.
- E3: no PPMd, BZip2 or Zstandard option in `#method` or `#s-method` for any format the Format select offers.
- E4: shortcuts dialog rows follow the workspace in which it opens.
- E5: no `aria-live` on bulk containers, and short status lines keep theirs.
- E6: `#basic-update-indicator` exists, is a hidden named button in the header strip.
- E7: Power Options group is named by its caption, and the confirm message id exists.
- V1 (Vitest, `src/tests/beta2-ui-markup.test.ts`): `renderShortcuts` workspace filter and the open-time render. E4 covers the same behaviour in the GUI, but the GUI suite runs after this worker, so V1 gives an immediate check.

Spec: `e2e/specs/beta2-ui-markup.spec.js`. Existing specs that quote this markup
are listed at the end.

## M14a: `#progress-announcer` leaves the statusbar

Context: the announcer sits inside `<footer class="statusbar">`, which
`#app[data-workspace-mode="basic"] .statusbar` hides. Basic users get no
screen-reader progress.

1. The announcer stays inside the footer. Basic progress is silent again.
   Covered by E1 (`insideStatusbar` false, no hidden ancestor in Basic).
2. The announcer is moved into `#basic-workspace` or the Power `.grid`, so it is
   hidden in one workspace. Covered by E1 (hidden-ancestor walk in Basic and in Power).
3. A second `#progress-announcer` is left behind. `getElementById` then returns
   the first, possibly hidden, copy. Covered by E1 (`count` is 1).
4. `role="status"`, `aria-live="polite"` or the `sr-only` class is dropped.
   Covered by E1 (role, live and class asserted).
5. The element takes layout space or becomes visible. Covered by E1 (bounding
   box at most 1 px square).
6. `ui/status.ts` writes to a different element, so a Basic compress produces
   no text. Covered by E1 (MutationObserver during a 16 MiB compress; at least one
   non-empty change). The same contract is also checked by the existing
   `audit-a11y` case that counts at most six changes per compress.
7. The announcer moves into `<body>` before `#app` and a skip-link or CSS rule
   that targets `body > *` changes. Not covered by E1. The element is absolutely
   positioned, so layout is unaffected. Visual check deferred to batch 4.

## M14b: `#basic-update-indicator`

Context: Basic folds the chrome into the header strip (`.header__actions`).
The footer indicator is invisible in Basic. The button is hidden by default and
3C wires it to updater.ts.

1. The id is missing or renamed, so 3C cannot wire it. Covered by E6 (exists, count 1).
2. The button is visible at startup without an update. Covered by E6 (`hidden` true
   and computed display `none`).
3. The `.btn` display rule beats the `hidden` attribute, so a hidden button shows.
   Covered by E6 (computed display). The global `[hidden]` rule in `main-pre.css`
   uses `!important`, so this should not happen.
4. The element has no accessible name (empty text). Covered by E6 (text non-empty).
5. The element is outside the Basic header strip, so Basic never shows it.
   Covered by E6 (`closest(".header__actions")`).
6. The element has no `type="button"`. Covered by E6.
7. The element is shown in Power as well, next to `#update-ready-indicator`, so
   there are two indicators. Not covered by an automated test. 3C must decide
   when to show it (Basic only). Reported to the manager.
8. The label text falls below 12 px. Covered by the existing `audit-a11y`
   text-size case (`.btn--sm` is 0.75rem, which is 12 px).
9. The click handler is not wired. Not covered here. 3C owns the wiring.

## A11y1: Basic archive card names

Context: `#basic-extract-archive-info` and `#basic-browse-archive-info` are
`role="button"` cards with `aria-label="Choose archive to extract"` and
`"Choose archive to browse"`. The aria-label hides the archive name. No TypeScript
sets an aria-label on these cards (checked across `src/`), so the markup change
is sufficient.

1. The aria-label stays, so the name has no file name. Covered by E2 (name
   includes `hello.7z`).
2. The name is built from the name and meta spans. The file name must still be
   present when the meta text is empty or changes. Covered by E2 (inclusion check).
3. Removing the aria-label breaks the card as a button (role or tabindex lost).
   Covered by E2 (role `button`, tabindex `0`). Enter and Space handling in
   `basic/wire.ts` is unchanged, and `main.spec` clicks the cards.
4. A later TypeScript change sets an aria-label that hides the name again. Not
   covered by a test. Noted here for future batches.
5. The in-page name approximation (aria-labelledby, then aria-label, then text)
   is not the platform accessibility tree. E2 is a regression guard, not a
   screen-reader proof.

## A11y2: Orphan Options label

Context: `<label>Options</label>` in the Power "Security and extras" section
labels no control.

1. The caption stays orphaned, so the three checkboxes have no group name.
   Covered by E7 (group `role="group"` named by the caption text `Options`).
2. The `aria-labelledby` points at a missing id, so the group is unnamed.
   Covered by E7 (resolved text equals `Options`).
3. The caption loses its look because the element type changes. The element
   stays a `<label>`, so `.field label` still styles it. Not covered by a test.
   No CSS is edited.
4. The checkboxes stop toggling. Not changed by this markup. Covered by the
   existing settings and Power flows that use `#update-mode` and `#encrypt-headers`.

## A11y3: Live-region audit

Every `aria-live` in `src/index.html` was reviewed. Kept or removed:

Removed (bulk or long text filled at once):

- `#licenses-list` (licenses are loaded as one list). Covered by E5 (attribute absent).
- `#os-archive-default-list` (default-app rows are filled from the OS in one pass). Covered by E5.
- `#command-preview-text` (one long command in a `<pre>`). Covered by E5.

Kept (short status lines or explicit off):

- `#status` (statusbar line). Covered by E5 (still polite).
- `#progress-announcer` (moved, still polite). Covered by E1 and E5.
- `#os-integration-help` (one status sentence). Covered by E5 (still polite).
- `#selective-summary` (one summary line). Covered by E5 (still polite).
- `#convert-output-name` (one output name). Kept, not in E5.
- `#convert-error` (`role="alert"`, error text). Kept.
- `#startup-recovery-banner` (`role="alert"`). Kept.
- `#quick-action-feedback` (one feedback line). Kept, not in E5.
- `#basic-browse-summary`, `#basic-browse-status`, `#browse-summary` (short summaries, `aria-atomic`). Kept.
- `#basic-compress-progress`, `#basic-extract-progress` (`role="status"` panels that hold the bar, the status label and a detail block). Kept. The per-tick detail is marked `aria-live="off"` by `basic/progress.ts`. Whether that suppresses ticks inside a polite parent is not verified here. Noted as a risk, not changed.
- `#basic-compress-completion`, `#basic-extract-completion` (short completion card). Kept.
- `#log` and `#debug-console-log` (`role="log"`, explicit `aria-live="off"`). Kept off. The explicit off overrides the implicit polite of `role="log"`. Not in E5 (they are not polite before or after).

Regression risks:

1. A removed live region is re-added by a later edit. Covered by E5 (attribute absent).
2. A kept status line loses its live attribute. Covered by E5 (`status`,
   `os-integration-help`, `selective-summary`, `progress-announcer` polite).

## M-method: Dead compression method options

Context: the UI cannot drive PPMd, BZip2 or Zstandard (see `src/archive/args.ts`
and `src/presets.ts`). The options are removed from `#method` (Power) and `#s-method`
(Settings > Compression). The Format selects keep their bzip2 option, which is a real format.

1. One of the three options is left behind in `#method` or `#s-method`. Covered by
   E3: the case switches every format the Format select offers, on both selects,
   and fails on any removed method. The per-format lists are written to evidence.
2. The per-format filter in `presets.ts` or `settings.ts` re-adds a removed method
   for one format. Covered by E3 (the sweep covers every format, and `#s-method`
   must follow the format it was set to).
3. bzip2 is removed from the Format selects by mistake. Covered by E3 (`formats`
   in the sweep must still list bzip2).
4. The sweep leaves the Format or Settings format changed. Covered by E3
   (`restoredFormat` must equal `originalFormat`).
5. A saved or preset value of `ppmd`, `bzip2` or `zstd` makes the select empty.
   Not covered here. `presets.ts` and `settings-model.ts` belong to worker 3D,
   which migrates the values. Reported to the manager.
6. `src/tests/setup-dom.ts` still lists `ppmd` and `bzip2` in its test-only
   `METHOD_OPTIONS`. The app is not affected. Not changed (not markup).

## S-shortcuts: Shortcuts dialog shows the current workspace only

Context: `renderShortcuts()` rendered every row once at wiring time, so the
Power dialog showed Basic rows and the reverse. The fix renders the rows for
the workspace that is active when the dialog opens. Rows tagged `all` stay in
both. The `?` trigger and its guards are unchanged.

1. Rows render only at wiring time, so a workspace change leaves stale rows.
   The fix renders on every open. Covered by E4 (two opens in different
   workspaces in one session) and V1 (open-time render after a dataset change).
2. The `all` rows are dropped. Covered by E4 (Run, Settings, Esc, ?, tabs
   present in both) and V1.
3. The filter reads the wrong workspace (for example, a missing dataset). The
   fallback is Basic, matching `getWorkspaceMode`. Covered by V1 (power and basic
   cases) and E4.
4. A Basic-only row appears in Power, or a Power-only row appears in Basic.
   Covered by E4 (no `basic` rows in Power, no `power` rows in Basic).
5. `?` stops opening the dialog in Basic. Covered by E4 (`?` dispatched in Basic).
6. The `?` guards change (opens over another dialog). Not changed. The existing
   `power-helpers` and `settings-flows` specs cover the guards.
7. The no-argument `renderShortcuts()` contract changes. Covered by the existing
   `src/tests/shortcuts.test.ts`, which is kept unchanged.
8. Focus no longer returns to the trigger after close. Not changed. Existing
   keyboard specs cover Esc.
9. `ui-surfaces.spec.js` case "lists Basic and Power rows in the keyboard shortcuts
   modal" encodes the old behaviour and will fail after this change. It is not
   owned by this worker and is reported to the manager.

## C-confirm: Confirm-dialog message id

1. The confirm message element has no id, so 3C cannot point `aria-describedby`
   at it. Checked: `#input-modal-label` already exists in `index.html` and
   `confirmChoice` writes the message into it. No markup change is needed.
   Covered by E7 (`input-modal-label` id is present).

## Existing checks that quote this markup

- `e2e/specs/audit-a11y.spec.js`: announcer count (at most six changes per compress),
  `role="status"` and `aria-live="polite"` on the announcer, Basic progress bar names,
  control contrast and the 12 px text-size rule. The announcer is found by id, so the
  move does not break it. `#basic-update-indicator` uses `.btn--sm`, so it passes the 12 px rule.
- `e2e/specs/audit-copy.spec.js`: aria-expanded, aria-haspopup and aria-pressed on
  triggers. Unaffected.
- `e2e/specs/main.spec.js`: clicks `#basic-extract-archive-info` and
  `#basic-browse-archive-info` and reads the name spans by id. Ids are unchanged. Unaffected.
- `e2e/specs/audit-tools.spec.js`: context menu on `.statusbar`. The footer stays. Unaffected.
- `e2e/specs/audit-presets.spec.js`: reads `#command-preview-text` text. Unaffected.
- `e2e/specs/ui-surfaces.spec.js`: the shortcuts case expects Basic and Power rows in
  one dialog. It will fail after S-shortcuts. Reported.
- `src/tests/basic-accessibility.test.ts`: string checks on `index.html`. All still hold.
