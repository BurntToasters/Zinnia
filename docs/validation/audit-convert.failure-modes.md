# Archive Convert and Add-files failure inventory

This inventory was written before changing `src/archive/mutations.ts` or the
Convert dialog markup. It covers plan items A-02 (Convert uses hidden Add-mode
controls and writes plaintext copies silently), C-03 (Add files and Convert
have no percent or ETA in Power), and the `src/archive/mutations.ts` part of
A-01 (passwords cleared before 7-Zip runs).

## A-02: Convert gets its own dialog

Today Convert reads the output format, password, file-name encryption, split
size and timestamp options from the Add-mode form. Those controls are hidden in
Browse mode, so the operation depends on state the user cannot see.

1. The dialog must not read `#format`, `#password`, `#encrypt-headers`,
   `#split-size`, `#split-custom`, `#store-timestamps`, `#level`, `#method`,
   `#dict`, `#word-size`, `#solid` or `#threads`. A test that sets a different
   Add-tab format and password must still see the dialog defaults. Calling
   `buildCompressionMethodSwitches` from `args.ts` reads the hidden level,
   method and dictionary controls, so Convert must build its own switch list.
2. The dialog must default to a known format (7z) and an empty password on
   every open. A stale value from the Add tab must never become the output
   format.
3. Encrypted source and no output password: a confirmation must appear before
   the save dialog and before any extraction. Declining must write nothing and
   leave the dialog open with the typed values intact. Accepting must write an
   unencrypted archive.
4. The confirmation must not appear for an unencrypted source, or when the
   output password is set. Format without password support (tar, gzip, bzip2,
   xz) with an encrypted source still counts as an unencrypted output.
5. Encryption state of the source must come from a current listing. A cached
   listing for an older file identity must not be trusted. If the listing
   fails or is cancelled, Convert stops before extraction. Huge archives whose
   listing is capped at 64 MiB are blocked by this rule; that is a known
   limitation, not a silent plaintext copy. The user gets an error toast that
   says the listing could not be read and that listings over 64 MiB cannot be
   converted yet. A user cancel shows no extra toast.
6. "Encrypt file names" only appears for formats that support header
   encryption (7z). Turning it on without a password is a pre-run validation
   error and keeps the dialog open.
7. Split size must be validated inside the dialog, before the save dialog and
   before extraction. An invalid custom value (`abc`, `0k`, below 1 MiB) keeps
   the dialog open with the error and writes nothing. Validation returns an
   error value and never throws, so no exception can escape the Submit click
   into a WebDriver execute or an unhandled rejection.
8. The default save name is the source stem plus the new extension
   (`hello.7z` to `hello.zip`), not `converted.<ext>`. The same name must be
   shown in the dialog so it can be checked without a native dialog.
9. A save name that resolves to the source archive path must be refused before
   extraction. Converting 7z to 7z with the default name would otherwise
   overwrite the source. Comparison is case-insensitive and separator-agnostic.
10. An extension that does not match the output format, or a compound TAR name
    (`.tar.gz`, `.tgz`), is rejected inside the dialog before any run starts.
11. Cancel, Esc and the close button must close the dialog without starting a
    run, restore focus, and clear the dialog password field. Esc and Ctrl+Enter
    must not reach the global handler while the dialog is open, otherwise
    Ctrl+Enter would start a browse or extract run behind the dialog.
12. The source password comes from the Browse password field, then from the
    password remembered by the last successful listing, then from the Extract
    field as a fallback. A wrong source password must reach the existing
    password retry prompt, not a silent failure.
13. A password-protected output must use the dialog password for `-p`, add
    `-mem=AES256` only for ZIP, and add `-mhe=on` only when "Encrypt file
    names" is ticked and the format supports it (7z).
14. Single-stream outputs (gzip, bzip2, xz) with more than one extracted child
    must still fail before recompression, as before.
15. Basic mode has no Convert button. The dialog markup must not add a new
    `data-mode-visible` or `data-power-only` control that changes Basic.

## C-03: percent and ETA for Add files and Convert

The compress and extract paths use `withLiveProgress` (runtime.ts). Add files
and Convert call `runWithPasswordRetry` or `invokeGuardedRun7z` directly, so
the Power progress line never shows a percent.

1. Wrapping must not change the password retry path. `withLiveProgress` only
   reports while `sevenZipRunInFlight` is true, so a password prompt must not
   show a stale percent.
2. The progress line must be cleared when the run ends, on success, failure
   and cancel. A stuck "42%" line after Cancel is a regression.
3. Convert has two 7-Zip phases (extract, recompress). Each phase must go
   through `withLiveProgress`, and the recompress phase must not inherit the
   extract phase's start time or percent.
4. The Browse listing that runs after a successful Add files must not run while
   the progress line still shows an old percent.
5. Add files (`u`) and the recompress step (`a`) must pass `-bsp1`. Without it
   7-Zip sends no percent stream for those phases, and the Power line shows only
   "Finalizing…". The extract phase already passes `-bsp1`.

## A-01 (mutations.ts only): passwords cleared before 7-Zip starts

1. A pre-run error (missing archive identity, output token, runtime probe,
   ZipCrypto refusal in Add files, invalid split size, bad extension,
   same-path target) must leave the Browse password and the Convert dialog
   password in place.
2. A declined overwrite or unencrypted-copy confirmation must leave passwords
   in place. The dialog stays open, so the typed password is still there.
3. After 7-Zip has started (success, failure, cancel of a running job), the
   password fields must be cleared, as before.
4. Add files: the post-success listing uses the Browse password. Clearing must
   happen after that listing, not before it. An encrypted archive would
   otherwise prompt for a password it was just given.
5. The Convert extract phase and the recompress phase share one "started"
   flag. Clearing after the extract phase only when recompress starts would
   leave the password behind after an extract failure.

## Cross-cutting

- The Convert dialog is a modal: `role="dialog"`, `aria-modal="true"`, a
  labelled title, `trapFocus` / `releaseFocusTrap` from `utils.ts`, and an
  Esc close that does not leak to global shortcuts.
- Native confirm and save dialogs go through `confirmWithE2eQueue` and
  `takeE2eDialogResult`, so E2E can answer them without a native window.
- Existing unit tests in `src/tests/archive-flow.test.ts` that call
  `convertArchive` must now answer the dialog and prime the listing cache.
  Their expectations for 7-Zip argument lists stay the same except where the
  behavior intentionally changed (Add-tab level and method no longer applied).

## Deferred

- Convert does not expose the Add-tab level, method, dictionary, word size,
  solid or thread controls. Convert uses 7-Zip defaults (level 5). A user who
  wants another method must set it through a future option; this is recorded
  here rather than silently inherited from hidden controls.
