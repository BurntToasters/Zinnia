# Argument and list-file failure inventory

This inventory was written before changing production code. It covers audit
items A-03 (list-file quoting), B-06 (switch rules after `--`), B-01 (member
cap) and C-50 (stale list-directory sweep).

## Managed list-file line quoting (A-03)

7-Zip's list-file reader trims whitespace around each line and strips exactly
one surrounding pair of double quotes. A raw line therefore loses leading and
trailing spaces, and a name wrapped in quotes loses its own quotes. The
fix writes every line as `"<name>"`.

1. The `./` neutralization for compress inputs that start with `-` must be
   applied before the quotes are added. `./` placed after the quote
   (`"./-x"` versus `./"-x"`) would keep the leading quote in the name.
2. Only the compress branch could be wrapped while the extract branch keeps
   raw lines. Extract selections (`report `, ` lead.txt`) would then still
   substitute `report`. Both branches must share one writer.
3. A name that already starts and ends with `"` must gain exactly one pair
   (`""quoted""`). A fix that strips, escapes, or deduplicates quotes would
   turn `"quoted"` into `quoted` and select the sibling.
4. Embedded quotes (`x"y`, `"mid"dle"`) and trailing backslashes (`trail\`)
   must round-trip. Probed with the bundled 7-Zip 26.06: all exact.
5. A name containing CR, LF or NUL would split into several list entries or
   truncate a line. The writer must reject these (`prepare_managed_listfile`
   already rejects CR/LF; NUL is added there as defense in depth, and
   `validate_run_7z_args` rejects NUL for every argument).
6. A rejected name must not leave a partial list file. The `ManagedListFile`
   drop guard must still remove the file and its private directory on error.
7. The `-scsUTF-8` switch must stay in the rewritten command. Without it,
   non-ASCII names are decoded with the host code page and no longer match.
8. Ordinary paths with spaces (`C:\My Docs\a.txt`) must not change meaning on
   Windows. Windows cannot be checked on this host, so this is `[target]`.
   The Windows E2E run (not this host) is the check.
9. The quoted form must not be written for the sidecar's own `@listfile`
   reference or for the archive path. Only selected member lines are wrapped.

## Switch rules apply before `--` only (B-06)

After the first `--`, every argument is a literal path or member name. A
member named `-web/app.js` or `-sidebar.png` must not be checked as a switch.
Path safety that is not a switch rule must still run on those names.

1. Blocked-switch matching (`-si`, `-so`, `-sdel`, `-w`, `-sns`, and the rest)
   must not run after `--`. Members `-work.txt` and `-sdel.txt` must pass.
2. The `@listfile` and embedded-listfile checks (`has_embedded_listfile`) must
   not run after `--`. The `@` in `-icons/@2x.png` is a literal character.
3. NUL and `..` parent-directory rejection must keep running after `--`.
   Moving the whole loop under the separator guard would drop them.
4. The `-p` line-break check and the password/output/overwrite counts must
   stay before `--`. A member named `-pending.zip` must not count as a second
   password or be consumed by `prepare_password_transport`.
5. A second `--` after the first is a literal member name, not a separator
   error. A member named `--` must be selectable.
6. Helpers that scan the whole argument vector instead of the switch region
   can drop or change members: `apply_backend_link_switches` retained every
   `-snld*` and `-sns*` argument, `harden_7z_args` retained every `-scc*` on
   Windows and every `-mcu`/`-mcl`, and both used `any` to skip inserting
   `-spd`, `-snl`, `-snh`, `-spod` when a member had that name. A member named
   `-snldfoo` would be deleted from the selection, and a member named `-spd`
   would stop 7-Zip from receiving the wildcard-disabling switch. These must
   operate on the switch region only.
7. `is_zip_create_or_update` used `any` over all arguments, so a member named
   `-tzip` could force `-mcu=on`. It must scan the switch region only.
8. For `x`, an archive name after `--` that starts with `-` or `@` is still
   neutralized by the list-file rewrite (`./`). Without a list file (no
   selection), 7-Zip receives the archive literally after `--`, which is safe.
9. An extract whose only selected member is switch-shaped (`-web/app.js`)
   must still produce a list-file reference, not an empty or switch-shaped
   command.
10. Compress include (`-i!`) and exclude (`-x!`) payload checks stay before
    `--` only (they already are). A member named `-i!foo` is a literal name.

## Member cap (B-01)

`MAX_7Z_ARGS` (8192) applied to the whole vector, so 9,000 selected members
failed with "Too many 7z arguments."

1. The 8192 cap must count only the switch region (command, switches and
   archive). Counting all arguments would still reject 9,000 members.
2. The member cap must come from `quota::MAX_EXTRACT_ENTRIES`, not a copied
   number. The boundary is exactly 1,000,000 members accepted and 1,000,001
   refused.
3. The `x`, `l` and `t` commands have the archive as the first argument after
   `--`. The member count must exclude it, or the boundary is off by one.
4. `validation.rs` cannot reach `process::quota` (a private module of
   `process`). The member check therefore lives in `process/commands.rs`,
   which is inside the `process` tree. Tests must confirm both places agree.
5. The IPC request still has the 64 MiB aggregate byte cap, in Rust and in
   `backend-ipc.ts`. A pathological selection of 1,000,000 long names can hit
   that cap first. The error text must say the request is too large, not
   "too many members". 9,000 typical names (about 1 MB) are far below it.
6. Per-argument byte cap (8192) stays for members. It matches the frontend
   `MAX_ARCHIVE_MEMBER_PATH_BYTES`, so long names are refused the same way.
7. Frontend: `buildSelectiveExtractArgs` spreads the selection into `args`.
   Very large spreads can exceed the JavaScript call-stack limit at around
   100k entries. That file (`selective-extract.ts`) is not owned by this
   worker; reported, not changed. 9,000 is well below it.
8. Outside the owned files, the browse listing (`MAX_OUTPUT_BYTES`, 10 MiB) and
   the extraction preflight (`LIST_OUTPUT_LIMIT`, 32 MiB) bound the archive
   listing, not the selected members. About 30,000 entries exceed the browse
   cap (B-02). The 9,000-file archive is about 3 MB of listing, so it fits.
9. The browse and selective tree render at most 1,000 rows, but selecting a
   folder expands it through the scope entries, not the rendered rows. The
   E2E must toggle the folder row, not its rendered children.
10. `resolveSelectiveExtractMemberPaths` must still drop non-empty folders
    and keep empty folders for the 9,000-member case.

## Stale list-directory sweep (C-50)

Verified by reading, not changed. `tempdir::sweep_stale_7z_list_dirs` already
runs from `sweep_stale_launch_temp_files` at startup (`main.rs`).

1. The sweep matches only `zinnia-7z-list-` plus exactly 32 hex characters.
   `staging::random_token` must keep producing 32 lowercase hex characters
   (16 bytes). A change to the token length would silently stop the sweep.
2. Directories must contain only `items.txt` to be removed. A changed file
   name in `ManagedListFile` would leave every leftover directory in place.
3. The age threshold is 10 minutes. A directory newer than that is skipped
   until the next launch.
4. Symlinks and reparse points are skipped. On Unix, a directory owned by a
   different uid or gid is skipped.
5. The sweep and `prepare_managed_listfile` must use the same temp directory
   (`std::env::temp_dir()`).

## Test coverage plan

- E2E (`e2e/specs/audit-argv.spec.js`, POSIX-only cases skipped on win32):
  compress inputs `report `, ` lead.txt`, `"quoted"` (with siblings);
  selective extract of `report `, `-web/app.js`, `-work.txt`, `-sidebar.png`,
  `-icons/@2x.png`; selective extract of a folder with 9,000 files.
- Sidecar (`src-tauri/tests/sidecar_roundtrip.rs`, POSIX-only): list-file
  lines wrapped in quotes round-trip exact names for create and extract.
  This pins the 7-Zip contract the fix depends on.
- Rust unit tests in `validation.rs`, `commands.rs` and `argv.rs`, written
  before the code they cover: switch-shaped members after `--`, the switch-
  region count and the member cap, quoted list-file output, the CR/LF/NUL
  rejection, and the switch-region helpers.

## Deferred

- Windows verification of quoted list lines and ordinary paths (item A-03.8):
  needs a Windows host or CI run. Not checkable on macOS.
- Frontend spread of very large selections (item B-01.7): `selective-extract.ts`
  is outside this worker's files.
