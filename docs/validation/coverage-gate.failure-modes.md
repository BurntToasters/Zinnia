# Coverage gate regression

The supplied macOS and Linux logs pass all 1,073 tests but fail global coverage
thresholds. Windows reproduces the exact totals: lines 78.66%, statements
76.12%, functions 75.94%, branches 64.71%. Keep the existing thresholds.

Failure cases to cover before changing any implementation:

- Recent menu rendering can expose full paths as labels, retain stale rows, or
  fail to hide an empty list.
- Keyboard navigation can lose focus, fail to wrap, or let Escape navigate away
  instead of closing the menu and restoring trigger focus.
- Selecting a missing archive can invoke the archive handler after pruning.
- A delayed filesystem probe can reopen a menu after an outside click.
- Remembering an archive can duplicate entries or exceed the five-entry limit.
- Shortcut help can duplicate rows on refresh or omit platform key alternatives.
- An updater status-query failure can allow installation during archive work.
- A newly started archive operation can race the restart confirmation.
- A background download can open a restart modal without user action, or its
  ready indicator can fail to install or report installation errors.
- A same-version or older update can download and install unnecessarily.

Verification: run `npx vitest run --coverage` and retain the generated
`coverage/coverage-summary.json` and HTML report. Then run the aggregate coverage
parser against that report to verify the additional critical-file thresholds.
