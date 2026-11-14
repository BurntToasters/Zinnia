# Windows shell integration failure inventory

This inventory was written before changing production code. It covers four
suspected Windows shell defects found by reading code, and the beta 2 rows added
to `docs/QA-CONTEXT-MENUS.md`:

1. Classic Extract verbs survive a successful Windows 11 registration
   (`src-tauri/windows/nsis-hooks.nsh`).
2. An empty `Zone.Identifier` stream fails the Mark-of-the-Web copy
   (`src-tauri/src/process/archive_snapshot/motw.rs`).
3. The shell extension leaks COM objects and CoTaskMem strings when
   `std::bad_alloc` is thrown (`src-tauri/windows/shell/dllmain.cpp`).
4. A snapshot is left behind when the Zone.Identifier copy fails
   (`src-tauri/src/process/archive_snapshot/copy.rs`).

Status keys: `TEST` means a Rust test named in the item runs on this machine.
`READ` means the path was checked by reading the code because no automated run
can reach it here (no signed NSIS installer, no shell DLL build, no makensis).
`UNVERIFIED` means the change has not been executed.

## 1: Classic Extract verbs survive a Windows 11 registration

Status: confirmed by reading. Fix: `READ` only, UNVERIFIED on Windows.

Hook placement: `src-tauri/tauri.conf.json` sets `installerHooks` to
`windows/nsis-hooks.nsh`. The Tauri NSIS template (embedded in
`node_modules/@tauri-apps/cli-win32-x64-msvc/cli.win32-x64-msvc.node`) runs
`!insertmacro NSIS_HOOK_POSTINSTALL` after files and shortcuts are written. The
modern-versus-classic decision lives in that macro, so the fix belongs there.

Verbs written by the fallback path (`NSIS_HOOK_POSTINSTALL` when `$R6` is 0 or
2, through `ZINNIA_POSTINSTALL_CLASSIC_EXTRACT_FALLBACK`):

- `HKCU\Software\Classes\SystemFileAssociations\<ext>\shell\ZinniaExtract`
  (with its `\command` subkey) for 11 extensions: .7z, .zip, .tar, .gz, .bz2,
  .xz, .rar, .tgz, .tbz2, .txz, .001.
- `HKCU\Software\Classes\*\shell\ZinniaCompress`,
  `HKCU\Software\Classes\Directory\shell\ZinniaCompress` and
  `HKCU\Software\Classes\Directory\Background\shell\ZinniaCompress`. These come
  from `ZINNIA_REGISTER_COMPRESS_VERBS`, which runs on every install before the
  `$R6` branch.

Verbs removed by the modern path (`$R6` is 1 or 3) before the fix:

- The three Compress keys only (`ZINNIA_UNREGISTER_COMPRESS_VERBS`).
- The 11 `ZinniaExtract` keys are not removed. The DetailPrint in the
  `zinnia_postinstall_win11_ok` branch says "Removing classic Extract/Compress
  verbs", which the code does not do.

Coverage of the modern Extract package: `ExtractAppxManifest.xml.template`
declares the same 11 `desktop5:ItemType` values, so removing classic Extract
does not remove a file type from the menu.

The registration script `scripts/register-windows-context-menu.ps1` writes and
removes no HKCU classic verbs. It needs no change for this defect.

Ways the fix could fail or regress:

1. The modern path deletes a key the fallback never wrote, or a different hive.
   Mitigation: the modern path calls `ZINNIA_UNREGISTER_ARCHIVE_VERBS`, which
   deletes `HKCU\Software\Classes\SystemFileAssociations\<ext>\shell\ZinniaExtract`,
   the same key `ZINNIA_REGISTER_CLASSIC_EXTRACT` writes.
2. The removal list drifts from the fallback list. Mitigation: the 11 removal
   calls move into one macro that is used by both the modern branches and
   `NSIS_HOOK_POSTUNINSTALL`, so one list is the source of truth. The archive
   checker `scripts/check-archive-formats.mjs` reads the
   `ZINNIA_UNREGISTER_ARCHIVE_VERBS` calls (layer `windowsClassicArchiveVerbs`)
   and must still report 11 entries in the same order.
3. The uninstall path stops deleting the 11 keys during the refactor. Mitigation:
   `NSIS_HOOK_POSTUNINSTALL` calls the same macro, so the set is unchanged.
