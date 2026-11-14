# Beta 2 streaming member preflight, listing line filter and redaction failure inventory

This inventory was written before changing production code (worker piece 2B,
`rust-stream-listing`). It covers three changes:

- B1: the extract member-safety preflight parses `7z l -slt` output as it
  arrives instead of buffering the whole listing (`process/staging/slt.rs`).
- B2: `l -slt` listings drop per-entry lines the frontend never reads before
  they count against `MAX_LIST_OUTPUT_BYTES` (`output.rs`, `commands/spawn.rs`,
  `commands/run.rs`).
- B3: `-p` password switches are redacted after any boundary character, not only
  after whitespace (`output.rs`).

Each item lists how the change could fail or regress and the test that covers
it. Tests named `stream_*`, `listing_filter_*`, `redact_*` and `collect_*` are
Rust unit tests in the owning files. Items marked E2E are covered by
`e2e/specs/beta2-rust-stream-listing.spec.js`, which runs in the serial GUI suite
after this piece is merged.

## Frontend key proof (B2)

Keys dropped from per-entry lines: `CRC`, `Created`, `Accessed`, `Host OS`,
`Characteristics`, `Comment`, `Offset`, `Volume Index`, `Version`.

Searched `src/` (excluding `src/tests/`) and `e2e/` for each key as `Key = `,
`"Key"`, `Key:` and as a bare word. The only hits are unrelated (`CRC` inside
an error hint string in `src/error-hints.ts`, `getVersion`/`Version` in updater
and setup code, `_setupWizardVersion`, and `formatVersion` in e2e journal
helpers). No code reads these keys from listing output.

The frontend listing parser `src/archive/listing.ts` reads only `Type`,
`Physical Size`, `Method`, `Solid`, `Encrypted`, `Path`, `Size`, `Packed Size`,
`Modified`, `Folder` and `Attributes`. Browse (`src/archive/inspection.ts`),
Selective extract (via the Browse cache), Convert (`src/basic/actions.ts`,
`src/archive/mutations.ts`) and Test (`t -spd`, which is not a listing command)
all use that parser or the same stdout only for encryption flags and error
hints.

Two read-only side effects are accepted and reported, not kept:

- `looksLikePasswordRequiredError` and `describe7zError` scan listing stdout for
  phrases such as "enter password" and "crc failed". A dropped `Comment` or
  `Version` line can no longer trigger a password or damaged-archive hint from
  member text. This removes a false positive; no real hint is lost.
- Debug logs of a Browse listing show fewer lines. Those lines are not used by
  any user-facing message.

Keys are dropped only with the exact shape `Key = ` at column 0, after the
`----------` separator. A line that only looks similar (`CRCX = `, `Host  OS = `,
` CRC = `, `CRC=`) is kept.

## B1 - streaming extract member preflight

Context: `assert_extract_archive_members_safe_with_summary` collected the whole
`l -slt -ba` stdout into a 256 MiB buffer, then parsed it. Above that size the
extract was refused. The new path feeds each chunk to `SltManifestParser` and
keeps only the facts the checks need.

Limits chosen and why:

- Per-line bound: 256 KiB of content before the newline (CR included). ZIP
  names and comments are at most 65,535 bytes. The Windows extended-path
  ceiling is 32,767 UTF-16 units, at most about 98 KB of UTF-8. 256 KiB leaves
  headroom and bounds the one line the parser holds (about 256 KiB per listing).
- Total listing text bound: `MAX_EXTRACT_ENTRIES * 4 KiB + MAX_EXTRACT_PATH_BYTES`,
  about 4.13 GB. Path text is already capped separately at 32 MiB. A real `-slt`
  record for a ZIP with the full key set is about 280-470 bytes, so 4 KiB per
  record is about 9-15 times headroom. The bound stops a runaway child from
  streaming forever. It does not affect memory, because nothing is buffered.
  Time is bounded by the existing preflight timeout.
- Stderr for this preflight is capped at `MAX_OUTPUT_BYTES` (10 MiB), not 256 MiB.
  Truncated stderr fails closed with the generic output-limit error.
- The stdout head kept for failure detail is capped at `MAX_OUTPUT_BYTES`. It is
  used only when stderr is empty, as the old code did. It is never checked for
  truncation, so it cannot produce a limit error by itself.

