# Beta 2 main-window chrome failure inventory

This inventory was written before changing production code. It covers the
beta 2 chrome items M7 (unreadable settings file overwritten), M9 (Basic window
taller than the work area), M12 (toast body click, copy and duplicates), M14
(Basic update indicator), the updater stage messages, header inertness under
modals, the Settings live-preview leak, the confirm dialog description, the
two once-only failure toasts, and the dead exports in the owned files.

Owned files: `src/toast.ts`, `src/updater.ts`, `src/utils.ts`,
`src/ui/workspace.ts`, `src/ui/status.ts`, `src/settings.ts`,
`src/prompt-modal.ts`, and the drag-drop catch in `src/app-init.ts`.

## M7: a failed settings load must not be overwritten by automatic saves

Context: `loadSettingsWithMetadata` returns defaults when `load_settings`
fails or the file is malformed. Automatic working-context saves then write the
defaults over the user's real file about 140 ms later.

1. A failed load leaves automatic writes allowed. The queued working-context
   write (`queuePersistWorkingContext`) must not schedule a timer while the file
   is unreadable. Covered by Vitest `beta2-fe-chrome.test.ts` (automatic block)
   and E2E `beta2-fe-chrome.spec.js` case 5 (automatic toggle leaves the raw
   file unchanged).
2. A debounced timer scheduled before the state changes must re-check at fire
   time. Covered by the same Vitest case (advance timers after the queue call).
3. The malformed-JSON branch of `parseSettingsRaw` also returns `malformed`. If
   only the invoke failure branch sets the flag, a corrupt file is still
   overwritten. Covered by E2E case 5, which uses an unparsable seed.
4. The wizard path calls `saveSettings` directly, and presets and the debug
   toggle go through `persistSettingsImmediately`. Without a gate in
   `saveSettings`, the wizard still replaces the file silently. Covered by
   Vitest (an explicit save asks first; decline writes nothing).
5. The Settings Save button must not replace the file without telling the user.
   The replacement confirm must appear before the write. Covered by E2E case 5
   (confirm with describedby) and Vitest (Save guard: no Save listener call
   until confirmed).
6. Declining the replacement confirm must keep the Settings edits. A rollback
   would reset the modal fields. The Save guard stops the click before the Save
   handler runs, so the modal keeps its values. Covered by Vitest (decline does
   not reach the Save listener) and E2E case 5 (decline leaves the file bytes
   unchanged).
7. The replacement permit is one-shot. A leftover permit would let a later Save
   replace the file without a confirm. The permit is taken synchronously in
   `persistSettingsImmediately`, and the guard clears any leftover after the
   synthetic click. Covered by Vitest (a second Save asks again).
8. After a successful explicit write the file is readable again. The unreadable
   flag must clear, or automatic saves stay blocked for the rest of the session
   after a legitimate recovery. Covered by Vitest (writes resume after replace).
9. A failed explicit write after confirmation must keep the file unreadable.
   Covered by Vitest (a failed write keeps the block).
10. The user-visible message is the existing startup banner. Its text now says
    automatic saves are paused. The existing "disk unavailable" cause must
    still be in the text. Covered by `settings-io.test.ts` (unchanged
    expectation) and Vitest (paused wording).
11. E2E `audit-settings.spec.js` case "recovers from an unparsable
    settings.json" now meets the replace confirm. That spec is outside this
    worker's files and must answer the confirm (`queueConfirmResult(true)`)
    before its Save click. Reported to the manager, not changed here.

## M9: Basic window fits the work area

Context: Basic locks 500x650 with resize disabled. On a 1366x768 display at
125% scale, or 1080p at 175%, the action bar falls below the visible area.

1. A short work area must reduce the height, not the width. Covered by Vitest
   `beta2-fe-chrome.test.ts` (availHeight 574 gives 500x574).
2. A tall work area must keep 650. Covered by Vitest (availHeight 900).
3. An unknown work area (availHeight 0, as in jsdom) must not clamp to zero.
   Covered by Vitest (availHeight 0 keeps 650).