4. The deferred path (`$R6` is 2) loses the classic fallback while the modern
   menu is only staged. Mitigation: the removal is added only to the `$R6` 1 and
   `$R6` 3 branches. The deferred path still goes to the fallback, as the
   comment in `register-windows-context-menu.ps1` requires.
5. A restored older payload (`$R6` is 3) declares fewer Extract types than the
   current template, so removing classic Extract would leave a type with no
   Extract entry. Residual risk: the restored payload is an older build and this
   is not covered by any test. The Compress removal already has this property on
   the restored branch.
6. The DetailPrint text and the code disagree. Mitigation: after the fix the
   message is accurate for both branches.
7. A deferred registration that later completes on an Explorer restart does not
   run the NSIS hook again, so classic Extract stays until the next install or
   uninstall. Residual: this is existing behaviour and is not changed here.

Verification: `READ` for the registry outcome. It needs a signed NSIS install
over a classic-fallback install on Windows 11, followed by a registry query; the
QA row in `docs/QA-CONTEXT-MENUS.md` records that check. Run here:
`node scripts/check-archive-formats.mjs` reports OK, and
`npx vitest run src/tests/windows-context-menu-policy.test.ts` passes 10 of 10.
makensis is not installed, so the hook file is not compiled.

## 2: Empty Zone.Identifier stream fails the copy

Status: confirmed by reading. Confirmed by `TEST` before the fix (see the
results section at the end).

Behaviour today: `decode_zone_identifier` returns `None` for an empty byte slice
(the text branch fails `zone_text_is_valid("")`, the UTF-16 branches need at
least two bytes). `copy_windows_zone_identifier_with_identity` then returns
`Err("Archive Mark-of-the-Web has an invalid format.")`. A missing stream is
handled as success (`ErrorKind::NotFound` returns `Ok(())`), so an empty stream
is treated more strictly than an absent one.

Callers that propagate the error: `process/archive_snapshot/copy.rs:453` (the
snapshot byte copy, where this function does not remove the snapshot file on
that error), `process/commit/publish.rs:136`, and `quarantine.rs:210`.

Ways the fix could fail or regress:

1. The empty stream is treated as "no zone", but the destination still receives
   a zero-length `:Zone.Identifier`. That is the same malformed state the
   defect describes. Mitigation: return `Ok(())` before the destination stream
   is opened. Coverage: `TEST` `empty_zone_identifier_stream_is_treated_as_no_zone`
   asserts the destination stream is `NotFound`.
2. The empty check runs before the source re-open identity check, so a swapped
   source returns `Ok(())` and skips `SOURCE_CHANGED`. Mitigation: the check runs
   after the identity comparison, just before decoding. Coverage: `READ` only,
   because the race cannot be scheduled deterministically in a test.
3. The size limit or the read rejects an empty stream before the check runs.
   Mitigation: a zero-length stream passes the `MAX_ZONE_BYTES` limit, and the
   check runs on the bytes already read, so it cannot be bypassed.
4. Whitespace-only or BOM-only streams still fail with "invalid format". This is
   outside the reported defect and is left unchanged. No test covers it. Residual.
5. The fix changes how valid streams are copied. Mitigation: the copy path is
   unchanged; `TEST` `zone_transfer_header_without_zone_id_is_copied_verbatim`
   and `TEST` `zone_id_three_is_copied_verbatim` pin the existing verbatim copy
   for the two valid shapes.
6. The new tests pass without exercising NTFS. Mitigation: the stream is created
   with `std::fs::write` on `<file>:Zone.Identifier` using `expect`, so a volume
   without alternate data streams fails the test rather than skipping it.
7. Tests leave temporary data behind. Mitigation: a Drop guard removes the
   scratch directory, including its alternate streams.
8. The new test module compiles on other platforms and treats `:Zone.Identifier`
   as a file name there. Mitigation: the module is `#[cfg(all(test, windows))]`,
   matching the file's existing `#[cfg(windows)]` gating.
9. Clippy `-D warnings` rejects the test code. Mitigation: the code uses `expect`
   and `expect_err` with messages and no `unwrap`. Coverage: the clippy gate with
   `--all-targets`.
10. An empty source leaves an existing destination stream in place. This matches
    the `NotFound` path today, is not changed, and is residual.

Tests written before the fix:

