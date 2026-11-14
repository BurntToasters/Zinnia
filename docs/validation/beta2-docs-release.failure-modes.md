# Beta 2 docs and release metadata failure inventory

Piece 5B (`docs-release`). It covers the release notes, the reference docs, the
AppStream metadata and the version bump from `0.7.0-beta.1` to `0.7.0-beta.2`.
It has no GUI E2E spec: docs and version strings are checked by the scripts and
gates named in each item, not by the app. Items marked READ were checked by
reading the code or the inventory they came from. Items marked RUN were checked
by running a command in this piece.

Order note: this inventory was written after the docs and version edits had
been made. Each item below names the check that backs it, and each check was run
after the edit it covers.

## Version bump

1. A version field is left at `0.7.0-beta.1`. Check: `git grep "0.7.0-beta.1"`
   after the bump lists only historical text (the beta 1 changelog section, the
   beta 1 AppStream release, the beta 1 audit documents, and test or script
   fixtures outside this piece). RUN.
2. `sync-version` writes the wrong value to one of its targets. Check: the
   `sync-version` output lists each target, and a second run prints nothing,
   which means every value already matches. RUN.
3. `sync-version` rewrites `tauri.conf.json` and `tauri.windows.conf.json` with
   `JSON.stringify`, which expands every short array and adds churn across the
   file. Fix: `tauri.conf.json` was re-formatted with Prettier, which matches the
   committed style. `tauri.windows.conf.json` was restored from `HEAD` and only
   its five `shell-<version>/` paths were changed. Check: `git diff HEAD` on both
   files shows only version lines: `tauri.conf.json` has 4 changed lines (the
   version and `bundleVersion`, one removed and one added each), and
   `tauri.windows.conf.json` has 10 (five resource paths). RUN.
4. `bundleVersion` for macOS is wrong for a beta. Check: `macBundleVersionFromSemver`
   gives `0.7.3002` for beta 2 (beta sequence 2 in the 3000 range), and
   `tauri.conf.json` now shows it. READ, RUN through the sync output.
5. The Windows package version is not ordered after beta 1. Check: the MSIX
   manifests and the resource files now show `0.7.0.2`, and beta 1 was `0.7.0.1`.
   READ.
6. `package-lock.json` root and `packages[""]` versions differ. Check: the sync
   helper rewrites both, and `syncNpmLockfileVersion` verifies them. The diff
   shows 2 changed version lines plus no other change. RUN.
7. `Cargo.lock` zinnia entry differs from `Cargo.toml`. Check: `Cargo.lock` line
   `name = "zinnia"` has `version = "0.7.0-beta.2"`. RUN.
8. `Info.plist` marketing version changes from `0.7.0`. It does not: the marketing
   version drops the beta suffix, so it stays `0.7.0`. Check: no diff on
   `src-tauri/Info.plist`. RUN.
9. The Finder Sync `Info.plist` gets a different build number from the app.
   Check: the Finder Sync plist changes only the marketing and bundle version
   lines, to the same values as `tauri.conf.json`. RUN (2 lines in the diff).

## AppStream metadata

10. The beta 1 release date is wrong. The tag `v0.7.0-beta.1` is on the merge
    commit `340a1f5`, dated 2026-11-11, not 2026-11-01. Fix: the date is set to
    2026-11-11. Check: `git log -1 --format=%ad v0.7.0-beta.1`. RUN.
11. `update-metainfo.js` adds the beta 2 release with the run date. The run date
    is 2026-11-14. Risk: if beta 2 is tagged on another day, the date is wrong.
    Mitigation: the script keeps an existing release date on a second run, so the
    date must be corrected by hand before the tag is cut. Check: `--check` mode
    passes ("AppStream metadata already up to date"). RUN.

## CHANGELOG

12. The beta 2 section heading is missing when sync-version runs. The sync then
    inserts a placeholder note (add release notes) and the validator fails. Fix:
    the heading and the notes were written before the sync ran. Check: the
    changelog validator (node scripts/validate-changelog-version.js) prints
    changelog-version: ok (v0.7.0-beta.2), which rejects the placeholder. RUN.
13. Download links still point at beta 1. Check: the table links use
    `/releases/download/v0.7.0-beta.2/`, and the validator checks that URL. RUN.
