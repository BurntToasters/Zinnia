# Audit presets failure modes

Written before changing the preset, compression-argument, output-path and
command-preview code (plan items B-05, B-12, C-15, C-16, C-18, C-19, C-22,
C-23 and the `-mhe=` part of C-46). Each item lists the concrete ways the fix
could fail or regress.

## B-05 Store preset compresses

Context: at level 0 the frontend emits `-m0=deflate`, so ZIP entries are
written as `Method = Deflate`. Omitting `-m0=` at level 0 makes 7-Zip store
them (`Method = Store`). Probe: 7,200 bytes gave Deflate with `-m0=deflate`
and Store without it.

1. The level-0 branch still emits `-m0=` for some format, so ZIP stays deflated.
2. Dropping `-m0=` at level 0 also drops `-md`/`-mfb` for 7z. That is intended,
   but a level-0 change must not leave a stale dictionary switch behind.
3. A non-zero level loses its `-m0=` switch by accident (off-by-one or a
   truthiness check on `"0"`, which is a truthy string).
4. ZIP with a password at level 0 must still get `-mem=AES256`; removing the
   method switch must not change encryption switches.
5. The sidecar round trip passes on the probe, but the GUI run writes a
   different method because the preset applies `method` after level.
6. The `Store` preset selection is lost after `applyPreset` because
   `updateCompressionOptionsForFormat` resets the method list.
7. The E2E check reads the wrong record. `7z l -slt` prints the archive header
   and member blocks, so the check must match the `Path = hello.txt` block.

## B-12 Typing an archive name discards a Browse-chosen folder

Context: the archive-name input rebuilt the whole output path from the first
input's parent on each keystroke. The fix replaces only the file-name component
of the current output path.

1. A folder chosen with Browse is replaced by the first input's parent on the
   next keystroke (the original bug).
2. The file-name split breaks on Windows separators, or on a path with no
   separator, so the folder is joined wrongly.
3. A name typed as `photos.7z` with format 7z gives `photos.7z.7z`. Stripping
   must be case-insensitive and must match the current format only.
4. Compound names such as `photos.tar.gz` with format gzip become
   `photos.tar.gz.gz`, or the `.gz` is stripped from the wrong place.