Failure modes:

1. A chunk boundary inside a line changes the parse, for example a `Path = `
   split into `Pa` and `th = ...` is missed. Covered by
   `stream_split_at_every_byte_matches_whole_parse`.
2. A split inside a multibyte UTF-8 character yields a replacement character in
   a member path, so a name differs from the buffered parse. Covered by
   `stream_split_at_every_byte_matches_whole_parse` on a multibyte fixture.
3. A split between `\r` and `\n` leaves a `\r` in a value or counts a line
   twice. Covered by `stream_handles_crlf_and_multibyte_splits`, which checks
   every split of a CRLF fixture and the exact split between CR and LF.
4. The final line without a trailing newline is dropped, so an unsafe last
   member is missed. Covered by `stream_split_at_every_byte_matches_whole_parse`
   (the fixture has no final newline) and `stream_final_unterminated_line_is_checked`.
5. The entry cap (`MAX_EXTRACT_ENTRIES`) stops applying, or fires at a different
   count when chunks split records. Covered by `stream_entry_cap_is_enforced_across_chunks`
   (small cap) and `streaming_limits_default_to_extract_constants`.
6. The aggregate path-name cap (`MAX_EXTRACT_PATH_BYTES`) stops applying. Covered
   by `stream_entry_cap_is_enforced_across_chunks` with a small path cap.
7. A hostile line grows the parser's memory without bound. Covered by
   `stream_rejects_line_over_bound_and_accepts_exact_bound` (over-bound rejected,
   exact bound accepted), `stream_keeps_retained_state_bounded_by_the_line_limit`
   (10 MiB single line keeps retained capacity under four line bounds) and
   `stream_listing_over_256_mib_succeeds_with_bounded_state`.
8. The line bound rejects a legitimate line that is just under the bound.
   Covered by the exact-bound acceptance half of item 7.
9. The total-bytes bound is not chunk invariant, so the same listing gives
   different verdicts depending on chunking. The bound is checked at line end
   against byte-exact totals. Covered by `stream_split_at_every_byte_matches_whole_parse`
   and `stream_total_bytes_bound_is_enforced_at_line_end`.
10. The total-bytes bound refuses a legitimate large listing (above 256 MiB) or
    is too small for the entry cap. Covered by `stream_listing_over_256_mib_succeeds_with_bounded_state`
    (more than 256 MiB, under the cap) and `streaming_limits_default_to_extract_constants`.
11. The pathless single-stream fallback (bzip2, xz) changes. The fallback runs
    only when no `Path =` member was seen, so it is checked on the whole output.
    Covered by `stream_wrapper_matches_streaming_for_existing_fixture_shapes` and
    the existing pathless tests in `process/tests.rs`.
12. The declared-size limit (`max_bytes`) is checked later or differently.
    Covered by the existing `assert_slt_declared_size_within_limit` tests, which
    use the wrapper, and by `stream_wrapper_matches_streaming_for_existing_fixture_shapes`.
13. Symbolic and hard link checks change. Covered by the existing link tests in
    `process/tests.rs` (through the wrapper) and the link fixtures in
    `stream_wrapper_matches_streaming_for_existing_fixture_shapes`.
14. The first error in the stream stops being the reported error. Covered by
    `stream_first_error_wins_over_later_errors`.
15. Exit-1 metadata classification sees less stdout than before because stdout
    is no longer kept. The classifier is fed every stdout line by the parser.
    Covered by `stream_warning_scan_matches_buffered_classifier_at_every_split`
    and by the existing `extract_warning_is_metadata_only` tests in `commands/run.rs`.
16. Precedence changes: the exit-code verdict must still come before parse
    errors, as before. Covered by `listing_exit_error_is_reported_before_parse_errors`,
    which exercises the pure verdict helper that the async preflight calls.
17. A stream error or incomplete output from the child is mistaken for a clean
    listing. Covered by `collect_listing_reports_stream_error_as_incomplete`.
18. The child is not terminated or the registered child slot is not cleared on
    timeout, cancel or stream error. Unchanged structure: `run_registered_preflight`
    keeps the same register, password, timeout, terminate and clear sequence. Covered
    by the existing `process/tests.rs` cancellation tests and by the E2E
    cancel specs that already run in the GUI suite.
