# Large-archive merge batching failure inventory

This inventory was written before changing production code. It covers worker
2A (rust-merge-batching): the slow publish of a very large ZIP into an existing
destination folder, seen in beta 1 with a 110,000-entry archive that staged in
about a minute but did not publish within 20 minutes. It follows the open
"New finding, not fixed" bullet in `audit-listing.failure-modes.md`.

## Diagnosis (measured before any change)

Host: Windows 11 on NTFS, debug test build. A temporary `#[ignore]` harness
replayed the merge loop of `merge_staged_extract_recorded` one phase at a time,
then deleted itself. The destination was pre-created with one file and the
stage sat inside it (`InsideDestination`, the same placement the E2E case
uses). Two name shapes were measured: E2E-style names (`extract-000001.txt`,
14 characters, which NTFS must give 8.3 short names) and 8.3-compatible names
(`f00001.t`).

Full merge time (`merge_staged_extract`, no-op recorder, the path the Rust
tests use):

| Entries | E2E-style names | 8.3-compatible names |
| --- | --- | --- |
| 5,000 | 17.9 s (3.6 ms per entry) | 9.8 s (2.0 ms per entry) |
| 20,000 | 76.5 s (3.8 ms per entry) | 36.8 s (1.8 ms per entry) |

Per-entry phase cost in the loop, microseconds, E2E-style names:

| Phase | 5,000 entries | 20,000 entries |
| --- | --- | --- |
| validate (`validate_move_record`, ancestors, target absent) | 53 | 52 |
| fingerprint source (`path_identity_with_fingerprint`) | 244 | 235 |
| identity log append (write, fsync, identity check) | 2,512 | 2,534 |
| recorder journal (production shape: two `atomic_write_text` and one read) | 9,221 | 9,151 |
| rename (`rename_file_no_replace`) | 575 | 560 |
| verify target fingerprint | 243 | 234 |
| loop total | 64.3 s (12.9 ms per entry) | 255.4 s (12.8 ms per entry) |

Seal and the final directory sync take about 30 ms and 110 ms. Planning takes
about 0.4 s and 1.7 s.

Full merge with the production-shaped recorder (simulated journal, one recorder
call per log record and per plan record, as in the loop above) is recorded in
the "Measured after" section, with the same harness run before and after.

Bytes on disk, measured from the serialized structures:

- Move plan: 328 bytes per entry at a 130-character temporary path (306 bytes
  for 8.3 names). 110,000 entries need about 36 MB. The cap
  `MAX_MOVE_PLAN_BYTES` is 32 MiB (33.5 MB), so a 110,000-entry plan is refused
  before any publish. Longer real paths make this worse.
- Identity log: 377 bytes per record, independent of path length. 110,000
  records need about 41.5 MB. `MAX_MOVE_IDENTITY_LOG_BYTES` is 32 MiB, so the
  log cap refuses record number 89,000 or so, after roughly 9 to 19 minutes of
  work (at 6.3 to 12.8 ms per entry, the range measured on this host). Two
  records per entry (a copy-fallback correction) halve that point.

Search for superlinear work (the task asked to look especially for these):

- Every per-entry phase is flat between 5,000 and 20,000 entries, so no
  O(n) term per entry was reproduced on this host.
- Checked and constant per entry: `validate_move_record`,
  `assert_safe_extract_target_ancestors`, `path_entry_exists`,
  `ensure_path_identity` (metadata only, no rehash), the append path,
  `record_extract_artifact_identity` (the cleanup journal and pending registry
  hold one record per stage, so their size does not grow with entries), and
  `write_move_plan` (called once).
- One real O(links x plan) scan: `final_path_for_staged_source` filters the
  whole plan for every symbolic link, and it runs twice per link in
  `prepare_planned_links`. It is quadratic for archives with many links. Fixed
  in this piece (see F4).
- `auto_rename_path` loops only on real name collisions (up to 10,000 names).
  Not changed.
