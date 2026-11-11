# Archive password preflight failure inventory

This inventory was written before adding the F1/F3 regression cases or changing
production code. It covers the encrypted archive password check and the shared
registered 7-Zip preflight result boundary.

## Encrypted-member selection and password proof (F1)

- `7z l -slt -ba` is not a lossless representation of member names. A member
  containing a newline can be displayed with that character replaced by `_`.
  Passing the displayed name to `7z t` may select no member while returning
  exit code 0 and `Everything is Ok`.
- A lossy display name can collide with a real member name. If the encrypted
  member is `tiny\nsecret.txt` and a plaintext member is `tiny_secret.txt`, a
  member test can succeed against the plaintext alias and leave the encrypted
  member untested.
- Repeated or normalized-colliding names can make the smallest encrypted
  member selector ambiguous even if each displayed record looks syntactically
  valid.
- 7-Zip's wildcard case matching differs by platform. A plaintext member named
  `TINY_SECRET.TXT` can satisfy the lossy selector `tiny_secret.txt` on a
  case-insensitive matcher while appearing as a distinct path in the listing.
  Selected-member password tests must force case-sensitive matching; the
  whole-archive fallback remains necessary when the lossy name selects nothing.
- A nominally successful member test can report no files, omit evidence that
  the requested member was processed, or be incomplete. None of these cases
  proves that encrypted data accepted the supplied password.
- An encrypted archive can have no testable encrypted regular file (for
  example, only encrypted directory records). Treating the missing selector as
  a verified password would permit an update without testing encrypted data.
- A whole-archive fallback must itself complete within the existing timeout
  and output bounds, and must reject the archive if any encrypted data fails.
  Empty/no-data archives cannot gain password proof merely from an exit-zero
  test.
- Wrong passwords must be refused before mutation and leave the original
  archive bytes unchanged. Correct-password fallback must still allow updates
  and keep new data readable only with the original password.
- Ordinary archives with one unambiguous encrypted member should retain the
  efficient smallest-member check. Missing passwords, ZipCrypto refusal,
  cancellation, stdin-only password delivery, child cleanup, and the existing
  120-second/output limits must remain intact.
- POSIX-only newline-name cases are unsupported on Windows and must be skipped
  there without weakening the Windows test run.

## Registered preflight completeness (F3)

- A stream reader can emit an error and the child can still report exit 0; the
  partial listing/test output must not be returned as a successful preflight.
- A stream error combined with exit 1 and metadata-warning text must not be
  accepted by the existing metadata-only warning classifier.
- A child may end without a termination event. Missing termination must be an
  explicit preflight error rather than a result carrying partial output.
- A termination event can lack an exit code or report a signal; a synthetic
  status must not turn that into success.
- Stdout or stderr can be truncated at the configured bound. Truncation must
  remain a distinct failure and must not be confused with a successful short
  listing.
- A complete exit-0 result must remain accepted. A complete exit-1 result with
  a recognized metadata-only warning must continue to reach the existing
  caller classifier unchanged.
- On stream failure or missing termination, registered-child cleanup/reaping
  must still happen before returning; cancellation must retain precedence and
  must not be converted to an incomplete-output error.
