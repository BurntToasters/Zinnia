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

- Only the commands `a`, `u`, `x`, `l`, `t` are permitted.
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