5. A name containing `/` or `\` is accepted and creates a nested path. It must
   be rejected with a visible message, and the output path must stay unchanged.
6. The rejection message repeats on every keystroke, or never appears because
   the field is re-rendered.
7. A name that is only an extension (`.7z`) becomes an empty stem and produces
   `.7z` as the output name. It must fall back to the source name.
8. The Basic archive-name field diverges from the Power output path after the
   round trip through `syncBasicToPower`.
9. Autofill (no custom name) must still produce the source-derived name, so the
   default for a new selection does not regress.
10. The fix must not change the output path while the user has not typed in the
    archive-name field (format change, input change).

## C-15 Preset save/delete and debug toggle race

Context: `persistSettingsImmediately` throws `SettingsPersistSupersededError`
when a newer snapshot is queued. The Settings save path retries after
`awaitInFlightSettingsPersistence`. Preset and debug code rolled memory back on
that error while the newer snapshot still reached disk.

1. The superseded error still rolls back `customPresets` or `debug`, so memory
   and disk disagree.
2. The retry runs before the in-flight write finishes and is superseded again,
   which loops or drops the change.
3. A non-superseded error is swallowed by the retry branch.
4. `debug-toggle.ts` assigns `state.currentSettings = nextSettings` before the
   retry completes, so a failed retry leaves debug on in memory.
5. The race cannot be produced deterministically through the GUI. It is covered
   by mirroring the Settings save pattern and by code review, not by E2E.

## C-16 Built-in preset names and length

Context: `trimmed in PRESETS` walks the prototype chain, so `toString`,
`constructor` and `valueOf` were rejected as built-in names. Names also had no
length limit.

1. `Object.hasOwn` is not available in the target runtime. The target is
   ES2022 and WKWebView is recent, but this must be checked by typecheck.
2. Lookups in `applyPreset` still use `PRESETS[name]`, so a stored name such as
   `constructor` returns an inherited value.
3. A 64-character limit counts UTF-16 units; a name with emoji can exceed the
   visible limit while looking short. Accept the simple `length` count and
   document it.
4. The limit error is shown only as a generic "Could not save preset" toast,
   without the limit text.
5. A saved name at exactly 64 characters is rejected (off-by-one).

## C-18 Changing format keeps the old extension

Context: a manually chosen output path is not autofilled, so changing format
left `out.7z` as a zip. The run then fails extension validation.

1. Compound extensions (`.tar.gz`, `.tgz`) are not swapped as a unit, leaving
   `x.tar.7z` or `x.tgz.zip`.
2. An output name with no known archive extension (`report.final`) loses its
   stem when the extension is swapped.
3. The swap runs even when the output path is empty, creating a bare extension.
4. Basic format changes do not swap the Basic output field, so Basic and Power
   disagree after switching format.
5. Autofilled paths must still be regenerated by the existing autofill path,
   not double-swapped.

## C-19 Split volume and multi-input default names

Context: `a.7z.001` derived `a.7z.001_extracted`. Multi-input compression was
named after the first input. Protected-parent fallback is Windows-only, and a
read-only source volume default is not handled.

1. `a.7z.001` must strip the numeric volume suffix and then the archive suffix,
   so the folder is `a`. `a.z01` and `a.part1.rar` need the same handling.
2. A plain numeric-looking name (`report.2024`) without a split marker must not
   be stripped as a volume.
3. Multi-input naming must use the shared parent's basename. When inputs have
   different parents, keep the first input's name.
4. A shared parent at a drive or filesystem root has an empty basename and must
   fall back to the first input's name.
5. The sanitizer must still reject unsafe folder names (`CON`, trailing dot)
   after the new stripping.
6. Read-only volume fallback: no existing backend command reports that a folder
   is not writable (checked `src-tauri/src` for writability commands). Deferred.

## C-22 File dialog filters

Context: the open-archive dialogs (Basic) use a hard-coded list, and the save
dialog for output had no filter.

1. Adding inputs in compress mode must not be filtered to archive extensions,
   because compression accepts any file.
2. An archive filter that is missing `001` or `rar` hides valid split and RAR
   archives.
3. The save filter must follow the selected output extension, including
   `gzip` -> `gz` and `bzip2` -> `bz2`.
4. The "All files" option must remain available so unusual names still open.
5. Dialog filter options must not change the chosen path; cancel must still
   leave the field unchanged.

## C-23 Command preview quoting

Context: the preview joined arguments with spaces. Quoting must make the copied
text runnable, and password masking must still apply before quoting.

1. Quoting before masking would put the real password inside quotes in the
   preview. Masking must run first.
2. A password-free argument containing a space (for example a path) must be
   quoted, and an embedded single quote on POSIX must be escaped as `'\''`.
3. Windows uses double quotes. An embedded `"` must be escaped.
4. Plain arguments such as `-mx=5` or `--` must stay unquoted for readability.
5. Platform detection reads the `platform-windows` body class that app-init sets.
   Before startup finishes the class is absent and the POSIX form is used. Importing
   `state` here would touch the DOM at module load and break test setup.

## C-46 `-mhe=` in the frontend allow-list

Context: `validateExtraArgs` rejects any argument starting with `-mhe` through
the `blocked` list before it reaches the method allow-list. So the `-mhe=`
prefix in `ALLOWED_METHOD_PREFIXES` cannot be reached from extra args.
Callers that emit `-mhe=on` (`archive/args.ts`, `archive/mutations.ts`) build
it directly and do not pass through the allow-list.

1. Removing the prefix must not affect the switch that encrypts headers. The
   switch is built in `buildArgs` and `mutations.ts`, not validated.
2. `arg-allow-list-sync.test.ts` compares the frontend list with Rust
   `PREFIXES`, which still contain `-mhe=`. The expectation must change on
   purpose, and the Rust list is left for its owner.
3. A user typing `-mhe=off` in extra args must still be rejected.

## Deferred

- C-19 read-only volume fallback: no backend command reports folder
  writability (checked `src-tauri/src` for writability commands). Revisit when
  such a command exists.
- C-15: no deterministic GUI path to the superseded race. Covered by pattern
  match with the Settings save path, not by an E2E case.
- C-22 Basic open-archive dialogs (`src/basic/wire.ts`): the Basic filter lacks
  an "All files" option. Basic wire-up outside the archive-name and output-path
  code belongs to another worker, so it is left as is.
- C-23 quoting has no unit test. Its E2E case reads the preview modal, which
  needs the built app to run.