4. The E2E build skips the resize (`isE2eFrontend`). The clamp must sit after
   that guard. Covered by code review; the Vitest environment has the flag off.
5. Power size is not affected. The clamp applies only to the Basic branch.
   Covered by existing `ui.test.ts` power resize tests (unchanged).

## M12: toast body click, copy and collapsing duplicates

Context: a click on the toast body dismisses it, so error text cannot be
selected or copied. Duplicates stack.

1. A body click must not dismiss a toast. The existing `dismisses on click`
   test encodes the old rule and is replaced. Covered by Vitest `toast.test.ts`
   and E2E case 1 (a click on the text keeps the error toast).
2. Dismissal through the close button and Esc must keep working. Covered by
   existing `toast.test.ts` (Esc) and E2E case 1 (close button).
3. Text must remain selectable. Covered by E2E case 1 (the selection of the
   message text equals the message).
4. Copy appears only on error toasts. Covered by Vitest (a success toast has no
   Copy button).
5. Copy writes the message text, not the count or the close label. Covered by
   Vitest (the clipboard mock receives the message) and E2E case 1 (the copied
   value is read from the recorded `writeText` call).
6. Copy must work when `navigator.clipboard` is missing. The fallback uses a
   hidden textarea and `execCommand`. Code review item (jsdom has no clipboard
   API, so the fallback path is not run).
7. A toast with the same kind and text as a visible one refreshes it and shows
   "(2)" instead of stacking. Covered by Vitest (one `.toast`, count 2) and E2E
   case 2.
8. Toasts with different text or kind must not collapse. Covered by Vitest
   (different text stacks; same text with a different kind stacks).
9. A collapsed timed toast restarts its timer. A stale timer would dismiss the
   refreshed toast early. Covered by Vitest (refresh extends the lifetime).
10. The sticky-toast cap of three must keep counting toasts once each.
    Covered by the existing `trimStickyToasts` path and the `audit-keyboard`
    cap case (not run here).
11. The region keeps its aria behaviour (no `aria-live` on the region, role
    alert for errors, role status otherwise). Covered by existing `toast.test.ts`.
12. The `toast-message` class stays on the message span, because E2E helpers
    read `.toast-message`. Covered by existing E2E helpers and the Vitest text
    assertions.

## M14: Basic update indicator mirror

Context: `#basic-update-indicator` (added by 3A in the Basic header) mirrors
`#update-ready-indicator`. In Power the status-bar indicator already covers the
update, so the Basic copy shows only in Basic.

1. Hidden state, text, title and click handler must mirror the status-bar
   indicator. Covered by Vitest `beta2-fe-chrome.test.ts` (mirror after a parked
   update) and existing `updater.test.ts` (status-bar expectations).
2. The Basic copy must be hidden in Power even when an update is ready. Covered
   by Vitest (`setWorkspaceMode("power")` hides it).
3. Switching back to Basic must show it again without a new update check.
   Covered by Vitest (`setWorkspaceMode("basic")` shows it).
4. The click on the Basic copy must start the same install path as the status
   bar. Covered by Vitest (the click downloads the parked update).
5. The updater must tolerate a missing `#basic-update-indicator`. Covered by
   code review (setup-dom adds the element for the tests).
6. The workspace-mode hook fires only when the mode really changes. A
   `setWorkspaceMode` call during a run returns early before the hook. Code
   review item.

## Updater stage messages

Context: a failed install sets the status to "Idle", and a failed download
reports the check stage.

1. A failed install must report "Update install failed." in the status and
   "Update install failed. <cause>" in the toast. Covered by Vitest
   `updater.test.ts` (install failure expectations and the indicator install
   failure).
2. A failed download must report "Update download failed." in the status and
   the matching toast, from the indicator and from an interactive check.
   Covered by Vitest `updater.test.ts` (parked download failure and the new
   interactive candidate download failure).
3. A failed check keeps "Failed to check for updates." and the existing status
   rule. Covered by existing `updater.test.ts` (network down, Idle).
4. A parked update must stay parked after a failed download or install, so the
   indicator retries. Covered by existing `updater.test.ts` retry tests (kept).