- The quota monitor scans the whole stage repeatedly during 7-Zip, but
  `run.rs` sets `quota_finished` and awaits the task before commit, so the scan
  does not overlap the merge. Not the cause.

Conclusion: the merge is linear here with a large constant. The dominant
per-entry cost is the production journal (about 9 ms: two atomic file rewrites
with fsync and one read) plus one fsync per identity log append (about 2.5 ms).
At 6.3 to 12.8 ms per entry, 110,000 entries take about 11.5 to 23.5 minutes,
which brackets the beta 1 report of no publish within 20 minutes. The beta 1 "superlinear" observation was made on macOS, where
`sync_all` is `F_FULLFSYNC`; it is not reproduced on Windows. A macOS run is a
`[target]` check. The two byte caps would also stop the 110,000-entry publish
on this host, so both caps are part of the fix.

## F1: batched identity journaling in the merge loop

Context: one identity log append (with fsync), one recorder journal update and
one rename per entry. The fix appends up to `MOVE_IDENTITY_BATCH_RECORDS` (256)
consecutive direct-rename records in one write with one fsync, calls the
recorder once with the batch log fingerprint, and then renames those records
one by one. Target-local publishes and post-rename identity corrections keep
per-record journaling.

1. An object is renamed before its batch identity is durable in the log, or
   before the journal records the log fingerprint. Test:
   `batch_journal_is_durable_before_its_renames` (at the journaled event the
   test reads the log from disk and checks its length and fingerprint against
   the recorded identity; at each rename event it checks that the renamed
   index is covered by the journaled batch).
2. A batch journal failure still publishes something. Test:
   `batch_journal_failure_publishes_nothing` (the test recorder returns an
   error at the journaled event; no target may exist and every source must
   remain).
3. The recorder is called once per record instead of once per batch (the
   per-entry cost returns). Test: `merge_publishes_257_entries_in_two_batches`
   asserts exactly five recorder calls for 257 entries (plan, log creation, two
   batches, seal).
4. Batch boundary off by one (256 and 257). Test:
   `merge_publishes_257_entries_in_two_batches` publishes all 257 entries and
   checks the file count.
