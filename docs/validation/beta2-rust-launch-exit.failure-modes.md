# Beta 2 Rust launch, exit and platform failure inventory

This inventory was written before changing production code. It covers three
items in the Rust backend: M1 (forced exit loops on an unkillable 7-Zip child),
M2 (`zinnia foo.zip` from a terminal on a cold start), and the platform module
cleanups in `platform/mod.rs`.

Test names in this file are the Rust tests and E2E cases that cover each item.
Items marked "not E2E-reachable" are covered only by the Rust decision tests
and by code review, because the E2E harness cannot create the state.

## Harness limits that bound the E2E coverage

1. The launched app's argv is fixed per suite by `ZINNIA_E2E_APP_ARGS`
   (`scripts/test-e2e.js`). A scenario spec such as this one runs with no
   argv, so it cannot cold-start the app with `foo.zip`.
2. The app's working directory is inherited from the harness and is not set by
   any spec. A relative cold start therefore cannot be given a known cwd.
3. `production_integrations_enabled()` in `main.rs` returns false while
   `ZINNIA_E2E=1`. The single-instance plugin is not registered in E2E sessions,
   so a second process cannot forward a relative argv and cwd to the E2E app.
4. The forced-exit path needs a 7-Zip child that `terminate_child` cannot stop.
   E2E cannot create that child.

## M1: forced exit re-enters the exit gate with an unkillable child

Context: `force_exit_after_busy_teardown` restores the child and calls
`app.exit(0)`. `app.exit(0)` raises `ExitRequested` again, and
`defer_exit_while_operation_finishes` prevented it again while the child was
still registered. The same re-entry happens with `cancelling` left true and no
owner, which needs no child at all.

1. The forced flag is stored after `app.exit(0)` instead of before. The
   `ExitRequested` raised by that call still sees a busy slot and loops.
   Covered by `forced_exit_proceeds_with_running_child` (decision with
   `forced = true`). Ordering is confirmed by review: both forced exits in
   `force_exit_after_busy_teardown` go through `exit_forced_app`, which stores
   the flag before calling `app.exit(0)`. Not E2E-reachable.
2. The forced flag is honoured by the decision but not by the warm-idle branch
   (`should_keep_extract_warm` then `enter_extract_warm_idle` then
   `prevent_exit`). A forced exit would stay resident. Covered by review of both
   `RunEvent` closures. The macOS/iOS closure is [unverified-os]. Not E2E-reachable.
3. The forced flag is not honoured by `defer_close_while_operation_finishes`.
   A window close during forced exit would re-cancel and prevent close again.
   Covered by `forced_close_of_busy_owner_is_not_deferred`.
4. Fail-open in normal quit: a normal quit with a running child lets the process
   exit and kills 7-Zip mid-write. Covered by
   `running_child_defers_exit_until_forced` and
   `owner_busy_close_defers_when_not_forced`.
5. Normal idle quit blocked: the decision returns true with an idle slot.
   Covered by `idle_slot_lets_exit_proceed`. The E2E teardown in
   `e2e/wdio.conf.js` (`requestGracefulAppShutdown`) quits through
   `plugin:process|exit` with an idle slot, which is the E2E evidence for this
   item. It is indirect: the spec does not assert the exit itself.
6. Update reservation no longer protected in the normal case. Covered by
   `update_reservation_defers_exit_when_not_forced`.
7. Update reservation overridden by the forced flag, so the updater is killed
   mid-install. Covered by `forced_exit_proceeds_with_update_reservation`, which
   pins the chosen behaviour. Residual: a reservation needs `child.is_none()`
   and `preparing`, and the forced path sets `cancelling` and leaves the child
   registered, so both cannot hold at once. Not E2E-reachable.
8. The no-owner branch loops with `cancelling` true and no child. Covered by
   `forced_exit_proceeds_with_cancelling_slot_and_no_owner`, and the non-forced
   counterpart `busy_without_owner_defers_exit_when_not_forced`.
9. The flag is process-global and leaks between tests. The decision function
   takes the flag as a parameter, so no test reads or writes the static.
   Covered by design.
10. The flag is set on a path that does not exit. A later normal quit would then
    bypass the guard. `exit_forced_app` is the only place the flag is stored,
    and its only callers are the two forced exits in
    `force_exit_after_busy_teardown`. Covered by review.

## M2: `zinnia foo.zip` from a terminal on a cold start

Context: `collect_cli_context` and `resolve_cli_context_with_handoffs` parse
argv without resolving relative paths. The second-instance path resolves them
through `resolve_open_args_against_cwd`. For `foo.zip`, the derived destination
`foo` has parent `Some("")`, so `canonicalize("")` fails and quick extract never
starts. `derive_extract_destination_path` and `normalize_destination_path` are
covered below.

