# Rust extract safety failure inventory (beta 2)

This inventory was written before changing production code. It covers:

- H1: 7-Zip replaces every `*` in an `-o<dir>` argument with the archive name,
  so a `*` in any extract output path can send writes outside the staging
  directory.
- M3 [unverified-os]: on macOS the quarantine read opens the raw archive path
  with `O_NOFOLLOW`, so a symlinked archive always fails after validation.
- Rust low: `-p<secret>` tokens are echoed in validation errors.
- Rust low: a recovery `JoinError` returns before the prepare slot is released.
- Rust low: the crate uses `tokio::task::spawn_blocking` but declares only the
  `time` tokio feature.

Rust tests cover H1 and the password redaction. The Windows host cannot create
a directory whose name contains `*`, so those tests assert the pure string rule
and check that the rejection happens before any filesystem change. M3 and the
JoinError cannot run on this Windows host and have no automated test; see the
last sections.

## H1: `*` in a path that reaches an extract `-o` argument

Context: Zinnia stages an extraction as `.zinnia-extract-<token>` beside the
destination, or inside it. Only that basename is wildcard-free. A `*` in an
ancestor folder, which macOS and Linux allow, makes 7-Zip write to another
directory. Compound TAR extraction also builds an `-o` path from the input
snapshot parent, which sits beside the archive or in app cache.

Ways the fix could fail or regress:

1. The check runs after the stage directory is created, so a rejected request
   leaves a `.zinnia-extract-*` directory behind. Covered by
   `extract_plan_rejects_wildcard_ancestor_before_creating_stage`, which
   compares the parent directory listing before and after the rejection.
2. A `*` basename on Windows fails inside `path_entry_exists` with a filesystem
   error instead of the plain message. The check must run before any
   filesystem call. Covered by
   `extract_plan_rejects_wildcard_basename_before_creating_stage`, which
   asserts the exact message.
3. The requested destination is clean but a symlink resolves into a `*` folder.
   The check must also run on the resolved destination before the stage is
   created. Covered by review of `plan.rs` only: creating such a link needs
   a POSIX host, and the shared pure rule is covered by item 1 and item 2.
4. The frontend `-o` is validated only after the plan is built. Covered by
   `validate_run_7z_args_rejects_wildcard_in_extract_output_ancestor` and
   `validate_run_7z_args_rejects_wildcard_in_extract_output_basename`, which
   run before any spawn or staging, in `parse_run_7z_request`.
5. Compound TAR outer extraction (`compound_tar_outer_extract_args`) takes an
   `-o` from the snapshot parent. The check must run in
   `prepare_compound_tar_snapshot` before the outer stage is created. That
   function needs a Tauri `AppHandle`, so it has no unit test. Covered by
   review, and by the same pure rule in items 1 and 2.
6. A compound TAR archive inside a `*` folder gets an input snapshot created
   beside it before the outer check runs. An early check in
   `prepare_cleanup_plan` for `x`, `l` and `t` compound archives stops this
   before any staging. Covered by
   `compound_archive_in_wildcard_folder_is_rejected_before_snapshot`.
7. The early compound check is applied to `a` or `u` commands, where a `.tar.gz`
   input is a source file and not a staged input. A compress request would
   then be wrongly refused. Covered by
   `compress_input_named_like_compound_archive_is_not_rejected`.
8. The rule is applied to archive output paths (`a`, `u`), which 7-Zip does not
   substitute. Refusing them would change behaviour without a safety gain.
   Covered by `validate_run_7z_args_keeps_wildcard_in_archive_output_path`.
9. A plain destination stops staging beside the destination. Covered by
   `extract_plan_keeps_plain_destination_staging_beside_destination`, which
   uses a real archive file and a real rollback.
10. The user-facing text drifts from the requested sentence. Covered by the
    exact-string assertions in the validation, plan and staging tests.
11. `rewrite_extract_output` is the last point before the command line. If a
    future caller passes a stage path with `*`, the rewrite must refuse rather
    than write the argument. Covered by
    `rewrite_extract_output_rejects_wildcard_stage_path`.
12. A plain stage path still rewrites normally. Covered by
    `rewrite_extract_output_accepts_plain_stage_path`.

## M3 [unverified-os]: macOS quarantine read through a symlinked archive

Context: `run.rs` reads the quarantine attribute from the raw archive path.
`quarantine.rs` opens that path with `O_NOFOLLOW`. A symlink passes
`validate_archive_path` and then always fails. The fix passes the resolved
regular-file path from `path_safety::resolve_regular_file_input`, the same
resolution the input snapshot uses.