19. The stdout head is unbounded, or truncation of the head is reported as a
    limit error. Covered by `collect_listing_keeps_only_a_bounded_stdout_head`.
20. The failure detail changes: stderr first, then stdout head, sanitized. Covered
    by `listing_exit_error_is_reported_before_parse_errors` (detail text).
21. The message for the total-bytes bound still says 256 MiB. The constant
    `MEMBER_LIST_LIMIT_MESSAGE` is updated and the old test that asserted "256 MiB"
    is rewritten. Covered by `stream_total_bytes_bound_is_enforced_at_line_end`.
22. The buffered callers (update encryption listing, password test) lose their
    256 MiB buffer or change behavior. They keep `run_registered_preflight_7z` with
    `collect_command_output` and the same constant. Covered by the existing
    `process/tests.rs` update-policy tests.
23. Debug-build test time for the 256 MiB stream exceeds about 30 seconds. The
    test generates 700,000 records of 409 bytes on the fly (286 MB, about 273 MiB,
    under the 1,000,000 entry cap). Measured run time in debug: about 20 seconds
    for the single test (`stream_listing_over_256_mib_succeeds_with_bounded_state`).
24. Documentation still states the old 256 MiB extract ceiling (`SECURITY.md`
    line 131). This piece does not own docs outside `docs/validation`. Reported to
    the manager as a stale-number follow-up.
25. E2E: a ZIP with 200-character member names and empty files must extract all
    files. Covered by `e2e/specs/beta2-rust-stream-listing.spec.js` case 1.
    The 32 MiB aggregate path cap means a long-name archive cannot pass 256 MiB of
    listing text (about 160,000 entries at 200 characters). So the over-256 MiB
    behavior is proven by the synthetic Rust stream test, not by the GUI run.

## B2 - listing line filter for `l -slt`

Context: Browse and Convert run `l -slt`, which prints about 280 bytes per ZIP
entry, and 9 of those keys are never read. Dropping them before the cap lets
about 4 times more entries fit in `MAX_LIST_OUTPUT_BYTES` (64 MiB).

Failure modes:

1. A key the frontend reads is dropped. The dropped set is fixed to the nine
   keys proven unread above, and `listing_filter_drops_only_the_nine_unread_keys_after_separator`
   checks the set and that kept keys stay in order.
2. The archive header block (before `----------`) is filtered. Covered by
   `listing_filter_keeps_archive_header_block_untouched`. Output without any
   separator is untouched, covered by `listing_filter_passes_text_through_when_no_entry_section_exists`.
   Kept keys and their order are unchanged, covered by `listing_filter_keeps_kept_keys_and_order`.
3. The separator is not recognized, so no entry lines are dropped. Covered by
   `listing_filter_drops_only_the_nine_unread_keys_after_separator` (separator
   present) and `listing_filter_separator_must_be_the_exact_dash_line`.
4. A line split across chunks is dropped partially or kept partially, leaking a
   value fragment or a key. Covered by `listing_filter_is_chunk_invariant_at_every_split`
   (every byte split, plus one-byte chunks) and `listing_filter_is_chunk_invariant_inside_multibyte_paths`.
5. Dropped lines still count against `MAX_LIST_OUTPUT_BYTES`, so a 73 MB listing
   still truncates. Covered by `collect_filtered_listing_applies_filter_before_byte_cap`
   (unfiltered exceeds the small cap, filtered fits, not truncated) and E2E case 2.
6. The filter runs on non-listing commands (`x`, `t`, `a`) or on `l` without
   `-slt`, changing their output. Covered by `listing_filter_applies_only_to_listing_with_slt`.
7. An archive named `-slt` after `--` enables the filter. Covered by the same test.
8. Key lookalikes (`CRCX = `, `Host  OS = `, ` CRC = `, `CRC=`) are dropped.
   Covered by `listing_filter_key_lookalikes_are_kept`.
9. The final line without a newline is not flushed, so the last entry line is
   lost. Covered by `listing_filter_flushes_unterminated_last_line`.