- `empty_zone_identifier_stream_is_treated_as_no_zone`: source stream is empty.
  Expected to fail before the fix with the invalid-format error.
- `zone_transfer_header_without_zone_id_is_copied_verbatim`: source stream is
  `[ZoneTransfer]\r\n`. Expected to pass before and after the fix.
- `zone_id_three_is_copied_verbatim`: source stream is
  `[ZoneTransfer]\r\nZoneId=3\r\n`. Expected to pass before and after the fix.

## 3: Shell extension leak on bad_alloc

Status: confirmed by reading. Fix: `READ` only, UNVERIFIED because the shell DLL
is not built here.

Leak site A, `GetSelectedPaths` (`dllmain.cpp` lines 112-141): after
`GetDisplayName` returns a non-null PWSTR, `out->emplace_back(path)` runs before
`CoTaskMemFree(path)` and `item->Release()`. If it throws `std::bad_alloc`, the
PWSTR and the `IShellItem` reference are both leaked. The only handler is
`GuardedCall` at the entry point, which converts the exception to
`E_OUTOFMEMORY` and does not know about either object.

Leak site B, `GetFolderPathFromSite` (lines 145-170): `*out = path;` runs before
`CoTaskMemFree(path)`, so a throw from the string assignment leaks the PWSTR.
This is the same pattern in the same file and is fixed in the same change.

Fix shape: owners with a custom deleter for `CoTaskMemFree` and
`IShellItem::Release`, so each object is released on every path, including the
exception path. The explicit free and release calls are removed so nothing is
released twice.

Ways the fix could fail or regress:

1. Double free or double release, if an explicit call stays next to its owner.
   Mitigation: the explicit `CoTaskMemFree` and `Release` calls are removed from
   both functions.
2. The `IShellItem` is released on the `GetItemAt` failure path. Mitigation: the
   owner takes the returned pointer unconditionally, so a non-null pointer is
   released even when `GetItemAt` reports failure. A null pointer is a no-op.
3. The string is read after the PWSTR is freed. Mitigation: the `std::wstring`
   copy happens inside the owner's scope, before the scope ends.
4. `std::unique_ptr` is used without `<memory>`. Mitigation: add the include.
5. `resolved != count`, `count > kMaxPathsPerRequest` and the other lines
   asserted by `src/tests/windows-context-menu-policy.test.ts` change text.
   Mitigation: those lines are kept verbatim.
6. A null PWSTR with `S_OK` is treated as resolved. Mitigation: the existing
   `path` condition is kept, so a null path still counts as unresolved and
   returns `ERROR_NOT_SUPPORTED`.
7. The deleter is not `noexcept`, so a release could throw during unwinding.
   Mitigation: both deleters are `noexcept`.
8. The change alters threading or the handoff path. Mitigation: no change outside
   the two functions and the include.

Verification: `READ`, plus a syntax check. MSVC `cl` (Build Tools 14.52) with
`/std:c++17 /EHsc /W4 /Zs` and the shell target's defines (`UNICODE`,
`_UNICODE`, `WIN32_LEAN_AND_MEAN`, `NOMINMAX`) compiles `dllmain.cpp` with no
diagnostics. That is a compile-only check: the DLL is not linked, loaded or run,
so the leak fix is unverified at runtime. The shell build
(`scripts/build-windows-context-menu.ps1`) and a bad_alloc injection run are the
remaining checks.

## 4: Snapshot left behind when the zone copy fails

Status: confirmed by reading (before the fix, `copy.rs` returned the zone error
with `?` and removed nothing). Confirmed by `TEST` before the fix (see Results).

Behaviour today: `copy_archive_snapshot_file` creates the snapshot with
`create_new` and copies the bytes. The Windows Zone.Identifier copy runs at the
end of that byte-copy tail with `?`, so an `Err` returns without calling
`remove_file_for_cleanup`. The byte-copy error just above the zone copy does
clean up, so the two paths disagree.

Reachability: on Windows, `copy_archive_snapshot_file` first tries CopyFile2
(`try_copy_file2_snapshot`). CopyFile2 keeps alternate streams, so a successful
CopyFile2 copies an invalid Zone.Identifier verbatim and returns without
validating it. The byte-copy tail, and therefore the zone error, runs only when
CopyFile2 declines. This is observed by reading and is not changed here.

