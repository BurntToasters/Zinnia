# Security Policy

## Reporting a vulnerability

Report security issues privately via GitHub's **Report a vulnerability** advisory
flow (Security tab) or by email to the maintainer. Please do not open public
issues for undisclosed vulnerabilities. Include reproduction steps and affected
version/platform.

## Threat model

Zinnia is a single-user desktop application. It runs the bundled 7-Zip binary as
a sidecar; it does not run a server or accept network input beyond the signed
update check.

### 7z argument boundary

All 7z invocations go through `validate_run_7z_args`
([`src-tauri/src/validation.rs`](src-tauri/src/validation.rs)), the security
boundary between frontend-supplied arguments and the spawned process:

- Only the commands `a`, `u`, `x`, `l`, `t`, `b` are permitted.
- A mandatory `--` separator divides switches from paths; switches are
  allow-listed by prefix.
- Null bytes and over-length arguments are rejected.
- Positional paths and the `-o` output directory may not contain a `..`
  parent-directory segment (defense-in-depth against path traversal, independent
  of frontend validation).

Arguments are passed to the sidecar as an array — never via a shell string — so
command injection is not possible.

### Password handling (known limitation)

7-Zip's CLI accepts a password only through the `-p` switch. On most platforms
the process command line is visible to other processes owned by the same user
(e.g. `ps`), so a password passed to a running 7z process can be observed
locally during the operation.

Mitigations in place:

- Passwords are never written to the activity log, command preview, or persisted
  settings (redacted via `sanitizeCommandArgsForPreview` /
  `redactSensitiveText`).
- This exposure is local-user-only and transient (the lifetime of the
  operation).

A full fix requires linking 7-Zip as a library (e.g. `sevenz-rust2`) for the
encrypted paths so the password never reaches a process command line. This is
tracked as planned work and is out of scope for the CLI sidecar today.

Avoid sharing screen recordings or process listings while an encrypted
operation is running.

### Vendored 7-Zip binaries

The 7-Zip binaries in `assets/` are committed to the repository and checksummed
in `assets/7z-checksums.json`. Because they are bundled, a 7-Zip CVE fix
requires manually updating the binaries, regenerating checksums, and shipping a
new Zinnia release — there is no OS-level automatic update mechanism.

**Action:** watch the [7-Zip release page](https://www.7-zip.org/history.txt)
and [NVD vendor page](https://nvd.nist.gov/vuln/search/results?form_type=Basic&results_type=overview&query=7-zip&search_type=all)
for new advisories. When a new 7-Zip version addresses a security issue, update
`assets/` with the new binaries, run
`node scripts/prepare-7z.js --update-checksums` to regenerate
`assets/7z-checksums.json`, and cut a Zinnia release.
