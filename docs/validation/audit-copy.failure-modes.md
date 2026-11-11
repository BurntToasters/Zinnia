# Terminology, copy, settings wording and release documentation failure inventory

This inventory was written before changing any copy or markup. It covers plan
items C-38 (terminology), C-41 (local logging wording), the C-33 leftovers that
sit in `ui/workspace.ts` and `settings.ts` (density label and settings trigger
`aria-expanded`), C-42 (beta release notes), and the target-only checks for
A-05 and the other Windows, Linux and macOS items. The E2E cases live in
`e2e/specs/audit-copy.spec.js`.

## C-38: one term per action

Context: the same action has several names. Power's first mode tab says "Add",
the Basic home card says "Make an archive", quick actions say "Extract Selected"
and "Selective Extract", the browse action says "List" and "Select items...",
and the output path is called "Output path" in Basic and "Archive destination"
in Power. Basic's "Choose folder" opens a save-file dialog. The OS Integration
help names internal packaging terms ("sparse identity package", "NSIS",
"ProgId").

Decided terms: "Compress" for creating archives, "Extract selected" for the
selective picker (button, modal title, shortcuts), "List contents" for listing,
"Output archive" for the compress output path, "Destination folder" for extract
targets, "Choose location" for the Basic save-file button.

Ways the change could fail or regress:

1. A label change that breaks a selector. Every E2E and unit assertion that
   matches the old text must be found first. The grep over `e2e/` and
   `src/tests/` found no assertion on the changed label text; the affected
   selectors use ids and `data-mode-btn` attributes, which do not change.
2. The Power mode tab keeps `data-mode-btn="add"`. Renaming the attribute would
   break `main.spec.js`, `audit-argv.spec.js`, `audit-presets.spec.js` and
   `ui-driver.js`. Only the visible text changes.