Test reachability: the byte-copy tail moves unchanged into
`copy_archive_snapshot_bytes`, so the test can run it without CopyFile2. The
production call passes the same arguments in the same order.

Ways the fix could fail or regress:

1. Cleanup runs while the destination stream is still open, so the delete
   fails. Mitigation: `copy_windows_zone_identifier` drops its destination stream
   before it returns, so cleanup runs after the handle is closed. Coverage:
   `TEST` checks the snapshot file is gone.
2. Cleanup deletes a file this call did not create. Mitigation: the helper opens
   the destination with `create_new` just before the zone copy, so a pre-existing
   file fails earlier. Coverage: `READ`.
3. The returned message changes. Mitigation: a successful cleanup returns the
   original zone error text, the same shape as the byte-copy path. A failed
   cleanup appends the same "partial snapshot cleanup also failed" text as its
   siblings. Coverage: `TEST` asserts the exact message on the success path; the
   appended text on cleanup failure is `READ` only.
4. The extraction changes the CowClone, ByteCopy or space-check behaviour. Mitigation:
   the moved block is byte-identical, the space check stays in the caller before
   the call, and the arguments are unchanged. Coverage: the existing
   `windows_byte_copy_zone_identifier_helper_preserves_valid_stream` test, the
   progress tests in `copy.rs`, and the full `npm run test:rust` run.
5. The new Windows-only test module compiles on other platforms. Mitigation:
   `#[cfg(all(test, windows))]`.
6. `source_path` is unused on non-Windows and trips `-D warnings`. Mitigation: the
   existing `let _ = source_path;` stays in the helper.
7. Test temporary data stays behind when an assertion fails. Mitigation: a Drop
   guard removes the scratch directory.
8. A valid zone must still leave a snapshot. Coverage: the existing valid-stream
   helper test; the fix adds cleanup only on the error path.

Test written before the fix:

- `invalid_zone_identifier_removes_the_snapshot_and_keeps_the_error`: the source
  stream is `not a zone identifier`. Expected to fail before the fix, because the
  snapshot file remains.

## QA document

Status: documentation only.

Rows added to `docs/QA-CONTEXT-MENUS.md`, in the Windows 11 "Failure modes"
table:

- Quick extract into a read-only folder, then Choose another folder. The
  automated behaviour is covered by `e2e/specs/beta2-quick-extract-recovery.spec.js`
  (E2E-1, E2E-2). The QA row covers the packaged Windows build, where the picker
  is the native folder dialog that WebDriver cannot drive here.
- Reinstall over a classic-fallback install with a successful modern
  registration. Expects the HKCU classic Extract and Compress keys to be gone.
- Archive with an empty `Zone.Identifier` stream. Expects success with no
  Mark-of-the-Web on the output and no invalid-format error.

## Results

Recorded after the changes. Each row lists the command that backs it.

- Item 2 before the fix: `cargo test --locked --manifest-path src-tauri/Cargo.toml --bins motw::tests`.
  `empty_zone_identifier_stream_is_treated_as_no_zone` failed with
  "Archive Mark-of-the-Web has an invalid format."; the two pinning tests passed.
- Item 2 after the fix: the same command. All three tests pass.
- Item 1: `node scripts/check-archive-formats.mjs` reports OK;
  `npx vitest run src/tests/windows-context-menu-policy.test.ts` passes 10 of 10.
  The registry outcome is not executed (see the item 1 verification notes).
- Item 3: MSVC compile-only check of `dllmain.cpp` with no diagnostics. Runtime
  behaviour is not executed (see the item 3 verification notes).
- Item 4 before the fix: `cargo test --locked --manifest-path src-tauri/Cargo.toml --bins zone_cleanup_tests`.
  `invalid_zone_identifier_removes_the_snapshot_and_keeps_the_error` failed: the
  error text matched, but the 15-byte snapshot remained.
- Item 4 after the fix: the same command passes, and the `archive_snapshot` filter
  (26 tests, including the valid-stream Zone.Identifier and byte-copy tests) passes.
- Gates: `cargo fmt --manifest-path src-tauri/Cargo.toml --check` exit 0;
  `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  exit 0; `npm run test:rust` exit 0 (543, 9 and 1 tests); `npm run validate:no-em-dash` ok.
- Not run: the NSIS installer, the GUI app, `npm run test:e2e`, and any shell DLL link.
