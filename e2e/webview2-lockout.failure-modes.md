# WebView2 lockout workaround: failure modes

Context: `TEMP_WEBVIEW2_LOCKOUT_WORKAROUND` in `e2e/helpers/profile.js` adds
`AutofillAiWalletPrivatePasses` and `AutofillAmbientAutofill` to
`--disable-features` for E2E WebView2 launches. It works around upstream
behavior (MicrosoftEdge/WebView2Feedback #5722, Chromium #562403601), where a
fresh WebView2 environment can log a failed Windows logon (Event 4625). This is
not password handling.

Mechanism (Chromium source, checked 2026-10-17): `password_manager_util_win.cc`
calls `LogonUser()` with a blank password to learn whether the OS password is
blank, unless Local State already records `password_manager.os_password_last_changed`.
A fresh WebView2 user data folder has no Local State, so every fresh E2E profile
runs it. The autofill client reaches it when either feature above is enabled
(crrev.com/c/7715959, crrev.com/c/8363705).

The arg merge (`mergeWebView2BrowserArgs`) must not fail in these ways:

1. Dropping existing switches: a base switch (for example `--disable-gpu`) or a
   developer switch (for example `--remote-debugging-port=1`) is missing from the output.
2. Two `--disable-features` switches: Chromium may honor only one, silently losing features.
3. Losing an externally supplied `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`: the
   developer's value is overwritten instead of merged.
4. Undefined or empty input: `"undefined"` text, an empty token, or stray whitespace
   appears in the output. Undefined, empty and whitespace-only inputs must be skipped.
5. Duplicate features: the same feature name from two inputs, or repeated within one
   list, survives. Dedup must keep first-seen order.
6. Values containing `=`: splitting on every `=` truncates the value, so the first `=`
   must be the only separator.
7. Leaking into non-Windows env: the variable is set on macOS or Linux runs.
8. Removal not restoring the original string: deleting the temp array entry leaves a
   trailing comma, double space, or reordered features, so the result is not exactly
   the pre-workaround `E2E_WEBVIEW2_BROWSER_ARGS`.
9. Non-deterministic output: ordering depends on object or Set iteration details that
   change between runs, so identical inputs give different strings.
10. Enable and disable mixed: `--enable-features` values are folded into
    `--disable-features`, or the reverse.

## Removal

Upstream status on 2026-10-17: not fixed. No Chromium change removing the
blank-password `LogonUser()` call has merged; crrev.com/c/8504537 (work in
progress) lists the 4625 as an open follow-up.

Remove the temporary workaround only after all of these hold:

1. A merged Chromium change removes or replaces the blank-password `LogonUser()`
   call, or stops it on a fresh Local State (track #5722, Chromium #562403601
   and #541310282).
2. The WebView2 Stable runtime on dev and test machines is at or past that
   change's first release (chromiumdash `fetch_commit`; registry value `pv` under
   `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`).
3. Several fresh-profile launches without the flags leave the account's
   bad-password counter unchanged (`BadPasswordAttempts` on
   `[ADSI]"WinNT://<host>/<user>,user"`, readable without elevation; ROSI's
   `e2e/webview2-lockout-probe.mjs` automates this). A matching 4625 event
   (Logon Type 2, source Advapi, status 0xC000006D or 0xC000006A, process
   msedgewebview2.exe) needs an elevated shell and failure auditing.
4. A small E2E subset passes without the flags.
5. A normal full E2E run passes.

Cleanup deletes only the temporary array entries and their `TEMP_WEBVIEW2_LOCKOUT_WORKAROUND`
comment block. Keep the merge helper, because it is generic and still protects developer
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` values.
