# Archive listing limits, preflight timeout, snapshot feedback and exit-1 classifier failure inventory

This inventory was written before changing production code. It covers plan items
B-02 (listing and preflight ceilings), B-03 (preflight timeout), B-04 (snapshot
copy feedback) and C-09 (exit-1 warning classifier).

## Browse listing cap and preflight ceiling (B-02)

Context: `run_7z` buffered listings with the 10 MiB `MAX_OUTPUT_BYTES`, so a ZIP
of about 32,000 entries could not be browsed. The member-safety preflight used
a 32 MiB buffer, so extraction was refused above about 103,000 ZIP entries.

1. A listing that exceeds the browse cap must set `stdout_truncated` and must not
   be shown as a complete listing. The frontend already keys on that flag.
2. Raising the cap for every command would let large `x` or `t` outputs use
   more memory. Only `l` (listing) commands may get the 64 MiB cap.
3. The 40,000-entry ZIP browse scenario must list the final member, not just
   the first page, and must not show the "listing too large" toast.
4. The preflight cap must stay bounded. Raising it to 256 MiB must not turn
   the buffer into an unbounded read; truncation still cancels the child.
5. Truncated preflight output must produce the plain-words error ("Nothing was
   extracted") and must not be reported as a generic output-limit failure.
6. A complete exit-0 listing that is just under the cap must still be parsed
   and accepted. Byte-count rounding must not reject it early.
7. A large ZIP extraction (30,000 entries in E2E) must publish every file. A preflight that
   passes but a quota check that counts a different number must not drop files.
8. The entry-count safety check (`MAX_EXTRACT_ENTRIES`) and the aggregate path
   byte limit must still run on the parsed listing. Raising the buffer must
   not skip them.
9. Docs must state the real browse and extract ceilings. A stale number in
   README or SECURITY.md would contradict the code.
10. Changing `MAX_OUTPUT_BYTES` itself would also change `x` and `t` behavior,
    so the new cap must be a separate constant.

## Preflight timeout scaled by archive size (B-03)

Context: the member-safety, encryption and password-test preflights used a
fixed 120 s timeout. Listing an uncompressed TAR reads the whole file, so
multi-gigabyte archives on slow media can exceed it.

1. The formula must give exactly 120 s for an empty or tiny archive so that
   existing timeouts do not change for normal archives.
2. Each additional 16 MiB must add exactly one second. Rounding up keeps the
   budget from being one second short at a boundary.
3. The size of a split archive must be the sum of all volumes. Using only the
   first volume would give a 1 GiB budget to a 40 GiB set.
4. When the volume family cannot be resolved, the first file size is used.
   An error here must not panic or return a zero budget.
5. Overflow for an extreme size must saturate, not wrap to a short timeout.
6. Cancel must still terminate the child during the wait. Scaling the timeout
   must not replace the registered-child cancel path.
7. The timeout message must suggest copying the archive to a faster disk and
   must still state the seconds that were used.
8. Scaling must not extend the timeout for the password check beyond what the
   same formula gives; the same helper is used for all three preflights.
9. A timeout must still terminate the child and clear the registered child
   slot, as before.

Why this is covered by Rust tests and not by E2E: on APFS and a fast SSD, a
multi-gigabyte archive lists well under 120 s, so the GUI cannot reach the
timeout. The formula is therefore tested directly in `slt.rs` (written before
the code), and the slow-media check remains a `[target]` item for a Windows or
Linux run.

## Snapshot copy feedback (B-04)

Context: when the snapshot cannot be cloned or hard-linked, it falls back to a
cancellable byte copy. That copy can take minutes, and the UI shows no progress.

1. Progress must be monotonic. A repeated or decreasing percent would make the
   bar jump backwards.
2. Progress must start at 0 and end at 100 for a non-empty archive, and must
   not report 100 before the copy is complete.
3. A zero-byte archive must not divide by zero.
4. A copy cancelled mid-way must stop emitting progress and must still remove
   the partial snapshot, as before.
5. Progress events must go through the existing `7z-progress-structured`
   channel with a `currentFile` label, so no frontend code path needs a new
   event name.
6. The progress must not be emitted for the APFS clone or Windows hard-link
   paths, because those do not copy bytes.
7. Throttling must not drop the final 100 percent event.
8. The byte copy is not reached on APFS (clone succeeds) or on Windows with a
   hard link, so the GUI cannot trigger it on this host. The progress phase is
   covered by a Rust test that drives the byte-copy helper directly on any
   platform (`copy.rs`), written before the code.

Deferred: holding an open descriptor and re-checking identity on Unix instead
of copying the archive (plan B-04 long-term fix). See the Deferred section.

## Exit-1 warning classifier (C-09)

Context: `extract_warning_is_metadata_only` rejects 7-Zip's summary line
"Archives with Warnings: 1" because it contains "warning" and does not start
with "warnings:". Real 7-Zip 26.06 output for a ZIP with data after its end
prints this line after an otherwise successful extraction.

Captured on the bundled arm64 7-Zip 26.06 (`src-tauri/binaries`):

- Extract of a ZIP with trailing junk: exit 0, stdout contains `WARNINGS:`,
  `There are data after the end of archive`, and `Archives with Warnings: 1`.
- Compress of a folder with a file mode 000 (POSIX): exit 1, stdout contains
  `WARNING: Cannot open 1 file`, stderr contains `WARNING: errno=13 : Permission
denied`. This is a compress run, not classifier input, but it is a real
  exit-1 unknown-warning sample that must still be rejected.
- A bzip2 with trailing bytes, a truncated ZIP, and gzip with trailing bytes
  exit 2 with `ERROR:` lines. These are not warnings and must stay rejected.

Failure modes:

1. Accepting the summary line must not also accept `Archives with Errors: N`
   or any `ERROR:`/`Errors:` line. Errors must still fail closed.
2. An unknown `WARNING:` line in stdout must still fail, even when the summary
   line and a known metadata warning are present.
3. An unknown stderr line must still fail even when stdout is acceptable.
4. A data, CRC, password or dangerous-link marker must still fail even with a
   summary line.
5. The summary line must only be accepted as the exact 7-Zip shape
   `Archives with Warnings: <digits>`, not any line containing "archives".
6. Exit 0 must not reach this classifier (the caller only consults it for
   exit 1), so no exit-0 behavior changes.
7. Real exit-1 extraction output could not be produced on this macOS host
   (every extraction probe exited 0 or 2). The exit-1 fixture therefore uses the
   real exit-0 summary text with exit 1 supplied by the caller. A real exit-1
   extraction capture is a `[target]` check on Windows or Linux.

## Deferred

- B-02 long-term: parse the member listing as a stream instead of buffering it
  (for ZIP/TAR above 256 MiB). This pass keeps the bounded buffer and states
  the ceiling in the error message and docs.
- B-04 long-term: on Unix, hold an open descriptor for the archive and re-check
  identity after the run (already done for list/test) instead of byte-copying
  when no clone is available. Deferred because it changes the integrity model
  for ext4, exFAT and SMB.
- B-03 slow-media verification on a real USB stick or network share is a
  `[target]` check; it cannot run on this host.
- C-09 real exit-1 extraction capture on Windows or Linux is a `[target]` check.
- New finding, not fixed: app extraction time grows faster than linearly with
  entry count. Measured on macOS arm64 (stored ZIP, 8-byte files): 30,000
  entries took 79 s in the app; 110,000 entries staged all files within about a
  minute but did not publish within 20 minutes. Raw 7-Zip extracts 110,000 in
  about 7 s. A Rust-side trace put collect at about 10 s and finalize at about
  6 s, so the remaining time is not yet located. The E2E case uses 30,000
  entries until this is diagnosed, so it does not prove extraction above the
  old 32 MiB preflight cap end to end.