1. First-instance argv is not resolved against the process cwd, so the archive
   stays relative. Covered by `cold_start_relative_archive_resolves_against_current_dir`,
   `cold_start_relative_subdirectory_resolves_against_current_dir` and
   `cold_start_dot_slash_archive_resolves_against_current_dir`.
   `cold_start_resolved_archive_derives_an_absolute_destination` runs the whole
   chain from argv to the normalized destination.
2. Resolution changes argv0 or a flag value (`--extract`, `--compress`,
   `--zinnia-shell-handoff`), which would break mode routing. Covered by
   `cold_start_relative_archive_resolves_against_current_dir` (asserts argv0 and
   the flag are kept) and `cold_start_relative_archive_still_routes_to_extract`.
3. Empty parent `Some("")` still fails `canonicalize`. Covered by
   `relative_leaf_without_parent_resolves_under_current_dir` and
   `relative_archive_destination_resolves_under_current_dir`.
4. `./x.zip` derives `./x`, whose parent is `.`. Covered by
   `dot_slash_archive_destination_resolves_under_current_dir`.
5. A relative subdirectory destination resolves against the wrong base. Covered
   by `relative_subdirectory_destination_resolves_under_current_dir`.
6. An absolute path is joined to the cwd or otherwise changed. Covered by
   `absolute_destination_is_unchanged_by_relative_resolution` and
   `cold_start_absolute_archive_is_unchanged`.
7. Second-instance resolution regresses (for example `./input.txt` changes
   shape). Covered by the existing test
   `resolve_open_args_against_cwd` expectations in `launch/tests.rs`, which must
   keep passing. The shared function is not changed in behaviour.
8. Windows `canonicalize` returns a `\\?\` verbatim path, so expectations written
   as plain strings never match. The new tests compare canonical forms on both
   sides. Covered by test design.
9. `current_dir()` fails (deleted cwd). The code keeps the argv unresolved and
   does not panic. Covered by review only: the failure cannot be injected in a
   pure test without a wider signature change.
10. A non-UTF-8 cwd is converted lossily before joining. This matches the
    second-instance path, which takes a `String` from the plugin. Not covered by
    a test. Residual risk, accepted.
11. The resolved argv changes the shell handoff. A handoff file is absolute, so
    it is kept. Covered by the existing `resolve_open_args_against_cwd` test,
    which resolves only relative `handoff.json`.
12. Cold start and the setup path disagree. `collect_cli_context` (pre-setup)
    and `resolve_cli_context_with_handoffs` (setup) must both resolve. Covered by
    review, and by `cold_start_relative_archive_still_routes_to_extract`, which
    calls the same resolver both entry points use.
13. A relative cold start of the real app is not E2E-reachable (see the harness
    limits above). The E2E spec covers only the idle cold start (item E-1).

## Platform cleanups in `platform/mod.rs`

P1. The `"arm64" => "aarch64"` arm in `get_beta_updater_target` is removed. It
    is unreachable: `std::env::consts::ARCH` is derived from `target_arch`, and
    Rust reports `aarch64` for every Arm64 target (Apple Silicon, Windows on
    ARM, Linux arm64). The only consumer is `get_beta_updater_target`, called
    from `src/updater.ts`. Covered by review and by grep (only this match
    touches the value). Not unit-testable without changing `ARCH`.
P2. Removing an allow on a re-export leaves an unused import on some OS, which
    fails `clippy -D warnings` there. Covered by Windows clippy (run before
    reporting). macOS and Linux are [unverified-os] and were checked only by
    grepping every `cfg` branch.
P3. Dropping the `os_integration_status_for` re-export breaks a caller on some
    OS. Only `integration_status.rs` names it, both in code and in its tests.
    Covered by Windows `cargo test` and clippy, plus grep. [unverified-os] for
    macOS and Linux.
P4. Dropping the allow on the macOS-only `register_macos_finder_sync` re-export
    would warn if `main.rs` did not use it. `main.rs` uses it under
    `cfg(target_os = "macos")`. Covered by grep. [unverified-os].
P5. Dropping the allow on the `defaults_cmds` re-exports leaves names that
    `generate_handler!` uses on every OS. Covered by Windows clippy, plus grep
    of `main.rs` (unconditional invoke handler). [unverified-os] for macOS and Linux.

## E2E coverage

E-1. Cold idle launch (no argv): the main workspace shows, `get_initial_mode`
     is empty, and `get_shell_handoff_error` is null. Covered by
     `e2e/specs/beta2-rust-launch-exit.spec.js` (writes
     `beta2-rust-launch-exit-cold-idle.json`). This guards the changed startup
     argv pipeline against injecting a path or mode when none was given.
E-2. Relative cold start (`foo.zip`): not E2E-reachable (harness limits 1 and
     2). Covered by M2 Rust tests only.
E-3. Relative second-instance open: not E2E-reachable (harness limit 3).
     Covered by the existing `launch/tests.rs` second-instance tests only.
E-4. Forced exit loop (M1): not E2E-reachable (harness limit 4). Covered by the
     M1 Rust decision tests only.