5. A target that appears after the batch was journaled is overwritten or
   merged. The preflight must run again at rename time. Test:
   `batch_target_created_after_journal_is_refused` (creates a colliding target
   at the journaled event; expects "Extraction destination changed during
   commit", the earlier renames rolled back and every source present).
6. A source that changes between its fingerprint (before journaling) and its
   rename is accepted. The post-rename fingerprint check must still run. Test:
   `batch_source_change_after_journal_is_refused` (rewrites a source at the
   journaled event with the same length; expects "Extraction link changed
   during commit").
7. A crash after the batch journal and before any rename is not recoverable.
   Test: `merge_crash_after_batch_journal_recovers_clean` (panic injected at the
   journaled event, then `rollback_persisted_move_plan` with the journaled
   identities; the stage must be intact and the destination must hold only the
   pre-existing file). This also covers "journaled in a batch but never
   renamed" in rollback. The companion
   `merge_crash_before_batch_journal_recovers_from_unjournaled_tail` crashes
   after the batch lines are written but before the journal is updated, so
   recovery must accept a three-record unjournaled tail through the F2 rule.
8. A crash between two renames of one batch is not recoverable. Test:
   `merge_crash_mid_batch_recovers_clean` (panic after the first rename of a
   three-entry batch; recovery must restore the renamed entry through its batch
   identity).
9. Target-local records interleaved with batched records lose their own
   journaling or are batched. Test: `merge_mixes_target_local_and_batched_records`
   (a staged directory that collides with an existing one forces nested
   target-local records between top-level direct records).
10. The `mid-promotion` crash point stops firing after entry 0. It is still
    called after the first publish. Covered by the existing E2E case
    `extract-mid-promotion` (manager GUI run, not run here).
11. The new `mid-batch` crash point fires when a batch has one record, or before
    any rename. It fires only after the first rename of a batch with at least
    two records, and it is a no-op outside the `e2e` feature. Covered by code
    review and by the inventory item in F5 below.

## F2: recovery tolerance for an unjournaled tail

Context: `effective_move_identity_log_identity` today accepts exactly one
unjournaled record (complete or torn). A batch can leave up to 256 complete
records, plus at most one torn record, after the journaled prefix.

1. A single unjournaled record is still accepted (regression of the existing
   rule). Test: `effective_identity_accepts_single_unjournaled_record`.
2. A full batch of 256 complete records is accepted. Test:
   `effective_identity_accepts_full_batch_tail`.
3. A tail of 257 complete records is rejected and the caller gets the journaled
   identity back unchanged, so the strict check fails closed. Test:
   `effective_identity_rejects_tail_beyond_one_batch`.
4. A torn final record after complete records is accepted. Test:
   `effective_identity_accepts_torn_final_record_after_batch`.
5. A torn final record longer than `MAX_MOVE_IDENTITY_RECORD_BYTES` is
   rejected. Test: `effective_identity_rejects_oversized_torn_record`.
6. A changed journaled prefix ignores the tail entirely. Test:
   `effective_identity_ignores_tail_when_prefix_changed`.
7. A malformed complete record in the tail is accepted by the shape check and
   must be rejected when the records are parsed. Test:
   `hydrate_rejects_malformed_complete_batch_record`.
8. `hydrate_move_plan_identities` must ignore only a torn final line, and must
   still reject an empty or invalid complete line. Test:
   `hydrate_ignores_only_torn_final_record`.
9. Accepted risk: a same-user attacker who can write the log could add up to
   256 identity lines to the unjournaled tail, not one. The records only bind
   identities for retract checks, and the retract still requires the target
   object to match its recorded inode and fingerprint. This is the same trust
   model as the single record today, scaled to the batch and bounded by it.

## F3: byte caps for 110,000 entries

Context: the plan cap is 32 MiB (about 102,000 entries at 328 bytes), and the
log cap is 32 MiB (about 89,000 records at 377 bytes).

1. A 110,000-entry plan is refused by `write_move_plan`. Test:
   `identity_log_and_plan_accept_110k_entries` (writes a 110,000-entry plan and
   a 110,000-record identity log through the production writers).
2. The cap is raised too far and reading the sidecar in recovery exhausts
   memory. Plan cap: 512 MiB. Log cap: 1 GiB. Recovery reads each sidecar into
   memory once (`read_bounded_nofollow_bytes_if_matches`), and
   `effective_move_identity_log_identity` also reads the whole log to hash it.
   Memory during recovery is therefore about the sum of both sidecars plus the
   parsed plan. At 110,000 entries that is about 80 MB transient. At the
   1,000,000-entry limit with two records per entry it is about 1.1 GB for the
   plan and log bytes and about 1.5 GB with the parsed plan. This is stated, not
   tested; it is reached only by archives of that size.
3. The record-count limit (`MAX_EXTRACT_ENTRIES` times two) must still be
   enforced. It is unchanged in the code path.

## F4: link planning without a whole-plan scan per link

1. The new source-to-record lookup must return the same record as the old scan
   (the deepest record whose source is the path or an ancestor of it). Test:
   `prepare_planned_links_rewrites_many_links` (hundreds of relative symbolic
   links into a nested target-local record; every rewritten target must still
   resolve to the published object).
2. An unmapped link must keep the same fallback
   (`destination.join(source.strip_prefix(staged))`). Covered by the existing
   relative-link tests in `tests.rs`.

## F5: `mid-batch` crash point and the `extract-mid-batch` case

1. The point name is a plain string at a call site; `e2e_crash.rs` keeps no
   list, so no change is needed there. The point fires after the first rename
   of a batch with at least two records, under the `e2e` feature only.
2. Fixture: `hello.7z` holds one entry, so the point could never fire. The
   harness takes an optional `entries` count on extract cases. When it is set,
   `prepareCrashCase` builds `src/entries.7z` with `run7z` from `hello.txt`
   (the payload) plus filler files, stores it with `-mx=0`, and removes its
   staging folder before the pre-state manifest is taken. Cases without the
   field keep the `hello.7z` path unchanged. Checked in Node with a fake
   profile: 300 entries, `hello.txt` equals the payload, no staging left,
   manifest of four entries, environment payload about 1.4 KB, and the
   `hello.7z` case still produces its single-entry archive.
3. Case `extract-mid-batch`: destination `preexisting`, 300 entries, expect
   `rolled-back`. The first batch holds 256 records, so the crash fires after
   the first rename of a 256-record batch. Recovery restores that entry from its
   journaled batch identity and the unrenamed entries need no change. The
   post-recovery extraction of the same archive must still produce
   `hello.txt`, which the fixture keeps.
4. Guard: `entries` on a non-extract case throws, and an `entries` value below
   two throws, so a typo cannot silently fall back to the single-entry archive.
5. `suiteCount` is 55, which is `2 + 9 * 2 + 35` from
   `expectedRecoverySuiteCount`. `scripts/test-e2e.js` and the two CI
   proof checks read the same field.
6. Not run here: the GUI crash case (the manager runs it). The Node-side checks
   above and the Vitest and Node runner tests do not start the app.

## F6: 110,000-entry E2E extract

1. Extraction timeout too short for the expected run: raised to 15 minutes.
   The expected run is a few minutes.
2. Pre-created destination must stay, and `writeEvidence` must keep `extractMs`
   and `publishedFiles`.
3. The spec title and evidence name must say 110,000 entries, so the evidence is
   not misleading.
4. Listing preflight at 110,000 entries depends on batch 1 listing caps
   (`process/staging/slt.rs`, not owned here). If that is not in place, the
   E2E fails before the merge.
5. The E2E run is a manager GUI run. `node --check` only is run here.

## Test-first order

1. This inventory.
2. E2E spec change (`e2e/specs/audit-listing.spec.js`).
3. Rust tests in `extract_merge.rs` and `cleanup_journal.rs`. They reference
   the new names, so they do not compile until the code lands.
4. Production code.

## Measured after

The same harness ran before and after the change, back to back on this host.
It calls `merge_staged_extract_recorded` with a recorder that does the
production journal I/O (two `atomic_write_text` and one read per recorder call),
on E2E-style names, with the stage inside a pre-created destination.

| Entries | Before (one recorder call per entry) | After (one recorder call per 256 entries) |
| --- | --- | --- |
| 5,000 | 28.7 s (5.75 ms per entry), 5,003 recorder calls | 7.1 s (1.42 ms per entry), 23 recorder calls |
| 20,000 | 126.0 s (6.30 ms per entry), 20,003 recorder calls | 28.5 s (1.42 ms per entry), 82 recorder calls |

Per-entry cost is flat across 5,000 and 20,000 entries after the change. The
remaining per-entry cost is the source and target fingerprints and the rename,
which the safety model keeps.

Extrapolated to 110,000 entries: about 2.6 minutes of merge after the change,
against about 11.5 minutes before. Before the change, the 110,000-entry plan
and identity log were also refused by the 32 MiB caps, so that run stopped
before any publish. The extrapolation assumes the linear trend holds at 110,000
and is not measured here. The GUI E2E run (110,000 entries) is the manager's
check.

Timing on this shared host varied by about 2x between sessions (the same
replayed loop gave 12.8 ms per entry in one session and 5.75 ms in another).
Only the back-to-back before and after pair above is compared.

Byte limits after the change: plan 512 MiB and identity log 1 GiB. A
110,000-entry plan (about 36 MB) and log (about 41.5 MB) fit with room to
spare, and the 1,000,000-entry limit with one record each (about 330 MB plan,
about 380 MB log) also fits. Recovery memory is described in F3.

Not measured here: the GUI E2E run, a macOS run (where the original superlinear
observation was made), and the GUI run of the `extract-mid-batch` crash case (added in F5; the manager runs it).
