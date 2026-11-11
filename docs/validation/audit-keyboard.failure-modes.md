# Keyboard, dialog layering and toast failure inventory

This inventory was written before changing production code. It covers audit
items B-09, B-10, C-24, C-31, C-32, C-35, C-36 and C-37. The E2E cases live in
`e2e/specs/audit-keyboard.spec.js`.

## B-09: Esc closes a dialog and also navigates Basic to Home

Context: `power-events/keyboard.ts` closes the top dialog on Esc. The Basic
handler in `basic/keyboard-events.ts` runs on the same document and sends
Basic to Home when no `.modal-overlay` is visible. Toasts and the Recent menu
are not modal overlays, so Esc there reaches Basic as well.

Fix shape: a shared `markKeyHandled(event)` / `isKeyHandled(event)` pair in
`utils.ts`, backed by a WeakSet. Every Esc consumer that closes something marks
the event. The Basic handler and the Power handler return early on handled
events. The Recent menu listens in the capture phase on `document`, so it marks
before the Basic bubble listener runs. Toast listeners sit on the toast element,
which runs before any document listener.

Ways the fix could fail or regress:

1. Ordering: a document-level bubble listener marks too late. If Basic runs
   first, it sees no open overlay and navigates Home. Recent must therefore use
   capture, not bubble.
2. Marking without consuming: a closing handler marks the event but a later
   handler that does not check the flag still acts. Basic and Power must both
   check first.
3. Over-marking: an Esc with nothing to close is marked anyway. Basic then
   stops working for Esc that should still return Home, and the Esc-blurs-input
   path breaks. Mark only when a close actually happens.
4. Double close: a toast Esc with Settings open closes both the toast and
   Settings. The Power handler must skip handled events.
5. The wizard overlay returns early on Esc. It must still mark the event so
   Basic does not navigate underneath it.
6. Prompt modal (`promptInput`, `confirmChoice`): Esc must still cancel and
   must not leak to Basic. The modal overlay check already covers Basic, but the
   mark keeps the rule uniform.
7. Non-Esc keys must not be affected. Only Esc sets the flag.
8. A marked event must not be re-marked or un-marked by a later handler. The
   WeakSet has no unmark path; no code should rely on one.

## B-10: Enter runs an operation during IME composition

Context: Enter during Japanese, Chinese or Korean composition confirms the
candidate. `keydown` for that Enter has `isComposing === true` in WebKit and
`keyCode === 229`. The Basic Enter-to-run shortcut and the prompt modal's Enter
handler did not check either.

Fix shape: `isImeComposing(event)` in `utils.ts` returns
`event.isComposing || event.keyCode === 229`. Every Enter handler in files this
area owns calls it first. The Basic Enter-to-run shortcut is limited to text
inputs (types text, search, url, tel, email, password, number).

Ways the fix could fail or regress:

1. Missing `isComposing` on a synthetic event: tests that construct
   `KeyboardEvent` without the property get `undefined`. The helper must coerce
   to boolean and treat `undefined` as false.
2. Blocking a normal Enter: `keyCode` is deprecated but still 13 for normal
   Enter. The check must be `=== 229`, not truthiness.
3. Restricting Enter too far: the Basic shortcut must still run from a text
   field (the archive-name input). Checking `instanceof HTMLInputElement` with a
   type list is required, not a `tagName` test that drops every input.
4. Checkbox or select Enter must not run. A checkbox that is focused and Enter
   pressed must not click Run.
5. Enter on a button or link still activates that control natively. The Basic
   handler must not also click Run.
6. Ctrl+Enter / Cmd+Enter global shortcut: it also must ignore composing events.
7. Esc during composition cancels the IME candidate window. Closing a dialog on
   that Esc is a related bug but is not part of this item. It is recorded under
   Deferred.

## C-24: formatSize returns "NaN undefined", "-" for zero

Context: `formatSize(0)` returned "-", so a 0-byte file looked like a folder.
Negative and fractional input produced "NaN undefined" or wrong units.

Fix shape: 0 returns "0 B". Fractional input is rounded to the nearest byte.
Only negative, NaN, or non-finite input returns "-".

Ways the fix could fail or regress:

1. Rounding 0.4 to 0 must give "0 B", not "-".
2. Rounding 0.5 up to 1 must give "1 B".
3. Negative values, NaN, Infinity, and -Infinity must return "-", not a unit.
4. Very large values must keep the TB cap (index clamped to 4).
5. Callers that show "-" for folders: `archive/browse-ui.ts` and
   `archive/selective-tree-ui.ts` check `isFolder` before calling. Verified
   read-only, so no caller relies on `formatSize` for the folder dash.
6. Totals: `browse-ui.ts` formats totals. A zero total now reads "0 B" where it
   read "-". That is intentional.

## C-31: Recent menu has no arrow-key navigation or focus management

Context: `basic/recent.ts` marks buttons with `role="menuitem"` but has no
arrow keys, no focus on open, and no focus restore on close. Opening by mouse
on WKWebView does not focus the trigger, so keyboard users cannot reach the
items.

Fix shape: ArrowDown/ArrowUp move between items (wrapping). Home/End jump to
the first and last. Opening focuses the first item. Esc closes and returns
focus to the trigger. Arrow keys are handled on the `#header-recent` wrapper so
they work from the trigger too.

Ways the fix could fail or regress:

1. Focus on open races the async refresh. Focus must move only after the menu
   is actually shown, not while the list is still pending.