14. A beta 2 item is wrong about the code. Each item was checked against its
    inventory, and against code where a short grep was enough:
    - Basic drop while busy: the toast text "An operation is already running. Drop
      the files again in a moment." is in `src/basic/actions.ts`, and the drop is
      refused there, not queued. The queued text "Files will be added when the
      current operation finishes." is in `src/incoming-paths.ts`, and it applies to
      Power drops and OS hand-offs through the incoming-path lock. READ, RUN (grep).
    - 110,000 entries publish, about four minutes: the timing comes from the piece
      brief (240,494 ms on Windows). It was not re-measured in this piece. The GUI
      E2E run is the manager's check. Listed under Known issues as "about four
      minutes in testing on Windows".
    - Listing limits: the new 1,000,000 entry and about 4 GB listing text bound is
      the text of `MEMBER_LIST_LIMIT_MESSAGE` in `src-tauri/src/process/staging/slt.rs`,
      and `MAX_EXTRACT_ENTRIES` in `src-tauri/src/process/quota.rs`. READ, RUN (grep).
    - Browse count: "about four times more entries" comes from the streaming
      inventory. The CHANGELOG says four times more entries and does not state a
      new count. The README says "hundreds of thousands" for the same reason.
      READ.
    - Quick extract "Choose another folder": the Known issue from beta 1 is
      removed. The quick-extract inventory and its E2E spec cover it. The E2E spec
      has not been run in this piece. READ.
    - Open bug B (Basic changed archive stuck at Running): the cleanup inventory
      says "Not reproduced", so it is not claimed as fixed. READ.
    - Open bug A (Power header-encrypted archive with no password): the fix is in
      the frontend retry path, and the CHANGELOG says Power now prompts. READ.
15. The beta 1 entry says dropped files are queued during running jobs, which is
    not true for Basic drops. The beta 2 section states the real behaviour and
    does not edit the beta 1 entry. READ (item 14 above).
16. A fix is listed as done when it is not verified. Items that are verified only
    by reading the code, or only on macOS, Linux or a signed Windows build, are in
    Known issues: the macOS quarantine symlink read and platform cleanups
    (`[unverified-os]`), the Windows verb cleanup and shell leak fix (READ, and a
    compile-only check for the DLL), High Contrast and reduced motion styles (READ
    only, forced colors cannot be emulated here). READ.
17. `deps:vendored` output is quoted wrong. Check: the command was run in this
    piece, and its table is quoted in the report and in Known issues.
    `tauri-plugin-wdio-webdriver` 1.4.0 (latest 1.5.1) and `tauri-plugin-updater`
    2.10.1 (latest 2.14.1). The network worked, so no fetch failure is reported. RUN.
18. The Known issues list still has a fixed item (streaming parser, Choose another
    folder, slow 100,000 entries note). These were removed or rewritten. READ.
19. The download table is re-wrapped by Prettier. Check: `npx prettier --check
CHANGELOG.md` passes after the write. Only column widths of the table changed,
    and the links did not change. RUN.

## README, SECURITY, ARCHITECTURE, CONTRIBUTING

20. A stated limit is stale. Each old number was searched for across the owned
    docs (`200,000`, `800,000`, `256 MiB`, `100,000`, `32 MiB`). The README
    system-requirements bullet and the SECURITY listing-limit bullet were rewritten
    to the current constants: `MAX_LIST_OUTPUT_BYTES` (64 MiB),
    `MAX_EXTRACT_ENTRIES` (1,000,000), the 4 GB listing text bound and the 256 KiB
    line bound from the streaming inventory. READ, RUN (grep for old values).
21. The `*` refusal is not documented. The new SECURITY bullet cites the H1
    behaviour from the Rust extract-safety inventory. READ.
22. ARCHITECTURE names something that does not exist. Each name was checked with
    grep: `choose_extract_destination` (`launch/extract_window.rs`),
    `allow-choose-extract-destination` (`capabilities/extract.json`),
    `SltManifestParser` and `ListingLineFilter`, `MOVE_IDENTITY_BATCH_RECORDS`
    (`process/journal.rs`), and the 512 MiB and 1 GiB caps. RUN (grep).
23. The default capability grants `choose_extract_destination` to the main window.
    Check: `src-tauri/capabilities/default.json` does not contain
    `choose-extract-destination`. RUN.
24. CONTRIBUTING's testing guidance conflicts with AGENTS.md. The old text said
    "Add tests with each change" and required a Vitest arg-builder test for each
    new 7z switch. The new text puts the failure inventory first, makes E2E the
    main proof with evidence artifacts, allows isolated tests only where E2E cannot
    reach, and forbids tests written after the code. Check: the old sentence is no
    longer present (grep). READ, RUN (grep).
25. The removal of the `plan.md` file was denied by the permission system during
    this piece. The file is still tracked and unchanged (`git status` shows no
    change). Risk: the manager must delete it before release. Not claimed as done.
26. `docs/DEPENDENCY_UPDATES.md` said the re-vendor was "scheduled after
    0.7.0-beta.1", which is now in the past. The text now says it was scheduled and
    is not part of 0.7.0-beta.2. Batch 1 edits to that file were kept. READ.

## Gates

27. Prose gates fail on the new text. Check: `npm run validate:no-em-dash` and
    `npx prettier --check` on each changed markdown file. RUN.
28. The version consistency tests fail on the new version. Check: `src/tests/sync-version.test.ts`,
    `src/tests/update-metainfo.test.ts`, and `src/tests/release-script-safeguards.test.ts`
    run under `npm test`. RUN.
