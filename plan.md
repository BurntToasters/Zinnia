# Zinnia 0.7.0-beta.1 audit plan

> **Agent instructions: delete this file (`plan.md`) when you have finished working through it.**
> It is a working document, not project documentation. Do not commit it as a permanent file.
> Follow `AGENTS.md` while fixing: write the failure inventory first, prefer E2E coverage, never add
> unit tests after the code, and do not add agent co-author trailers.

Audited: branch `next-0.7.0` at `3d1de0c`, version `0.7.0-beta.1`, on macOS arm64 (2026-11-09).
This was a read-only audit. No tracked file was changed; `plan.md` is the only new file.

## How to read this

Each finding has an ID, a priority, a location, what happens, how it was verified, and a fix direction.

Verification tags:

- **[probe]** reproduced by running the unmodified source or the bundled 7-Zip 26.06 sidecar.
- **[code]** established by reading the code path end to end; not executed.
- **[target]** cannot be settled on this macOS host; needs a Windows, Linux, or signed-package check.

Priorities:

- **P1** fix before the first beta ships.
- **P2** fix during the beta, before stable.
- **P3** polish; batch when convenient.

## Baseline (all green)

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` (ESLint, comment lint, archive-format alignment) | pass |
| `npm run format:check` | pass |
| `vitest run` | 67 files, 1,070 tests pass |
| `vite build` | pass (main JS 169 kB, index.html 106 kB, CSS 98 kB) |
| `cargo fmt --check` | pass |
| `cargo clippy --all-targets -- -D warnings` | pass |
| `cargo test --all-targets` | 406 unit + 10 sidecar + 1 example pass |
| `cargo audit` | 0 vulnerabilities; 4 allowed warnings (`zbus_names`, `zvariant`, `zvariant_derive` unmaintained; `async-executor` yanked) |
| `npm audit` | 35 moderate, 14 high, all dev-only and covered by the reviewed-advisory gate (review expires 2026-12-01) |

Passing gates do not cover the findings below. None of them has an existing test.

## What was and was not covered

Read in full: every non-test frontend module under `src/` (entry, state, settings, `ui/`, `archive/`,
`basic/`, `power-events/`, `extract-window/`, updater, OS integration, wizard, presets, quick actions,
toast, prompt, debug mode, E2E gating), plus `validation.rs` and its submodules, `process/commands.rs`,
`commands/argv.rs`, most of `commands/run.rs`, `main.rs`, `settings_store.rs`, `app_menu.rs`, the Tauri
configs and capabilities, and `Cargo.toml`.

Read in part or by targeted search: `staging/slt.rs`, `path_safety.rs`, `archive_snapshot*`, `logging.rs`,
`output.rs`, `launch/extract_window.rs`, `launch/open_path.rs`, `windows/shell/dllmain.cpp` (first 520
lines), CI workflows, Linux desktop and Flatpak manifests, CHANGELOG, README.

Audited by script rather than by eye: `index.html`, `extract.html`, `debug-console.html` (structure,
labels, roles, id references) and the CSS (motion, focus, contrast tokens, font sizes, z-index).

**Not reviewed this pass** (the 2026-11-04 audit concentrated here, so they were deprioritised):
journal/recovery/commit internals (`process/journal/*`, `recovery.rs`, `commit/*`, `quota.rs`),
`fs_secure*`, `tempdir.rs`, `quarantine.rs`, `archive_detect.rs`, `progress.rs`, `platform/*`,
`macos_services.rs`, `finder_sync_requests.rs`, `launch/open_routing.rs`, the vendored updater and
WebDriver plugins, the Swift Finder Sync extension, NSIS hooks, PowerShell scripts, the ~110 release and
tooling scripts, and the E2E suite itself. Nothing was run on Windows or Linux, in a packaged build, or
with a screen reader. Visual review was limited to CSS and markup; no screenshots were taken.

---

## P1: fix before the first beta

### A-01. A failed or cancelled run silently erases the password, so the retry creates an unencrypted archive

- **Where:** `src/archive/ops.ts:210-213` (`finally { clearPasswordFields(); ... }`), also
  `selective-run.ts:202-205`, `inspection.ts:176-179`, `basic/actions.ts:618-621`.
- **What happens:** `runAction` clears every password field in `finally`, including when nothing ran.
  A user types a password, clicks Run, and hits a pre-run error (output name has the wrong extension,
  GZIP given two inputs, runtime probe failure) or answers Cancel to "Replace archive". The password
  field is now empty with no notice. They fix the problem and click Run again. The archive is created
  with no encryption and the success toast says "Archive created."
- **Verified:** [probe] with the real modules in jsdom: password `s3cret`, run aborted before 7-Zip
  started, `#password` was `""` afterwards. The validation-error and cancelled-confirm branches reach
  the same `finally`.
- **Why P1:** silent loss of encryption intent. "Encrypt file names" only saves the user when it is
  ticked (it then demands a password).
- **Fix direction:** clear passwords only after 7-Zip has actually been started (success, real failure,
  or user cancel of a running job). Leave them in place for pre-run validation errors and for a declined
  overwrite confirm. Cover Power and Basic.

### A-02. Convert writes a plaintext copy of an encrypted archive without saying so, using controls the user cannot see

- **Where:** `src/archive/mutations.ts:228-456`; the Convert button is `#browse-convert` in Browse mode.
- **What happens:** Convert reads the output format, password, "encrypt file names", split size and
  timestamp options from the Add-mode form (`#format`, `#password`, `#encrypt-headers`, `#split-size`).
  Those controls are hidden in Browse mode (`data-mode-visible`). Converting a password-protected
  archive therefore produces an unencrypted archive unless the user had earlier typed a password on the
  Add tab. There is no warning, and the output format is whatever the hidden select last held.
- **Verified:** [code]. The save dialog defaults to `converted.<ext>` regardless of the source name.
- **Fix direction:** give Convert its own small dialog (target format, password, encrypt names) or at
  minimum show the effective format and encryption state and require confirmation when the source is
  encrypted and the output will not be. Default the name to the source stem. Validate split size before
  the extract phase rather than after it (`mutations.ts:382`).

### A-03. Managed list files are written unquoted, so 7-Zip silently substitutes a different file

- **Where:** `src-tauri/src/process/commands/argv.rs:119-133`; used for every `a`/`u`/`x` path
  (`spawn.rs:560-563`).
- **What happens:** each selected path is written as a raw line. 7-Zip's list-file reader trims
  whitespace and strips one pair of surrounding double quotes. Results with the bundled 7zz 26.06:
  - Compress input `/dir/report ` (trailing space) with a sibling `/dir/report`: the sibling is
    archived, exit 0.
  - Extract selection `report ` when `report` also exists: `report` is extracted instead.
  - Compress input named `"quoted"` with a sibling `quoted`: the sibling is archived.
  - Selection ` lead.txt` (leading space): "No files to process", exit 0. The backend's
    `ensure_extract_stage_has_output` turns this one into an error, but the substitutions above are
    silent.
  - Writing the line wrapped in double quotes preserved the exact name in the same test.
- **Verified:** [probe] against the bundled sidecar using the same line format Zinnia writes.
- **Why P1:** wrong content is archived or extracted with a success message. Rare names, but silent.
- **Fix direction:** wrap every list-file line in double quotes (a name that itself starts and ends with
  a quote then round-trips, because only one pair is stripped). Add E2E cases for trailing space,
  leading space, and quoted names on POSIX, for both compress inputs and selective members.

### A-04. `next-0.7.0` has diverged from `main`; 0.6.6 and PR #246 are not merged

- **Where:** `git cherry -v HEAD main` reports three commits with no patch-equivalent on this branch:
  `87317f2` (release 0.6.6), `5f59ef9` (universal macOS 7-Zip assets), `fa14307` (verify Unix binary
  modes, PR #246). Merge base is `f3756a2`.
- **What happens:** the branch carries its own versions of the macOS 7-Zip work, so a later merge will
  conflict in `assets/`, `scripts/prepare-7z*.js`, `scripts/update-7z.js`, `src-tauri/build.rs`,
  `src/tests/7z-provenance.test.ts` and `src/tests/macos-compatibility.test.ts` (main adds 173 lines of
  tests there). Any behaviour fixed only on `main` is absent from the beta.
- **Verified:** [probe] (git).
- **Fix direction:** merge or rebase `main` into `next-0.7.0` before tagging, resolve the 7-Zip asset
  and script conflicts deliberately, and rerun the full gate. Also add the missing `0.6.5` and `0.6.6`
  entries to `run.rosie.zinnia.metainfo.xml` (it jumps from `0.7.0-beta.1` to `0.6.4`).

### A-05. Confirm OneDrive-backed folders work on Windows before shipping

- **Where:** `src-tauri/src/path_safety.rs:22-37` (`is_link_or_reparse` is true for any
  `FILE_ATTRIBUTE_REPARSE_POINT`), `process/commands/run.rs:236-246`, `compress_preflight.rs:405`,
  `SECURITY.md:73`.
- **What happens:** by design, compress inputs and destinations that are reparse points, including cloud
  placeholders, are rejected ("Choose the real file or folder, not a symbolic link or reparse point").
  On Windows 11, Desktop, Documents and Pictures are commonly redirected into OneDrive. Whether Zinnia
  sees those files as reparse points depends on the process's placeholder compatibility mode. The
  default Tauri manifest declares no `supportedOS`, which probably keeps placeholders disguised, but
  that is an inference.
- **Verified:** [target]. Not testable on this host.
- **Why P1:** if placeholders are exposed, the most common folders on Windows cannot be compressed from
  or extracted into.
- **Check:** on Windows 11 with OneDrive Known Folder Move enabled, compress from and extract into
  Desktop and Documents, with files both "always keep on this device" and online-only. Repeat from the
  Explorer context menu. If it fails, allow the cloud reparse tags explicitly instead of all tags.

---

## P2: fix during the beta

### Functional limits and correctness

**B-01. Selective extraction fails once more than about 8,184 files are selected.** [probe]
`validate_run_7z_args` enforces `MAX_7Z_ARGS = 8192` (`validation.rs:7,37`) inside
`parse_run_7z_request` (`commands.rs:78`), before the paths are moved into a list file. The picker
expands a ticked folder into every file beneath it (`browse-selective-helpers.ts:20-35`). 8,185 members
return "Too many 7z arguments." Ticking one large folder is the normal use of the picker.
Fix: validate switches and the archive separately from member count, or raise the member cap to match
what the list file can carry, or pass folder prefixes safely.

**B-02. Archive size ceilings are far below the documented limits.** [probe]
Measured with 7zz 26.06 and ~58-character paths: a `-slt` record is about 325 bytes for ZIP, 319 for
TAR, 209 for 7z.
- Browse and selective extract use the 10 MiB `MAX_OUTPUT_BYTES` (`output.rs:3`, `run.rs:1339`,
  `inspection.ts:273`): about 32,000 entries for ZIP/TAR and 50,000 for 7z. Beyond that the archive
  cannot be browsed.
- The extraction safety preflight uses `LIST_OUTPUT_LIMIT = 32 MiB` (`staging/slt.rs:401`): about
  103,000 entries for ZIP/TAR and 160,000 for 7z. Beyond that **extraction is refused entirely**
  ("member-safety preflight exceeded its output limit"). `MAX_EXTRACT_ENTRIES = 1,000,000`
  (`quota.rs:13`) is unreachable.
Fix: parse the listing as a stream instead of buffering it, or size the cap from `MAX_EXTRACT_ENTRIES`.
Until then, state the limit in the error message and the docs.

**B-03. The safety preflight has a fixed 120-second timeout.** [code]
`staging/slt.rs:467`. Listing an uncompressed `.tar` (and the inner tar of a `.tar.gz`) reads the whole
file. A tar in the tens of gigabytes on a hard disk, USB stick or network share will exceed 120 s and
cannot be extracted. Fix: make the timeout progress-based (no output for N seconds) or scale it with
archive size. Verify on slow media.

**B-04. Extraction byte-copies the whole archive first on filesystems without hard links or CoW.** [code]
`archive_snapshot.rs:76+`, `archive_snapshot/copy.rs` (strategies: Windows hard link, CopyFile2, CoW
clone, cancellable byte copy). On ext4, XFS without reflink, exFAT, FAT32 and SMB, every extraction
first copies the archive: double the I/O and extra free space equal to the archive size. This is a
deliberate integrity trade-off, but ext4 is the default Linux filesystem and exFAT the default for
removable media. Consider holding an open descriptor and re-checking identity after the run (already
done for list/test) instead of copying on Unix. At minimum surface "Preparing a safe copy..." with
progress so the UI does not look stalled.

**B-05. The "Store" preset compresses.** [probe]
`presets.ts:39-46` sets ZIP, level 0, `method: "deflate"`, and `args.ts:78-79` emits `-mx=0 -m0=deflate`.
With an explicit method 7-Zip deflates even at level 0: a 7,200-byte file was written as `Method =
Deflate`, 70 bytes. Plain `-tzip -mx=0` gives `Method = Store`. Fix: omit `-m0=` when level is 0 (or
send `-m0=copy`), and add a sidecar round-trip assertion on the method.

**B-06. Selective extraction rejects members whose names begin with certain letters after a dash.** [probe]
`validation.rs:72-87` applies the blocked-switch list and the embedded-listfile check to arguments after
`--` as well. Members such as `-web/app.js`, `-sidebar.png`, `-social/x.png`, `-work.txt`,
`-snippets/a.rs`, `-sound/a.wav` and `-icons/@2x.png` are refused with "7z argument ... is not permitted".
The CHANGELOG says dash-prefixed members now extract; that holds only for names that do not start with
`-w`, `-si`, `-so`, `-sdel`, `-sfx`, `-sns`, `-sni`, `-spf2`, or `-i`/`-x` containing `@`. Fix: apply
switch rules only before the separator.

**B-07. Basic mode asks for a password on large archives that have none.** [code]
`basic/actions.ts:444-541`. `isArchiveEncrypted` returns `null` when the listing is truncated (see B-02)
or the probe fails; `null` is treated as encrypted; the prompt loops `while (!password)` with no way to
say "there is no password". Fix: on `null`, skip the upfront prompt and rely on the existing
password-retry path, or add a "No password" button.

**B-08. A corrupt `settings.json` can never be saved over.** [code]
`settings_store.rs:263-272` refuses to overwrite an unparsable file "to avoid losing reserved keys"; the
only reserved key is `_setupWizardVersion`. After the frontend loads defaults, every later save fails,
the setup wizard reappears on every launch, and the message tells the user to delete a file by hand.
Fix: rename the bad file to `settings.json.corrupt-<timestamp>` and write the new one. Related:
`atomic_write_text` returns an error if the parent-directory sync fails after the rename succeeded
(`settings_store.rs:195-203`), so the UI rolls back in memory while the disk holds the new values.

### Interaction bugs

**B-09. In Basic, Esc that closes a dialog also throws the user back to Home.** [probe]
`power-events/keyboard.ts:44-66` closes the dialog first; `basic/keyboard-events.ts:8,44-57` then runs,
finds no open `.modal-overlay`, and calls `setBasicView("home")`. Reproduced for Settings, Keyboard
Shortcuts, and Esc on a sticky toast (`toast.ts:63` does not stop propagation); the Recent menu
(`recent.ts:136`) has the same shape. From Home, "Make an archive" clears the file list
(`basic/wire.ts:131`), so the Compress session is lost. Fix: have the first handler mark the event
handled (`stopImmediatePropagation`, or a shared "consumed" flag) and have the Basic handler ignore
handled events.

**B-10. Enter starts the operation during IME composition.** [probe]
`basic/keyboard-events.ts:60-71` clicks Run on any Enter that is not on a button or link. No code in
`src/` checks `isComposing`. A user confirming a Japanese, Chinese or Korean archive name starts the
compression. The same gap exists in `prompt-modal.ts:73,175`. The Basic handler also fires with focus on
a `<select>` or checkbox. Fix: ignore `event.isComposing || event.keyCode === 229` everywhere Enter is
handled, and restrict the Basic shortcut to text inputs.

**B-11. Text inputs allow autocorrect, spellcheck and smart punctuation.** [code, target]
Only `#basic-browse-password` sets `spellcheck="false"`. Every path, archive-name, extra-args,
split-size and search input, and every password field once "Show" switches it to `type="text"`, is open
to WKWebView autocorrect and smart dashes. That can alter a visible password before an archive is
encrypted with it, or turn `--`/`-mx` into a typographic dash. Fix: add `spellcheck="false"
autocorrect="off" autocapitalize="off"` to all of them; use `autocomplete="new-password"` on create
fields. Verify on macOS with "Correct spelling automatically" and "Use smart quotes and dashes" on.

**B-12. Typing an archive name discards a destination folder the user picked.** [code]
`power-events/presets.ts:145-156` and `basic/wire.ts:479-492` rebuild the whole output path from the
first input's parent on every keystroke. A folder chosen with Browse is replaced. The name is not
sanitised either: `photos.7z` yields `photos.7z.7z`, and separators are accepted. Fix: replace only the
file-name component of the current output path; strip a duplicate extension and reject separators.

**B-13. Only one password attempt.** [code]
`archive/runtime.ts:298-342` and `extract-window/password-retry.ts:68-99` prompt once. A second wrong
password fails the operation; in the quick-extract window the user must relaunch. In a batch, dismissing
one prompt cancels the whole batch (`runtime.ts:326`). The prompt has no show/hide toggle, and an empty
submit is treated as cancel. Fix: loop until correct or cancelled, add "Skip this archive" for batches,
add a reveal toggle.

**B-14. Closing the window or quitting during an operation cancels it without asking.** [code]
`main.rs:51-92,162-218`; `app-init.ts` titlebar close; `extract-window/run-core.ts:76-83`. Staging keeps
this safe for data, but a long job is lost to one click. Fix: confirm when an operation owned by that
window is running.

**B-15. Settings -> Compression offers methods the app cannot use.** [code]
`#s-method` lists LZMA2, LZMA, PPMd, BZip2, Deflate and Zstandard for every format, and
`settings-model.ts` accepts them, but the runtime form supports only 7z:{LZMA2, LZMA} and
zip:{Deflate, LZMA} (`presets.ts:131-141`). Other saved defaults silently fall back. Zstandard is not in
stock 7-Zip at all. Fix: filter the settings method list by the selected format, as the main form does.

**B-16. The benchmark runs outside the operation lock.** [code]
`benchmark.ts:20-37` invokes `run_7z` with `b` without `setRunning`. There is no cancel and no progress,
the rest of the UI stays live, and starting an archive job meanwhile fails with a busy error. The result
is "Rating: N" with no unit. Fix: route it through the normal running state with a Cancel button.

**B-17. Right-click is disabled in every input.** [code]
`webview-context-menu.ts:27-35` suppresses the native menu everywhere unless debug mode is on. macOS has
an Edit menu (`app_menu.rs:92-101`), but on Windows and Linux mouse users cannot paste a path or
password. Fix: allow the native menu on editable targets, or add a small Cut/Copy/Paste menu.

---

## P3: polish

### Operations and feedback

- **C-01.** Update mode shows "An archive already exists ... Replace its contents?" with a "Replace"
  button, and the success toast says "Archive created." (`ops.ts:116-124,169-172`).
- **C-02.** Basic double-confirms overwrites: the native save dialog asks, then Zinnia asks
  (`basic/actions.ts:379`, `ops.ts:116`).
- **C-03.** Add files and Convert show no percent or ETA in Power; they do not use `withLiveProgress`
  (`mutations.ts:175,343,407`).
- **C-04.** Basic progress is a bar only, capped at 99%, with no number, ETA or file name; the
  "Compressing..." label is overwritten by "Running" (`basic/progress.ts:248-268,394`). Cancel leaves no
  visible confirmation (`basic/progress.ts:441`).
- **C-05.** Browsing a header-encrypted archive raises a sticky error toast ("Failed to list archive
  contents (exit code 2)") instead of prompting (`inspection.ts:249-270`). Browse -> "Extract all" in
  Basic asks again for the password just typed (`browse-events.ts:9-13`).
- **C-06.** Files dropped onto Power while a job runs wait silently and are applied when it ends
  (`app-init.ts` drop handler, `incoming-paths.ts:91`). Explorer hand-offs over the 4,096-path limit only
  write an info log line, while drops show a toast (`incoming-paths.ts:58`).
- **C-07.** Failed quick extract has no recovery: no retry and no way to choose another destination
  (`run-core.ts:286-296`). A read-only parent folder is a dead end.
- **C-08.** Error hints have drifted from 7-Zip 26.06. It prints "Cannot open the file as [7z] archive"
  and "Is not archive"; `error-hints.ts:31` looks for "can not open" with "as archive", so that hint
  never fires. "cannot create" is always reported as a permission problem (`error-hints.ts:54`). [probe]
- **C-09.** The exit-1 warning classifier rejects 7-Zip's own summary line "Archives with Warnings: 1"
  (`run.rs:473-485`), so its allow-list may be unreachable for real output. Trailing data after an
  archive exits 0 in 26.06 and is published normally. Add fixtures captured from real exit-1 runs.
  [probe on the classifier with real exit-0 output]
- **C-10.** Many failures are logged at info level (`ops.ts:197,350,362,398`, `inspection.ts:166,317`,
  `selective-run.ts:158,192`), so they are not marked as errors in the local log.
- **C-11.** A failed cancel sets "Cancelling..." with a 3-second auto-reset to "Idle" while the job is
  still running (`ops.ts:446`).
- **C-12.** `setRunning(false)` re-enables the "Repeat Last" quick actions even when there is nothing to
  repeat (`ui/status.ts:109`, `quick-actions.ts:91`).

### Settings, presets, paths

- **C-13.** Settings closes on Esc, Cancel or a click outside and drops unsaved edits without asking
  (`power-events/settings.ts:64-68`).
- **C-14.** The reset confirmation does not say that logs, recents and custom presets are also deleted
  (`power-events/settings.ts:167`).
- **C-15.** Preset save/delete and the debug toggle do not handle `SettingsPersistSupersededError`; on
  that race memory is rolled back while the newer queued snapshot still reaches disk
  (`power-events/presets.ts:78,115`, `debug-toggle.ts:33`).
- **C-16.** Custom preset names: `name in PRESETS` walks the prototype chain, so "toString",
  "constructor" and "valueOf" are rejected as built-in (`presets.ts:267`) [probe]; names have no length
  limit.
- **C-17.** Factory defaults (7z, level 5, 256 MB dictionary, 16 GB solid) match no preset, so Power
  shows "Custom" on first run; a 256 MB dictionary with all cores is memory-hungry. Consider making the
  defaults equal "Balanced".
- **C-18.** Changing format keeps a manually chosen output name with the old extension, and the run then
  fails (`presets.ts:158`, `args.ts:153`). Swap the extension instead.
- **C-19.** Split volumes derive odd extract folder names: `a.7z.001` -> `a.7z.001_extracted`
  (`extract-path.ts:66`). Multi-input archives are named after the first input. Protected-parent fallback
  knows only Windows folders; a source on a read-only volume defaults to a destination that cannot work
  (`extract-path.ts:177`).
- **C-20.** Power window size is saved from `window.innerWidth/Height` even when maximised
  (`ui/workspace.ts:249`), so it restores as a very large normal window. Double-click on the title bar
  probably cannot maximise because `core:window:allow-internal-toggle-maximize` is not granted. [target]
- **C-21.** Re-running the wizard and choosing Basic does not resync the Basic view
  (`power-events/settings.ts:148`). After step 0 the wizard has no skip, and Esc is swallowed; a wizard
  version bump forces returning users through all steps.
- **C-22.** File dialogs have no filters for archives or the output extension (`files.ts:71,114,204`).
- **C-23.** Command preview joins arguments with spaces and no quoting, so the copied text is not a
  runnable command (`command-sanitize.ts:17`).
- **C-24.** `formatSize` returns "NaN undefined" for negative or fractional input and "-" for a 0-byte
  file, which then looks like a folder (`utils.ts:159`). [probe]

### Updater

- **C-25.** "Later" on the update prompt triggers a notification permission request (`updater.ts:248`).
- **C-26.** "Update ready" is only a status-bar string that the next status overwrites; there is no
  persistent indicator (`updater.ts:166`).
- **C-27.** The restart prompt is a native modal that can appear in the middle of other work
  (`updater.ts:179`).

### Accessibility

- **C-28.** In the selective picker's search mode, each toggle re-renders the list and keyboard focus is
  lost, because focus restore only handles tree rows (`selective-tree-ui.ts:78-88,285-291`).
- **C-29.** `#progress`, `#status` and `#log` are polite live regions and receive progress every 75 ms
  (`run.rs:1339-1365`), so a screen reader is flooded. Announce at coarse steps instead.
- **C-30.** Basic progress bars (`role="progressbar"`) have no accessible name. Basic tabs lack
  `aria-controls` and their panels lack `aria-labelledby`. `#input-list` has `role="list"` with no
  `listitem` children. Two `<h3>` completion titles are empty until used.
- **C-31.** The Recent menu uses `role="menu"`/`menuitem` without arrow-key navigation or focus
  management (`basic/recent.ts:108-172`).
- **C-32.** Native-menu "Keyboard Shortcuts" and "Licenses" can open over another dialog with no check,
  and Esc then closes the lower one first (`power-shortcuts.ts:6`, `keyboard.ts:44-66`). The title bar
  and header stay clickable under every modal (`utils.ts:36-44`).
- **C-33.** The density toggle changes both its label and `aria-pressed`. `#open-settings` uses
  `aria-expanded`/`aria-controls` where `aria-haspopup="dialog"` fits. The hidden debug toggle
  (`img#about-debug-toggle`) is in the tab order.
- **C-34.** Control borders use 8-14% alpha and compute to roughly 1.2:1 against the surface (WCAG 1.4.11
  asks for 3:1). Text is 10 px in 10 rules and 11 px in 24, including validation reasons and help text.
- **C-35.** Timed toasts cannot be dismissed from the keyboard; only sticky ones handle Esc.
- **C-36.** `trapFocus` sets initial focus with an unfiltered `querySelector`, which can pick a hidden
  element (`utils.ts:137`).

### Visual and copy

- **C-37.** Toast text ignores the `\n` separators many messages use (no `white-space: pre-line`) and
  has no `overflow-wrap: anywhere`, so Windows paths can overflow the 360 px toast. Sticky toasts stack
  without limit (`styles/main-mid-overlay-toast.css:149-180`).
- **C-38.** Terminology varies: Add / Compress / Make an archive; Extract Selected / Selective Extract /
  Select items...; List / List contents; Archive destination / Output path. Basic's "Choose folder" opens
  a save-file dialog. OS Integration help uses "sparse identity package", "NSIS" and "ProgId".
- **C-39.** Validation messages appear under the title "Operation failed" in Basic
  (`basic/actions.ts:316`). The busy toast says "preparing another action" when a job is running
  (`basic/actions.ts:297`). Incoming-path errors say "dropped files" for Explorer hand-offs
  (`incoming-paths.ts:184`).
- **C-40.** The quick-extract window shows a full bar on some cancel paths and an empty one on others
  (`run-core.ts:343,355,382,472,499`).
- **C-41.** "Local logging: privacy-preserving" is generous. Logs hold full paths, and debug verbosity
  holds up to 20,000 characters of 7-Zip output per stream. Recents were made session-only for that
  reason. Reword the setting or redact the home directory.
- **C-42.** Release notes for the beta include internal detail (journal field names) that users cannot
  act on.

### Performance and maintainability

- **C-43.** The activity log and debug console append with `textContent +=` and re-split the whole text
  on every line (`ui/log.ts:68-92`, `debug-mode.ts:110-116,262`).
- **C-44.** The selective picker rebuilds the entry tree, the filter and up to 1,000 rows on every
  toggle, expand and keystroke; `resolveSelectiveExtractMemberPaths` is O(folders x entries); tree sort
  is not numeric-aware (`selective-tree-ui.ts:367-387`, `selective-extract.ts:230,294`).
- **C-45.** Basic's interaction lock keeps removed controls in a `Map` (`basic/progress.ts:143-165`).
  Two Basic buttons decide what to do by comparing their label to "Close" (`basic/wire.ts:531`,
  `extract-events.ts:140`). `setRunning` only resets the buttons of the current mode
  (`ui/status.ts:62-83`).
- **C-46.** `SETTING_DEFAULTS.threads` is mutated at startup (`app-init.ts`). `"-mhe="` in the frontend
  method allow-list is unreachable (`archive-rules.ts:12,165`). `resetRuntimeStateForFirstRun` skips the
  identity cache (`power-helpers.ts:52`). The light-theme tokens are duplicated in `variables.css`.
- **C-47.** ESLint rules cover `scripts/**/*.{js,ts}` and `e2e/**/*.js` only; 26 `.mjs` and 12 `.cjs`
  scripts, plus `bench/`, get no rules, and there is no `eslint:recommended` base. `tsconfig.json`
  includes Node types for webview code.
- **C-48.** Release profile lacks `overflow-checks = true` (`Cargo.toml`). Several CI jobs have no
  `timeout-minutes`. Dependabot does not watch the vendored crates under `src-tauri/vendor/`.
- **C-49.** The quick-extract window reads settings twice at startup (`extract-window/fx.ts:32`,
  `run-core.ts:91`) and has no clipboard fallback for "Copy details" (`run-core.ts:159`).
- **C-50.** A crash can leave `zinnia-7z-list-*` directories holding path names in the system temp
  folder (`argv.rs:92-96`); confirm the stale sweep covers them.

---

## Checked and found sound

So the next reader does not repeat the work:

- Adding files to a header-encrypted 7z keeps header encryption (wrong password still fails to open).
  [probe]
- Trailing data after a 7z, ZIP or TAR archive exits 0 and extracts normally. [probe]
- TAR, GZIP, BZIP2, XZ and ZIP-LZMA switch combinations built by the UI all succeed. [probe]
- CSP has no inline script or style, and the HTML has no inline handlers or `style` attributes.
- `innerHTML` is used three times, all with static strings. External links use `safeHref`.
- E2E hooks are compiled out of production builds (`VITE_ZINNIA_E2E`).
- The extract-window init script escapes U+2028/U+2029 and embeds JSON only.
- `open_path` opens only allow-listed real directories.
- Workflows pin actions by SHA, use read-only permissions, and disable credential persistence.
- No duplicate ids, no dangling `aria-*`/`for` references, no controls without a name (one hidden
  `<select>` aside), reduced-motion and forced-colors rules exist.
- The first 520 lines of the Explorer shell extension: bounded buffers, guarded COM entry points,
  private DACL on the hand-off file.

## Suggested order

1. A-04 (reconcile branches) first, so fixes land on the real release base.
2. A-01, A-02, A-03: small changes, security or integrity impact.
3. A-05 on a Windows machine, in parallel.
4. B-09, B-10, B-11, B-05, B-06: small and contained.
5. B-01, B-02, B-03, B-07: these share the listing and argument limits; design them together.
6. The rest of P2, then P3 in themed batches (operations, settings, accessibility, copy).

For each fix, write the failure inventory before the code and prove it with an E2E scenario that leaves
a repeatable artifact, as `AGENTS.md` requires.

> **Reminder: delete `plan.md` once every item has been fixed, deferred with a note elsewhere, or
> rejected.**