2. Esc with focus on the trigger, or elsewhere, while the menu is open must still
   close it. Esc with the menu closed must not be marked (see B-09 item 3).
3. Arrow keys must `preventDefault` so the page does not scroll.
4. Focus restore on Esc must not run when the menu closes by outside click or by
   choosing an item.
5. Choosing an item must still call the handler. Renaming or re-rendering the
   list must not lose the handler.
6. An empty list hides the wrapper and closes the menu. No focus call must
   target a hidden element.
7. Tab leaves the menu. The menu may stay open with focus outside, and a later
   Esc must still close it without navigating Basic.

## C-32: Keyboard Shortcuts and Licenses open over other dialogs

Context: native menu items call `openShortcutsModal` and `openLicensesModal`
with no check. The Esc handler checks Licenses first, then Settings, Selective,
Command preview and Shortcuts. A Shortcuts sheet opened over Settings therefore
closes Settings first on Esc, which is the wrong order.

Decision (simpler correct option): Keyboard Shortcuts does nothing when another
dialog is open. This matches the `?` key guard. Licenses already stacks
correctly: it is checked first in the Esc order, so it always closes first.
`licenses.ts` is not owned by this area and needs no change.

Ways the fix could fail or regress:

1. The guard must ignore the Shortcuts overlay itself. A repeated open call
   must not block when it is already visible.
2. The guard must include the setup wizard overlay, which is not a `.modal-overlay`
   by class in every state.
3. A menu open that is silently ignored leaves no visible response. This is an
   accepted trade-off; the user closes the other dialog first.
4. Licenses opened over Shortcuts: Esc closes Licenses first, then Shortcuts.
   This must stay true.
5. The trigger for Shortcuts (`shortcutsTrigger`) must not be overwritten by an
   ignored open call.

## C-35: Timed toasts cannot be dismissed from the keyboard

Context: only sticky toasts (duration 0) had a Dismiss button and an Esc
handler. Timed toasts are focusable (`tabIndex = 0`) but ignored Esc.

Fix shape: every toast gets a focusable Dismiss button and an Esc handler on
the toast element. Esc marks the event (B-09) and dismisses.

Ways the fix could fail or regress:

1. Focus inside a timed toast must keep the auto-dismiss timer paused (the
   existing focusin/focusout logic). The Esc handler must not disturb that.
2. Dismissing a toast removes the focused element, so focus falls to `body`.
   This is accepted; focus is not moved elsewhere. Recorded under Deferred.
3. `dismissToasts()` in `e2e/helpers/ui-driver.js` selects `.toast-dismiss`.
   Adding the button to timed toasts changes what that helper clicks. That is an
   improvement, not a break.
4. Clicking the Dismiss button must not also trigger the toast's click-to-dismiss
   twice. The button stops propagation.
5. Esc with a timed toast focused must not also close a dialog underneath. The
   toast marks the event first.

## C-36: trapFocus picks a hidden or disabled element for initial focus

Context: `trapFocus` used `container.querySelector(FOCUSABLE)`, which returns the
first match in DOM order even if it is hidden or disabled. The Tab cycle used a
visibility filter but not the disabled check.

Fix shape: one helper, `isFocusCandidate(el)`, requires that the element is
laid out (`offsetParent !== null`) and not disabled. Initial focus and Tab
cycling both use it.

Ways the fix could fail or regress:

1. Some elements are position fixed, so `offsetParent` is `null` even when
   visible. The existing Tab cycle already has this limit. This change must not
   make it worse for the initial focus target, and the note stays in code.
2. If no candidate is visible, initial focus must not throw. It is a no-op.
3. `summary` and `a[href]` have no `disabled` property. The helper must check
   the property with a type guard, not assume it exists.
4. Tests that stub `offsetParent` with `Object.defineProperty` must keep
   working.
5. Programmatic-only focus targets (`tabindex="-1"`) are excluded from the
   FOCUSABLE selector and must stay excluded.

## C-37: Toast text overflows and sticky toasts stack without limit

Context: toast text ignores the `\n` separators many messages use. Windows
paths have no break opportunities, so they overflow the 360 px toast. Sticky
toasts were never capped.

Fix shape: `.toast-message` gets `white-space: pre-line` and
`overflow-wrap: anywhere`. At most three sticky toasts are visible. Adding a
fourth dismisses the oldest sticky one.

Ways the fix could fail or regress:

1. `pre-line` keeps newlines but collapses runs of spaces. Messages that rely
   on double spaces lose them. Accepted.
2. The cap counts only sticky toasts that are not already leaving. A toast
   that is fading out must not count, or the newest toast is dismissed too.
3. Dismissing the oldest must use the same dismiss path (timers cleared,
   removal scheduled). Removing the node directly leaks the timer.
4. Timed toasts are not counted and not capped. A flood of timed toasts still
   stacks until they expire. Recorded under Deferred.
5. Truncation (`MAX_TOAST_CHARS`) still applies before display.
6. The toast-in animation and reduced-motion rules are unchanged.

## Deferred

- Esc during IME composition (B-10 item 7): not changed. Closing a dialog on
  the composition-cancel Esc is a separate defect.
- Focus after a keyboard dismiss (C-35 item 2): focus returns to `body`.
- Timed toasts are not capped (C-37 item 4).
- Title bar and header stay clickable under modal sheets (C-32). This is
  intentional in `keepInteractiveDuringModal` and was not changed.