5. An install failure after the watchdog fired must not leave the status at
   "Idle". Covered by code review (the catch sets the install stage status).
6. An error from `ask` in the install path is reported as an install failure.
   Code review item.

## M6: header and titlebar inert while a modal is open

Context: `keepInteractiveDuringModal` keeps the titlebar and `.header` clickable
while any modal is open.

1. The titlebar and `.header` must be inert while a modal is open, and restored
   on close. Covered by Vitest (`utils.test.ts` updated expectation and the
   `beta2-fe-chrome.test.ts` confirm case) and E2E case 3.
2. The toast region, extract app and recovery banner stay interactive. Covered
   by existing `utils.test.ts` expectations (kept).
3. Nested modals: Settings opens the confirm, and closing the confirm must not
   restore the header while Settings is still open. The isolation count covers
   this. Covered by E2E case 3 (cancel the confirm, header still inert).
4. Modals that do not use `trapFocus` are not isolated. Shortcuts, convert and
   recovery are owned by other workers. Reported to the manager.

## Live-preview leak in Settings

Context: Settings applies `basicWindowEffects` to state while open, so an
automatic save during the modal saves the preview. No theme or density preview
exists in this tree.

1. An automatic save while Settings is open must write the value committed at
   open, not the previewed one. Covered by Vitest (preview not persisted) and
   E2E case 4 (file content unchanged after a preview and an automatic write).
2. Cancel must restore the previous state value. Covered by existing
   `settings-dom.test.ts` (live preview restored on discard) and E2E case 4.
3. An explicit Save still writes the previewed value. Covered by existing
   `settings-dom.test.ts` round-trip tests.
4. The committed value must not leak after the modal closes. The override is
   active only while Settings is open. Covered by Vitest (after close the next
   automatic write uses the state value).

## M8: confirm dialog description

1. The confirm dialog's `aria-describedby` must point at the message element
   (`#input-modal-label`). Covered by Vitest (the id resolves to the message
   text) and E2E case 5.
2. The attribute must be removed when the dialog closes. Covered by Vitest
   (attribute absent after close).
3. The password prompt keeps its own `aria-describedby` for the field error.
   Covered by existing `prompt-modal.test.ts` (unchanged).

## Item 9: once-only failure toasts

1. A failed working-context save shows one toast for a run of failures, not one
   per debounced attempt. Covered by Vitest (three failures, one toast).
2. A failed drag-drop handler shows one toast per session. Code review item;
   the drag-drop path cannot be driven from Vitest or WebDriver without a native
   drop.

## Dead exports

Removed `export` from symbols with no importer in `src/` (tests included) or
`e2e/`: `SAFE_URL_PATTERN` (utils), `ToastKind` (toast), `DISCARD_SETTINGS_TITLE`,
`syncSettingsMethodOptions`, `syncBasicWindowEffectsVisibility`,
`CloseSettingsOptions` (settings), `PromptOptions`, `PasswordPromptOptions`,
`ConfirmChoiceOptions` (prompt-modal). Failure mode: a removed export that is
still imported breaks typecheck. Covered by `npm run typecheck`.

## E2E coverage

`e2e/specs/beta2-fe-chrome.spec.js` covers, in order:

1. An error toast from a corrupt Basic browse stays when its text is clicked,
   its text can be selected, Copy writes the message, and the close button
   dismisses it (M12 items 1-5).
2. Two identical Basic test-with-no-archive toasts collapse into one with
   "(2)" (M12 item 7).
3. While the replace-settings confirm is open, the titlebar controls and
   `#open-settings` are inert, and they are restored after Settings closes
   (M6, M7 item 5).
4. A Settings preview of Basic window effects followed by an automatic save and
   Cancel leaves the settings file content and the restored modal value
   unchanged (live-preview leak).
5. With an unparsable settings file, automatic writes are blocked, Save shows
   the confirm with `aria-describedby` pointing at its message, Decline leaves
   the bytes unchanged, and Replace writes valid settings (M7 items 1, 4, 5, 6,
   8; M8).

Each case writes evidence with `writeEvidence` under `beta2-fe-chrome-*`.