Ways the fix could fail or regress:

1. The change compiles only on macOS, so a type error would reach a macOS
   build. The change is kept small and uses the existing `resolve_regular_file_input`
   signature (`&Path` to `Result<PathBuf, String>`). Covered by review only.
2. The fix changes Windows or Linux behaviour. The new resolution is gated with
   `#[cfg(target_os = "macos")]`, and the other targets keep the raw path. Covered
   by review and by the Windows build, which compiles the non-macOS branch.
3. Resolution fails for a path that used to reach the quarantine read. The error
   path must release the prepare slot. Covered by review: it uses the same
   `release_prepare_slot_best_effort` call as the other pre-spawn errors.
4. The quarantine is read from a different file than the one the snapshot copies.
   Both use `resolve_regular_file_input`. Covered by review.

Not testable here: this item needs a macOS host with a symlinked archive. The
manager should run it on macOS.

## Password echo in validation errors

Context: `validate_run_7z_args` builds errors with the raw argument. A `-p`
token can carry a password, for example `b -p<secret>` fails with
`7z argument '-p<secret>' is not permitted.`. Other echo sites (the command in
position 0, and a path after `--` that contains `..`) can carry the same token.

Ways the fix could fail or regress:

1. The benchmark error still echoes the password. Covered by
   `validate_run_7z_args_redacts_password_switch_in_benchmark_error`.
2. Uppercase `-P` is not redacted, because the prefix check is case-sensitive.
   Covered by `validate_run_7z_args_redacts_uppercase_password_switch`.
3. The other echo sites leak: a `-p` token in command position, and a `-p`
   token after `--` that contains `..`. Covered by
   `validate_run_7z_args_redacts_password_token_in_other_error_positions`.
4. Redaction changes an allow or block decision. The helper only formats the
   message, so the decision code is unchanged. Covered by the existing
   validation tests (`validate_run_7z_args_rejects_*`,
   `validate_run_7z_args_allows_*`), which keep running.
5. Non-password switches stop being shown in errors, which would make errors
   less useful. Covered by `validate_run_7z_args_keeps_non_password_switch_in_errors`.
6. A path after `--` that starts with `-p` is shown as `-p<redacted>` in its
   error. The name is hidden on purpose, because the rule cannot tell a password
   token from a path. Covered by
   `validate_run_7z_args_redacts_password_token_in_other_error_positions`.

## Recovery JoinError releases the prepare slot

Context: in `run_7z_inner`, the blocking recovery call used `.map_err(...)?`.
A panicking or cancelled worker returned before `release_prepare_slot_best_effort`,
so `preparing` stayed set and later operations reported busy.

Ways the fix could fail or regress:

1. A `JoinError` still returns without releasing the slot. The fix releases in
   the `Err` arm of the join result. Covered by review only: the path needs a
   panicking worker inside `run_7z_inner`, which needs a Tauri `AppHandle` and a
   managed `State`.
2. The error text changes. The message stays `Archive recovery worker failed: ...`.
   Covered by review.
3. The `Ok` path changes. The inner recovery result is still returned unchanged
   and the existing `if let Err` branch still releases the slot. Covered by
   review and by the existing run tests in `process/tests.rs`.

## Cargo: tokio `rt` feature

Ways the change could fail or regress:

1. `Cargo.lock` changes. Cargo does not record features in the lock file, so
   `git diff --stat src-tauri/Cargo.lock` must stay empty. Checked: the diff is
   empty after the change.
2. A `--locked` build or clippy run fails. Checked by `cargo clippy --locked`
   and `npm run test:rust`.

## E2E coverage

There is no GUI E2E spec for this piece. A Windows host cannot create a path
with `*`, so the GUI cannot produce the failing case here. The proof is the Rust
tests above, which run before the code they cover.

## Rust tests added

- `src-tauri/src/validation.rs` (existing `tests` module): wildcard rejection
  and redaction cases.
- `src-tauri/src/process/staging.rs` (new `tests` module): `rewrite_extract_output`
  checks.
- `src-tauri/src/process/staging/plan.rs` (new `tests` module): plan rejection
  before staging, compound early check, compress false-positive guard, and the
  plain-destination regression.

## Known gaps

- M3 and the recovery JoinError have no automated test on this host (see above).
- The compound TAR outer `-o` check runs in code that needs a Tauri `AppHandle`.
  It is covered by review and by the shared pure rule.
- Symlink-to-`*` destinations are covered by review only, because they need a
  POSIX host to create.