10. CRLF handling: a dropped line leaves its `\r\n` behind, or a kept line loses
    its `\r`. Covered by `listing_filter_keeps_crlf_on_kept_lines_and_drops_whole_lines`.
11. The progress callback (`on_stdout_line`) sees filtered text, changing live
    progress. It keeps receiving the raw chunk. Covered by
    `collect_filtered_listing_applies_filter_before_byte_cap` (callback check).
    Without a filter the collector keeps every line, covered by
    `collect_filtered_listing_without_filter_keeps_every_line`.
12. `MAX_LIST_OUTPUT_BYTES` or the `x`/`t` cap changes. Covered by the existing
    `only_listing_commands_get_the_larger_browse_cap` test in `output.rs`.
13. A truncated filtered listing is reported as complete. The truncation flag
    still comes from `append_limited_output`. Covered by the cap test in item 5.
14. The filter's buffered state grows with line length. It holds at most 18 bytes
    (`Characteristics = ` is the longest dropped prefix) before deciding, then
    streams. Covered by `listing_filter_is_chunk_invariant_at_every_split` with
    a long kept line.
15. E2E: a listing above 64 MiB unfiltered but below it filtered must load in
    Browse with the full entry count. Covered by E2E case 2.

## B3 - password switch redaction after any boundary

Context: `redact_password_args` split on whitespace, so `["-psecret"]` and
`"-psecret"` were not redacted in text echoed to the user or logged.

Rule chosen: a `-p` (case-insensitive) starts a password switch when it is at the
start of the text, or directly after whitespace or one of
`" ' ` [ ( { < = , ;`. Everything from that `-p` to the end of the line is
replaced with `-p***`, as before (passwords may contain spaces). A `-p` that
follows a letter, digit, `-`, `_`, `.`, `/`, `\` or non-ASCII character is a
path fragment and stays.

Failure modes:

1. `"-psecret"` after a quote is not redacted. Covered by `redact_password_switch_after_quote_or_bracket`.
2. `["-psecret"]` after a bracket is not redacted. Same test.
3. A mid-word `-p` is redacted, changing path text such as `skip-path/file.txt`.
   Covered by `redact_leaves_mid_word_dash_p_alone` (`skip-path`, `a-pb.txt`,
   `dir\-pfoo`, `dir/-pfoo`, `é-psecret`).
4. Text before the switch is lost, or the cut is placed at the token start
   instead of the `-p`, so `["` disappears. Covered by the prefix assertions in
   `redact_password_switch_after_quote_or_bracket`. The rest of the line after a
   switch that contains spaces is still hidden, covered by
   `redact_password_switch_cuts_rest_of_line_even_with_spaces`.
5. The already-redacted form `-p***` with a closing delimiter (`"-p***"`) is
   treated as a secret and reduced to `-p***` again. Covered by
   `redact_keeps_already_redacted_switch_with_closing_delimiter`.
6. Redaction is not idempotent: `redact(redact(x))` differs from `redact(x)`.
   Covered by `redact_keeps_already_redacted_switch_with_closing_delimiter`.
7. Multi-line input: a password on one line hides the following lines, or the
   newline is dropped. Covered by `redact_password_switch_per_line_keeps_newlines`.
8. Uppercase `-P` is missed. Covered by `redact_sensitive_text_masks_password_args`
   (existing `-PMySecret` case) and `redact_password_switch_after_quote_or_bracket`.
9. A `-p` at the very end of text (`7z a -p`) is missed. Covered by
   `redact_password_switch_after_quote_or_bracket`.
10. Key-value redaction (`password=`) changes. Covered by the existing
    `redact_sensitive_text_masks_key_values` test.
11. The `-p***` text used by `validation.rs` (batch 1 `-p<redacted>` in errors) is
    changed. This piece does not touch `validation.rs`; the existing validation
    tests cover it.

## Coverage not provided by Rust tests

- The GUI behavior of Browse and extract at 73 MB listings and 50,000 long-name
  entries is covered only by the E2E spec, which the manager runs serially.
- A real 7-Zip exit-1 extract with metadata warnings is still a `[target]` check
  on Windows or Linux (see `audit-listing.failure-modes.md`).
- The update encryption listing and password test still buffer up to 256 MiB
  (they are not extract preflights). This is a known remaining limit.