3. "Extract selected" must match on all three surfaces: the quick action in
   Power, the Browse action (`#browse-selective`, which today says "Select
   items..."), and the picker title and confirm button. The shortcut
   descriptions in `shortcuts.ts` use the same wording and are rendered by the
   shared table in `ui-surfaces`.
4. "Destination folder" is applied to labels only. Placeholders
   ("Select destination folder", "Choose destination folder") and button text
   ("Browse") stay, so no placeholder assertion changes.
5. "Choose location" is applied only to the Basic save-file button
   (`#basic-choose-output`). The Basic destination button (`#basic-choose-extract`,
   which opens a folder dialog) keeps "Choose folder".
6. "Output archive" replaces "Output path" and "Archive destination" as label
   text only. The ids (`output-path`, `basic-output-path`) do not change, so
   `waitForOutputPath` and the Basic path assertions keep working.
7. The Basic home card "Make an archive" may stay a friendly phrase. Its
   section heading in the compress panel changes to "Compress" so the panel
   matches the button it contains.
8. OS Integration help: the frontend fallback strings in `os-integration.ts`
   change, but the Windows help that users see comes from the backend
   (`src-tauri/src/platform/integration_status.rs`, which sets `help` for the
   Win11 modern menu). That file is not owned here, so the backend text still
   says "sparse identity package" and "NSIS" until its owner changes it. This
   is reported, not changed. The E2E checks only the frontend fallback path
   for the terms; it does not claim the backend text is fixed.
9. The OS Integration help lists "Extract / Compress" in macOS text. That
   slash form is not in the removed list and stays.
10. Log messages in TypeScript ("Selective extract validation failed") are not
    user copy and stay unchanged. Changing them would only churn log grep
    patterns.

## C-41: local logging wording

Context: the Settings row is titled "Local logging" and described as
"Privacy-preserving activity logs on this device only." Logs hold full paths,
and debug verbosity holds up to 20,000 characters of 7-Zip output per stream.
The setting text must say what is logged. Home-directory redaction is not
implemented; the decision is to reword only.

Ways the change could fail or regress:

1. The title is the `aria-labelledby` target of `#s-local-logging`. Renaming
   the title keeps the accessible name in sync because the id stays the same.
2. The description must not say "private", "anonymous" or "redacted", because
   the logs are not redacted.
3. No E2E or unit test matched the old text (grep over `e2e/` and `src/tests/`
   found none), so no assertion needs updating.
4. The new text must not use an em dash (`scripts/validate-no-em-dash.js`).
5. "Recents are kept for this session only" is true for the Basic recent list
   as plan C-41 states. It is stated as fact, not as a promise about logs.

## C-33 leftovers: density label and settings trigger

Context: `setUiDensity` in `src/ui/workspace.ts` writes `textContent` on every
call, so the `#toggle-density` label flips between "Compact" and "Comfortable"
while `aria-pressed` also changes. The decision is a stable label with only
`aria-pressed` changing. `syncSettingsTriggerState` in `src/settings.ts` writes
`aria-expanded` on `#open-settings` on open and close, even though the markup
(`aria-haspopup="dialog"`, no `aria-controls`) is already correct.

Ways the change could fail or regress:

1. Removing the `textContent` write leaves the label at its markup value
   "Compact". It must be the same label in both states, so the E2E reads the
   label before and after a press and requires equality.
2. `aria-pressed` must still flip on each press. The E2E checks both values.
3. The density select (`#s-ui-density`) and `dataset.density` are still written.
   The E2E only reads the toggle, and checks the dataset to show the mode did
   change.
4. The density toggle is inside the header. It is clicked through the DOM, the
   same way `chrome.ts` handles it, so the E2E does not depend on keyboard focus
   (the native WebKit focus rules are not reliable for WebDriver on this host).
5. Unit tests that assert the toggle text ("Comfortable") would fail. A grep
   over `src/tests/` found no such assertion; `basic-accessibility.test.ts`
   checks only the id and `aria-pressed="false"` in markup.
6. `syncSettingsTriggerState` is removed with its two call sites (open and
   close). Leaving an empty function would keep dead code that a future change
   might fill again.
7. `src/tests/settings-dom.test.ts` asserts `aria-expanded` on `#open-settings`
   in four places. Those assertions encode the behavior being removed and are
   updated to assert the attribute is absent, not deleted.
8. `aria-haspopup="dialog"` and the absence of `aria-controls` stay as they are
   (the existing `audit-a11y` case checks them).
9. The E2E must open and close Settings through the real trigger click, not by
   setting the overlay hidden, because the attribute write happened in those
   code paths.

## C-42 and CHANGELOG: user-facing beta notes

Context: the `v0.7.0-beta.1` section of `CHANGELOG.md` lists internal names
(journal field names such as `format_version`, `archive_phase`,
`extract_phase`, `extract_stage_placement`, `_setupWizardVersion`-style
settings keys, and crate names) that users cannot act on. Audit fixes that
landed are not all listed. The section heading and the `/download/v0.7.0-beta.1/`
links must stay, because `scripts/validate-changelog-version.js` checks them.

Ways the change could fail or regress:

1. The heading `## Changes in \`v0.7.0-beta.1:\``must stay exact, and the
download links must keep`/download/v0.7.0-beta.1/`. The validator fails
   otherwise.
2. The file is `CHANGELOG.md` only. The Downloads table and the footer stay as
   they are. The `v0.6.0`, `v0.5.0` and `v0.4.0` history stays inside the
   `<details>` block unchanged.
3. Entries must name user-visible behavior. Internal names (journal fields,
   Rust module names, test names, `tauri.conf.json` keys) are replaced with
   plain words. Security entries keep the threat in plain words.
4. A fix listed as landed must appear in a failure-modes file as a fixed item,
   not only as a deferred one. Deferred items go to a "Known issues" list.
5. Known issues: large archives over about 100,000 entries extract very slowly;
   Convert cannot handle archives whose listing exceeds 64 MiB; the streaming
   listing parse (B-02 long-term) is not done; quick-extract "Choose another
   folder" is not offered; read-only-volume extract fallback is not done;
   Dependabot cannot watch vendored path crates; `eslint:recommended` needs the
   `@eslint/js` dev dependency.
   5a. The "Known issues" list must not contain an item that a later worker fixes
   in the same release without updating it. The list is the state at the time
   of writing and is re-checked before tagging.
6. No em dashes. `node scripts/validate-no-em-dash.js` covers the file.

## A-05 and target-only checks: release documentation

Context: some checks cannot run on this macOS host: OneDrive Known Folder Move
on Windows 11 (A-05), list-file quoting on Windows (A-03), slow-media preflight
timeout on a real USB stick or network share (B-03), safe-copy progress on
exFAT and ext4 (B-04), real exit-1 output on Windows and Linux (C-09), macOS
autocorrect and smart dashes (B-11), title-bar double-click maximize and restored
size (C-20), and right-click paste on Windows and Linux (B-17). They must be
recorded as a manual checklist in the release runbook, under the packaged-artifact
QA step, with what to do and the pass condition.

Ways the change could fail or regress:

1. The file is `docs/RELEASE-STABLE.md`. The change is append-only: a new
   subsection is added after section 6's paragraphs and before section 7. No
   existing text is edited.
2. A check that depends on a Windows host must say so and must not claim it was
   run here.
3. A-05 must include the fallback: if placeholders fail, allow cloud reparse
   tags explicitly instead of all tags. It must not suggest broadening the
   reparse rule without that fallback.
4. The em dash rule applies to the new section.
5. `QA-CONTEXT-MENUS.md` is not edited (not owned).

## Test coverage plan

- E2E (`e2e/specs/audit-copy.spec.js`), written before the copy change:
  - Power labels: the first mode tab reads "Compress", the quick actions read
    "Extract selected" and "List contents", the Power output and extract labels
    read "Output archive" and "Destination folder". The picker title and confirm
    button read "Extract selected", the Basic output button reads "Choose
    location", and the Local logging title has the new wording.
  - Settings trigger: after opening and closing Settings through the trigger,
    `#open-settings` has `aria-haspopup="dialog"` and no `aria-expanded`.
  - Density toggle: pressing it changes `aria-pressed` and leaves the label
    unchanged.
- Each E2E case ends with `writeEvidence` under a `audit-copy-<case>` name.
- Unit test updates are limited to the assertions listed under C-33 item 7.
- No new unit tests are written for these copy changes. The E2E cases cover
  them, and AGENTS.md forbids unit tests written after the code.
- Target-only checks are listed in the release runbook, not in automated tests.

## Deferred

- Backend OS Integration help text (`src-tauri/src/platform/integration_status.rs`)
  still uses "sparse identity package" and "NSIS" for the Win11 modern menu. It
  is outside this worker's files. The frontend fallbacks are changed.
- Home-directory redaction in logs (C-41 alternative): not implemented, per the
  decision to reword.
- The CHANGELOG known-issues list is the deferred set above; each item is
  tracked in its own failure-modes file.
